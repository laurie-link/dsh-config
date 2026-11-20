# dsh-live-page 内部契约（host / client / overlay 共用）

本文件是三个半侧的唯一接口事实源。改接口先改这里，再改实现与测试。

## 1. 角色

- **Host**（`index.js` + `lib/`）：DSH Host 进程。提供 `/live-page/*` 同源路由，按工作区起 `127.0.0.1` 随机端口的 live 静态服务，做保存/备份/页面快照/模型上下文。
- **Client**（`client.js`）：浏览器半，plain JS `__ModuleLoader__.load`。监听编辑器路径栏按钮事件与快捷键（composer 只挂不可见占位组件，用来取 sessionId 与 `inputActions`）；打开 live 页面；探测 IDE 官方浏览器 webview；上报页面；把选区插进 composer。
- **Overlay**（`assets/live/overlay.js` + `overlay.css`）：注入到被编辑页面里的脚本，做 contenteditable 直接编辑、保存、版本轮询、选区 postMessage。

## 2. Host 路由（DSH Host origin，同源 fetch）

所有响应 JSON：`{ok:true,...}` 或 `{ok:false,error}`。请求体上限 256KB。

### POST /live-page/open

请求：
```json
{ "sessionId": "session-...", "path": "pokemon-go/foo.html" }
```
`path` 可省略；省略时返回工作区 HTML 文件列表页地址。

响应：
```json
{ "ok": true, "url": "http://127.0.0.1:54321/pokemon-go/foo.html?__live=<token>&__live_edit=1",
  "file": "pokemon-go/foo.html", "title": "foo.html", "port": 54321,
  "nonce": "<per-server 32 hex>" }
```
- 只接受工作区内、后缀 `.html|.htm|.xhtml|.shtml` 的普通文件。
- 文件必须是普通文件、realpath 后仍在会话 cwd 内。

### GET /live-page/files?sessionId=

响应：
```json
{ "ok": true, "root": "/abs/workspace", "files": [{ "path": "a/b.html", "rel": "a/b.html" }], "truncated": false }
```
- 递归枚举工作区 HTML；忽略 `node_modules`、`.git`、`.svn`、`dist`、`build`、`.next`、`out`、`.venv`、`vendor`、`.cache`、`coverage`。
- 最多 1000 个，深度最多 8；10 秒缓存。

### POST /live-page/report

请求：
```json
{ "sessionId": "session-...",
  "page": { "url": "http://...", "title": "Page title", "kind": "browser" } }
```
- `page` 为 `null` 表示清除该会话页面。
- `kind` 由 client 传 `browser`；host 若命中 live server origin，会规范化为 `live` 并补 `file`。
- 响应 `{ok:true}`。

### GET /live-page/state?sessionId=

诊断：
```json
{ "ok": true, "page": { ... } | null, "text": "...prompt 文本...",
  "servers": [{ "port": 54321, "origin": "http://127.0.0.1:54321", "root": "/abs/workspace" }],
  "quotes": 0, "at": 169... }
```

### GET /live-page/servers

```json
{ "ok": true, "servers": [{ "port": 54321, "origin": "http://127.0.0.1:54321", "root": "/abs/workspace", "nonce": "<per-server 32 hex>" }] }
```

## 3. Live server 路由（127.0.0.1:随机端口）

每个工作区根一个服务。cookie 名 `dsh_live_<port>`，值 `token`；`HttpOnly; Path=/; SameSite=Strict`。

### GET /<rel>?__live=<token>

- token 匹配：`Set-Cookie` + `302 Location: /<rel>`（去掉 `__live`；若带 `__live_edit=1` 则保留为 `?__live_edit=1`）。overlay 读到后直接 `setEnabled(true)` 并把该 query 从地址栏抹掉，实现「点页面编辑后首屏即可编辑」。
- 无 token 但有对应 cookie：正常服务页面；HTML 注入 overlay 并 arm。
- 无 token 且无 cookie：服务页面但不注入（只读）。
- token 不匹配：403。

