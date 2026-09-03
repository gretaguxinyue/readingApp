# 朱批 · 手机读书笔记

一个纯前端的 EPUB 阅读器,装到手机主屏就是个 App。默认书和笔记都只存在本机(IndexedDB);想跨设备,配一下 Supabase,见下面的「多设备同步」。

## 部署

**Netlify**(和你仓库管理那套一样):把整个文件夹拖进 Netlify 的 Deploys 页面就行,秒上线。
或者 GitHub Pages、Vercel,任何能托管静态文件的地方都行。

必须走 **HTTPS**(或 localhost),否则 Service Worker 和剪贴板不工作。

本地试:

```bash
cd app && python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

装到手机:用 Safari / Chrome 打开网址 → 分享 → 添加到主屏幕。

## 用法

- **导入**:书架页点「导入 EPUB」,从文件 App / 网盘里选 `.epub`。可多选。
- **读**:一路下滑,章节自动接上;向上滑会把上一章补回来。下滑时上下栏自动隐藏。
- **听**:底栏「朗读」,或长按选中后「从这儿读」。
- **自动划屏**:底栏「自动」,页面匀速往上走。播放条上的滑杆随时调速,正文上轻点一下暂停/继续。
- **目录**:顶部「目录」,支持两级。
- **记笔记**:长按选中一段话 → 点「记笔记」→ 原文自动进笔记本,光标落在感悟框里。
- **改笔记**:点正文里的朱红下划线,或在笔记本里点任意一条。原文和感悟都能改。
- **导出**:笔记本右上「导出」,生成 Markdown,按章节分组,原文用引用块,感悟跟在下面。
- **返回键**:安卓的返回键 = 关抽屉 → 回书架。

## 多设备同步

默认所有数据都在本机的 IndexedDB 里,**换个设备就是一张白纸**——浏览器不会把一台手机的本地数据带到另一台。要跨设备,得有个后端。

用你已经在跑的 Supabase:

1. 控制台 → SQL Editor,把 `supabase-schema.sql` 整个粘进去跑一次(建两张表 + RLS + 一个私有的 `books` 桶)。
2. Settings → API,复制 Project URL 和 anon key,填到 `index.html` 顶部这两行:

   ```js
   const SUPABASE_URL      = 'https://xxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGci...';
   ```

   anon key 是设计上就要公开的,RLS 保证每个人只看得到自己的行。
3. Authentication → Providers → Email,把 **Confirm email** 关掉(不然注册后还要去邮箱点链接)。
4. 重新部署。书架顶部会出现同步条,点开注册一个账号;在第二台设备上用同一个账号登录。

同步什么时候跑:登录后、导入新书后、退出某本书时、切到后台时、保存或删除笔记后、以及重新联网时。也可以点同步条手动触发。

### 几个设计上的选择

**书的身份是文件内容的哈希**(SHA-256 前 32 位),不是随机 ID。所以同一个 EPUB 不管在哪台设备导入,`book_id` 都一样,笔记自然挂得上;同一本书重复导入也不会在书架上出现两次。旧版本导入的书首次启动时会自动改用哈希 ID,笔记跟着改挂。

**EPUB 原文件按需下载**。同步只传元数据,第二台设备的书架上会看到「云端 · 点按下载」,点了才把文件拉下来。省流量,也避免手机被几百 MB 的书塞满。

**冲突用最后写入者胜**,按 `updated_at` 比。一个人用不会有真冲突;唯一会互相盖的是阅读进度——两台设备同时读同一本,后放下的那台说了算。

**删除是墓碑不是真删**,不然离线的那台设备再上线时会把删掉的东西又推回来。墓碑存三个月自动清理。

如果不想上后端,笔记本里的「导出」生成的 Markdown 就是最轻的方案:另一台设备上重新导入同一个 EPUB,笔记单独存。缺点是笔记不会变成可点的高亮。

## 自动划屏

底栏「自动」开始匀速滚动。播放条上直接是一根滑杆,边滚边拖,快慢当场就能感觉到——这种连续量本来就该用手调,不该用数字调,所以没有读数。「Aa → 自动划屏速度」里有同一根滑杆,两边同步。

内部单位仍是**行/分钟**而不是像素/秒,这样换字号行距不用重调:同样的档位,18px 和 24px 下的阅读节奏一样。滑杆到行数走的是幂曲线(指数 1.8),因为常用的慢速段挤在低位,线性映射的话前两成行程就把好用的区间走完了。范围 8~100 行/分,一屏大约 174 秒到 14 秒。

自动停下来的时机:长按选中文字时(不然字会从手指底下跑掉)、打开任何抽屉时、切后台时。松开选中或关掉抽屉自动接着走。手动滑动不会打断,滚到哪儿就从哪儿继续。读到全书最后一屏自动停。

实现上是 `requestAnimationFrame` 里累加小数位置再写回 `scrollTop`,不是整数步进——低速下整数步进每秒只跳十几次,看得出来一格一格的。单帧 `dt` 截在 0.1 秒,所以切后台再回来不会一下蹦出去几屏。

朗读和自动划屏互斥:开一个会关掉另一个。朗读本来就带跟读滚动,两个一起跑只会打架。

## 朗读

底栏「朗读」从当前屏幕最上面那句开始读,底栏变成播放条(上一句 / 暂停 / 下一句 / 语速 / 停)。也可以长按选中一段 → 「从这儿读」,从指定位置开始。读到章尾会自动接下一章。

正在读的那句会高亮,页面跟着走;你手动滚了之后五秒内不抢你的滚动条。手机上会申请 wake lock,不让屏幕黑掉。

倍速是固定档位:1× / 1.5× / 2× / 2.5× / 3× / 4×。播放条上那个按钮点一下跳下一档,「Aa → 朗读倍速」里可以直接选。2.5× 往上很多语音会开始糊,这是语音包本身的限制,`SpeechSynthesisUtterance.rate` 调不出更好的结果。

划屏用滑杆、朗读用档位,是故意做成两种控件的:倍速是相对基准语速的乘数,离散的档位才有意义;划屏是每秒滚多少像素,连续的物理量,滑杆才对。两者不是一回事,也就不该长得一样。

声音在「Aa → 朗读声音」里选,会记住。语音包用的是系统的:

- **macOS** 系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音,中文找「婷婷」「Sinji」。
- **Windows** 设置 → 时间和语言 → 语音 → 添加声音,Win11 的「晓晓」「云希」是神经网络音,明显好过老的 Huihui。
- **Linux** WebKitGTK 基本没实现 `speechSynthesis`,这个功能在 Linux 桌面端用不了。

### 两个绕不开的坑

**句子是自己切的**,不是把整章丢给 `speak()`。Chrome 对长文本会静默截断,而且逐句才能做高亮和「上一句」。切句规则:中英文终止符 + 闭引号,英文句号会避开小数点,超过 220 字没标点就强行断。

**Chrome 系每十几秒会自己停**,是个陈年 bug。代码里每 9 秒 `pause()` 再 `resume()` 戳一下,只在 Chromium 内核下开——Safari 上这么干反而会卡顿。

## 桌面端

### 最省事:直接装 PWA

Chrome / Edge 打开网址 → 地址栏右边的安装图标 → 装好就是独立窗口,有自己的图标和任务栏项,没有浏览器地址栏。改代码重新部署就自动更新。**如果只是想要个桌面窗口,到这里就够了。**

### 想要真正的 .app / .exe:Tauri

`desktop/` 是配好的 Tauri v2 工程,前端直接指向 `app/`,不用打包不用改代码。比 Electron 小一个数量级(装好 10~15MB,Electron 要 150MB+),因为它用系统自带的 WebView 而不是塞一个 Chromium 进去。

准备一次:

```bash
# Rust 工具链
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --version "^2.0"

