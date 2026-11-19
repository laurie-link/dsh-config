---
name: dsh-profile-maintenance
description: |
  维护 DSH 本机安装时使用：安装/升级插件、重打本地补丁、构建客户端插件（dsh-vscode-mode /
  dsh-cursor-layout）、排查 Mac↔Windows 配置同步、配置本机 MCP 服务器（IDA / Playwright / REA）。
  触发词：插件、plugin add/update、补丁、patch、reapply、build、HMR、同步、sync、cordis.patch.yml、MCP。
---

# DSH 本机维护手册

`~/.dsh/AGENTS.md` 只保留行为规则；安装细节、补丁清单、排障都放在这里。
同步流水线见 `~/dsh-profile-sync/README.md`，补丁原文与差异见 `~/dsh-profile-sync/patches/<插件>/`。

## 1. 插件分两类

### link 本地插件（升级安全）

`dsh-vscode-mode-fork`、`dsh-cursor-layout`、`dsh-design-system`、`dsh-editor-context`、
`dsh-ntr-picker`、`dsh-workbench-sheets`、`dsh-live-page` 在 profile 里是 `link:` 本地目录，源码在
`~/dsh-plugins/` 和 `profile/vendor/`。`dsh-live-page`（HTML 实时编辑）的 overlay 在
`assets/live/overlay.js`：外部文件改动后每 2 秒轮询并自动刷新，只有页面里有未保存改动时才提示；
编辑模式用 sessionStorage 跨刷新保留，HUD 不再提供手动刷新按钮。**不要**用 `dsh plugin add dsh-vscode-mode@版本` 之类命令把 link 换成 npm 拷贝。

### npm 安装但被本地改过（更新会覆盖 → 必须重打）

统一命令：`reapply-local-patches`（`~/dsh-profile-sync/scripts/reapply-local-patches.sh`，
已软链到 `~/.local/bin/` 与 `~/.dsh/bin/`）。

| 插件 | 本地改动 | 重打后 |
| --- | --- | --- |
| `dsh-figma-mcp` | 隐藏设置项；Figma 条目写 profile patch 并保留 disabled 标记 | 重启 DSH |
| `dsh-task-notify` | 客户端通知 + 程序坞红点（Web Notification + `navigator.setAppBadge`；`ctx.sessions.retain()` 订阅、`hasFocus()` 前台门控） | 刷新页面即可（纯客户端补丁） |
| `dsh-image-gen` | ChatGPT 订阅生图模型常量 `gpt-image-2.6-sunburst` | 重启 DSH |
| `dsh-toolbox-ui` | 让位检测忽略官方 `@deepseek-ai/dsh-mcp-manager`（rc.2 起该包只有宿主服务、无客户端界面，会把「我的 MCP」面板顶掉） | 重启 DSH（宿主端） |
| `dsh-web-search-brave` | 代理支持（HTTP CONNECT 隧道；本机 v2rayN 混合代理 `127.0.0.1:10809`） | 重启 DSH；端口变了只改 `~/.dsh/web-search-brave.json` |

代理补丁单独重打：`scripts/reapply-web-search-brave-proxy.ps1`（`-Check` / `-Rollback`）。
npm 补丁插件升级/重装后一律先重打再用。

## 2. 构建与生效

- `dsh-vscode-mode`：TypeScript 工程，`lib/` 是 gitignored 构建产物，改完必须 `npm run build` 再刷新页面。
- `dsh-cursor-layout`：纯 `client.js`，HMR 约 1 秒热重载，无需构建、无需刷新。
- 替换客户端插件文件后要 Ctrl+R 重载页面：HMR 可能读到半截 bundle，表现为视图切换没反应、诊断里 `vscodeLoaded:false` / `bridge:false`。
- 宿主补丁（figma-mcp / image-gen / web-search-brave）重打后重启 DSH；客户端补丁（task-notify）刷新页面即可。

## 3. 同步（Mac → Windows）

- 两端都只推不拉：一端推过之后，另一端先 `git -C ~/dsh-profile-sync pull --rebase`，否则自动推送会一直 non-fast-forward 失败。
- `dsh-vscode-mode` 的 `lib/*.js` 靠 `sync-mac.sh` 用 `git add -f` 强制入库（默认被插件自己的 `.gitignore` 挡住）；Windows 缺 lib 时从 `%USERPROFILE%\dsh-local-artifacts\dsh-vscode-mode\lib` 补回。
- pnpm 的 `file:` 目录依赖只在首次安装时复制：vendor 更新后 `dsh plugin install` 不刷新 `node_modules`（`apply-windows.ps1` / `dsh-finish-sync.ps1` 已有镜像步骤）。
- 两边都要启用的 bundle 写 `profile/bundles.extra.json`（目前是 auto-review、forge-bundle），不要只改某一端 live `package.json`。
- 按机器不同、不要互相覆盖：Windows MCP 三行（`mcp-rea` / `mcp-ida` / `mcp-playwright`）、`subagent-model-selection-settings`、`dsh-vscode-mode` 模型路由（Mac 用 opencode-go，Windows 用 deepseek-account + deepseek-flash）。
- Windows 端 `apply-windows.ps1` 只做 `git pull --ff-only`，所以不要在该克隆里留本地提交，否则之后拉取会失败。

## 4. 本机 Windows：MCP 服务器

三个 `@deepseek-ai/dsh-mcp-client` 条目写在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾的 `- insert:` 块。

- 从 Mac 同步会整体覆盖 profile 配置，这三条要人工合并回去；`mcp-playwright` 保持 `disabled: false`。丢了就到 `%USERPROFILE%\dsh-backup-sync-<时间>\profiles\desktop\cordis.patch.yml` 里把这段拷回。
- 改该文件由 HMR 热加载，不用重启 DSH；工具变化在下一次模型请求生效。
- `mcp-rea` 默认 `disabled: true`（170 个工具、schema 约 1.9 MB），按需开启。
- `mcp-ida`：先在 IDA 里启动 MCP 插件（Edit → Plugins → MCP，Ctrl+Alt+M），RPC `http://127.0.0.1:13337`。
- `mcp-playwright`：extension 模式，连本机已开的 Chrome；Chrome Profile 1 装了 Playwright Extension（ID `mmlmfjhmonkocbjadbfplnigmagldckm`），`PLAYWRIGHT_MCP_EXTENSION_TOKEN` 必须与扩展里一致；首次调用会自动打开 `chrome-extension://…/connect.html`，30 秒未连上会报 `Playwright extension did not connect`。可直接操作用户已开标签页；连接页/测试页开在 Chrome 的「Playwright」标签组，用完可手关。
- REA 深度分析后端是 IDA（`REA_ANALYSIS_PROVIDER=ida`，读 `C:\Users\34897\.cursor\ida-mcp.json`）；本机没配 Ghidra，不要假设可用。

## 5. 常见现象对照

| 现象 | 处理 |
| --- | --- |
| 视图切换按钮没反应、`vscodeLoaded:false` | 替换过客户端插件文件，Ctrl+R 重载页面 |
| 改了 dsh-vscode-mode 源码但界面没变 | 先 `npm run build` 再刷新页面 |
| Brave 搜索全部失败 | 代理补丁未打或端口变了（§1） |
| Figma 设置项又出现 / 不能启停 | 重打补丁并重启 DSH |
| 同步后提示 non-fast-forward | 见 §3 第一条，先 pull --rebase |
