# dsh-live-page

在 DSH 的 IDE 视图里，把工作区 HTML 当真实网页直接编辑：页面改动自动写回源文件。同时把 IDE 浏览器当前页面的标题/URL 注入侧边 AI 的运行时上下文，并把你选中的页面文本自动以引用形式放进 composer，等你提问。

不依赖也不修改工作区里原来的 `visual-editor` / `localhost:4173` 服务。

## 使用

### 1. 可视编辑本地 HTML

1. 在 IDE 视图打开任意工作区 HTML 文件（`.html/.htm/.xhtml/.shtml`）。
2. 两个入口：
   - 编辑器路径栏的 **页面编辑** 按钮（需要 `dsh-vscode-mode` 已重新构建并刷新页面）；
   - 快捷键 `Cmd/Ctrl+Shift+E`（可在 设置 → 快捷键 里改）。

   composer 输入框那一行**不再放按钮**：插件只在该插槽挂一个不可见的占位组件，用来拿当前会话 id 和官方的 `inputActions`（插入 selected-text 引用时用），不会渲染任何 UI。
3. 页面在 IDE 右侧栏的 **浏览器** tab 打开，**首屏直接是 `Edit: On`**（通过 `__live_edit=1` 一次性标记）；点 badge 可关成 `Edit: Off`。页内跳转到其它页面时默认只读，再点 badge 开启。
4. 点段落/标题/列表项直接改。停顿约 0.9 秒或点空白处自动保存；页面右上角显示 Saving/Saved。
5. 源码编辑器未保存时，磁盘变化会走它自己的外部改动同步；有未保存缓冲时会提示冲突。**先保存源码，再用页面编辑**。

### 3. AI 行内补全（IDE 风格）

在渲染页面里编辑时，光标停在段落文字末尾并停顿约 0.7 秒，会出现**灰色补全建议**（后接一个 `Tab` 小标签），与页面同字体、同字号：

| 操作 | 效果 |
| --- | --- |
| `Tab` | 接受建议，插入到光标处，随后自动保存 |
| `Esc` | 忽略当前建议（不退出编辑） |
| 继续输入 / 点击别处 / 滚动 | 建议自动消失 |

- 只在光标位于块内文字**末尾**时建议（这样灰色文字不会压住已有文字）；句中不补全。
- 上下文包含：页面标题、源文件、上一个块文本、当前块光标前的文本；模型按同一语言和语气续写一句。
- 路由自动挑「快且不思考」的模型：优先使用带 `off` 思考档的 `deepseek-flash`（实测约 0.8–1.5 秒），没有则回落到会话默认模型。
- 路由是一串候选，不只一个：某个 provider 的凭据过期或模型下线时自动换下一个（`ACCOUNT_TOKEN_INVALID`、401/403 这类都算）；内容为空、超时、解析失败不会换模型。换过之后整个进程都记住。
- 可用环境变量固定路由：`DSH_LIVE_PAGE_AI_PROVIDER` / `DSH_LIVE_PAGE_AI_MODEL` / `DSH_LIVE_PAGE_AI_EFFORT`。
- 诊断：`GET /live-page/ai-probe` 看可用 provider/model/思考档与最近一次补全结果；页面里 `window.__dshLivePageOverlay.completion` 看最近一次补全耗时与文本。

### 4. 选中文字按指令改写

在页面里拖选一段文字，可以跨标题、段落、列表项：

1. 松开鼠标后，选区上方出现 **AI 改写** 按钮。
2. 点按钮，在面板里写要改成什么（例如「更简洁」「译成中文」「语气更口语」），按 **改写**（或 `Cmd/Ctrl+Enter`）。
3. 模型按块返回替换内容，面板里逐块显示 **原文（删除线）→ 改写后**；确认无误再点 **应用替换**。
4. 应用后立即写回源 HTML，并在左下角保留 **撤销替换** 按钮 20 秒。

- 选区最多 12 个块；一次改写只替换选中的文字，块内其余文字和内联格式保持不变。
- 模型返回的空格边界会被保留，避免「发布日期and」这种中文粘英文的情况。
- 改写输出会经过客户端白名单和服务端 `sanitize`：不允许 script/iframe/on* 等可执行内容。
- 面板里的 **改指令重试** 可以换一句话重新生成，不会先动页面。
- 路由与行内补全共用：优先 `deepseek-flash`（`off` 思考），可用同一组环境变量固定。
- 诊断：`GET /live-page/ai-probe` 里的 `lastRewrite`；页面里 `window.__dshLivePageOverlay.rewrite`。

页面里的修改保存回源 HTML：

- 保存前自动备份到 `~/.dsh/dsh-live-page/backups/<workspace-hash>/`，每个文件保留最近 20 份。
- 定位不到、匹配到多处、块过大、包含 script/iframe/on* 等可执行内容时拒绝保存，源文件不变，页面显示错误。
- 外部（AI / 其他编辑器）改动源文件后，页面每 2 秒检查版本并自动刷新，不需要手动点刷新；只有页面里还有未保存的改动时，才显示「文件已更新」提示，避免覆盖正在输入的内容。编辑模式在刷新后保留（sessionStorage）。

### 2. 浏览器页面感知

- 在 IDE 官方浏览器打开任意 HTTP(S) 页面（本地页面或外网页面），侧边 AI 每一步都能看到当前页面标题/URL；本地 live 页面还会带源文件路径。
- 没有浏览器页面时，这段上下文自动消失，不会污染聊天记录。

### 3. 选中文本 → composer