# 系统依赖:macOS 装 Xcode Command Line Tools;
# Windows 装 WebView2 Runtime(Win11 自带);
# Linux 需要 libwebkit2gtk-4.1-dev、build-essential、libssl-dev 等

# 生成全套图标(必须,macOS 的 .icns 只能这样出)
cd desktop && cargo tauri icon icon-source.png
```

跑起来 / 打包:

```bash
cd desktop
cargo tauri dev      # 开发,热更新
cargo tauri build    # 出安装包,在 src-tauri/target/release/bundle/
```

装完之后 `.epub` 会跟朱批关联,Finder / 资源管理器里双击就能打开——Rust 那边把文件字节通过 `ipc::Response` 交给前端,走的是二进制通道而不是 JSON,几十 MB 的书也不会卡。

桌面上的快捷键:空格播放/暂停(都没开时是翻页)、`A` 自动划屏、`+` `-` 划屏调速、← → 朗读上下一句、`R` 朗读、`T` 目录、`N` 笔记、`Esc` 返回、`Cmd/Ctrl+O` 导入。

### 几个配置上的讲究

`tauri.conf.json` 里的 CSP 是收紧过的:`script-src 'self'`,所以 JS 从 `index.html` 里抽到了 `app.js`。书本身的 XHTML 会被注入进 DOM,虽然解析时已经剥掉了 `<script>`,但多一道 CSP 兜底不亏。`connect-src` 放行了 `*.supabase.co`,同步照常。

`dragDropEnabled: false` 是故意的——Tauri 默认会截获文件拖放并只给你路径,关掉之后 WebView 自己处理,现有的拖拽导入代码原样能用。

Tauri 用的是自定义协议,Service Worker 注册不了,所以代码里检测到 `__TAURI__` 就跳过——桌面端文件本来就在本地,不需要离线缓存。

## 更新

纯静态站,所以**要重新部署**。但光重新部署还不够——Service Worker 会把旧版本一直喂给你,这是最容易踩的坑。

### 部署

一次性接上 Git,以后就不用再拖文件夹了:

```bash
git init && git add . && git commit -m "朱批"
git remote add origin git@github.com:你/zhupi.git && git push -u origin main
```

Netlify → Add new site → Import an existing project → 选这个仓库。仓库根目录有 `netlify.toml`,它已经写死了 `publish = "app"`,面板里什么都不用填。之后 `git push` 就自动上线。

要是继续手拖:把 **`app` 文件夹本身**拖到 Netlify 的 Deploys 页面,不是外层那个。

### 部署完是 Page not found

九成是 **publish 目录指错了**。Netlify 默认发布仓库根目录,而根目录里没有 `index.html`(它在 `app/` 里),于是根路径就是 404。

- 根目录放上 `netlify.toml` 最省事,它比面板设置优先。
- 手动改的话:Site configuration → Build & deploy → Build settings,**Publish directory** 填 `app`,**Base directory 留空**。这两个都填 `app` 是最常见的错法——Netlify 会把 publish 当成 base 的相对路径,变成 `app/app`,照样 404。
- 改完要点 **Trigger deploy → Clear cache and deploy site**,改配置不会自动重新发布。
- 验证:Deploys → 点开这次部署 → Deploy log,末尾会列出上传了哪些文件,`index.html` 必须在列表里且路径不带前缀。

### 为什么改了代码手机上还是旧的

Service Worker 的更新链条是:浏览器发现 `sw.js` 的**字节变了** → 装新的 → 清旧缓存。原来那版是「缓存优先」,`sw.js` 内容不变就不会重装,于是新的 `app.js` 永远送不到设备上——除非每次发版都记得改一下里面的版本号。

现在改成了分两档:

- `index.html` / `app.js` / `manifest`:**网络优先**,联网时永远拿最新的,断网才回落缓存。以后改代码不用再动 `sw.js`。
- `vendor/` 和 `icons/`:**缓存优先**,大而不常动,快也省流量。换了 jszip 或 supabase-js 才需要把 `sw.js` 里的 `VERSION` 加一。

配套的 `_headers` 文件告诉 Netlify 别缓存 `sw.js` 本身。这个文件必须跟 `index.html` 平级,也就是在 `app/` 里。

### 确认新版本到了没

「Aa → 版本」那一行显示当前版本号,旁边「检查更新」会主动拉一次 `sw.js`。装成 PWA 的话,**退出重开**才生效(SW 接管了,但页面上跑的还是加载时的旧代码)。彻底重来:iOS 长按图标删掉重装,Chrome 在 设置 → 网站设置 → 清除数据。

以后改代码记得把 `app.js` 顶部的 `APP_VERSION` 也加一,不然这行读数会骗你。

### 数据会不会丢

不会。书、笔记、进度都在 IndexedDB,重新部署只换代码,不碰数据。配了 Supabase 的话就更稳,本地被清了也能拉回来。

### 桌面版是另一回事

Netlify 重新部署跟已经装好的 `.app` / `.exe` 没关系——Tauri 把前端打进了安装包。改了代码要 `cargo tauri build` 重新出包再装一次。想做成自动更新,加 Tauri 的 updater 插件,需要签名密钥和一个放 manifest 的地方(GitHub Releases 就行)。

## 文件

```
index.html            界面结构和样式
app.js                全部逻辑
sw.js                 离线缓存 + 更新策略(仅网页端)
_headers              Netlify 的缓存头
manifest.webmanifest  PWA 配置(名字、图标、主题色)
icons/                图标
vendor/jszip.min.js   解压 EPUB 用
vendor/supabase.js    同步用
supabase-schema.sql   建表脚本
desktop/              Tauri 桌面端工程
```

两个依赖都已经本地化,不走 CDN,断网也能读。

## 几个技术点

**笔记锚点**不用 EPUB CFI,而是「章序号 + 该章纯文本里的字符区间」。重新打开时按区间遍历文本节点、用 `<mark>` 包住命中片段,不改动文本内容,所以偏移永远有效。代价是同一本书换了个版本(文本变了)锚点会漂。

**内存**:同时最多渲染 8 章,超了就从另一头卸掉并补偿 `scrollTop`,所以几千页的书也不会卡。

**书自带的 CSS 会被剥掉**(字体、字号、颜色、行高、缩进),统一交给阅读设置,避免各家排版打架。居中、加粗这类保留。

**存储**:书的原始文件、封面、笔记、进度都在 IndexedDB。启动时会申请 `navigator.storage.persist()`,减少被 iOS 清理的概率。配了 Supabase 之后,本地被清了也能从云端拉回来。

## 想再加点什么

- 全文搜索:在 `parseEpub` 之后把每章 `textContent` 建个倒排,几十行的事。
- 字体:想用思源宋体就把 woff2 放进 `fonts/`,在 `--serif` 最前面加上,顺手写进 `sw.js` 的 `SHELL` 数组。
