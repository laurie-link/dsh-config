# dsh-cursor-layout

把 DSH 主窗口重排成 **Cursor / VSCode 式工作台**：原来挤在右侧的浏览器 / 文件 / 终端 / 编辑器 / 差异审查工作台，变成**中间的主区域**；AI 对话退到右侧一条窄栏。代码和文件是主角，对话是配角。

```
┌──────────────┬─────────────────────────────────────┬──────────────────┐
│ DSH 会话栏    │ 工作台（文件编辑 / 文件树 / 浏览器 /   │ AI 对话 + 输入框  │
│ (Cmd+B 收起)  │ 终端 / 差异审查 / 任务…页签）           │                  │
└──────────────┴─────────────────────────────────────┴──────────────────┘
                            ↑ 活动栏 + 资源管理器在中间列左缘
```

- **中间（主区域）**：DSH 右侧栏原本承载的全部页签整体搬过来——`dsh-vscode-mode` 的 Monaco 编辑器（活动栏 + 资源管理器 + 文件页签 + 行内 diff + Keep/Undo + 状态栏）、官方文件树 / 浏览器 / 终端、`dsh-better-sidebar` 的 Git / 任务 / 会话审阅、`dsh-session-review` 的差异审阅。
- **右侧**：DSH 原生会话对话列（含 composer），宽度取窗口 25%，限制在 340–520px。
- **左侧**：DSH 会话列表。按 `Cmd/Ctrl+B` 收起它，就得到经典 Cursor 三栏：`活动栏+文件树 | 编辑器 | 对话`（收起状态会被跨刷新记住）。
- **Agent 视图开关**：会话头部右侧一颗 `Agent 视图` / `Cursor 布局` 药丸（`⌘⌥M`，浏览器里是 `Ctrl+Alt+Shift+M`）在两种视图间切换；**每个会话各记各的**（`dsh-cursor-layout/view.v2` 的 `bySession`，旧版单一 `view.v1` 会迁移成默认值），跨刷新记住。切到 Agent 视图时对话列居中、工作台整列隐藏（页签不卸载，切回来原样恢复）。
- **对话里的文件链接直接进 IDE 视图**：在 Agent 视图下点对话中的文件链接（含反引号路径被渲染成的可点文件 chip）会先把当前会话切回 IDE/Cursor 视图，再在中间工作台打开该文件——不再出现「点了没反应、其实开在隐藏的工作台里」。Agent 视图是用户自己选的，所以只在点文件链接时自动让位；用开关切回 Agent 视图即可保持。
- **原生「已编辑 N 个文件」卡片同样自动进 IDE 视图**（0.5.6）：DSH 核心 `ui-deliverables` 渲染的改动卡片（容器带 `data-changed-files`）点击头部或任一文件行时，原生会在右侧栏打开「本轮改动」审查页签；Agent 视图里工作台整列隐藏，所以点下去像没反应。本插件在捕获阶段先切到 IDE 视图（与文件链接同一套「只在这一下让位」的策略），再**放行原生点击**，审查页签就落在可见的工作台里；折叠用的「全部 N 个文件」开关（`aria-expanded`）不触发切视图。已在 IDE 视图时保持原生行为。
- **原生文件交付卡片直进「文件编辑」**（0.5.10）：对话里由 `ui-deliverables` 渲染的交付文件卡片（容器 `data-presented-file`；覆盖整张卡的预览按钮 `title` 是解析后的绝对路径）原点点开时走聊天自己的 `openFile`（官方右侧栏资源页签）——Agent 视图里右侧栏是隐藏的工作台列，IDE 视图里也不一定是 `dsh-vscode-mode` 的编辑器。本插件在捕获阶段接管这张卡的预览点击（卡片右侧「在系统应用中打开」等动作按钮保持原生）：先切 IDE 视图并激活「文件编辑」页签，再把路径派发给 `edrv:open-editor`，所以**代码 / 图片 / 视频都落在同一个编辑器页签**（图片 / 视频面板由 vscode-mode 提供），和对话里的文件 chip 行为对齐。没装 `dsh-vscode-mode` 时不接管，只切视图、交回原生打开。诊断见 report 的 `presentedOpen`（`cards` / `clicks` / `opened` / `lastPath` / `editorTab` 几何）。
- **打开文件后左侧资源管理器自动定位**（0.5.13）：交付卡片 / 对话文件链接把文件落进「文件编辑」时，同时把 `dsh-vscode-mode` 活动栏切到「文件管理」（编辑区左侧 44px 图标列 → 展开面板区）；文件树监听编辑器当前路径，会自动展开文件所在目录并高亮该文件，等价 VS Code 的「在资源管理器中定位」，不会再出现「打开是打开了，但不知道这个文件在哪」。面板区本来就停在「文件管理」时不重复点击；编辑器页签正文是懒挂载的，所以在 140ms → 3.8s 之间多次重试。工作区外的文件没有树节点，保持不动。诊断见 report 的 `explorer`（`attempts` / `finds` / `opened` / `railOnly` / `active`，以及 `rail.titles` 证明活动栏按钮被找到）。
- **媒体链接在 Agent 视图右侧直接预览**（0.5.4）：视频 / 图片（mp4/m4v/mov/webm/ogv + png/jpg/jpeg/gif/webp/avif/bmp/ico/svg）在 Agent 视图里点开时**不切 IDE 视图**，而是把工作台列以「媒体预览」形态显示在**右边**（对话仍在中间，宽度约 46vw、380–860px），`dsh-vscode-mode` 的视频面板 / 图片面板就在这一列里打开（播放器可拖动进度条）。Esc、面板自带收起按钮、关掉列里「文件编辑」这个页签（或它最后剩下的那个页签）或切到 IDE 视图都会关掉这个预览列。非媒体文件链接仍走上面的「切回 IDE 视图」逻辑。
- **预览列跟着面板一起撤，不再留一条关不掉的黑列**（0.5.16）：预览列只是把官方右侧栏搬到了右边，所以面板一收起，列就必须跟着收。以前点列里「文件编辑」页签的 `×` 关掉最后一个页签时，官方侧栏按设计收起整列，而预览列仍把那条（约 46vw）的轨道留在原地——右边于是变成一条没有页签、没有收起按钮的纯黑空列，只有 Esc 能脱身。现在 `sync()` 在 Agent 视图里同时检查 `data-rightbar-collapsed`（且必须「见过面板打开」，否则刚点开媒体那一瞬的竞态会把预览列自己撤掉），页签条上的点击也会在「文件编辑」消失后 120 / 420 / 1000ms 各复核一次并撤列；两条路都回落到纯 Agent 视图。诊断见 report 的 `viewToggleDebug.peekCloses` / `peekCloseReason`（`panel-collapsed` / `editor-tab-closed` / `explicit`）/ `peekSawPanelOpen`。
- **媒体点击由本插件接管**（0.5.4）：对话里的文件 chip 点击会在捕获阶段被识别；媒体后缀命中时 `preventDefault + stopPropagation`，**不让对话默认的官方资源路由执行**（官方查看器 / better-sidebar 对二进制媒体只会显示「此文件类型不支持预览 / 下载查看」，这是之前「视频看不了」的直接原因），改由本插件在 Agent 视图展开右侧预览列并派发 `edrv:open-editor`，把文件交给 `dsh-vscode-mode` 编辑区的视频 / 图片面板。IDE（Cursor）视图下媒体同样进编辑区（位于中间工作台）。
- **消息框上方「本轮改动」栏的点击同样投影可见目标**（0.5.12）：这条栏（`cursor-diffbar`，`N Files +新增 −删除` + `Undo` / `Keep` / `Review`）以前点文件行或 `Review` 只派发 `edrv:open-editor` —— Agent 视图里工作台整列 `display:none`，文件确实打开了、却开在看不见的列里，观感就是**点了没反应**。现在点行 /
  `Review` 先按当前视图投影出可见目标再打开：**媒体**（图片 / 视频，含 `Review` 指向的第一条）在 Agent 视图走右侧媒体预览列，**文本**切回 IDE 视图并聚焦第一处差异；**二进制 / 超大记录**（行尾恒为 `+0 −0`，没有文本 hunk）改为打开文件本身（图片 / 视频面板、或委托给官方查看器），不再空跑差异聚焦。打开请求带懒挂载重试；没装 `dsh-vscode-mode` 时退回官方打开器，点击仍会落地。诊断见 report 的 `diffBarDebug`（`clicks` / `lastPath` / `lastView` / `lastFocusDiff` / `lastError`）。
