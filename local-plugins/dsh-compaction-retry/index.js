/**
 * dsh-compaction-retry — Host half.
 *
 * 两件事：
 *   1. 让「会话压缩（compaction）的摘要请求」也走重试，和普通模型请求的重试机制一样
 *      （压缩的摘要是一直接 `ctx.llm.stream()` 调用，官方只尝试一次，不参与
 *      @deepseek-ai/dsh-llm-retry；于是上游偶发 429/5xx 会让自动压缩失败、切模型时
 *      整体报 MODEL_SWITCH_COMPACTION_FAILED）。
 *   2. 把压缩的实时状态通过 loopback 路由 `/compaction-retry/status` 暴露给浏览器半，
 *      让聊天输入框上方显示「正在压缩上下文…」（Codex 式提示），重试等待期间还会显示
 *      「上游限流，第 N 次重试（Xs 后继续）」。
 *
 * 压缩生命周期来自会话事件：`compaction/start` → `compaction/summary` → `compaction/end`
 * （dsh-compaction-basic 的事务标记）。切模型前的压缩由 `agent/request` 的 header 变化
 * 识别（`agent/request` 是 waterfall，本插件只做透传观察，不改变请求）。
 *
 * 策略字段与 dsh-llm-retry 的 normal mode 同名同义（mode / maxRetries / retryableCodes /
 * backoff）。宿主侧插件：新增/改动后需要重载宿主（新插件行会被热组合，改代码则看 HMR）。
 *
 * @author DSH local maintenance 2026-11-07
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Loader row name. */
export const name = 'compaction-retry'

/** 诊断路由需要 webServer；监听事件不需要额外的服务。 */
export const inject = ['webServer']

/** 与 dsh-llm-retry 默认 normal mode 相同的「可重试」错误码集合。 */
const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

/** 允许的配置键（拼错就 fail-fast，和官方插件的手感一致）。 */
const CONFIG_KEYS = new Set(['mode', 'maxRetries', 'retryableCodes', 'backoff', 'providerRetryAfter', 'retryWindowMs', 'log'])

/** 状态条目多久没进展就当作陈旧丢掉（压缩事务异常退出时的兜底）。 */
const STALE_ENTRY_MS = 30 * 60 * 1000

/** 切模型判定的时间窗：压缩必须在这个窗口内开始才算「切模型前的压缩」。 */
const SWITCH_WINDOW_MS = 30 * 1000

/** 配置错误的统一前缀。 */
function invalid(message) {
  throw new Error('compaction-retry: ' + message)
}

/** 非负整数（缺失时用默认值）。 */
function nonNegativeInteger(label, value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
    invalid(label + ' must be a non-negative integer')
  }
  return value
}

/** 正有限数（缺失时用默认值）。 */
function positiveNumber(label, value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    invalid(label + ' must be a positive finite number')
  }
  return value
}

/**
 * 校验并展开配置。
 * @param raw - Loader row 的 config（可省略）
 * @returns 规范化的策略对象
 */
function resolveConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (typeof source !== 'object' || Array.isArray(source)) invalid('config must be an object')
  for (const key of Object.keys(source)) {
    if (!CONFIG_KEYS.has(key)) invalid('unknown config key "' + key + '"')
  }
  const mode = source.mode === undefined ? 'normal' : source.mode
  if (mode !== 'normal' && mode !== 'always') invalid('mode must be "normal" or "always"')
  const maxRetries = nonNegativeInteger('maxRetries', source.maxRetries, 5)
  let retryableCodes = DEFAULT_RETRYABLE_CODES
  if (source.retryableCodes !== undefined) {
    if (!Array.isArray(source.retryableCodes)) invalid('retryableCodes must be an array of error codes')
    retryableCodes = source.retryableCodes.map((code) => String(code))
  }
  const backoff = source.backoff === undefined || source.backoff === null ? {} : source.backoff
  if (typeof backoff !== 'object' || Array.isArray(backoff)) invalid('backoff must be an object')
  for (const key of Object.keys(backoff)) {
    if (key !== 'initialDelayMs' && key !== 'maxDelayMs' && key !== 'jitterRatio') {
      invalid('unknown backoff key "' + key + '"')
    }
  }
  const initialDelayMs = positiveNumber('backoff.initialDelayMs', backoff.initialDelayMs, 500)
  const maxDelayMs = positiveNumber('backoff.maxDelayMs', backoff.maxDelayMs, 10000)
  if (maxDelayMs < initialDelayMs) invalid('backoff.maxDelayMs must be >= backoff.initialDelayMs')
  let jitterRatio = 0.1
  if (backoff.jitterRatio !== undefined) {
    if (typeof backoff.jitterRatio !== 'number' || !Number.isFinite(backoff.jitterRatio) || backoff.jitterRatio < 0 || backoff.jitterRatio > 1) {
      invalid('backoff.jitterRatio must be a number from 0 through 1')
    }
    jitterRatio = backoff.jitterRatio
  }
  if (source.providerRetryAfter !== undefined && typeof source.providerRetryAfter !== 'boolean') {
    invalid('providerRetryAfter must be a boolean')
  }
  if (source.log !== undefined && typeof source.log !== 'boolean') invalid('log must be a boolean')
  return {
    mode,
    maxRetries,
    retryableCodes,
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
    providerRetryAfter: source.providerRetryAfter !== false,
    retryWindowMs: nonNegativeInteger('retryWindowMs', source.retryWindowMs, 600000),
    log: source.log !== false,
  }
}

