import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'

/** 最小 cordis ctx 桩：on / effect / logger / webServer；effect 立即执行并记住 disposer。 */
function harness(config) {
  const listeners = new Map()
  const routes = []
  const disposers = []
  const info = []
  const ctx = {
    logger: { info: (format, line) => { info.push(line) } },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {
        const list = listeners.get(event) || []
        const at = list.indexOf(listener)
        if (at >= 0) list.splice(at, 1)
      }
    },
    effect(run) {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  apply(ctx, config)
  const first = (event) => {
    const list = listeners.get(event) || []
    assert.ok(list.length > 0, `${event} listener registered`)
    return list[0]
  }
  const status = () => {
    const route = routes.find((entry) => entry.path === '/compaction-retry/status')
    assert.ok(route, 'status route registered')
    let body = ''
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { body = text },
    }
    route.handler({ method: 'GET' }, res)
    assert.equal(res.statusCode, 200)
    return JSON.parse(body)
  }
  return { first, status, disposers, info, routes, listeners }
}

/** 假的一个 LlmError：code + failure 事实。 */
function llmFailure(code, extra = {}, message = `provider rejected with ${code}`) {
  const error = new Error(message)
  error.code = code
  error.failure = { message, code, ...extra }
  return error
}

function payloadOf(error, overrides = {}) {
  return { session: { id: 'session-test' }, error, ...overrides }
}

/** 一个假 session：足够 sessionKeyOfSession 用。 */
const SESSION = { id: 'session-test' }

/** 触发一次会话事件（宿主事件签名 (session, event)）。 */
function fireSessionEvent(harnessRef, type, data = {}) {
  harnessRef.first('session/event')(SESSION, { type, data })
}

const FAST = { backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }, log: false }

test('module exports the loader contract', () => {
  assert.equal(name, 'compaction-retry')
  assert.deepEqual(inject, ['webServer'])
})

test('non-retryable failures fall through to next()', async () => {
  const h = harness(FAST)
  const next = () => 'NEXT'
  const result = await h.first('compaction/summary-error')(payloadOf(llmFailure('UNSUPPORTED_CONTENT')), next)
  assert.equal(result, 'NEXT')
})

test('retryable RATE_LIMIT asks the engine to retry (returns true)', async () => {
  const h = harness({ ...FAST, maxRetries: 3 })
  const next = () => 'NEXT'
  const result = await h.first('compaction/summary-error')(payloadOf(llmFailure('RATE_LIMIT', { status: 429 })), next)
  assert.equal(result, true)
})

test('honours providerRetryAfterMs when the provider sends Retry-After', async () => {
  const h = harness({ ...FAST, backoff: { initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0 } })
  const next = () => 'NEXT'
  const startedAt = Date.now()
  const result = await h.first('compaction/summary-error')(payloadOf(llmFailure('RATE_LIMIT', { providerRetryAfterMs: 20 })), next)
  const elapsed = Date.now() - startedAt
  assert.equal(result, true)
  assert.ok(elapsed >= 15, `waited at least the Retry-After budget (took ${elapsed}ms)`)
  assert.ok(elapsed < 400, `did not fall back to the 500ms local backoff (took ${elapsed}ms)`)
})

test('normal mode gives up after maxRetries consecutive failures', async () => {
  const h = harness({ ...FAST, mode: 'normal', maxRetries: 1 })
  const next = () => 'NEXT'
  const listener = h.first('compaction/summary-error')
  assert.equal(await listener(payloadOf(llmFailure('RATE_LIMIT')), next), true)
  assert.equal(await listener(payloadOf(llmFailure('RATE_LIMIT')), next), 'NEXT')
})

test('always mode keeps retrying past maxRetries', async () => {
  const h = harness({ ...FAST, mode: 'always', maxRetries: 0 })
  const next = () => 'NEXT'
  const listener = h.first('compaction/summary-error')
  assert.equal(await listener(payloadOf(llmFailure('SERVER')), next), true)
  assert.equal(await listener(payloadOf(llmFailure('SERVER')), next), true)
})

test('an aborted signal does not start a retry', async () => {
  const h = harness(FAST)
  const controller = new AbortController()
  controller.abort()
  const result = await h.first('compaction/summary-error')(payloadOf(llmFailure('RATE_LIMIT'), { signal: controller.signal }), () => 'NEXT')
  assert.equal(result, 'NEXT')
})