- **空编辑区自动用 Agent 视图**（0.5.5）：除了按会话记住的选择，再补一条「事实优先」——切到**没打开任何文件**的会话时直接给 Agent 视图（不再先闪一下空荡荡的中间工作台；以前手选过 IDE 视图的空会话也一样让位）；在当前会话关掉**最后一个文件页签**时自动切回 Agent 视图。编辑器迟到恢复出文件（重启换 origin 后的界面状态水合）时再还原成该会话记住的视图；媒体预览列打开期间不打扰。空/非空的事实来自 `dsh-vscode-mode` 的 `edrv:editor-presence` 广播与 `window.__edrvEditorPresence__.editorFileCount(sessionId)` 同步查询（按会话的「工作区 + 会话」页签存档兜底），本插件不嗅探编辑器 DOM；没装 `dsh-vscode-mode` 时不参与判定。「手选」只在当次会话内有效：空编辑区的会话切走再切回仍按事实给 Agent 视图，想在空会话里用 IDE 视图（例如打开文件树找文件）随时点药丸切回即可，不会被打扰。
- 工作台页签全部关闭 / 右侧栏收起时，自动回退成「左侧会话栏 + 右侧铺满的对话」，即 DSH 原始观感，不会留下空白列；此时不会再自动把编辑器页签抢回来，除非切回 Cursor 视图。