/**
 * 从错误链里取出可路由的失败事实。
 * `LlmError` 有 `.code` 与 `.failure`（`{ message, code, status, providerRetryAfterMs, requestId }`），
 * 外层还可能套着 `cause`。
 * @param error - summarizeWithLlm 抛出的错误
 * @returns 失败事实（缺失字段为空 / undefined）
 */
function failureOf(error) {
  const out = { code: '', status: undefined, providerRetryAfterMs: undefined, message: '' }
  const seen = new Set()
  let current = error
  while (current !== null && current !== undefined && !seen.has(current) && seen.size < 8) {
    seen.add(current)
    if (out.message === '' && typeof current.message === 'string' && current.message.length > 0) {
      out.message = current.message
    }
    if (out.code === '' && typeof current.code === 'string' && current.code.length > 0) out.code = current.code
    const facts = current.failure !== null && typeof current.failure === 'object' ? current.failure : null
    if (facts !== null) {
      if (out.code === '' && typeof facts.code === 'string' && facts.code.length > 0) out.code = facts.code
      if (out.status === undefined && typeof facts.status === 'number') out.status = facts.status
      if (out.providerRetryAfterMs === undefined && typeof facts.providerRetryAfterMs === 'number') {
        out.providerRetryAfterMs = facts.providerRetryAfterMs
      }
      if (out.message === '' && typeof facts.message === 'string' && facts.message.length > 0) {
        out.message = facts.message
      }
    }
    current = current.cause
  }
  return out
}

/** 本地指数退避 + 对称抖动（与 dsh-llm-retry 的 localDelay 同式）。 */
function localDelay(config, retry, random) {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

/**
 * 本次重试要等多久。
 * @returns 毫秒数；`-1` 表示正常模式下上游要等的时间超过上限，直接放弃（同 dsh-llm-retry）
 */
function delayFor(config, failure, retry, random) {
  const retryAfter = failure.providerRetryAfterMs
  if (config.providerRetryAfter && typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    if (retryAfter <= config.maxDelayMs) return retryAfter
    if (config.mode === 'normal') return -1
  }
  return localDelay(config, retry, random)
}

/**
 * 可取消的等待。
 * @param delayMs - 等待时长
 * @param signal - 取消信号（可为空）
 * @returns 等满了 true，被取消 false
 */
function cancellableWait(delayMs, signal) {
  if (signal !== undefined && signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try { signal.removeEventListener('abort', onAbort) } catch { /* 无 signal */ }
      resolve(value)
    }
    const onAbort = () => {
      clearTimeout(timer)
      finish(false)
    }
    const timer = setTimeout(() => finish(true), delayMs)
    try {
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    } catch { /* 无 signal */ }
  })
}

/** 日志文件路径（Windows / macOS / Linux 各取各的 HOME）。 */
function logPath() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(home, '.dsh', 'logs', 'compaction-retry.log')
}

/** compaction/summary-error payload → 会话键。 */
function sessionKeyOf(payload) {
  const session = payload === undefined || payload === null ? null : payload.session
  if (session !== null && typeof session === 'object' && typeof session.id === 'string' && session.id.length > 0) {
    return session.id
  }
  return '<session>'
}

/** 会话对象 → 会话键。 */
function sessionKeyOfSession(session) {
  if (session !== null && typeof session === 'object' && typeof session.id === 'string' && session.id.length > 0) {
    return session.id
  }
  return '<session>'
}

