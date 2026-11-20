# dsh-editor-context

让 DSH 像 Cursor 一样知道自己正在看哪个文件。浏览器半观察 vscode-mode 的编辑器
页签与 Monaco 状态，把「当前活动文件 / 打开的页签 / 选区」以去抖方式 POST 到本机
Host；Host 在每个 Agent 创建时把这份状态注册成该 Agent 的**运行时上下文**（system
prompt 的一部分）。模型每一步都能看到它，聊天记录里不会出现任何消息。

## 安装

纯 JS 双半插件，无构建步骤、无 npm 依赖。

1. 在 DSH profile 的 `package.json` 里加依赖与 bundle（devtest/桌面 profile 由 Lead 维护）：

   ```json
   {
     "dependencies": { "dsh-editor-context": "link:/Users/laruielaurence/dsh-plugins/dsh-editor-context" },
     "dsh": { "profile": { "bundles": ["dsh-editor-context"] } }
   }
   ```

2. `pnpm install`。
3. Host 半改动需要重启 DSH；只改 `client.js` 时刷新页面即可（devtest 实例端口见
   `/tmp/devtest-url.txt`）。

## 行为

### client（浏览器半，`client.js`）

- 状态去抖 300ms 后上报，只有内容变化才发；内容长时间不变时每 5 分钟重发一次，避免
  Host 端 TTL 把仍然有效的快照判过期。
- **活动文件**判定顺序（点击页签切换后编辑器不一定重新获得焦点）：
  1. edrv 活动页签的 `data-edrv-tab-path` 对应到 Monaco 模型/编辑器 → 活动文本文件
     （带语言/选区/光标）；对应不到（计划/差异页签）→ 继续看第 2 步。分屏时优先
     聚焦分屏（`.edrv-group-focused`）里的活动页签。
  2. 否则看**官方右侧栏（side card）的活动 pane**（`[data-dockkit-pane-active]` /
     `[data-dockkit-float-active]`，取最后一个可见的）：
     - dsh-workbench-sheets 表格页签正文的 `data-workbench-sheets-path`
       （可选 `data-workbench-sheets-address` / `-kind`）→
       `active: { path, source: 'sheet' }`；
     - 官方 documentpreview 的 `data-textpreview-url`（文本/PDF/Word/PPT 同一属性）→
       `active: { path, source: 'preview' }`。
     地址按官方 `dsh-resource://file/…` 语法解析（session 域带 sessionId，absolute 域是绝对路径）。
  3. 都没有 → `active:null`（非文本 edrv 页签仍会标在打开列表里）。

  优先级补充：用户**焦点在官方侧栏**（`document.activeElement` 落在
  `[data-sidebar-right-session]` 内）或 **edrv 编辑器不可见**时，第 2 步优先于第 1 步
  ——刚点开的表格/预览页签会立即成为活动文件；点回编辑器后恢复文本文件。页签切换瞬间
  用 8 秒新鲜度窗口兜住「model 还没建好」的一两个报告，过期后不再冒充活动文本。
- **页签监听**：`MutationObserver` 观察编辑器与官方右侧栏区域内的页签增删、
  `class`/`aria-selected`/`data-edrv-tab-path`/`data-dockkit-pane-active` 变化，外加
  页签 `pointerdown`/`click` 兜底，都走 300ms 去抖。只响应
  `[data-edrv-view]`/`.edrv-tabs`/`[data-sidebar-right-session]`/`[data-dockkit-pane]`
  内的变更，聊天流式输出不会触发上报。
- **打开的文件列表**：edrv 页签标题优先取 `span.edrv-group-tab-name`（真实标题在 span
  里，不是直接文本节点），并去掉关闭按钮的 `×`；Monaco models 的路径列表作为补充保留；
  再补官方右侧栏的文件页签标题（`span[data-dockkit-tab-title]`）。只收「像文件名」的
  标题（带扩展名、扩展名不是纯数字），终端/浏览器/计划/轨迹这类非文件页签会被过滤；
  与 edrv 条目按 path 或 label 去重。
- **选区/光标**：只采信「model 与活动文件一致」的编辑器，跨文件切换不会把旧路径的
  选区带过去；页签切换导致 model 更换的那一轮先清空选区，等光标事件下一轮再补。
  单行选区上报 `line N selected`，多行上报 `lines A-B selected`。
- **视图**：读取 `[data-cursor-mode]` → `view: cursor|agent`。
- **会话**：优先可见的右侧栏会话根（`[data-sidebar-right-session]`），官方侧栏页签属于
  当前会话时直接用它上报 sessionId。
- 调试全局：`window.__editorContextDebug`（`reports` / `errors` / `lastReport` /
  `monacoFoundAt`，以及测试用的 `helpers` 纯函数）。
- 纯函数另有 `lib/sources.js` 等价实现（地址解析、预览/表格推断、文件页签名判定）；
  浏览器插件不能 import 本地文件，沙盒测试对两份实现做一致性校验。