## 实现方式

只重投影 shell 的 CSS grid 三轨（在 frame 上加 `[data-cursor-mode]` + 三个 `[data-cursor-col]` 标记），**不注册、不替换、不删除任何 slot occupant**，也不改其它插件的代码：
- Agent 视图的媒体预览列同样是纯 CSS 投影：第三轨宽度由 `--cursor-layout-peek`（视口 46%、380–860px 夹取）给出，工作台列从 `display:none` 临时恢复，不切换视图、不卸载页签，关掉预览即恢复原样。

- 两列宽度由 frame 自己的内联几何读回（`grid-template-columns` 首轨 = 左侧栏实时宽度），所以左侧栏拖拽、`Cmd+B` 收起/展开、窗口缩放都实时跟随。
- 工作台面板宽度用 `width: 100%` 覆盖掉右侧栏「按右侧轨道宽度锚定」的旧几何，让它在中间列铺满。
- 三列显式 `grid-row: 1`（frame 有第二行给底部 workbench，漏了会被自动排版挤下去、高度变 0，这是第一版中间空白的根因）。
- 右侧栏全屏（fullscreen）时自动让位，交还给 DSH 原生几何。
- 插件卸载 / 禁用 / 热重载时，`restore()` 会清掉全部标记、CSS 变量与样式表。

## Cursor 视图 ⇄ Agent 视图

同一个窗口有两种布局，随时可切：

| 视图 | 布局 |
|---|---|
| **Cursor 视图**（默认） | 会话栏 │ 工作台（文件/编辑器/终端/浏览器/差异）居中 │ AI 对话在右 |
| **Agent 视图** | DSH 原生：对话居中铺满，工作台列隐藏（页签保持挂载，切回来即恢复） |

切换入口：