/**
 * Mount the compaction retry policy + the live status route.
 * @param ctx - plugin context that owns listeners, pending waits, and the route
 * @param rawConfig - Loader row config
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const file = logPath()
  /** sessionId → { retry, at }：连续失败的计数（超过 retryWindowMs 自动归零）。 */
  const retries = new Map()
  /** sessionId → 正在进行的压缩：{ compactionId, startedAt, switch, retry }。 */
  const running = new Map()
  /** sessionId → 最近一次检测到的模型切换：{ at, from, to }。 */
  const switches = new Map()
  /** 插件释放时中止所有等待。 */
  const lifetime = new AbortController()
  const write = (event) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event })
    if (config.log) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, line + '\n')
      } catch { /* 日志失败不影响重试 */ }
    }
    try { ctx.logger.info('compaction-retry: %s', line) } catch { /* ignore */ }
  }

  /** 丢掉超过 STALE_ENTRY_MS 没更新的压缩状态（事务异常退出时的兜底）。 */
  const pruneRunning = () => {
    const now = Date.now()
    for (const [key, entry] of running) {
      const touched = entry.retry !== null && typeof entry.retry.untilAt === 'number'
        ? Math.max(entry.startedAt, entry.retry.untilAt - entry.retry.delayMs)
        : entry.startedAt
      if (now - touched > STALE_ENTRY_MS) running.delete(key)
    }
    for (const [key, entry] of switches) {
      if (now - entry.at > SWITCH_WINDOW_MS) switches.delete(key)
    }
  }

  /** 压缩开始：记录状态，并把最近的模型切换信息带进去（切模型前的压缩提示用）。 */
  const onCompactionStart = (session, event) => {
    const key = sessionKeyOfSession(session)
    const data = event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' ? event.data : {}
    const pending = switches.get(key)
    const switched = pending !== undefined && Date.now() - pending.at <= SWITCH_WINDOW_MS ? pending : null
    running.set(key, {
      compactionId: typeof data.compactionId === 'string' ? data.compactionId : '',
      startedAt: Date.now(),
      switch: switched === null ? null : { from: switched.from, to: switched.to },
      retry: null,
    })
    if (switched !== null) switches.delete(key)
    write({ phase: 'compaction-start', session: key, switch: switched === null ? null : switched.from + ' -> ' + switched.to })
  }

  /** 压缩结束（成功或失败）：移除状态。 */
  const onCompactionEnd = (session, event) => {
    const key = sessionKeyOfSession(session)
    const data = event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' ? event.data : {}
    const failed = data.error !== undefined && data.error !== null
    running.delete(key)
    if (failed) write({ phase: 'compaction-failed', session: key, error: String((data.error && data.error.message) || data.error).slice(0, 200) })
  }

  /**
   * `compaction/summary-error` waterfall：可重试时等待后返回 true（引擎重试摘要请求），
   * 否则调用 next()（默认 false → 压缩失败照旧上报）。
   */
  const handle = async (payload, next) => {
    try {
      const signal = payload === undefined || payload === null ? undefined : payload.signal
      if (lifetime.signal.aborted) return next()
      if (signal !== undefined && signal.aborted) return next()
      const failure = failureOf(payload === undefined || payload === null ? undefined : payload.error)
      if (failure.code === '' || !config.retryableCodes.includes(failure.code)) {
        write({ phase: 'skip', code: failure.code, status: failure.status, message: failure.message.slice(0, 200) })
        return next()
      }
      const key = sessionKeyOf(payload)
      const now = Date.now()
      const previous = retries.get(key)
      let retry = previous !== undefined && now - previous.at <= config.retryWindowMs ? previous.retry : 0
      if (config.mode === 'normal' && retry >= config.maxRetries) {
        retries.delete(key)
        write({ phase: 'give-up', session: key, code: failure.code, status: failure.status, retry, maxRetries: config.maxRetries })
        return next()
      }
      retry += 1
      const delayMs = delayFor(config, failure, retry, Math.random)
      if (delayMs < 0) {
        write({ phase: 'give-up-retry-after', session: key, code: failure.code, providerRetryAfterMs: failure.providerRetryAfterMs })
        return next()
      }
      // 让状态路由能看到「正在重试」：压缩可能没有 compaction/start（异常路径），兜底建一条。
      let entry = running.get(key)
      if (entry === undefined) {
        entry = { compactionId: '', startedAt: now, switch: null, retry: null }
        running.set(key, entry)
      }
      entry.retry = {
        attempt: retry,
        delayMs: Math.round(delayMs),
        untilAt: now + Math.round(delayMs),
        code: failure.code,
        status: failure.status,
      }
      const fused = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
      write({
        phase: 'schedule',
        session: key,
        code: failure.code,
        status: failure.status,
        providerRetryAfterMs: failure.providerRetryAfterMs,
        retry,
        delayMs: Math.round(delayMs),
        message: failure.message.slice(0, 200),
      })
      const waited = await cancellableWait(delayMs, fused)
      if (!waited) {
        const current = running.get(key)
        if (current !== undefined && current.retry !== null && current.retry.attempt === retry) current.retry = null
        write({ phase: 'cancelled', session: key, retry })
        return next()
      }
      retries.set(key, { retry, at: Date.now() })
      write({ phase: 'retry', session: key, retry })
      return true
    } catch (error) {
      write({ phase: 'internal-error', error: String((error && error.message) || error).slice(0, 200) })
      return next()
    }
  }

  ctx.effect(() => {
    const dispose = ctx.on('compaction/summary-error', (payload, next) => handle(payload, next))
    return () => { try { dispose() } catch { /* ignore */ } }
  }, 'compaction-retry: retry failed compaction summaries')

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
        if (event.type === 'compaction/start') onCompactionStart(session, event)
        else if (event.type === 'compaction/end') onCompactionEnd(session, event)
        else if (event.type === 'turn/end' && running.size > 0) pruneRunning()
      } catch { /* 状态只服务 UI */ }
    })
    return () => { try { dispose() } catch { /* ignore */ } }
  }, 'compaction-retry: track compaction lifecycle for the status route')

  ctx.effect(() => {
    // 只做透传观察：agent/request 是 waterfall，必须把 next() 的结果原样返回。
    const dispose = ctx.on('agent/request', async (payload, next) => {
      const requestConfig = await next()
      try {
        const agent = payload === undefined || payload === null ? undefined : payload.agent
        const session = agent !== null && agent !== undefined && typeof agent === 'object' ? agent.session : undefined
        if (session !== undefined && session !== null && typeof session.requestHeader === 'function') {
          const previous = session.requestHeader()
          const previousConfig = previous !== undefined && previous !== null ? previous.config : undefined
          if (previousConfig !== undefined && previousConfig !== null && requestConfig !== undefined && requestConfig !== null) {
            const from = String(previousConfig.provider) + '/' + String(previousConfig.model)
            const to = String(requestConfig.provider) + '/' + String(requestConfig.model)
            if (from !== to) {
              switches.set(sessionKeyOfSession(session), { at: Date.now(), from, to })
              write({ phase: 'model-switch', session: sessionKeyOfSession(session), from, to })
            }
          }
        }
      } catch { /* 观察失败不影响请求 */ }
      return requestConfig
    })
    return () => { try { dispose() } catch { /* ignore */ } }
  }, 'compaction-retry: observe model switches (pass-through)')

  ctx.effect(() => {
    /** 客户端轮询计数：用来确认浏览器半确实挂载并在拉取状态。 */
    let polls = 0
    let lastPollAt = 0
    const handler = (req, res) => {
      try {
        polls += 1
        lastPollAt = Date.now()
        pruneRunning()
        const sessions = {}
        for (const [key, entry] of running) {
          sessions[key] = {
            compactionId: entry.compactionId,
            startedAt: entry.startedAt,
            switch: entry.switch,
            retry: entry.retry,
          }
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ at: new Date().toISOString(), polls, lastPollAt, sessions }))
      } catch (error) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(String(error))
      }
    }
    return ctx.webServer.register({ kind: 'exact', path: '/compaction-retry/status', handler })
  }, 'compaction-retry: status route')

  ctx.effect(() => () => {
    lifetime.abort(new Error('compaction-retry disposed'))
  }, 'compaction-retry: abort pending waits on dispose')

  write({
    phase: 'ready',
    mode: config.mode,
    maxRetries: config.maxRetries,
    retryableCodes: config.retryableCodes,
    initialDelayMs: config.initialDelayMs,
    maxDelayMs: config.maxDelayMs,
    jitterRatio: config.jitterRatio,
    providerRetryAfter: config.providerRetryAfter,
    logFile: file,
    statusRoute: '/compaction-retry/status',
  })
}