test('aborting during the backoff wait returns next()', async () => {
  const h = harness({ ...FAST, backoff: { initialDelayMs: 200, maxDelayMs: 200, jitterRatio: 0 } })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const result = await h.first('compaction/summary-error')(payloadOf(llmFailure('RATE_LIMIT'), { signal: controller.signal }), () => 'NEXT')
  assert.equal(result, 'NEXT')
})

test('a retryable Retry-After above maxDelayMs gives up in normal mode', async () => {
  const h = harness({ ...FAST, backoff: { initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 } })
  const result = await h.first('compaction/summary-error')(payloadOf(llmFailure('RATE_LIMIT', { providerRetryAfterMs: 60_000 })), () => 'NEXT')
  assert.equal(result, 'NEXT')
})

test('reads failure facts from the cause chain too', async () => {
  const inner = llmFailure('RATE_LIMIT', { status: 429 })
  const outer = new Error('wrapped')
  outer.cause = inner
  const h = harness(FAST)
  assert.equal(await h.first('compaction/summary-error')(payloadOf(outer), () => 'NEXT'), true)
})

test('unknown config keys and bad values fail fast', () => {
  assert.throws(() => harness({ nope: 1 }), /unknown config key/)
  assert.throws(() => harness({ mode: 'sometimes' }), /mode must be/)
  assert.throws(() => harness({ maxRetries: -1 }), /maxRetries must be/)
  assert.throws(() => harness({ backoff: { initialDelayMs: 0 } }), /initialDelayMs must be/)
  assert.throws(() => harness({ backoff: { maxDelayMs: 1, initialDelayMs: 2 } }), /maxDelayMs must be/)
})

test('disposal aborts a pending backoff', async () => {
  const h = harness({ ...FAST, backoff: { initialDelayMs: 500, maxDelayMs: 500, jitterRatio: 0 } })
  setTimeout(() => { for (const dispose of h.disposers) dispose() }, 20)
  const startedAt = Date.now()
  const result = await h.first('compaction/summary-error')(payloadOf(llmFailure('RATE_LIMIT')), () => 'NEXT')
  assert.equal(result, 'NEXT')
  assert.ok(Date.now() - startedAt < 400, 'disposal interrupted the wait')
})

test('status route tracks compaction start/end and shows retry progress', async () => {
  const h = harness({ ...FAST, backoff: { initialDelayMs: 40, maxDelayMs: 40, jitterRatio: 0 } })
  assert.deepEqual(Object.keys(h.status().sessions), [])
  fireSessionEvent(h, 'compaction/start', { compactionId: 'c1' })
  const started = h.status()
  assert.ok(started.sessions['session-test'], 'running compaction exposed')
  assert.equal(started.sessions['session-test'].compactionId, 'c1')
  assert.equal(started.sessions['session-test'].retry, null)

  const pending = h.first('compaction/summary-error')(payloadOf(llmFailure('RATE_LIMIT', { status: 429 })), () => 'NEXT')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const during = h.status()
  assert.ok(during.sessions['session-test'].retry, 'retry progress exposed while waiting')
  assert.equal(during.sessions['session-test'].retry.attempt, 1)
  assert.equal(during.sessions['session-test'].retry.code, 'RATE_LIMIT')
  assert.equal(await pending, true)

  fireSessionEvent(h, 'compaction/end', { compactionId: 'c1' })
  assert.deepEqual(Object.keys(h.status().sessions), [])
})

test('status route marks a compaction started right after a model switch', async () => {
  const h = harness(FAST)
  const agent = {
    session: {
      id: 'session-test',
      requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' } }),
    },
  }
  const next = async () => ({ provider: 'acp/cursor', model: 'composer-2.5' })
  const returned = await h.first('agent/request')({ agent }, next)
  assert.deepEqual(returned, { provider: 'acp/cursor', model: 'composer-2.5' })
  fireSessionEvent(h, 'compaction/start', { compactionId: 'c2' })
  const entry = h.status().sessions['session-test']
  assert.ok(entry, 'compaction exposed')
  assert.deepEqual(entry.switch, { from: 'deepseek-account/deepseek-v4.1-flash', to: 'acp/cursor/composer-2.5' })
})
