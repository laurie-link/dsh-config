# 本地插件源码

15 个不在 npm 上的插件，源码放在这里。它们在我本机是 `link:` 依赖，指回 `~/dsh-plugins/`。

**目录里只有源码**：不含依赖、构建产物、截图、第三方 vendor 文件（Monaco / pdfjs 那些）。所以体积小，但两个 fork 需要自己构建。

## 清单

| 目录 | 包名 | 用途 |
| --- | --- | --- |
| `dsh-edit-diff` | `dsh-edit-diff` | 改文件时显示 Cursor 式红绿 diff 卡片，点击在编辑器里定位 |
| `dsh-cursor-layout` | `dsh-cursor-layout` | Cursor 风格布局与改动栏 |
| `dsh-vscode-mode-fork` | `dsh-vscode-mode` | IDE 式工作台（**fork**，见下） |
| `dsh-personalization` | `dsh-personalization` | 把个性化设置（回答风格）注入系统提示 |
| `dsh-async-ui` | `@local/dsh-async-ui` | 图片异步渲染，核对不通过的图直接不显示 |
| `dsh-image-resolver` | `@local/dsh-image-resolver` | 图片地址解析与主体核对 |
| `dsh-ntr-picker` | `dsh-ntr` | 模型 / 智能体选择器（**fork**，见下） |
| `dsh-session-search` | `dsh-session-search` | 搜历史会话内容 |
| `dsh-compaction-retry` | `dsh-compaction-retry` | 上下文压缩失败自动重试 |
| `dsh-enter-plan-mode` | `dsh-enter-plan-mode` | 模型可自主进入计划模式，退出仍需人批准 |
| `dsh-editor-context` | `dsh-editor-context` | 把当前打开的文件喂进上下文 |
| `dsh-debug-mode` | `dsh-debug-mode` | 运行时日志调试：起本地收集端点、读日志、最小化修复 |
| `dsh-ui-control` | `dsh-ui-control` | 界面小修（外链图标、节点渲染等） |
| `dsh-live-page` | `dsh-live-page` | 实时页面预览 |
| `dsh-workbench-sheets` | `dsh-workbench-sheets` | 工作台里的表格视图 |

## 怎么装

把目录放到 `~/dsh-plugins/`（路径随意，能读到就行），然后按目录装：

```sh
dsh plugin --profile desktop add ~/dsh-plugins/dsh-edit-diff
```

装完重启 DSH。有的插件带 `cordis.patch.yml`，需要按里面的说明往 profile 的补丁文件里加几行才会生效；这类插件的 README 里写了具体位置。

## 两个 fork

| 目录 | 上游 | 许可 |
| --- | --- | --- |
| `dsh-vscode-mode-fork` | [Lenonss/DSH_VsCodeMode](https://github.com/Lenonss/DSH_VsCodeMode) | MIT |
| `dsh-ntr-picker` | [GDWhisper/dsh-ntr](https://github.com/GDWhisper/dsh-ntr) | MIT |

这两个是我在上游基础上改的，改动为自己用，上游是 MIT 所以照许可带了 LICENSE。它们都是 TypeScript 工程，源码目录里没有 `lib/`，装之前要先装依赖并构建：

```sh
cd ~/dsh-plugins/dsh-vscode-mode-fork
npm install && npm run build
```

`dsh-vscode-mode-fork` 我还去掉了 `assets/vendor`（Monaco、pdfjs 这些第三方静态文件，十几 MB），构建脚本一般会自己补回来；补不回来就从上游拷。

## 注意

这些插件都是贴着 DSH 内部接口写的，**只在我这套环境（macOS · DSH 0.2.2-rc.5）验证过**。DSH 升级后接口一变就可能坏，坏了自己改，别指望能开箱即用。
