# dsh-compaction-retry

两件事：

1. **压缩摘要请求重试**：DSH 普通模型请求由 `@deepseek-ai/dsh-llm-retry` 在 `agent/request-error`
   边界按提供方 `retryPolicy` 重试；而会话压缩的摘要是一次**直接 `ctx.llm.stream()`** 调用
   （`dsh-compaction-basic`），官方只尝试一次、不参与重试。上游偶发 429/5xx 时压缩失败：
   自动压缩只能等下一轮，切模型时整体报 `MODEL_SWITCH_COMPACTION_FAILED`。本插件挂在压缩引擎
   的 `compaction/summary-error` waterfall 上，可重试错误 → 退避后返回 `true`，引擎重新准备输入
   并重试摘要。
2. **Codex 式「正在压缩」提示**（客户端半）：对话输入框上方显示
   「正在压缩上下文…（切换 xxx 前的准备 · 已用 Ns · 上游限流，第 N 次重试（约 Xs 后继续））」，
   数据来自宿主半的 loopback 路由 `GET /compaction-retry/status`（约 600ms 轮询，页面隐藏时跳过，
   按会话过滤）。压缩进行中（自动压力压缩 / 切模型前压缩 / `/compact`）都能看到，结束后自动消失。

## 策略（与 dsh-llm-retry 的 retryPolicy 同名同义）

```yaml
- id: compaction-retry
  config:
    mode: normal                 # normal | always
    maxRetries: 1000             # normal 模式重试上限（不含第一次）
    retryableCodes: [TRANSPORT, RATE_LIMIT, SERVER, TIMEOUT, EMPTY_RESPONSE]
    backoff:
      initialDelayMs: 5000
      maxDelayMs: 60000
      jitterRatio: 0.2
    providerRetryAfter: true     # 优先用上游 Retry-After
    retryWindowMs: 600000        # 连续失败计数多久后归零
    log: true                    # 写 ~/.dsh/logs/compaction-retry.log
```

默认值（`cordis.patch.yml` 里）对齐本机 opencode-go 的 `retryPolicy`，所以压缩失败时的等待/重试
行为与普通请求一致。

## 观测

- `~/.dsh/logs/compaction-retry.log`：`ready` / `compaction-start` / `model-switch` /
  `schedule` / `retry` / `skip` / `give-up` / `compaction-failed` 等相位。
- `GET /compaction-retry/status`：`{ polls, sessions: { <sessionId>: { compactionId, startedAt,
  switch, retry } } }`（`polls` 增长说明浏览器半在正常轮询）。
- 客户端：多语言无关的中文文案，跟随 dock 座位渲染。

## 安装 / 生效

宿主半改动：在插件管理里禁用再启用该 bundle（或用 HMR），新代码即生效；新增客户端半时 DSH 的
client HMR 会自动挂载（无需刷新，必要时 Ctrl+R）。首次安装需要把它加进 profile 的
`dependencies` 与 `dsh.profile.bundles`（本机已做）。

## 测试

```sh
node --check index.js && node --check client.js
node --test tests/smoke.test.mjs
```