### GET /

有 cookie 时生成「工作区 HTML 文件列表」页（自带搜索框，链接 `/<rel>`）；否则 403 提示从 IDE 按钮打开。

### GET /__live/overlay.js、/__live/overlay.css

返回 overlay 资源（`no-store`）。无 cookie 也可取（内容不含敏感数据）。

### POST /__live/save

必须：对应 cookie 正确 + `Origin === http://127.0.0.1:<port>`（缺失 Origin 时要求 cookie）+ 目标文件已 arm。

请求：
```json
{ "file": "pokemon-go/foo.html", "tag": "p",
  "text": "normalized original text",
  "outerHTML": "<p>...</p>",
  "newOuterHTML": "<p>...</p>",
  "selectorPath": "div > p:nth-of-type(3)",
  "anchor": "#optional-heading-id" }
```
- `newOuterHTML === ""` 表示删除该块。
- 响应成功：`{ "ok": true, "file": "...", "method": "outerHTML-exact|outerHTML-normalized|text-fingerprint", "version": "mtimeMs:size", "backup": "/abs/backup.html" }`
- 失败：HTTP 400/403/404/409/413 + `{ "ok": false, "error": "可读中文", "code": "..." }`；409 用于「找不到/不唯一/源文件已变化」。

### POST /__live/complete

必须：对应 cookie 正确 + 同源 `Origin`。请求体上限 64KB；同一时刻只跑一个补全（忙时返回 `{ok:true,text:"",note:"busy"}`）。

请求：
```json
{ "file": "pokemon-go/foo.html", "title": "页面标题", "tag": "p",
  "before": "上一个块的文本（可空）", "prefix": "光标前的块文本", "suffix": "" }
```
- `prefix` 去空白后至少 3 个字符；`suffix` 非空时 overlay 不会发起请求（避免压住已有文字）。

响应：`{ "ok": true, "text": "续写文本", "note?": "...", "ms": 1234, "route": "deepseek-account/deepseek-flash[off]" }`

### POST /__live/rewrite

必须：对应 cookie 正确 + 同源 `Origin` + 目标文件已 arm。请求体上限 256KB；同一时刻只跑一个改写（忙时返回 `{ok:false,blocks:[],note:"上一条改写还在进行中，请稍后再试"}`）。

请求：
```json
{ "file": "pokemon-go/foo.html", "title": "页面标题",
  "before": "选区前最后约 600 字", "after": "选区后最初约 600 字",
  "instruction": "改成更简洁的英文",
  "blocks": [{ "text": "块完整文本", "start": 10, "end": 24, "tag": "p" }] }
```
- `blocks` 1–12 个；`start < end` 且都在 `text` 范围内；`instruction` 去空白后至少 2 字。
- 服务端把 `file` 规范化为相对路径，再调用 `rewriteText`。

响应：
```json
{ "ok": true, "blocks": [{ "index": 0, "html": "替换后的内联 HTML" }],
  "note?": "...", "ms": 1200, "route": "deepseek-account/deepseek-flash[off]" }
```
- 每个请求块恰好返回一个 `index`，无多余/重复；`html` 只允许内联标签，不能含 script/iframe/img/on*/块级标签。
- `route` 是最终真正产出结果的 provider/model；路由按候选顺序解析，遇到凭据/路由类失败（`ACCOUNT_TOKEN_INVALID`、`invalid dsh token`、401/403、provider/model not found）换下一个候选重试，最多 3 个；空回复、超时、解析失败不换模型。
- 失败：400/403/404/409/413 + `{ "ok": false, "error": "可读中文", "code": "..." }`。

### GET /__live/version?file=<rel>

必须 cookie 正确。响应 `{ "ok": true, "version": "mtimeMs:size" }`。

### 页面注入片段

