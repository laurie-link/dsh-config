---
name: external-agent-delegate
description: >-
  把任务外派给真实的 Codex 或 Cursor 智能体，并在结果回来后验收合并。用于用户说「派 codex 去干」「让 cursor 做这个」「找个第三方子代理/外援处理」，或需要 Codex/Cursor 的独立实现、第二意见、批量长任务、跨厂商交叉验证时。也说明何时该用原生团队成员而不是外援。
---

# 外派第三方智能体（Codex / Cursor）

DSH 里外部 agent 只能当**一次性外援**，不能当团队成员。选错通道会浪费上下文和配额。

## 先选通道

| 需求 | 用哪个 |
|---|---|
| 成员要记住之前的工作、能随时插话、上共享任务板、继承我们的对话上下文 | `spawn_teammate`（原生成员；`context: fork` 才好继承 Lead 历史） |
| 一次性把一件事交给真的 Codex/Cursor 跑，拿回最终答案 | `subagent_codex` / `subagent_cursor` 工具 |
| 多个独立子任务并行、每个都要跑完整 agent 循环 | `workflow` + `parallel`（内部子代理）或串联 `subagent_*` |
| 官方 subagent 工具不可用（未挂载/报 unknown tool） | 退化到 `codex exec` / `cursor-agent -p`（见文末），但要自己收尾 |

**外部 agent 的关键事实**（ACP/Codex 协议层决定，不是配置问题）：
- 每次调用都是**全新进程 + 全新会话**，不继承父会话历史、工具、技能、权限策略，也不复用 prompt cache。
- 只能执行一次：没有 `send_message` 续聊、没有冷恢复、不参与团队 roster / 任务板。
- 它只拿到任务文本 + 工作目录（cwd），答案通过完成通知回到父会话。
- 它的 token 独立计费；它自己的工具调用/推理不会进入我们的上下文。

## 任务包必须自包含

外援看不到我们这段对话。派活前先写完整任务包，缺一项就大概率跑偏：

1. **目标**：一句话说清交付物（文件改哪、跑通什么、输出什么）。
2. **仓库/目录**：绝对路径 + 分支/工作区状态（是否允许它新建分支、会不会有并发写入）。
3. **相关文件**：明确列路径，别让它自己猜；必要时先 `read` 确认行号和现状。
4. **约束**：不许改的文件、必须保持的接口/行为、代码风格、测试命令。
5. **验收标准**：可执行（`npm test`、`cargo check`、具体用例）或可核对（diff 只动哪几个文件）。
6. **输出格式**：要求它返回「改动摘要 + 验收命令输出 + 未解决项」，禁止只回「已完成」。

## 调用与验收

1. `subagent_codex` / `subagent_cursor` 立即返回 child id，**不阻塞**；结果稍后以完成通知到达父会话。
2. 等通知期间可以继续做别的活；不要反复轮询同一件事。
3. 结果回来后必须自己验收：
   - `git status` / `git diff` 看它到底动了什么；
   - 跑验收命令，别信它的自述；
   - 检查有没有夹带无关改动、被吞掉的测试、临时调试代码。
4. 不通过就带着具体 diff 再派一轮（新的一次性任务），或在本地直接修。
5. 汇总结论写进对话，别把它的原文当结论转述。

## 并发与安全

- 同一工作区让多个外援同时写会互相覆盖：要么分目录/分文件，要么串行派。
- 限制写范围：Codex 用 `permissionMode`（`approve-for-me`/`dangerously-bypass-approvals-and-sandbox` 才允许改文件）；Cursor ACP 的 `permission` 配成 `allow_once` 才会自动批准。
- 外援跑得慢（30 秒~数分钟）属正常；长任务优先用后台任务而不是前台等。

## 退化路径（工具没挂上时）

```bash
# Codex
codex exec --skip-git-repo-check -m gpt-6-luna "<任务包>"
# Cursor（未信任目录需加 --trust）
cursor-agent -p --mode=ask --trust --model composer-2.5 "<任务包>"
```

这类 CLI 调用同样是一次性、不共享上下文；用完检查 `git status`，长任务放后台 job 跑。

## 这两个工具的实现现状（2026-11-05 实测）

- `subagent_cursor` → ACP 提供方直接驱动 `cursor-agent acp`，实测返回 `CURSOR-SUBAGENT-OK`。
- `subagent_codex` → 走 ACP 桥接 `npx -y @agentclientprotocol/codex-acp`（驱动系统 codex 0.166），实测返回 `CODEX-ACP-SUBAGENT-OK`。
- 官方 `@deepseek-ai/dsh-subagent-codex` bundle **已停用**：它内置 `@openai/codex` 0.153.4，对当前 ChatGPT 账号太旧，gpt-6-luna / gpt-5.5 / gpt-5.4 全部 400 model_not_found，会在 turn 阶段 product-error。不要重新启用它来排查，除非官方升级内置 codex 版本。
- 两个工具都是 external one-shot：不接受后续消息；首次调用 codex 可能因为 npx 拉包慢 30~60 秒，属正常。

## 已知限制（别反复重新验证）

- 官方 `@deepseek-ai/dsh-subagent-acp` / `-codex` 都是 external（one-shot）后端，不接受后续消息。
- 智能体团队的 roster 只收 **continuable** 子级（本地 in-process agent），因此成员不可能是 Cursor/Codex；provider 层无法改变，因为 continuable 分支由管理器自己物化本地 agent，provider 只能给 seed。
- 想让外部 agent 真正「共享上下文」，只能靠任务包把上下文写进去；没有 token 级共享方案。
