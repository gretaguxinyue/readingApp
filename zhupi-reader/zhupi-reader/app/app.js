/* ══════════ 存储 ══════════ */
const DB = (() => {
  let p;
  function open(){
    if (p) return p;
    p = new Promise((res, rej) => {
      const r = indexedDB.open('zhupi', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', {keyPath:'id'});
        if (!db.objectStoreNames.contains('notes')) {
          const s = db.createObjectStore('notes', {keyPath:'id'});
          s.createIndex('book', 'bookId');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', {keyPath:'k'});
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return p;
  }
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put:  (s, v)  => tx(s, 'readwrite', o => o.put(v)),
    get:  (s, k)  => tx(s, 'readonly',  o => o.get(k)),
    del:  (s, k)  => tx(s, 'readwrite', o => o.delete(k)),
    all:  (s)     => tx(s, 'readonly',  o => o.getAll()),
    byBook: (s, id) => tx(s, 'readonly', o => o.index('book').getAll(id)),
  };
})();

const kvGet = async (k, d) => { const r = await DB.get('kv', k); return r ? r.v : d; };
const kvSet = (k, v) => DB.put('kv', {k, v});

/* ══════════ 小工具 ══════════ */
const $ = s => document.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
let toastT;
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
}
function resolvePath(base, rel){
  try {
    const u = new URL(rel, 'app://x/' + base);
    return decodeURIComponent(u.pathname.slice(1));
  } catch { return rel; }
}
function openSheet(el){ el.classList.add('open'); asHold('sheet', true); }
function closeSheet(el){
  el.classList.remove('open');
  asHold('sheet', !!document.querySelector('.sheet.open'));
}
document.querySelectorAll('[data-close]').forEach(b =>
  b.addEventListener('click', () => closeSheet(b.closest('.sheet'))));

/* ══════════ 同步(Supabase) ══════════
   ↓ 填这两行,同一份部署在所有设备上就能同步。anon key 是公开的,可以直接写在这里。 */
const SUPABASE_URL      = '';
const SUPABASE_ANON_KEY = '';

let sb = null, me = null, syncing = false;

async function fileHash(file){
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
const iso = ms => new Date(ms || Date.now()).toISOString();

function bookRow(b){
  return {id: b.id, user_id: me.id, title: b.title || '', author: b.author || '',
    spine_len: b.spineLen || 0, storage_path: b.storagePath || null,
    pos: b.pos || {ci: 0, ratio: 0}, added: iso(b.added), read_at: iso(b.readAt),
    updated_at: iso(b.updated), deleted: !!b.deleted};
}
function noteRow(n){
  return {id: n.id, user_id: me.id, book_id: n.bookId, ci: n.ci,
    start_off: n.start, end_off: n.end, quote: n.quote || '', comment: n.comment || '',
    created: iso(n.created), updated_at: iso(n.updated), deleted: !!n.deleted};
}

async function initSync(){
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) return paintSyncBar();
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const {data} = await sb.auth.getSession();
  me = data.session ? data.session.user : null;
  sb.auth.onAuthStateChange((_, sess) => {
    me = sess ? sess.user : null;
    paintSyncBar(); renderShelf();
    if (me) syncNow();
  });
  paintSyncBar();
  if (me) syncNow();
}

async function syncNow(quiet){
  if (!sb || !me || syncing) return;
  if (!navigator.onLine) { if (!quiet) toast('离线,等联网后再同步'); return; }
  syncing = true; paintSyncBar('正在同步…');
  const startedAt = Date.now();
  try {
    const since = await kvGet('lastSync', '1970-01-01T00:00:00.000Z');
    const sinceMs = Date.parse(since);

    // ── 推 ──
    const books = (await DB.all('books')) || [];
    const notes = (await DB.all('notes')) || [];
    const pb = books.filter(b => (b.updated || 0) > sinceMs).map(bookRow);
    const pn = notes.filter(n => (n.updated || 0) > sinceMs).map(noteRow);
    if (pb.length) { const {error} = await sb.from('books').upsert(pb); if (error) throw error; }
    if (pn.length) { const {error} = await sb.from('notes').upsert(pn); if (error) throw error; }

    // 还没上传过原文件的,补传
    for (const b of books) {
      if (b.deleted || b.storagePath || !b.file) continue;
      const path = me.id + '/' + b.id + '.epub';
      const {error} = await sb.storage.from('books')
        .upload(path, b.file, {upsert: true, contentType: 'application/epub+zip'});
      if (error && error.statusCode !== '409') continue;
      b.storagePath = path; b.updated = Date.now();
      await DB.put('books', b);
      await sb.from('books').upsert(bookRow(b));
    }

    // ── 拉 ──
    const rb = await sb.from('books').select('*').gt('updated_at', since);
    if (rb.error) throw rb.error;
    for (const r of rb.data || []) {
      const local = books.find(b => b.id === r.id) || await DB.get('books', r.id);
      const rt = Date.parse(r.updated_at);
      if (local && (local.updated || 0) >= rt) continue;
      if (r.deleted) { if (local) await DB.del('books', r.id); continue; }
      await DB.put('books', Object.assign(local || {id: r.id, file: null, cover: null}, {
        title: r.title, author: r.author, spineLen: r.spine_len, storagePath: r.storage_path,
        pos: r.pos, added: Date.parse(r.added), readAt: Date.parse(r.read_at),
        updated: rt, deleted: false
      }));
    }
    const rn = await sb.from('notes').select('*').gt('updated_at', since);
    if (rn.error) throw rn.error;
    for (const r of rn.data || []) {
      const local = notes.find(n => n.id === r.id) || await DB.get('notes', r.id);
      const rt = Date.parse(r.updated_at);
      if (local && (local.updated || 0) >= rt) continue;
      if (r.deleted) { if (local) await DB.del('notes', r.id); continue; }
      await DB.put('notes', {id: r.id, bookId: r.book_id, ci: r.ci, start: r.start_off, end: r.end_off,
        quote: r.quote, comment: r.comment, created: Date.parse(r.created), updated: rt, deleted: false});
    }

    await kvSet('lastSync', iso(startedAt - 120000));   // 留两分钟余量,重复推送是幂等的
    await kvSet('syncedAt', Date.now());
    if (R.book) R.notes = (await DB.byBook('notes', R.book.id)) || [];
    if (!$('#library').hidden) renderShelf();
    paintSyncBar();
    if (!quiet) toast('同步完成');
  } catch (err) {
    console.error(err);
    paintSyncBar('同步失败,点这里重试');
    if (!quiet) toast(err.message || '同步失败');
  } finally { syncing = false; }
}

async function paintSyncBar(override){
  const bar = $('#syncBar'), msg = bar.querySelector('.msg');
  bar.classList.toggle('live', !!me);
  if (override) { msg.textContent = override; return; }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { msg.textContent = '同步未配置 — 见 README'; return; }
  if (!me) { msg.textContent = '登录后在别的设备也能看到这些书'; return; }
  const t = await kvGet('syncedAt', 0);
  const mins = t ? Math.floor((Date.now() - t) / 60000) : null;
  const when = !t ? '还没同步过' : mins < 1 ? '刚刚同步' : mins < 60 ? mins + ' 分钟前同步' :
               new Date(t).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) + ' 同步';
  msg.textContent = me.email + ' · ' + when;
}

$('#syncBar').onclick = async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return toast('先在 index.html 顶部填 Supabase 地址和 anon key');
  if (!me) { $('#authOut').hidden = false; $('#authIn').hidden = true; return openSheet($('#authSheet')); }
  $('#authOut').hidden = true; $('#authIn').hidden = false;
  $('#auWho').textContent = me.email;
  const t = await kvGet('syncedAt', 0);
  $('#auWhen').textContent = t ? new Date(t).toLocaleString('zh-CN') : '还没同步过';
  openSheet($('#authSheet'));
};
async function doAuth(kind){
  const email = $('#auEmail').value.trim(), password = $('#auPass').value;
  if (!email || !password) return toast('邮箱和密码都要填');
  const fn = kind === 'up' ? sb.auth.signUp({email, password}) : sb.auth.signInWithPassword({email, password});
  const {error} = await fn;
  if (error) return toast(error.message);
  closeSheet($('#authSheet'));
  $('#auPass').value = '';
  toast(kind === 'up' ? '注册成功' : '已登录');
}
$('#auLogin').onclick = () => doAuth('in');
$('#auSignup').onclick = () => doAuth('up');
$('#auSync').onclick = () => { closeSheet($('#authSheet')); syncNow(); };
$('#auOut').onclick = async () => {
  if (!confirm('退出登录?本机的书和笔记会留着。')) return;
  await sb.auth.signOut();
  await kvSet('lastSync', '1970-01-01T00:00:00.000Z');
  closeSheet($('#authSheet'));
  toast('已退出');
};
window.addEventListener('online', () => syncNow(true));

