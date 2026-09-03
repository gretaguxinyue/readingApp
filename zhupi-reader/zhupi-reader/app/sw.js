/* 发版策略:
   - 会改的文件(index.html / app.js / manifest)走「网络优先」——联网时永远拿到最新的,
     断网才回落到缓存。这样以后改代码不用记得改这里的版本号。
   - 不怎么动的大件(vendor / icons)走「缓存优先」,快,也省流量。版本号变了才重新装。 */
const VERSION = 'zhupi-v4';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest',
               './vendor/jszip.min.js', './vendor/supabase.js',
               './icons/icon-192.png', './icons/icon-512.png'];
const STATIC = /\/(vendor|icons)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 只管自己的静态文件;Supabase 的请求一律放行,不缓存也不拦截
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (STATIC.test(url.pathname)) {                      // 缓存优先
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }

  e.respondWith(                                        // 网络优先
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
