# 插件清单

46 个插件，按用途分组。版本是我这套配置上实际的版本，装的时候不一定是最新。

**「本地」标记**：这些插件是我自己写的或改过的，不在 npm 上，需要源码手动放进去并 `link:`。数量 15 个。其余 31 个可以直接 `dsh plugin --profile desktop add <包名>` 装。

## 运行时、上下文与记忆

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| `billion-context` | 0.1.216 | 上下文压缩管理，长对话不爆上下文 |
| `dsh-auto-memory` | 1.5.0 | 自动记住长期偏好和项目状态 |
| `dsh-compaction-retry` | 本地 | 压缩失败自动重试 |
| `dsh-session-search` | 本地 | 搜历史会话的内容 |
| `dsh-rewind-plugin` | ^0.21.2 | 对话和文件回退到任意一步 |

## 界面与编辑器

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| `dsh-vscode-mode` | 本地 | IDE 式工作台（本地 fork，改过内部接口） |
| `dsh-cursor-layout` | 本地 | Cursor 风格布局 + 改动栏杆 |
| `dsh-better-sidebar` | 0.30.1 | 右侧栏：浏览器、终端、编辑器标签 |
| `dsh-better-sidebar-svn` | github:ztyhehe/dsh-better-sidebar-svn | 右侧栏的 SVN 支持 |
| `dsh-edit-diff` | 本地 | 改文件时显示 Cursor 式红绿 diff 卡片 |
| `dsh-editor-context` | 本地 | 把当前打开的文件自动喂给模型 |
| `dsh-enter-plan-mode` | 本地 | 模型可自主进入计划模式 |
| `dsh-ui-control` | 本地 | 修外链图标一类的小问题 |
| `dsh-toolbox-ui` | ^1.10.1 | 工具箱面板 |
| `dsh-marktext` | ^0.1.13 | 文本渲染增强 |
| `dsh-workbench-sheets` | 本地 | 工作台里的表格视图 |
| `dsh-debug-mode` | 本地 | 运行时日志调试模式 |

## 内容生产

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| `dsh-claude-design` | 2.16.0 | 画板 / 版式设计 |
| `dsh-claude-design-system` | 2.16.0 | 设计系统与品牌 |
| `dsh-claude-slides` | 2.16.0 | 幻灯片 |
| `dsh-claude-motion` | 2.16.0 | 动效短片 |
| `dsh-claude-data` | 2.16.0 | 数据看板 |
| `dsh-claude-whiteboard` | 2.16.0 | 白板 / 流程图 |
| `dsh-univer-office` | ^0.4.0 | Office 文档、表格、演示 |
| `dsh-image-gen` | 0.10.3 | 图片生成与编辑 |
| `dsh-image-hunt` | 1.4.1 | 多图源搜图并下载 |
| `dsh-live-page` | 本地 | 实时页面预览 |
| `dsh-figma-mcp` | ^1.0.0 | 接 Figma（读设计稿、导切图） |
| `@local/dsh-async-ui` | 本地 | 图片异步渲染 |
| `@local/dsh-image-resolver` | 本地 | 图片地址解析与核对 |

## 协作与子代理

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| `@deepseek-ai/dsh-tool-subagent` | 0.2.2-rc.1 | 子代理工具 |
| `@deepseek-ai/dsh-subagent-acp` | 0.2.2-rc.1 | 通过 ACP 接外部智能体 |
| `@deepseek-ai/dsh-subagent-codex` | 0.2.2-rc.1 | 接 Codex |
| `@aiwayds/dsh-subagent-registry` | ^0.19.1 | 自定义子代理注册表 |
| `dsh-native-codex-cli` | github:447662/dsh-native-codex-cli | 直接调 Codex CLI |
| `dsh-task-notify` | ^0.4.1 | 任务完成通知 |

## 交互与外部工具

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| `@changfenhuang/dsh-genui` | 0.16.0 | 对话里的交互式组件（表格、图表、图片组等） |
| `deepseek-harness-intelligent-ui` | 0.2.15 | 界面增强 |
| `dsh-taste-skill` | 2.1.6 | 设计审美技能包 |
| `dsh-web-search-brave` | github:thomasly/dsh-web-search-brave | 搜索接入 |
| `dsh-plugin-lcu` | ^0.3.8 | 插件工具 |
| `dshmarket` | 1.73.19 | 插件市场 |
| `dsh-ntr` | 本地 | 模型 / 智能体选择器 |
| `dsh-pet` | 0.4.8 | 桌面宠物（Electron 程序，仅桌面） |
| `dsh-personalization` | 本地 | 把个性化设置注入系统提示 |
| `@xiazhi88/dshgo` | ^2.0.5 | 把本机 DSH 开到局域网，手机/平板访问 |

## 关于依赖来源

清单里 46 个依赖有几种写法，对应不同来源：

- **普通版本号**（如 `0.30.1`）：npm 上直接装。
- **`^` 开头**：允许小版本更新，npm 上装。
- **`github:用户/仓库`**：从 GitHub 装，可能钉了 commit。
- **`.tgz` 地址**：作者用打包文件发布，不是走 npm registry 常规发布。
- **`本地`**：`link:` 到本机目录，装不上。

## 版本注意

- 这套配置对应 DSH `0.2.2-rc.5`。插件对 DSH 版本有硬要求，换版本前先看包里的 `engines.dsh` 或 peer 依赖。
- 已知的版本摩擦：`@deepseek-ai/dsh-subagent-acp`、`dsh-subagent-codex`、`dsh-tool-subagent` 三个 `0.2.2-rc.1` 对 DSH `0.2.2-rc.5` 报版本不兼容警告（`Exact-version exemption: not active`）。实际能用，但装的时候会看到提示。