/* ══════════ 阅读设置 ══════════ */
const S = {theme:'day', font:'serif', fs:18, lh:1.92, side:22};
function applySettings(){
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.style.setProperty('--fs', S.fs + 'px');
  document.documentElement.style.setProperty('--lh', S.lh);
  document.documentElement.style.setProperty('--side', S.side + 'px');
  document.documentElement.style.setProperty('--body-font', S.font === 'serif' ? 'var(--serif)' : 'var(--sans)');
  document.querySelector('meta[name=theme-color]').content =
    getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  $('#verVal').textContent = 'v' + APP_VERSION + (TAURI ? ' · 桌面版' : '');
  $('#fsVal').textContent = S.fs + ' px';
  $('#lhVal').textContent = S.lh.toFixed(2);
  $('#sdVal').textContent = S.side + ' px';
  paintAuto();
  $('#themeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.themeBtn === S.theme));
  $('#fontSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.font === S.font));
  kvSet('settings', S);
}
$('#themeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.theme = b.dataset.themeBtn; applySettings();
});
$('#fontSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.font = b.dataset.font; applySettings();
});
$('#setSheet').addEventListener('click', e => {
  const b = e.target.closest('button[data-fs],button[data-lh],button[data-sd]'); if (!b) return;
  if (b.dataset.fs) S.fs = Math.min(28, Math.max(14, S.fs + +b.dataset.fs));
  if (b.dataset.lh) S.lh = Math.min(2.6, Math.max(1.4, +(S.lh + +b.dataset.lh * 0.08).toFixed(2)));
  if (b.dataset.sd) S.side = Math.min(48, Math.max(10, S.side + +b.dataset.sd * 4));
  applySettings();
});