- **会话页**：对话标题栏右侧的胶囊按钮（图标 + `Agent 视图` / `Cursor 布局`）。
- **空白新对话页**（hero，没有会话标题栏）：对话列顶部左侧的同一个胶囊按钮（挂在 root 作用域的 `conversation.header.leading` 座位，无 Session 也可用）。
- **键盘**：`⌘⌥M`（Windows/Linux `Ctrl+Alt+M`；浏览器版多带 Shift），命令 id `cursorLayout.toggleView`，可在 设置 → 快捷键 里改键。
- 选择**按会话**持久化在 `localStorage['dsh-cursor-layout/view.v2']`（`{ fallback, bySession }`；旧 `view.v1` 迁移为 fallback），切换会话时套用该会话自己的视图，下次打开沿用。

## 消息框上方的「本轮改动」栏（Cursor 式）

对话列输入框上方是一条 Cursor 风格的改动栏，数据来自 `dsh-vscode-mode` 的官方审查记录（`edrv.review.*` RPC）：

- 头部：`N Files  +新增 −删除`，右侧三个按钮 `Undo` / `Keep` / `Review`。
- 展开（点击左侧 ▸）：**按文件聚合**列出工作区相对路径与 `+N −M`（同一文件多个轮次记录合成一行，行尾 `×N` 标记录数）；点击任一行在编辑区打开该文件（文本打开 diff，图片 / 视频打开预览面板，二进制 / 超大记录打开文件本身）。
- **点在 Agent 视图也有反应**（0.5.12）：点文件行或 `Review` 时先投影一个可见目标再打开——媒体走右侧媒体预览列（对话保持居中，Esc / 收起按钮 / 切视图关闭），文本切回 IDE 视图并聚焦第一处差异；以前只派发打开事件，Agent 视图下开在隐藏的工作台列里，看起来像没反应。打开请求覆盖编辑器懒挂载窗口（重试），未装 `dsh-vscode-mode` 时退回官方打开器。
- **只列当前会话工作区内的文件**（官方记录里工作区外的绝对路径、`~` 路径会被过滤），避免把插件源码、`/tmp` 之类的噪声算进来。
- `Undo` = 把待审文件恢复成本轮修改前；`Keep` = 标记已审（不改磁盘）。
- `Review` = 对齐 Cursor 的 Review Changes（0.5.15）：展开本栏**按文件聚合的文件列表**并在 IDE 视图打开第一处差异 —— 相当于 Cursor 的「文件列表 + diff」审查面：点任一文件行看它的 diff，编辑器里用 ←/→ 换文件、↑/↓ 换差异、审查条逐个文件 Keep/Undo；栏上的 `Keep` / `Undo` 仍是整批结清。**不再**拉起编辑器的「差异总览」——那个面板按官方轮次记录排（一条记录一个卡片），几百条 pending 时反而没法用；它仍可从编辑器审查条「⋯ → 差异总览」打开。
- **Keep / Undo 现在按「路径」结清两套台账（0.5.15）**：vscode-mode 的差异记录有「待审累计投影」和「官方轮次记录」两套账，同一文件可能各有一条；以前只结列表里那一条，另一条会在投影结算后重新浮出，表现为「点了 Keep，下一轮文件又回来了 / Keep 过的文件还在列表里」。现在 `Keep` 成功后会重新取列表，对同一批路径多轮收口（host 新版在服务端一次完成）；`Undo` 由 host 在文件级判定后结案同路径官方记录。仍有残留或跨端/沙箱拒绝时，栏内会显示具体原因而不是假装成功。
- **Keep 完成度如实显示（0.5.15）**：`keepAll` 的 `skipped` / 段级 `error` 不再被忽略（以前 `ok:true` 就当成全部成功）；动作类错误与后台轮询错误分开，后续自动刷新不会把失败提示冲掉。
- 数据为空时整条隐藏；`dsh-vscode-mode` 不在时自动不显示（不报错）。
- vscode-mode 自带的「差异 N 个文件 · 查看下一个」dock 已**全局隐藏**（含 Agent 视图、工作台关闭时的原生回退、空白新对话页），避免出现两条重复栏。
- 空白「新对话」hero 页不渲染 —— 但判断依据是「没有 sessionId 或没有待审文件」，**不是**「页面里有 conversation.hero 这一层」。rc.2 起普通会话也会渲染 `conversation.hero.frame` 包装层，之前用 hero 存在来判断会把这条栏永久挡掉（2026-11-13 修）。
- `dsh-session-review` 注入 `conversation.input.dock` 的中文条（`.dsr-dock`：「本轮修改 N 个文件 / 撤销全部 / 保存全部 / Review 全部」）已用 CSS 全局隐藏（2026-11-13 用户选定只保留本栏）；它的侧栏 Review 面板不受影响。
- **宽度与消息框一致**：宽度取 `100% − 2×--dsh-composer-side-clearance`、上限 `--dsh-composer-card-max-width` 并水平居中，所以在 Agent 视图（对话列很宽）里也不会铺满整屏，始终和下面的 composer 卡片等宽对齐。0.5.0 修掉了之前的整屏宽问题。
- 它同时会隐藏 vscode-mode 自带的对话摘要 dock，避免出现两条重复栏（编辑器内部那条操作条保留）。

