# DSH 配置分享

我在 Mac 上用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 DSH）配置：**插件清单 + 技能库 + 全局偏好**。

这份仓库是「配置快照」，不是一键安装包。里面**不含任何密钥、登录凭据和对话记录**，只有清单、说明和我自己写的规则文件。

- 环境：macOS · DSH `0.2.2-rc.5` · `desktop` profile
- 插件：46 个，清单与用途见 [PLUGINS.md](PLUGINS.md)
- 技能：5 个，在 [`skills/`](skills/)
- 全局偏好：根目录的 `AGENTS.md` 与 [`instructions/`](instructions/)

## 目录

```
AGENTS.md              全局偏好入口（只放永远生效的个人规则）
instructions/
  TOOLS.md             工具用法、技能挑选、回答里的组件怎么画
  personality.md       回答风格（语气、用词、配图、可视化）
skills/                技能库（每个目录一份 SKILL.md）
local-plugins/         15 个本地插件源码（含 2 个 fork）
PLUGINS.md             插件清单：名字、版本、干什么用、哪些是本地自建
```

## 怎么用

### 1. 装 DSH

```sh
npm i -g @deepseek-ai/dsh@latest
```

### 2. 放规则文件

把 `AGENTS.md` 放到 `~/.dsh/AGENTS.md`，`instructions/` 整个目录放到 `~/.dsh/instructions/`。

`instructions/` 里两份文件默认由个性化插件维护；不装插件也可以直接放进去，DSH 会读到。

### 3. 装插件

清单在 `PLUGINS.md`，按需挑。单装一个：

```sh
dsh plugin --profile desktop add <包名>
```

注意几点：

- **本地自建插件源码在 [`local-plugins/`](local-plugins/)**。清单里标「本地」的 15 个不在 npm 上，源码我放仓库里了，但要自己构建、有的还要往 profile 补丁里加几行才生效。
- **版本别乱跳**。插件和 DSH 版本有硬要求，装之前看一眼包里的要求。我这份是按 `0.2.2-rc.5` 配的。
- **按需装，别全装**。46 个是我长期用下来的结果，很多是特定工作流才用得到。

### 4. 放技能

把 `skills/` 里的目录复制到 `~/.agents/skills/`。技能是纯文本指令，不需要构建。

## 技能说明

| 技能 | 用途 |
| --- | --- |
| `dsh-profile-maintenance` | 维护 DSH 本机安装：装/升级插件、重打补丁、构建客户端插件、配置 MCP |
| `external-agent-delegate` | 把任务外派给 Codex / Cursor 等外部智能体，并验收合并结果 |
| `humanizer` | 让文本读起来更像人写的（第三方技能，许可见目录内 LICENSE） |
| `reverse-any-video` | 把一个视频复刻成可编辑工程，逐帧对照原片 |
| `style-sampling` | 照着一种已验证的视频风格做新的一集 |

## 关于本地自建插件

`PLUGINS.md` 里标「本地」的 15 个插件，是这套配置里最花时间的部分：编辑器式的改动栏、红绿 diff 卡片、回退快照、计划模式、压缩重试、会话搜索、图片渲染管线等。它们依赖对 DSH 内部接口的改动，**只在我这个版本上验证过**，所以没法发布成 npm 包。

源码全在 [`local-plugins/`](local-plugins/)，想看思路直接翻；想装的话按那份说明来，先构建、再补丁、再装。

## 许可

仓库里的说明文字和我自己写的规则文件随便用。`skills/humanizer` 是第三方技能，遵守它目录内的 LICENSE；其余技能为自用整理。