/* ══════════ EPUB 解析 ══════════ */
async function parseEpub(zip){
  const container = await zip.file('META-INF/container.xml').async('string');
  const cdoc = new DOMParser().parseFromString(container, 'application/xml');
  const opfPath = cdoc.querySelector('rootfile').getAttribute('full-path');
  const opfXml = await zip.file(opfPath).async('string');
  const opf = new DOMParser().parseFromString(opfXml, 'application/xml');

  const manifest = {};
  opf.querySelectorAll('manifest > item').forEach(it => {
    manifest[it.getAttribute('id')] = {
      href: resolvePath(opfPath, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || ''
    };
  });

  const spine = [];
  opf.querySelectorAll('spine > itemref').forEach(ir => {
    const id = ir.getAttribute('idref');
    if (manifest[id]) spine.push(id);
  });

  const meta = t => { const n = opf.querySelector('metadata > ' + t); return n ? n.textContent.trim() : ''; };
  const title = meta('title') || '未命名';
  const author = meta('creator') || '';
  const lang = (meta('language') || '').trim() || 'zh-CN';

  // 封面
  let coverHref = '';
  for (const id in manifest) if (/cover-image/.test(manifest[id].props)) coverHref = manifest[id].href;
  if (!coverHref) {
    const m = opf.querySelector('metadata > meta[name="cover"]');
    if (m && manifest[m.getAttribute('content')]) coverHref = manifest[m.getAttribute('content')].href;
  }

  // 目录
  const idxOf = {};
  spine.forEach((id, i) => { idxOf[manifest[id].href] = i; });
  let toc = [];
  const navId = Object.keys(manifest).find(id => /\bnav\b/.test(manifest[id].props));
  const ncxId = Object.keys(manifest).find(id => manifest[id].type === 'application/x-dtbncx+xml');

  const link = (label, href, base, depth) => {
    const path = resolvePath(base, href.split('#')[0]);
    if (!(path in idxOf)) return;
    toc.push({label: label.trim(), idx: idxOf[path], depth});
  };

  if (navId && zip.file(manifest[navId].href)) {
    const base = manifest[navId].href;
    const nd = new DOMParser().parseFromString(await zip.file(base).async('string'), 'text/html');
    let nav = [...nd.querySelectorAll('nav')].find(n => (n.getAttribute('epub:type') || '') === 'toc') || nd.querySelector('nav');
    if (nav) nav.querySelectorAll('a[href]').forEach(a => {
      let d = 0, el = a.parentElement;
      while (el && el !== nav) { if (el.tagName === 'OL') d++; el = el.parentElement; }
      link(a.textContent, a.getAttribute('href'), base, Math.max(0, d - 1));
    });
  }
  if (!toc.length && ncxId && zip.file(manifest[ncxId].href)) {
    const base = manifest[ncxId].href;
    const nd = new DOMParser().parseFromString(await zip.file(base).async('string'), 'application/xml');
    nd.querySelectorAll('navPoint').forEach(np => {
      const lbl = np.querySelector('navLabel > text');
      const c = np.querySelector('content');
      if (!lbl || !c) return;
      let d = 0, el = np.parentElement;
      while (el) { if (el.tagName === 'navPoint') d++; el = el.parentElement; }
      link(lbl.textContent, c.getAttribute('src'), base, d);
    });
  }
  if (!toc.length) toc = spine.map((_, i) => ({label: '第 ' + (i + 1) + ' 节', idx: i, depth: 0}));

  // 每个 spine 位置对应的章名（供页脚显示）
  const chapName = [];
  let cur = toc[0] ? toc[0].label : '';
  for (let i = 0; i < spine.length; i++) {
    const hit = toc.find(t => t.idx === i && t.depth === 0) || toc.find(t => t.idx === i);
    if (hit) cur = hit.label;
    chapName[i] = cur;
  }

  return {title, author, lang, manifest, spine, toc, chapName, coverHref};
}

/* ══════════ 阅读器状态 ══════════ */
const R = {
  book: null, zip: null, meta: null,
  notes: [], first: 0, last: -1,
  blobs: new Map(), busy: false, saveT: 0
};
const MAX_SECTIONS = 8;
const scroller = $('#scroller'), pages = $('#pages');

async function blobUrl(path, mime){
  if (R.blobs.has(path)) return R.blobs.get(path);
  const f = R.zip.file(path);
  if (!f) return '';
  const buf = await f.async('arraybuffer');
  const url = URL.createObjectURL(new Blob([buf], {type: mime || 'image/*'}));
  R.blobs.set(path, url);
  return url;
}

const KILL_STYLE = /(^|;)\s*(color|background|background-color|font-family|font-size|line-height|width|height|margin|text-indent)\s*:[^;]*/gi;

async function buildSection(i){
  const item = R.meta.manifest[R.meta.spine[i]];
  const sec = document.createElement('section');
  sec.dataset.idx = i;

  const mark = document.createElement('div');
  mark.className = 'chapMark';
  mark.innerHTML = '<span></span>';
  mark.firstChild.textContent = R.meta.chapName[i] || '';
  sec.appendChild(mark);

  let html = '';
  try { html = await R.zip.file(item.href).async('string'); } catch {}
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,link,iframe,audio,video').forEach(n => n.remove());

  // 图片
  const imgs = [...doc.querySelectorAll('img[src],image')];
  for (const n of imgs) {
    const raw = n.getAttribute('src') || n.getAttribute('xlink:href') || n.getAttribute('href');
    if (!raw || /^data:/.test(raw)) continue;
    const p = resolvePath(item.href, raw);
    const mt = Object.values(R.meta.manifest).find(m => m.href === p);
    const u = await blobUrl(p, mt && mt.type);
    if (n.tagName === 'IMG') n.src = u; else n.setAttribute('href', u);
  }
  // 内部链接改成跳章
  doc.querySelectorAll('a[href]').forEach(a => {
    const h = a.getAttribute('href');
    if (/^(https?|mailto):/.test(h)) { a.target = '_blank'; a.rel = 'noopener'; return; }
    const p = resolvePath(item.href, h.split('#')[0]);
    const t = R.meta.spine.findIndex(id => R.meta.manifest[id].href === p);
    a.removeAttribute('href');
    if (t >= 0) a.dataset.goto = t;
  });
  // 清掉书自带的字体/颜色，交给阅读设置
  doc.querySelectorAll('[style]').forEach(n => {
    const s = n.getAttribute('style').replace(KILL_STYLE, '').replace(/^;+/, '').trim();
    if (s) n.setAttribute('style', s); else n.removeAttribute('style');
  });
  doc.querySelectorAll('[class]').forEach(n => n.removeAttribute('class'));

  const body = document.createElement('div');
  while (doc.body.firstChild) body.appendChild(doc.body.firstChild);
  sec.appendChild(body);
  sec._content = body;
  return sec;
}

function contentOf(sec){ return sec._content || sec.lastElementChild; }

/* 文本偏移 <-> DOM 位置 */
function offsetOf(root, node, off){
  if (!root.contains(node)) return -1;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0, n;
  while ((n = w.nextNode())) {
    if (n === node) return acc + off;
    acc += n.nodeValue.length;
  }
  return -1;
}
function paintNote(sec, note){
  const root = contentOf(sec);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0, n, hits = [];
  while ((n = w.nextNode())) {
    const len = n.nodeValue.length;
    const s = Math.max(note.start, acc), e = Math.min(note.end, acc + len);
    if (s < e) hits.push([n, s - acc, e - acc]);
    acc += len;
  }
  hits.reverse().forEach(([node, s, e]) => {
    try {
      const r = document.createRange();
      r.setStart(node, s); r.setEnd(node, e);
      const m = document.createElement('mark');
      m.className = 'hl'; m.dataset.note = note.id;
      r.surroundContents(m);
    } catch {}
  });
}
function paintAll(sec){
  const i = +sec.dataset.idx;
  R.notes.filter(n => n.ci === i).sort((a, b) => b.start - a.start).forEach(n => paintNote(sec, n));
}

/* ══════════ 连续滚动 ══════════ */
async function appendNext(){
  if (R.busy || R.last >= R.meta.spine.length - 1) return;
  R.busy = true;
  const sec = await buildSection(R.last + 1);
  pages.appendChild(sec); paintAll(sec); R.last++;
  while (pages.children.length > MAX_SECTIONS) {
    const h0 = pages.scrollHeight;
    pages.firstElementChild.remove(); R.first++;
    scroller.scrollTop -= (h0 - pages.scrollHeight);
  }
  R.busy = false;
}
async function prependPrev(){
  if (R.busy || R.first <= 0) return;
  R.busy = true;
  const sec = await buildSection(R.first - 1);
  const h0 = pages.scrollHeight;
  pages.insertBefore(sec, pages.firstElementChild);
  paintAll(sec); R.first--;
  scroller.scrollTop += (pages.scrollHeight - h0);
  while (pages.children.length > MAX_SECTIONS) { pages.lastElementChild.remove(); R.last--; }
  R.busy = false;
}
async function goChapter(i, ratio){
  TTS.cache.clear();
  R.first = R.last = i;
  pages.innerHTML = '';
  const sec = await buildSection(i);
  pages.appendChild(sec); paintAll(sec);
  scroller.scrollTop = ratio ? sec.offsetTop + sec.offsetHeight * ratio : 0;
  updateWhere();
  // 内容太短就先补一章，保证能继续下滑
  if (pages.scrollHeight < scroller.clientHeight * 1.6) appendNext();
}

let lastY = 0, tick = false;
scroller.addEventListener('scroll', () => {
  if (tick) return;
  tick = true;
  requestAnimationFrame(() => {
    tick = false;
    const y = scroller.scrollTop;
    if (R._autoScroll) R._autoScroll = false; else TTS.follow = Date.now();
    // 下滑藏栏，上滑显栏
    const dy = y - lastY;
    if (Math.abs(dy) > 8) {
      const hide = dy > 0 && y > 120 && !TTS.on && !AS.on;
      $('#topBar').classList.toggle('hide', hide);
      $('#botBar').classList.toggle('hide', hide);
      lastY = y;
    }
    if (y + scroller.clientHeight > scroller.scrollHeight - 1400) appendNext();
    if (y < 600) prependPrev();
    updateWhere();
    clearTimeout(R.saveT);
    R.saveT = setTimeout(saveProgress, 500);
  });
}, {passive: true});

function currentSection(){
  const top = scroller.scrollTop + 80;
  let cur = pages.firstElementChild;
  for (const s of pages.children) { if (s.offsetTop <= top) cur = s; else break; }
  return cur;
}
function updateWhere(){
  const sec = currentSection();
  if (!sec) return;
  const i = +sec.dataset.idx;
  const within = Math.min(1, Math.max(0, (scroller.scrollTop - sec.offsetTop) / (sec.offsetHeight || 1)));
  const pct = ((i + within) / R.meta.spine.length) * 100;
  $('#whereNow').textContent = R.meta.chapName[i] || '';
  $('#pctNow').textContent = pct.toFixed(1) + '%';
  R._pos = {ci: i, ratio: within};
}
function saveProgress(){
  if (!R.book || !R._pos) return;
  R.book.pos = R._pos;
  R.book.readAt = R.book.updated = Date.now();
  DB.put('books', R.book);
}

pages.addEventListener('click', e => {
  if (AS.on && !e.target.closest('mark.hl,a') && document.getSelection().isCollapsed) return asToggle();
  const m = e.target.closest('mark.hl');
  if (m) { const n = R.notes.find(x => x.id === m.dataset.note); if (n) editNote(n); return; }
  const a = e.target.closest('a[data-goto]');
  if (a) goChapter(+a.dataset.goto, 0);
});

/* ══════════ 长按选中 → 记笔记 ══════════ */
let pending = null, selT;
document.addEventListener('selectionchange', () => {
  clearTimeout(selT);
  selT = setTimeout(handleSelection, 180);
});
function handleSelection(){
  const bar = $('#selBar');
  const sel = document.getSelection();
  asHold('sel', !!(sel && !sel.isCollapsed && sel.rangeCount));
  if ($('#reader').hidden || !sel || sel.isCollapsed || !sel.rangeCount) { bar.classList.remove('show'); pending = null; return; }
  const range = sel.getRangeAt(0);
  const head = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const sec = head && head.closest('#pages section');
  if (!sec) { bar.classList.remove('show'); pending = null; return; }
  const root = contentOf(sec);
  const start = offsetOf(root, range.startContainer, range.startOffset);
  let end = offsetOf(root, range.endContainer, range.endOffset);
  if (end < 0) end = root.textContent.length;   // 选到了下一章，就收到本章末尾
  const text = sel.toString().trim();
  if (start < 0 || end <= start || !text) { bar.classList.remove('show'); pending = null; return; }
  pending = {ci: +sec.dataset.idx, start, end, text};

  const r = range.getBoundingClientRect();
  bar.classList.add('show');
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let x = Math.min(window.innerWidth - bw - 10, Math.max(10, r.left + r.width / 2 - bw / 2));
  let y = r.bottom + 12;
  if (y + bh > window.innerHeight - 20) y = Math.max(10, r.top - bh - 12);
  bar.style.left = x + 'px';
  bar.style.top = y + 'px';
}
$('#selCopy').addEventListener('click', async () => {
  if (!pending) return;
  try { await navigator.clipboard.writeText(pending.text); toast('已复制'); } catch { toast('复制失败'); }
  document.getSelection().removeAllRanges();
  $('#selBar').classList.remove('show');
});
$('#selNote').addEventListener('click', async () => {
  if (!pending) return;
  const note = {
    id: uid(), bookId: R.book.id, ci: pending.ci,
    start: pending.start, end: pending.end,
    quote: pending.text, comment: '',
    created: Date.now(), updated: Date.now()
  };
  await DB.put('notes', note);
  R.notes.push(note);
  const sec = [...pages.children].find(s => +s.dataset.idx === note.ci);
  if (sec) paintNote(sec, note);
  document.getSelection().removeAllRanges();
  $('#selBar').classList.remove('show');
  editNote(note, true);
});

/* ══════════ 朗读 ══════════ */
const synth = window.speechSynthesis;
const CHROMIUM = /Chrome\//.test(navigator.userAgent);
const TTS = {on: false, paused: false, ci: -1, i: 0, list: [], rate: 1, voice: null,
             cache: new Map(), keep: null, wake: null, follow: 0};
const sayHL = (window.CSS && CSS.highlights) ? new Highlight() : null;
if (sayHL) CSS.highlights.set('speaking', sayHL);

/* 把一章的纯文本切成句子,位置沿用笔记那套「章内字符偏移」 */
const STOP = '。！？…；!?;\n\r', CLOSE = '”’」』）)"\'';
function splitSentences(text){
  const out = [];
  const push = (a, b) => { if (text.slice(a, b).trim()) out.push({start: a, end: b, text: text.slice(a, b).trim()}); };
  let i = 0, s = 0;
  while (i < text.length) {
    const c = text[i++];
    if (STOP.includes(c)) {
      while (i < text.length && (CLOSE.includes(text[i]) || STOP.includes(text[i]))) i++;
      push(s, i); s = i;
    } else if (c === '.' && !/\d/.test(text[i] || '')) {          // 英文句号,避开小数点
      while (i < text.length && (CLOSE.includes(text[i]) || text[i] === ' ')) i++;
      push(s, i); s = i;
    } else if (i - s > 220) { push(s, i); s = i; }                 // 长段没标点也得断开
  }
  push(s, text.length);
  return out;
}
function sentencesOf(sec){
  const ci = +sec.dataset.idx;
  if (!TTS.cache.has(ci)) TTS.cache.set(ci, splitSentences(contentOf(sec).textContent));
  return TTS.cache.get(ci);
}

/* 字符区间 → DOM Range */
function rangeAt(root, start, end){
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let acc = 0, n, open = false;
  while ((n = w.nextNode())) {
    const len = n.nodeValue.length;
    if (!open && start < acc + len) { r.setStart(n, Math.max(0, start - acc)); open = true; }
    if (open && end <= acc + len) { r.setEnd(n, Math.max(0, end - acc)); return r; }
    acc += len;
    if (open) r.setEnd(n, len);
  }
  return open ? r : null;
}
function clearSaying(){
  if (sayHL) sayHL.clear();
  document.querySelectorAll('mark.say').forEach(m => {
    const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); m.remove(); p.normalize();
  });
}
function showSaying(sec, sent){
  clearSaying();
  const r = rangeAt(contentOf(sec), sent.start, sent.end);
  if (!r) return;
  if (sayHL) sayHL.add(r);
  else { try { const m = document.createElement('mark'); m.className = 'say'; r.surroundContents(m); } catch {} }
  if (Date.now() - TTS.follow < 5000) return;                      // 刚手动滚过,先别抢
  const box = r.getBoundingClientRect();
  if (box.height) {
    R._autoScroll = true;
    scroller.scrollTop += box.top - window.innerHeight * 0.36;
  }
}

