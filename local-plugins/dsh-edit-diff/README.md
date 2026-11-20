# dsh-edit-diff

把 DSH 对话里「改文件」的工具行换成 Cursor 那样的 diff 卡片：直接看见红绿增删行和行号，点一下就在 IDE 视图打开这个文件、跳到改动所在行。

## 它替换了什么

DSH 内置的文件改动行只显示一行摘要（`写入 xxx.md 4KB +117 −0`），要再点开才看到内容，而且点开的是右侧栏的编辑器。本插件抢下 `tool.call.toolview` 的三个座位（`edit` / `write` / `apply_patch`），改用自己画的行：

- 头部一行：铅笔图标 + 动作（编辑／写入／新建） + 文件名 + 目录（cwd 相对化、home 显示 `~`） + `+N −M`
- 正文：逐行 diff，左边行号、中间 `+`/`−`、右边等宽文本；增行绿底、删行红底、未改动的行留 1 行上下文，超过 10 行折叠成「展开全部 N 行」
- 流式阶段（工具还没结果）也能显示：参数一到位就先按意图 diff 画出来，标题显示「正在编辑…」
- 出错时头部保留，正文换成错误首行
- 点头部或任意文件标题：优先请 dsh-cursor-layout 切到 IDE 视图、在文件编辑区打开并跳行；没有 vscode-mode 时退回官方 `openFile`（开右侧栏）

## 行号是怎么来的

工具结果的 `meta.diffs` 不带行号，所以行号是反推的：宿主半开了个只读路由 `GET /edit-diff/file?path=…` 读文件文本，客户端先拿整块新文本在文件里找位置；找不到（比如编辑还没落盘、或之后又被改过）就退一步，用 diff 里最长的一段未改动行当锚点，用锚点位置减去它在块内前面有几行，算出这一块的第一行。定不到位置时卡片照常画，只是不显示行号。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：注册 `/edit-diff/file` 读文件文本（512KB 截断、二进制跳过），外加 `/edit-diff/ping`、`/edit-diff/env` 诊断路由 |
| `client.js` | 浏览器半：注册三个工具行座位、diff 计算与渲染、CSS |
| `cordis.patch.yml` | 宿主插件插入声明 |
| `preview.html` | 离线预览页：自带极简 React 渲染器，用假数据渲染卡片，改样式时先在这里看效果 |

## 调试

- `curl 'http://127.0.0.1:58896/edit-diff/file?path=<urlencoded 绝对路径>'` 看路由是否正常。
- `~/.dsh/logs/dsh-edit-diff.log`：客户端每次挂载、以及几拍心跳都会记一行，用来确认浏览器半到底有没有跑起来。
- 浏览器控制台里 `window.__dshEditDiff.debug` 暴露了 `diffOps` / `linesOf` / `locateNewStart` / `layoutFiles` 等纯函数，方便排查定位问题。
- 改 `client.js` 后 `touch` 一下即可：`dsh-client-hmr` 约 3 秒内重新 apply（日志会出现新的 `event=apply`），不用重启；**新增**的工具行座位要等到下次刷新页面/重启才进页面。改 `index.js` 只要动一下 `~/.dsh/profiles/desktop/cordis.patch.yml` 就会热重载。

## 已知问题

- 点击卡片会切到 IDE 视图并打开文件，但「精确落到改动那一行」依赖 dsh-vscode-mode 的晚到定位（编辑器 Monaco 未就绪时首次跳转只开到文件、停在 1:1）。桥接里已把 `edrv:open-editor` 的派发重试放宽到 `[0,150,500,1200,2000,3000]ms`，仍在实测中。

## 预览

```bash
open ~/dsh-plugins/dsh-edit-diff/preview.html
```