### host（宿主半，`index.js` + `lib/context.js`）

- `POST /editor-context/report`：只接受回环同源 POST，body 上限 256KB；坏 JSON / 坏结构
  返回 400 且不覆盖旧快照；任何异常都不会抛出到插件链路。
- 快照有效期 30 分钟；**session 不匹配返回空串**（不能把别的会话的编辑器状态注入给
  无关 Agent）；未带 sessionId 的上报对所有 Agent 生效。
- 每个 `agent/created` 时注册 `systemPrompt.context({ name:'editor-context', order:130, text })`；
  Agent 销毁时自动注销；旧版 DSH 没有 `systemPrompt` 服务时静默跳过；注册代码包在
  try/catch 里，失败只记 warn，不会否决会话创建。
- 注入文本包含：`view`、会话工作目录（能拿到时）、活动文件、非文本活动页签、打开页签
  列表（最多 12 条）、路径相对工作目录的说明；快照超过 3 秒会带 `as of Ns ago`，避免
  每步啰嗦。活动文件分两种措辞：
  - Monaco 文本文件：`- Active file: <path> (language …; lines A-B selected)`
  - 官方侧栏预览页签（`source: preview`）：`- Active file (open in a read-only viewer): <path>`
  - 我们的表格页签（`source: sheet`）：`- Active file (open in the editable spreadsheet tab): <path>`
- `latest.active.source` 可为 `preview`（documentpreview 的 PDF/Word/PPT/文本预览）或
  `sheet`（dsh-workbench-sheets 表格页签），便于诊断。
- 多客户端（多标签/不同 origin）以最近一次上报为准（后到覆盖）。

## 诊断路由

```bash
# 端口用 DSH 桌面/web GUI 的端口；devtest 实例见 /tmp/devtest-url.txt
curl http://127.0.0.1:<port>/editor-context/state
curl 'http://127.0.0.1:<port>/editor-context/state?sessionId=<sid>'
```

返回 `{ ok, latest, registrations, text }`：`latest` 是最近一次规范化后的上报，
`registrations` 是当前存活的 prompt 上下文注册数，`text` 是该会话此刻将注入模型的
文本（不带 `?sessionId=` 时为 `null`）。

验收官方侧栏场景时，`latest.active` 应类似
`{ "path": "_dsh-preview-test/sample.xlsx", "source": "sheet" }`，`text` 里出现
`- Active file (open in the editable spreadsheet tab): _dsh-preview-test/sample.xlsx`，
`open` 列表含多个 csv/xlsx/pdf/docx 页签。

## 为什么聊天记录里看不到这段上下文

它注册在 Agent 的 `systemPrompt` **运行时上下文层**，作为每一步 prompt 的一部分参与
推理，不是一条聊天消息：对话记录、历史消息里都不会出现，模型也只能看到「当前」的
编辑器状态（TTL 过期后连它也没有）。

## 自测

```bash
cd /Users/laruielaurence/dsh-plugins/dsh-editor-context
node --check index.js client.js lib/context.js
node --test tests/*.test.mjs
```

- `tests/context.test.mjs`：`normalizeReport` 坏输入/字段丢弃/50 条上限/TTL、
  `contextTextFor` 的 session 不匹配、单行与多行选区文案、无活动文件但有打开列表、
  view/cwd/as-of 文案、`active.source` 的保留与「只读查看器」措辞。
- `tests/host.test.mjs`：假 ctx/req/res 下的路由注册、report（合法/坏 JSON/非 POST）、
  state 诊断、`agent/created` 的注册语义与「缺失服务时静默跳过」、source 透传。
- `tests/sources.test.mjs`：`lib/sources.js` 的地址解析（session/absolute/POSIX/盘符/
  UNC/坏输入）、预览与表格属性推断、文件页签名判定。
- `tests/client.test.mjs`：node:vm 沙盒里的假 window/document/Monaco，覆盖 edrv 页签
  与官方右侧栏（dockkit）推断、页签点击/观察器、选区清空、失败退避，以及 client 与
  `lib/sources.js` 纯函数的一致性校验。

## 已知限制

- 官方右侧栏的推断依赖其 DOM 标记（`[data-sidebar-right-session]`、`[data-dockkit-*]`、
  `[data-textpreview-url]`、`data-workbench-sheets-*`）。DSH 升级若改这些标记，需要同步
  调整 `client.js` 里的选择器；表格插件缺 `data-workbench-sheets-*` 属性时只会跳过
  表格推断（退化为官方预览推断或 `active:null`），不会报错。
- 只推断**可见**的右侧栏会话（`hidden` 的保留会话不参与）；右侧栏完全关闭时不做推断。
- 打开列表里没有地址的非文件页签靠标题启发式过滤（带扩展名才收），因此无扩展名的
  文件页签可能只出现在活动文件里、不收进打开列表。
- 单快照模型：多个浏览器客户端互相覆盖，以最近上报者为准。