async function ensureSection(i){
  const find = () => [...pages.children].find(s => +s.dataset.idx === i);
  let sec = find();
  if (sec) return sec;
  if (i === R.last + 1) await appendNext();
  else if (i === R.first - 1) await prependPrev();
  sec = find();
  if (!sec) { await goChapter(i, 0); sec = find(); }
  return sec;
}

function voicesFor(lang){
  const all = synth ? synth.getVoices() : [];
  const tag = (lang || 'zh').toLowerCase().slice(0, 2);
  const hit = all.filter(v => v.lang.toLowerCase().startsWith(tag));
  return hit.length ? hit.concat(all.filter(v => !hit.includes(v))) : all;
}
function paintVoices(){
  const sel = $('#ttsVoice'), hint = $('#ttsHint');
  const list = voicesFor(R.meta ? R.meta.lang : 'zh');
  sel.innerHTML = '';
  if (!synth || !list.length) {
    sel.innerHTML = '<option>没有可用的语音</option>';
    hint.textContent = synth ? '系统里还没装语音包。macOS 在「系统设置 → 辅助功能 → 朗读内容」里下载,Windows 在「时间和语言 → 语音」里加。'
                             : '当前环境不支持语音合成。';
    return;
  }
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v.voiceURI; o.textContent = v.name + ' · ' + v.lang;
    sel.appendChild(o);
  });
  if (TTS._savedVoice) { const v = list.find(x => x.voiceURI === TTS._savedVoice); if (v) TTS.voice = v; TTS._savedVoice = ''; }
  if (!TTS.voice || !list.includes(TTS.voice)) TTS.voice = list[0];
  sel.value = TTS.voice.voiceURI;
  hint.textContent = '本书标注的语言是 ' + (R.meta ? R.meta.lang : '—') + '。';
}
if (synth) synth.addEventListener('voiceschanged', () => { if (!$('#reader').hidden) paintVoices(); });
$('#ttsVoice').onchange = e => {
  TTS.voice = synth.getVoices().find(v => v.voiceURI === e.target.value) || null;
  kvSet('ttsVoice', e.target.value);
  if (TTS.on) sayCurrent();
};
$('#setSheet').addEventListener('click', e => {
  const b = e.target.closest('button[data-rate]'); if (!b) return;
  TTS.rate = Math.min(2.5, Math.max(0.5, +(TTS.rate + +b.dataset.rate * 0.1).toFixed(1)));
  paintRate(); kvSet('ttsRate', TTS.rate);
  if (TTS.on && !TTS.paused) sayCurrent();
});
function paintRate(){
  $('#rateVal').textContent = TTS.rate.toFixed(1) + '×';
  $('#ttsRate').textContent = TTS.rate.toFixed(1) + '×';
}