在 `</body>` 前插入：
```html
<link rel="stylesheet" href="/__live/overlay.css">
<script id="dsh-live-overlay" src="/__live/overlay.js" defer
        data-file="pokemon-go/foo.html"
        data-version="1730000000000:12345"
        data-title="页面标题"
        data-nonce="<per-server 32 hex>"></script>
```
- 注入时剥掉页面自身的 `<meta http-equiv="Content-Security-Policy" ...>`。
- 目录请求解析到 `index.html` 时，`data-file` 是 `sub/index.html`，不是 `/sub/`。

## 4. Overlay ↔ Client（仅 Web GUI 本地页面选区路径）

Overlay 在非编辑状态、选区稳定 400ms、文本长度 ≥2 时：
```js
window.parent.postMessage({
  type: 'dsh-live-selection',
  nonce: '<data-nonce>',
  text: '<selection.toString()>',
  url: location.href,
  title: document.title,
  file: '<data-file>'
}, '*')
```
Client 校验：`event.origin` 在 `/live-page/servers` 的 origin 集合内，且 `nonce` 与已知 live nonce 匹配（未知时先拉一次 servers，仍不匹配丢弃）。

桌面 webview 不依赖这条消息；client 用 `executeJavaScript` 轮询选区。

### 选区改写（overlay 内部）

- `mousedown` 先退出当前 contenteditable 块，让浏览器原生拖选可以跨块；`mouseup` 未拖动时才重新进入块编辑，拖动则保留选区并显示「AI 改写」。
- 选区稳定 140ms 后计算快照：最多 12 个块，每块 `{el,text,start,end,tag,range}`；点击按钮时保存快照，面板打开后就不再依赖当前 selection。
- 改写结果按块 index 匹配；应用前校验 `el.isConnected && el.textContent === block.text`，有一块不匹配就拒绝整次应用。
- 应用时逐块 `range.deleteContents()` + 白名单 fragment 插入；保留选区首尾空白边界；应用后立即 `POST /__live/save`，20 秒内可撤销并再次保存。

## 5. Client ↔ Fork

Fork 的工具栏按钮点击：
```js
window.dispatchEvent(new CustomEvent('dsh-live:open', { detail: { path: active } }))
```
Client 在 apply 时设置 `window.__dshLivePageReady = true`；fork 仅在该标志为 true 时显示按钮。

## 6. 常量（v1 代码常量，README 说明）

| 名称 | 值 |
|---|---|
| `MIN_SELECTION_CHARS` | 2 |
| `MAX_QUOTE_CHARS` | 8000 |
| `SELECTION_POLL_MS` | 400 |
| `SELECTION_DEBOUNCE_MS` | 450 |
| `PAGE_POLL_MS` | 700 |
| `PAGE_REPORT_REFRESH_MS` | 5 分钟 |
| `PAGE_TTL_MS` | 30 分钟 |
| `AUTO_QUOTE` | true |
| `QUOTE_SOURCE` | true（引用尾部附 `— from <title> (<file 或 url>)`） |
| `MAX_HTML_FILES` | 1000 |
| `BACKUP_KEEP_PER_FILE` | 20 |
| `MAX_REWRITE_BLOCKS` | 12 |
| `MAX_INSTRUCTION_CHARS` | 2000 |
| `MAX_REWRITE_TOTAL_CHARS` | 24000 |
| `REWRITE_TIMEOUT_MS` | 22000 |
| `REWRITE_UNDO_MS` | 20000 |

## 7. 调试

- `window.__dshLivePageDebug = { probes, errors, lastPage, lastReport, lastQuote, quotes }`
- `window.__dshLivePageOverlay.rewrite`：`{open,pending,blocks,result,status,error}`
- Host 诊断：`curl http://127.0.0.1:<dsh-port>/live-page/state?sessionId=...`；`/live-page/ai-probe` 含 `lastCompletion` / `lastRewrite`。