## Agent 视图 / Cursor 视图切换

顶部会话头部有一颗药丸按钮，用来在两种布局之间来回切：

- **Cursor（默认）**：当前的三栏工作台观感——左侧会话、中间工作台、右侧窄对话列。
- **Agent**：回到 DSH 原生 Agent 观感——对话在中间列居中，工作台整列隐藏（`display:none`），左边仍保留会话栏。工作台只是隐藏，Monaco/终端/差异页签都保持挂载，切回 Cursor 立即恢复原状。

交互与实现：

- 点击药丸，或按 `⌘⌥M`（macOS 桌面端；浏览器里是 `Ctrl+Alt+Shift+M`）切换；快捷键 `id` 是 `cursorLayout.toggleView`，可在 `设置 → 快捷键` 里改键位。
- 选择**按会话**持久化在 `localStorage['dsh-cursor-layout/view.v2']`（`{ fallback, bySession }`；旧 `view.v1` 迁移为 fallback），没有记录的会话按 fallback 启动（默认 Cursor 视图）。
- 投影仍是纯 CSS：两种视图都由 frame 上的 `data-cursor-mode="cursor|agent"` 切换 grid 模板；Agent 视图把第三轨设为 `0px` 并隐藏 `[data-cursor-col="workbench"]`，不卸载任何 slot occupant。
- Agent 视图下 `ensureTimer` 不再自动重开编辑器页签，避免和用户选择的视图打架。
- **Agent 视图的媒体预览列**：`data-cursor-media-peek` 属性 + `--cursor-layout-peek` 变量把三轨临时切成 `侧栏 | 对话 | 工作台(右)`；CSS 只在该属性存在时解除 `[data-cursor-col="workbench"]` 的 `display:none`。触发点是对话文件链接的捕获阶段点击（`button._fileLink_*` / `dsh-resource://file/…` 锚点，路径取 `title`、资源地址或 chip 文本），媒体后缀命中才走预览列；也监听 `edrv:media-open` 事件兼容其它入口。

## AI 补全与「选中问 AI」