async function keepAwake(on){
  try {
    if (on && 'wakeLock' in navigator && !TTS.wake) {
      TTS.wake = await navigator.wakeLock.request('screen');
      TTS.wake.addEventListener('release', () => { TTS.wake = null; });
    } else if (!on && TTS.wake) { TTS.wake.release(); TTS.wake = null; }
  } catch {}
}

function sayCurrent(){
  if (!TTS.on) return;
  synth.cancel();
  const sent = TTS.list[TTS.i];
  if (!sent) return sayNextChapter();
  const sec = [...pages.children].find(s => +s.dataset.idx === TTS.ci);
  if (sec) showSaying(sec, sent);
  const u = new SpeechSynthesisUtterance(sent.text);
  u.rate = TTS.rate;
  if (TTS.voice) { u.voice = TTS.voice; u.lang = TTS.voice.lang; }
  else u.lang = R.meta.lang;
  u.onend = () => { if (TTS.on && !TTS.paused) { TTS.i++; sayCurrent(); } };
  u.onerror = ev => { if (ev.error !== 'interrupted' && ev.error !== 'canceled') { TTS.i++; sayCurrent(); } };
  synth.speak(u);
}
async function sayNextChapter(){
  if (TTS.ci >= R.meta.spine.length - 1) { toast('读完了'); return ttsStop(); }
  const sec = await ensureSection(TTS.ci + 1);
  if (!sec) return ttsStop();
  TTS.ci++; TTS.list = sentencesOf(sec); TTS.i = 0;
  sayCurrent();
}

async function ttsStart(ci, charOffset){
  if (!synth) return toast('这个环境不支持朗读');
  if (!synth.getVoices().length) { await new Promise(r => setTimeout(r, 300)); }
  if (!synth.getVoices().length) return toast('系统里没有可用的语音包');
  paintVoices();
  const sec = await ensureSection(ci);
  if (!sec) return;
  if (AS.on) asStop();
  TTS.on = true; TTS.paused = false; TTS.ci = ci;
  TTS.list = sentencesOf(sec);
  TTS.i = Math.max(0, TTS.list.findIndex(x => x.end > (charOffset || 0)));
  paintTts();
  keepAwake(true);
  if (CHROMIUM && !TTS.keep) TTS.keep = setInterval(() => {          // Chrome 十几秒就断,得戳一下
    if (TTS.on && !TTS.paused && synth.speaking) { synth.pause(); synth.resume(); }
  }, 9000);
  sayCurrent();
}
function ttsStop(){
  TTS.on = false; TTS.paused = false;
  synth && synth.cancel();
  clearInterval(TTS.keep); TTS.keep = null;
  clearSaying(); keepAwake(AS.on); paintTts();
}
function ttsToggle(){
  if (!TTS.on) return;
  TTS.paused = !TTS.paused;
  if (TTS.paused) synth.cancel(); else sayCurrent();
  paintTts();
}
function ttsStep(d){
  if (!TTS.on) return;
  const n = TTS.i + d;
  if (n < 0) { if (TTS.ci > 0) return ensureSection(TTS.ci - 1).then(sec => {
      if (!sec) return; TTS.ci--; TTS.list = sentencesOf(sec); TTS.i = TTS.list.length - 1; sayCurrent(); }); return; }
  if (n >= TTS.list.length) return sayNextChapter();
  TTS.i = n; TTS.paused = false; paintTts(); sayCurrent();
}
function paintTts(){
  const bar = $('#ttsBar'), on = TTS.on;
  bar.hidden = !on;
  $('#footNormal').hidden = on || AS.on;
  $('#ttsBtn').classList.toggle('on', on);
  $('#ttsToggle').textContent = TTS.paused ? '▶' : '❚❚';
  if (on) { $('#topBar').classList.remove('hide'); $('#botBar').classList.remove('hide'); }
  paintRate();
}
$('#ttsBtn').onclick = () => TTS.on ? ttsStop() : ttsStart(R._pos ? R._pos.ci : 0, sentenceAtTop());
$('#ttsToggle').onclick = ttsToggle;
$('#ttsPrev').onclick = () => ttsStep(-1);
$('#ttsNext').onclick = () => ttsStep(1);
$('#ttsStop').onclick = ttsStop;
$('#ttsRate').onclick = () => openSheet($('#setSheet'));
/* 从屏幕顶部那句开始读,而不是从整章开头 */
function sentenceAtTop(){
  const sec = currentSection(); if (!sec) return 0;
  const root = contentOf(sec), w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0, n;
  while ((n = w.nextNode())) {
    const r = document.createRange(); r.selectNode(n);
    if (r.getBoundingClientRect().bottom > 90) return acc;
    acc += n.nodeValue.length;
  }
  return 0;
}
$('#selRead').addEventListener('click', () => {
  if (!pending) return;
  const p = pending;
  document.getSelection().removeAllRanges();
  $('#selBar').classList.remove('show');
  ttsStart(p.ci, p.start);
});

