# dsh-session-search

DSH 左下角的 **Cursor 式会话搜索**：在「自动化任务」下方新增一个「会话搜索」入口，
点开是一个居中浮层，打开即列出最近对话；输入关键词后同时按 **会话标题** 和
**对话内容** 搜索，↓/↑ + Enter 或鼠标点击直接跳转。

同时移除了「工作区」标题栏里原来的搜索图标（以及它背后只能按标题搜索的旧交互）。

## 功能

- **最近对话**：不输入关键词时列出最近 30 个可跳转会话（按更新时间倒序，带运行 /
  待处理 / 完成状态点、工作区名、相对时间）。
- **标题 + 内容搜索**：
  - 标题、会话 id、工作区名在客户端即时匹配（无需等待）。
  - 对话内容由 Host 半的会话索引匹配，支持 **中文子串**（官方 `sessions.search`
    走 FTS5 `unicode61`，整段中文是一个 token，所以原来的搜索对中文基本等于按标题查）。
  - 内容命中带上下文片段和关键词高亮。
- **键盘**：↑/↓ 选择、Enter 打开、Esc 关闭；点击浮层外关闭。
- **保留 ⌘K**：桌面的原生按键桥会在页面之前派发旧的 `session.search` 命令，本插件
  监听旧搜索展开的动作，把它重定向成打开新浮层，并把隐藏的旧搜索收起。
- **入口位置**：「自动化任务」正下方（`sidebar.panellist` 的 order 15，介于
  schedules=10 与 Codex=20 之间）。

## 实现

- Host 半（`index.js`）：懒加载时通过 `ctx.sessionQuery.listSessions()` +
  `filterEvents()` 读取每个会话最近一次的表面消息文本，在内存里建一份
  「会话 → 消息文本」索引；消息只保留 user/assistant 文本，长消息截断到 20000 字。
  对外暴露两个同源路由：
  - `POST /dsh-session-search/search` `{query, limit}` → 子串匹配结果 + 片段
  - `GET /dsh-session-search/status` → 索引进度（首次搜索时前端显示进度）
  - 已持久化的会话每个进程只读一次；live 会话在每次搜索前按签名增量重读，所以当前
    正在进行的对话也能搜到。
- Client 半（`client.js`）：`shell.overlay` 里的浮层 + `sidebar.panellist` 的入口行 +
  `main` 的兜底页（从「更多」菜单也能进）；捕获阶段拦截入口行的点击，避免
  `layout.selectPanel` 把中间列切走；CSS 隐藏 `[class*="_searchSlot"]`。
- 侧边栏入口行图标渲染后会给侧边栏自己的 `<button>` 打上
  `data-dsh-session-search-entry`，点击拦截只认这个标记，不会误伤其它按钮。

## 安装 / 卸载

```sh
dsh plugin --profile desktop add /Users/laruielaurence/dsh-plugins/dsh-session-search
dsh plugin --profile desktop remove dsh-session-search
```

本机以 link 方式安装：改 `client.js` / `index.js` 后客户端 HMR 约 1 秒热重载；
Host 半改动需要重启 DSH。

## 兼容性

- 依赖 DSH 0.2.2-rc.1 的 `shell.overlay` / `sidebar.panellist` / `main` 槽位与
  `ctx.sessionQuery` 服务；升级后若槽位名或 class 命名变化，插件会安全失效
  （入口不出现、搜索浮层打不开），不会改坏界面。
- 隐藏旧搜索图标用的是 `[class*="_searchSlot"]`（CSS Module 命名后缀），不依赖
  构建哈希。

## 文件

- `index.js`：Host 半（会话内容索引 + 两个本地路由）。
- `client.js`：Client 半（浮层 / 入口 / 兜底面板 / 样式注入 / 旧搜索重定向）。
- `cordis.patch.yml`：bundle 补丁，插入插件行。
- `locale/{zh,en}.json`、`icon.svg`：插件管理页的展示元数据。