- **AI 补全（ghost text）**：由本插件自带的内联补全 provider 提供（走 `dsh-vscode-mode` 的 `/edrv/rpc edrv.ai.inline` 通道，并退役它自带那份可能因模块重载而失效的 provider，保证只有一份 ghost text）。
  - 配置（写在 profile 的 `cordis.patch.yml` 里，已生效）：`aiInline: true`、`aiProvider: deepseek-account`、`aiModel: deepseek-flash`、**`aiEffort: off`**。
  - `aiEffort` 必须是 `off`：`deepseek-flash` 默认是 `high` 思考档，思考型模型只返回 reasoning 不返回正文，补全永远是空的（这是最初“没反应”的根因）。
  - 行为：停止输入约 0.16s 去抖后发一次补全请求，模型约 0.7–1.2s 返回；`Tab` 接受，`Alt+\`（Option+\）手动触发（由本插件补绑，因为插件自带命令在官方快捷键目录里没有键位）。
  - 也可在 `设置 → VSCodeMode →「AI 补全」` 里调整模型/思考档（保存会写进 DSH 设置存储）。
- **选中代码问 AI**：在编辑器里选中代码后按 **`⌘U`（Cmd+U；Windows/Linux 上是 Ctrl+U）**，或右键「添加选中内容为引用」，选中范围会作为引用 chip 插入右侧对话输入框，接着直接提问即可（等价 Cursor 的 Add to Chat）。注意 macOS 上 vscode-mode 的 primary 修饰键是 Cmd，所以按 Ctrl+U 不会有反应。
- 限制：Cursor 的 `Cmd+K` 行内「选中代码 → 对话式改写」没有等价能力；现有的是「补全」和「引用到对话」两条。

## 诊断

Host 半在 `GET /cursor-layout/report` 暴露最近一次客户端上报的帧几何（loopback，内存里只留最后一份，便于以后排查布局回归）：

```sh
curl -s http://127.0.0.1:<GUI 端口>/cursor-layout/report | python3 -m json.tool
curl -s http://127.0.0.1:<GUI 端口>/cursor-layout/probe  | python3 -m json.tool   # 插件配置 + LLM provider/模型目录
```

`report` 里能看到：当前三栏几何、`data-cursor-mode` 状态（`view` 字段是 `cursor|agent`）、`composerCard` 与改动栏的实测矩形（验证等宽）、工作台页签、`viewToggle`/`viewToggleDebug`（头部药丸与快捷键注册状态）、合并改动栏、AI 补全 provider 状态（`ownInline.ready/calls/lastMs/lastLen`）与最近错误。原生「已编辑 N 个文件」卡片单独有一条 `changedFiles`：卡在不在 DOM（`cards`）、它的按钮与 `aria-describedby`（`buttons`）、点击次数 / 切视图次数 / 跳过次数（`clicks`/`reveals`/`skipped`）、最后一次点到的路径与无障碍标签，以及点击后 400ms 快照的审查页签几何（`reviewTab`，`rect` 非零即证明页签真的可见地挂上了）。原生文件交付卡片另有一条 `presentedOpen`：`cards`（屏上有几张卡）、`clicks`/`opened`（点了几次 / 成功交给编辑器的次数）、`lastPath` 与 `lastView`（点击时是 Agent 还是 IDE 视图）、`editorTab`（点击后 500ms 快照的编辑器主体几何，`rect` 非零即证明文件编辑页签可见）。

## 安装 / 卸载

```sh
dsh plugin --profile desktop add /Users/laruielaurence/Documents/dsh-plugins/dsh-cursor-layout
dsh plugin --profile desktop remove dsh-cursor-layout
```

装完硬刷新（`Cmd+Shift+R`）即可。本机已以 link 方式安装：改完 `client.js`，客户端 HMR 会在约 1 秒内自动热重载，无需刷新。

## 兼容性

- 依赖 DSH 0.2.1-rc.5 的 AppFrame 结构（`[data-rightbar-col]`、`[data-sidebar-right-panel]`、`data-rightbar-collapsed` 等稳定的数据属性）。DSH 升级后若这些标记变化，插件会安全失效（不生效、不报错、不改坏界面），按新版本重新适配即可。
- 首次安装会在有 vscode-mode 时打开「文件编辑」页签，并把「代码优先」当成默认；用户手动关闭工作台后不会被反复重开。

## 文件

- `index.js`：Host 半（诊断路由 + 挂载行）。
- `client.js`：全部布局逻辑（样式注入、帧几何观察、三栏投影、自动化打开工作台、诊断上报）。
- `cordis.patch.yml`：bundle 补丁，插入插件行。
- `locale/{zh,en}.json`、`icon.svg`：插件管理页的展示元数据。