/* ══════════ 自动划屏 ══════════ */
/* 速度存成「行/分钟」而不是「像素/秒」:换了字号行距,阅读节奏不用重调 */
const AS = {on: false, paused: false, lpm: 24, pos: 0, last: 0, raf: 0, t0: 0};
const asHolds = new Set();
const asLine = () => S.fs * S.lh;
const asPxPerSec = () => AS.lpm * asLine() / 60;

function asHold(why, on){
  const had = asHolds.size;
  on ? asHolds.add(why) : asHolds.delete(why);
  if (AS.on && !!had !== !!asHolds.size) { AS.t0 = performance.now(); paintAuto(); }
}

function asStep(t){
  if (!AS.on) return;
  AS.raf = requestAnimationFrame(asStep);
  if (AS.paused || asHolds.size) { AS.t0 = t; return; }
  const dt = Math.min(0.1, (t - AS.t0) / 1000); AS.t0 = t;
  if (Math.abs(scroller.scrollTop - AS.last) > 2) AS.pos = scroller.scrollTop;  // 有人动过:手滑、补章、跳章
  const max = scroller.scrollHeight - scroller.clientHeight;
  AS.pos = Math.min(AS.pos + asPxPerSec() * dt, max);
  if (AS.pos >= max - 1 && R.last >= R.meta.spine.length - 1) { toast('读完了'); return asStop(); }
  R._autoScroll = true;
  scroller.scrollTop = AS.pos;
  AS.last = scroller.scrollTop;
}

function asStart(){
  if (TTS.on) ttsStop();
  AS.on = true; AS.paused = false;
  asHolds.clear();
  AS.pos = AS.last = scroller.scrollTop;
  AS.t0 = performance.now();
  cancelAnimationFrame(AS.raf);
  AS.raf = requestAnimationFrame(asStep);
  keepAwake(true); paintAuto();
}
function asStop(){
  AS.on = false; AS.paused = false;
  cancelAnimationFrame(AS.raf); AS.raf = 0;
  asHolds.clear();
  keepAwake(TTS.on); paintAuto();
}
function asToggle(){
  if (!AS.on) return asStart();
  AS.paused = !AS.paused; AS.t0 = performance.now(); paintAuto();
}
function asSpeed(d){
  AS.lpm = Math.min(90, Math.max(4, AS.lpm + d * (AS.lpm >= 30 ? 3 : 2)));
  kvSet('asLpm', AS.lpm); paintAuto();
}
function asLabel(){
  const h = scroller.clientHeight;
  const secs = h ? Math.round(h / asPxPerSec()) : 0;
  return AS.lpm + ' 行/分' + (secs ? '　约 ' + secs + ' 秒一屏' : '');
}
function paintAuto(){
  const on = AS.on;
  $('#autoBar').hidden = !on;
  $('#footNormal').hidden = on || TTS.on;
  $('#autoBtn').classList.toggle('on', on);
  $('#asToggle').textContent = (AS.paused || asHolds.size) ? '▶' : '❚❚';
  $('#asRate').textContent = asLabel();
  $('#lpmVal').textContent = AS.lpm + ' 行/分';
  $('#lpmHint').textContent = '当前字号下' + (scroller.clientHeight ? '约 ' + Math.round(scroller.clientHeight / asPxPerSec()) + ' 秒滚过一屏。' : '。');
  if (on) { $('#topBar').classList.remove('hide'); $('#botBar').classList.remove('hide'); }
}
$('#autoBtn').onclick = () => AS.on ? asStop() : asStart();
$('#asToggle').onclick = asToggle;
$('#asStop').onclick = asStop;
$('#asSlower').onclick = () => asSpeed(-1);
$('#asFaster').onclick = () => asSpeed(1);
$('#setSheet').addEventListener('click', e => {
  const b = e.target.closest('button[data-lpm]'); if (!b) return;
  asSpeed(+b.dataset.lpm);
});

/* ══════════ 笔记编辑 ══════════ */
let editing = null;
function editNote(note, fresh){
  editing = note;
  $('#edTitle').textContent = fresh ? '写下感悟' : '编辑笔记';
  $('#neQuote').value = note.quote;
  $('#neComment').value = note.comment;
  openSheet($('#editSheet'));
  if (fresh) setTimeout(() => $('#neComment').focus(), 320);
}
$('#neSave').addEventListener('click', async () => {
  if (!editing) return;
  editing.quote = $('#neQuote').value.trim();
  editing.comment = $('#neComment').value;
  editing.updated = Date.now();
  await DB.put('notes', editing);
  closeSheet($('#editSheet'));
  if ($('#notesSheet').classList.contains('open')) renderNotes();
  syncNow(true);
  toast('已保存');
});
$('#neDel').addEventListener('click', async () => {
  if (!editing || !confirm('删除这条笔记？')) return;
  editing.deleted = true; editing.updated = Date.now();
  await DB.put('notes', editing);
  R.notes = R.notes.filter(n => n.id !== editing.id);
  document.querySelectorAll('mark.hl[data-note="' + editing.id + '"]').forEach(m => {
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    m.remove(); p.normalize();
  });
  closeSheet($('#editSheet'));
  renderNotes();
  syncNow(true);
  toast('已删除');
});

