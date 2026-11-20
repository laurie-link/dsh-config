# dsh-enter-plan-mode

给 DSH 补上 Claude Code 的 `EnterPlanMode`：模型自己判断任务该先规划时，可以主动把会话切进计划模式；退出仍然只由用户决定。

## 行为

- 新增模型侧工具 `enter_plan_mode`（无参数）。调用后走 `ctx.planMode.set(agent, true)`，切换从**下一步**生效——那一步开始出现计划模式指引和受审核的 `exit_plan_mode`。
- 退出仍然只能由用户决定：`exit_plan_mode` 弹计划审核（Approve / Keep planning），`/plan off` 由用户手动执行。没有任何工具能让模型自己取消计划模式（和 Claude Code 一致）。
- 已在计划模式里再调用：返回 `changed: false`，不会重复切换。
- 子代理不提供这个工具：子代理没有能批准计划的用户，进去会卡住。
- 抑制了 plan-mode 服务自带的一句错误叙述：模型自己切进去时，原本会向对话注入 “The user switched this session to plan mode.”。本插件只对**自己触发的这次切换**屏蔽（在控制器原型上按 session 打一次性标记，卸载即还原），用户用 `/plan` 切换时照常播报。

## 实现要点

- **不能在根上下文等 `planMode` 服务**：plan-mode 在 `@deepseek-ai/dsh-base` 里是 `include:plan-mode` 一行，桌面 profile 默认 `enabled: false` 挂在根上；真正生效的实例在每个 Agent 预设的作用域里。所以插件只 `inject: ['tools']`，执行/注册时用 `agent.ctx.planMode ?? ctx.get('planMode')` 惰性解析；解析不到就不注册工具（`when` 门控），执行时也再兜底报错。
- **工具输出 schema 用数组式 `required`**：DSH 的工具 schema 校验报过 `schema.properties.active.required is not supported on type "boolean"`，`required` 必须写在对象层 `required: ['active', 'changed']`。

## 和 Claude Code 的一处差异

Claude Code 的 plan mode 会硬性拦住编辑工具；DSH 的计划模式是**行为契约**（系统提示里明确「不要改文件、不要跑格式化/提交」，`exit_plan_mode` 是唯一出口），工具目录不变，不强制拦截。这个插件只补齐「自己进 / 不能自己出」的自主性语义，不改变 DSH 原有的软约束设计。

## 安装 / 重载

本地 bundle，已 `link:` 到 desktop profile（`~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles`）：

```bash
dsh plugin add /Users/laruielaurence/dsh-plugins/dsh-enter-plan-mode
```

改完 `index.js` 后让宿主重新加载该行（本次是关再开一次）：

```
plugin_manager set_plugin { target: 'include:enter-plan-mode', enabled: false }
plugin_manager set_plugin { target: 'include:enter-plan-mode', enabled: true }
```

卸载：`dsh plugin remove dsh-enter-plan-mode`（同时从 profile bundles 移除）。

## 验证状态（2026-11-19）

- `include:enter-plan-mode` 行 `fiberPhase: active`，`application: applied`。
- `Tool.listTools` 里已出现 `enter_plan_mode`，`parameters` 为空对象、输出 schema 带 `required: ['active','changed']`——说明 `when` 门控在 Agent 作用域解析到了 plan-mode 控制器。
- 端到端（真正切进计划模式、exit 审核）留待用户首次触发时确认。

## 文件

- `index.js` — 宿主插件：注册工具、子代理门控、惰性解析 plan-mode、叙述抑制
- `cordis.patch.yml` — 插入一行 `enter-plan-mode`
- `locale/en.json`、`locale/zh.json` — 插件市场里的标题与描述
- `icon.svg` — 插件图标