- 在 IDE 浏览器页面里选中一段文字，约 0.5 秒后 composer 出现一条 selected-text 引用（quote）。
- 引用内容 = 选中文本 + 来源行（页面标题 + 本地文件路径或 URL）。
- 同一段文本不会反复插入；输入框忙时会提示。
- 桌面 Electron 下外网页面用 `<webview>` 读取选区和页面信息；Web GUI 下外网页面可以从地址栏/页签标题读到页面信息，但受浏览器跨域限制读不到选区；本地 live 页面通过 overlay `postMessage` 选区仍可用。
- 选中的是页面里正在编辑的 contenteditable/input 时不会触发，避免打断编辑。

## 安装

本插件是本地 link 包：

```bash
# 已在 ~/dsh-plugins/dsh-live-page
# 用 DSH 的插件管理器安装（不要手写 profile 的 package.json / cordis.patch.yml）
```

安装后它会作为 `dsh-live-page` bundle 出现在当前 profile。新 bundle 通常可 HMR 激活；Host 半未生效时重启 DSH。

配套的 `dsh-vscode-mode-fork` 按钮改动在 `src/client/ui/EditorView.ts`，改完需要：

```bash
cd ~/dsh-plugins/dsh-vscode-mode-fork
npm run typecheck && npm run build
```

然后刷新页面。插件不依赖这颗按钮，composer 按钮和快捷键仍可用。

## 架构

```
编辑器按钮 / composer 按钮 / 快捷键
        │  读当前 HTML 路径 + sessionId
        ▼
POST /live-page/open ──► Host 解析 cwd/path，起/复用 per-root live server
        │                          │ 返回带一次性 token 的 URL
        ▼                          ▼
ctx.sidebarRight.openTab('browser', {params:{url}})
        │
        ▼  token → Set-Cookie + 302 干净 URL → 注入 overlay
   官方浏览器 <webview> ── overlay 编辑 ──► POST /__live/save（cookie + Origin）
        │                                   └─► 定位/sanitize/备份/原子写
        │
        ├─ client 探测 webview URL/标题 ──► POST /live-page/report ──► systemPrompt.context
        └─ client 轮询选区 ──► composer insertQuote
```

- Host：`index.js` + `lib/`，只用 `node:` 内置模块。
- Client：`client.js`，plain JS `__ModuleLoader__`，只 require 浏览器模块表里的 React。
- Overlay：`assets/live/overlay.js` + `overlay.css`，注入到用户页面里的经典脚本（无构建）。

接口契约见 [CONTRACT.md](CONTRACT.md)。

## 路由

Host（DSH 同源）：`POST /live-page/open`、`GET /live-page/files`、`POST /live-page/report`、`GET /live-page/state`、`GET /live-page/servers`。

Live server（`127.0.0.1:<random>`）：`GET /<rel>?__live=<token>`、`GET /`（文件列表）、`GET /__live/overlay.js|css`、`POST /__live/save`、`POST /__live/complete`、`POST /__live/rewrite`、`GET /__live/version`。

## 安全模型

- live server 只绑 `127.0.0.1`，随机端口；路径 realpath 后必须仍在工作区内，拒绝符号链接逃逸、`..`、点目录和 `node_modules`。
- 保存需要 `dsh_live_<port>` cookie（`HttpOnly; SameSite=Strict`）+ 同源 `Origin` + 该文件确实通过页面编辑打开过（armed）。
- 页面里的 overlay 只发送文本和块 HTML；服务端重新定位、净化并限制大小，不信任客户端路径。
- 仅服务工作区文件；不代理外网页面。

## 限制

- 已支持跨块选区与按指令改写；跨块合并/删除结构、富文本工具栏、图片/链接插入仍不在范围。
- 不迁移旧 visual-editor 的 Cursor AI 改写弹窗、LanguageTool 拼写检查、region 编辑。
- Web GUI 的外网页面只能读页面信息，不能读选区（浏览器跨域限制）。
- 页面自身带 CSP **响应头**时 overlay 可能不执行；服务端会剥掉 CSP meta，但 HTTP header 无法在页面内移除。
- 每次点「页面编辑」会新开一个官方浏览器 tab（浏览器 tab 是 `multiple: true`）；可手动关闭旧 tab。
- live 页面地址是随机端口的 loopback URL；重启 DSH 后需重新从按钮打开。
- 常量在 `client.js` / `lib/` 顶部，暂未做设置页：`AUTO_QUOTE`、`MIN_SELECTION_CHARS`、`MAX_QUOTE_CHARS`、`PAGE_TTL_MS`、`BACKUP_KEEP_PER_FILE` 等。

## 诊断

- `curl http://127.0.0.1:50508/live-page/state?sessionId=<sid>`：当前页面快照、将注入模型的文本、live server 列表。
- 浏览器控制台：`window.__dshLivePageDebug`（client：最近页面/上报/引用/错误）与 `window.__dshLivePageOverlay`（overlay：编辑态/最近保存/改写状态/错误）。
- 插件日志会以 `dsh-live-page:` 前缀输出 live server 异常。

## 开发

```bash
cd ~/dsh-plugins/dsh-live-page
npm run check
npm test
```

- `tests/paths.test.mjs`、`patch.test.mjs`、`context.test.mjs`、`files.test.mjs`：Host 纯函数。
- `tests/liveSite.test.mjs`：真实 loopback 服务的 token/注入/保存/版本/穿越/补全/改写。
- `tests/completion.test.mjs`、`tests/rewrite.test.mjs`：补全与改写的校验、提示词、清洗、解析。
- `tests/host.test.mjs`：Host 路由与 prompt context。
- `tests/client.test.mjs`：Client 纯函数与注册（node:vm 沙箱）。