/* ══════════ 笔记本 ══════════ */
function renderNotes(){
  const q = $('#noteSearch').value.trim().toLowerCase();
  const list = R.notes
    .filter(n => !q || (n.quote + n.comment).toLowerCase().includes(q))
    .sort((a, b) => a.ci - b.ci || a.start - b.start);
  const box = $('#noteList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + (q ? '没有匹配的笔记。' : '还没有笔记。<br>在正文里长按选中一段话，点「记笔记」。') + '</div>';
    return;
  }
  let lastCi = -1;
  for (const n of list) {
    if (n.ci !== lastCi) {
      lastCi = n.ci;
      const g = document.createElement('div');
      g.className = 'grp'; g.textContent = R.meta.chapName[n.ci] || ('第 ' + (n.ci + 1) + ' 节');
      box.appendChild(g);
    }
    const el = document.createElement('div');
    el.className = 'note';
    const q1 = document.createElement('div'); q1.className = 'q'; q1.textContent = n.quote;
    const c1 = document.createElement('p');
    c1.className = 'c' + (n.comment.trim() ? '' : ' blank');
    c1.textContent = n.comment.trim() || '＋ 还没写感悟';
    const act = document.createElement('div'); act.className = 'act';
    const b1 = document.createElement('button'); b1.textContent = '编辑';
    const b2 = document.createElement('button'); b2.textContent = '回到原文';
    b1.onclick = () => editNote(n);
    c1.onclick = () => editNote(n);
    b2.onclick = async () => { closeSheet($('#notesSheet')); await goChapter(n.ci, 0); scrollToNote(n.id); };
    act.append(b1, b2);
    el.append(q1, c1, act);
    box.appendChild(el);
  }
}
function scrollToNote(id){
  setTimeout(() => {
    const m = document.querySelector('mark.hl[data-note="' + id + '"]');
    if (m) scroller.scrollTop += m.getBoundingClientRect().top - window.innerHeight * 0.3;
  }, 120);
}
$('#noteSearch').addEventListener('input', renderNotes);
$('#exportBtn').addEventListener('click', () => {
  const list = [...R.notes].sort((a, b) => a.ci - b.ci || a.start - b.start);
  if (!list.length) return toast('还没有笔记');
  let md = '# ' + R.meta.title + '\n' + (R.meta.author ? '\n' + R.meta.author + '\n' : '');
  let lastCi = -1;
  for (const n of list) {
    if (n.ci !== lastCi) { lastCi = n.ci; md += '\n## ' + (R.meta.chapName[n.ci] || ('第 ' + (n.ci + 1) + ' 节')) + '\n'; }
    md += '\n> ' + n.quote.replace(/\n+/g, '\n> ') + '\n';
    if (n.comment.trim()) md += '\n' + n.comment.trim() + '\n';
  }
  const blob = new Blob([md], {type: 'text/markdown;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = R.meta.title.replace(/[\/\\:*?"<>|]/g, '') + ' 笔记.md';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

/* ══════════ 目录 ══════════ */
function renderToc(){
  const box = $('#tocList');
  box.innerHTML = '';
  const cur = R._pos ? R._pos.ci : 0;
  R.meta.toc.forEach(t => {
    const b = document.createElement('button');
    b.className = 'tocItem' + (t.idx === cur ? ' cur' : '');
    b.dataset.depth = Math.min(1, t.depth);
    b.textContent = t.label;
    b.onclick = () => { closeSheet($('#tocSheet')); goChapter(t.idx, 0); };
    box.appendChild(b);
  });
  const c = box.querySelector('.cur');
  if (c) setTimeout(() => c.scrollIntoView({block: 'center'}), 30);
}

/* ══════════ 打开 / 关闭书 ══════════ */
async function openBook(rec){
  if (!rec.file) {
    if (!sb || !me || !rec.storagePath) return toast('这本书还没下载,请在原设备上先同步一次');
    toast('正在下载《' + rec.title + '》…');
    const {data, error} = await sb.storage.from('books').download(rec.storagePath);
    if (error) return toast('下载失败:' + error.message);
    rec.file = new File([data], rec.title + '.epub', {type: 'application/epub+zip'});
    try {
      const z = await JSZip.loadAsync(rec.file);
      const m = await parseEpub(z);
      if (m.coverHref && z.file(m.coverHref)) {
        const mt = Object.values(m.manifest).find(x => x.href === m.coverHref);
        rec.cover = new Blob([await z.file(m.coverHref).async('arraybuffer')], {type: (mt && mt.type) || 'image/jpeg'});
      }
    } catch {}
    await DB.put('books', rec);          // 只补文件,不动 updated,免得又推一遍
  }
  toast('正在打开…');
  try {
    R.zip = await JSZip.loadAsync(rec.file);
    R.meta = await parseEpub(R.zip);
  } catch (err) {
    console.error(err);
    return toast('这本书读不开，文件可能已损坏');
  }
  R.book = rec;
  R.notes = ((await DB.byBook('notes', rec.id)) || []).filter(n => !n.deleted);
  R.blobs.forEach(u => URL.revokeObjectURL(u)); R.blobs.clear();
  $('#bookTitle').textContent = R.meta.title;
  $('#library').hidden = true;
  $('#reader').hidden = false;
  $('#topBar').classList.remove('hide'); $('#botBar').classList.remove('hide');
  const pos = rec.pos || {ci: 0, ratio: 0};
  await goChapter(Math.min(pos.ci, R.meta.spine.length - 1), pos.ratio);
  lastY = scroller.scrollTop;
}
function closeBook(){
  ttsStop(); asStop();
  TTS.cache.clear();
  saveProgress();
  syncNow(true);
  R.blobs.forEach(u => URL.revokeObjectURL(u)); R.blobs.clear();
  pages.innerHTML = '';
  $('#reader').hidden = true;
  $('#library').hidden = false;
  R.book = null;
  renderShelf();
}
$('#backBtn').onclick = closeBook;
$('#tocBtn').onclick = () => { renderToc(); openSheet($('#tocSheet')); };
$('#noteBtn').onclick = () => { renderNotes(); openSheet($('#notesSheet')); };
$('#setBtn').onclick = () => openSheet($('#setSheet'));
window.addEventListener('popstate', () => {
  const open = document.querySelector('.sheet.open');
  if (open) { closeSheet(open); history.pushState(null, '', location.href); return; }
  if (!$('#reader').hidden) { closeBook(); history.pushState(null, '', location.href); }
});

/* ══════════ 书架 ══════════ */
async function renderShelf(){
  const books = (await DB.all('books') || []).filter(b => !b.deleted)
    .sort((a, b) => (b.readAt || b.added) - (a.readAt || a.added));
  const allNotes = (await DB.all('notes') || []).filter(n => !n.deleted);
  const box = $('#shelf');
  box.innerHTML = '';
  if (!books.length) {
    box.innerHTML = '<div class="empty">书架是空的。<br>点下面的按钮，选一个 EPUB 文件。</div>';
    return;
  }
  for (const b of books) {
    const row = document.createElement('div');
    row.className = 'bookRow' + (b.file ? '' : ' cloudOnly');
    const cov = document.createElement('div');
    cov.className = 'cover';
    if (b.cover) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(b.cover);
      img.style.cssText = 'width:100%;height:100%;object-fit:cover';
      cov.appendChild(img);
    } else cov.textContent = (b.title || '书')[0];
    const meta = document.createElement('div');
    meta.className = 'bookMeta';
    const t = document.createElement('b'); t.textContent = b.title;
    const a = document.createElement('span'); a.textContent = b.author || '　';
    const st = document.createElement('div'); st.className = 'stat';
    const n = allNotes.filter(x => x.bookId === b.id).length;
    const pct = b.pos ? Math.round(((b.pos.ci + b.pos.ratio) / Math.max(1, b.spineLen)) * 100) : 0;
    st.innerHTML = (b.file ? '读到 ' + pct + '%' : '云端 · 点按下载') + '　笔记 <i>' + n + '</i> 条';
    meta.append(t, a, st);
    const del = document.createElement('button');
    del.className = 'rowDel'; del.textContent = '⋯';
    del.onclick = async e => {
      e.stopPropagation();
      if (!confirm('删除《' + b.title + '》？笔记也会一起删掉。')) return;
      const now = Date.now();
      await DB.put('books', Object.assign(b, {deleted: true, updated: now, file: null, cover: null}));
      for (const x of allNotes.filter(x => x.bookId === b.id))
        await DB.put('notes', Object.assign(x, {deleted: true, updated: now}));
      if (sb && me && b.storagePath) sb.storage.from('books').remove([b.storagePath]).catch(() => {});
      renderShelf(); syncNow(true);
    };
    row.append(cov, meta, del);
    row.onclick = () => openBook(b);
    box.appendChild(row);
  }
}

$('#importBtn').onclick = () => $('#fileIn').click();
$('#fileIn').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  importFiles(files);
});
async function importFiles(files){
  for (const f of files) {
    try {
      toast('正在解析 ' + f.name);
      const zip = await JSZip.loadAsync(f);
      const m = await parseEpub(zip);
      let cover = null;
      if (m.coverHref && zip.file(m.coverHref)) {
        const mt = Object.values(m.manifest).find(x => x.href === m.coverHref);
        cover = new Blob([await zip.file(m.coverHref).async('arraybuffer')], {type: (mt && mt.type) || 'image/jpeg'});
      }
      const id = await fileHash(f);                  // 同一个文件在任何设备上都是同一个 id
      const old = await DB.get('books', id);
      await DB.put('books', Object.assign(old || {added: Date.now(), pos: {ci: 0, ratio: 0}}, {
        id, title: m.title, author: m.author, file: f, cover,
        spineLen: m.spine.length, readAt: Date.now(), updated: Date.now(), deleted: false
      }));
      toast(old ? '《' + m.title + '》已在书架上' : '已导入《' + m.title + '》');
    } catch (err) {
      console.error(err);
      toast(f.name + ' 解析失败，可能不是标准 EPUB');
    }
  }
  renderShelf();
  syncNow(true);
}

// 拖进来也能导入（桌面浏览器测试用）
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  if (!e.dataTransfer.files.length || $('#library').hidden) return;
  $('#fileIn').files = e.dataTransfer.files;
  $('#fileIn').dispatchEvent(new Event('change'));
});

/* ══════════ 版本 / 更新 ══════════ */
const APP_VERSION = '1.2.0';
const hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);

async function checkUpdate(){
  if (TAURI) return toast('桌面版更新要重新安装,见 README');
  if (!('serviceWorker' in navigator)) return toast('当前 v' + APP_VERSION);
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return toast('当前 v' + APP_VERSION);
  toast('正在检查…');
  try { await reg.update(); } catch { return toast('检查失败,看看网络'); }
  await new Promise(r => setTimeout(r, 1200));
  toast(reg.installing || reg.waiting ? '有新版本,退出重开就生效' : '已经是最新的 v' + APP_VERSION);
}
$('#checkUpd').onclick = checkUpdate;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('新版本已就绪,退出重开生效');   // 首次装 SW 不提示
  });
}

/* ══════════ 桌面端(Tauri) ══════════ */
const TAURI = !!(window.__TAURI__ && window.__TAURI__.core);
async function importPaths(paths){
  const out = [];
  for (const path of paths || []) {
    try {
      const buf = await window.__TAURI__.core.invoke('read_file', {path});
      out.push(new File([buf], path.split(/[\\/]/).pop(), {type: 'application/epub+zip'}));
    } catch (e) { console.error(e); toast('打不开 ' + path); }
  }
  if (out.length) await importFiles(out);
}
async function initDesktop(){
  if (!TAURI) return;
  document.documentElement.classList.add('desktop');
  try {
    await importPaths(await window.__TAURI__.core.invoke('opened_files'));
    window.__TAURI__.event.listen('open-epub', e => importPaths(e.payload));
  } catch (e) { console.error(e); }
}

/* 键盘:桌面上没有快捷键不像话 */
document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); return $('#fileIn').click(); }
  if (e.key === 'Escape') {
    const sh = document.querySelector('.sheet.open');
    if (sh) return closeSheet(sh);
    if (!$('#reader').hidden) return closeBook();
    return;
  }
  if ($('#reader').hidden || mod) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (TTS.on) return ttsToggle();
    if (AS.on) return asToggle();
    R._autoScroll = true;
    scroller.scrollBy({top: scroller.clientHeight * 0.85, behavior: 'smooth'});
  }
  else if (e.key.toLowerCase() === 'a') { e.preventDefault(); $('#autoBtn').click(); }
  else if ((e.key === '+' || e.key === '=') && AS.on) asSpeed(1);
  else if (e.key === '-' && AS.on) asSpeed(-1);
  else if (e.key === 'ArrowRight' && TTS.on) { e.preventDefault(); ttsStep(1); }
  else if (e.key === 'ArrowLeft'  && TTS.on) { e.preventDefault(); ttsStep(-1); }
  else if (e.key.toLowerCase() === 'r') $('#ttsBtn').click();
  else if (e.key.toLowerCase() === 't') $('#tocBtn').click();
  else if (e.key.toLowerCase() === 'n') $('#noteBtn').click();
});

/* ══════════ 启动 ══════════ */
(async () => {
  Object.assign(S, await kvGet('settings', {}) || {});
  applySettings();
  AS.lpm = await kvGet('asLpm', 24);
  TTS.rate = await kvGet('ttsRate', 1);
  TTS._savedVoice = await kvGet('ttsVoice', '');
  paintRate();
  await migrate();
  await renderShelf();
  await initSync();
  await initDesktop();
  history.pushState(null, '', location.href);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (!TAURI && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
// 旧版本的书用的是随机 id,换成文件哈希,笔记跟着改挂
async function migrate(){
  const books = (await DB.all('books')) || [];
  for (const b of books) {
    if (/^[0-9a-f]{32}$/.test(b.id) || !b.file) continue;
    const id = await fileHash(b.file);
    for (const n of ((await DB.byBook('notes', b.id)) || [])) {
      n.bookId = id; n.updated = n.updated || Date.now(); await DB.put('notes', n);
    }
    await DB.del('books', b.id);
    await DB.put('books', Object.assign(b, {id, updated: Date.now()}));
  }
  const cut = Date.now() - 90 * 864e5;                 // 三个月前的墓碑可以扔了
  for (const b of books) if (b.deleted && b.updated < cut) await DB.del('books', b.id);
  for (const n of (await DB.all('notes')) || []) if (n.deleted && n.updated < cut) await DB.del('notes', n.id);
}

window.addEventListener('pagehide', () => { saveProgress(); if (synth) synth.cancel(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { saveProgress(); syncNow(true); }
  else { if (me) syncNow(true); if (TTS.on || AS.on) keepAwake(true); }
});
