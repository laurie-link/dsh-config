/**
 * dsh-editor-context — Host 半路由与注册语义单测（不起 DSH 实例，用假 ctx/req/res）。
 *
 * 运行：cd ~/dsh-plugins/dsh-editor-context && node --test tests/*.test.mjs
 */
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearLatestReport, getLatestReport } from '../lib/context.js'
import { apply } from '../index.js'

/** 假 Cordis 上下文：只提供本插件用到的 effect/webServer/on/get/logger。 */
function fakeContext() {
  const routes = new Map()
  const listeners = []
  const ctx = {
    effect(factory) { return factory() },
    webServer: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
    on(event, handler) { listeners.push({ event, handler }) },
    get() { return undefined },
    logger: { warn() {} },
    routes,
    listeners,
  }
  return ctx
}

/** 模拟 IncomingMessage：handler 同步挂好 readBody 监听后再投喂 body。 */
function fakeRequest({ method = 'POST', url = '/editor-context/report', body = '' }) {
  const handlers = new Map()
  const req = {
    method,
    url,
    on(event, handler) { handlers.set(event, handler); return req },
    destroy() {},
  }
  const res = { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(text) { this.body = text } }
  /**
   * 先启动 handler（readBody 会在第一个 await 前同步注册 data/end 监听），再投喂 body；
   * 顺序反了 handler 会一直等 end。
   */
  const call = (route) => {
    const pending = route.handler(req, res)
    if (body) handlers.get('data')?.(Buffer.from(body))
    handlers.get('end')?.()
    return pending
  }
  return { req, res, call }
}

function setup() {
  const ctx = fakeContext()
  apply(ctx)
  return ctx
}

beforeEach(() => { clearLatestReport() })

test('apply：注册 report 与 state 两个精确路由，并监听 agent/created', () => {
  const ctx = setup()
  assert.ok(ctx.routes.has('/editor-context/report'))
  assert.ok(ctx.routes.has('/editor-context/state'))
  assert.deepEqual(ctx.listeners.map((item) => item.event), ['agent/created'])
})

test('POST /editor-context/report：合法上报写入快照并返回 ok', async () => {
  const ctx = setup()
  const { res, call } = fakeRequest({
    body: JSON.stringify({ sessionId: 'session-1', at: Date.now(), active: { path: 'src/a.ts' }, open: [{ label: 'a.ts', path: 'src/a.ts' }] }),
  })
  await call(ctx.routes.get('/editor-context/report'))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true })
  assert.equal(getLatestReport().active.path, 'src/a.ts')
})

test('POST /editor-context/report：坏 JSON 返回 400 且不覆盖已有快照', async () => {
  const ctx = setup()
  const first = fakeRequest({ body: JSON.stringify({ sessionId: 's', at: Date.now(), active: { path: 'keep.ts' } }) })
  await first.call(ctx.routes.get('/editor-context/report'))
  const second = fakeRequest({ body: '{not json' })
  await second.call(ctx.routes.get('/editor-context/report'))
  assert.equal(second.res.statusCode, 400)
  assert.equal(JSON.parse(second.res.body).ok, false)
  assert.equal(getLatestReport().active.path, 'keep.ts')
})

test('POST /editor-context/report：非 POST 返回 405', async () => {
  const ctx = setup()
  const { res, call } = fakeRequest({ method: 'GET' })
  await call(ctx.routes.get('/editor-context/report'))
  assert.equal(res.statusCode, 405)
})

test('GET /editor-context/state：无 sessionId 时 text 为 null，带 sessionId 时给出注入文本', async () => {
  const ctx = setup()
  const report = fakeRequest({ body: JSON.stringify({ sessionId: 'session-1', at: Date.now(), active: { path: 'src/a.ts', cursorLine: 4 } }) })
  await report.call(ctx.routes.get('/editor-context/report'))

  const plain = fakeRequest({ method: 'GET', url: '/editor-context/state' })
  await plain.call(ctx.routes.get('/editor-context/state'))
  assert.equal(plain.res.statusCode, 200)
  const plainBody = JSON.parse(plain.res.body)
  assert.equal(plainBody.ok, true)
  assert.equal(plainBody.text, null)
  assert.equal(plainBody.latest.active.path, 'src/a.ts')

  const withSession = fakeRequest({ method: 'GET', url: '/editor-context/state?sessionId=session-1' })
  await withSession.call(ctx.routes.get('/editor-context/state'))
  assert.match(JSON.parse(withSession.res.body).text, /Active file: src\/a\.ts \(cursor at line 4\)/)

  const otherSession = fakeRequest({ method: 'GET', url: '/editor-context/state?sessionId=someone-else' })
  await otherSession.call(ctx.routes.get('/editor-context/state'))
  assert.equal(JSON.parse(otherSession.res.body).text, '')
})

test('agent/created：缺失 session/systemPrompt 时静默跳过，不抛错', () => {
  const ctx = setup()
  const handler = ctx.listeners[0].handler
  assert.doesNotThrow(() => {
    handler({})
    handler({ agent: {} })
    handler({ agent: { session: { id: 's' }, ctx: { get: () => undefined } } })
    handler({ agent: { session: { id: 's' }, ctx: { get: () => ({}) } } })
  })
})

test('agent/created：给该 Agent 注册 name/order/text，text 返回当前会话上下文', () => {
  const ctx = setup()
  const report = fakeRequest({ body: JSON.stringify({ sessionId: 'session-1', at: Date.now(), active: { path: 'src/a.ts' }, view: 'cursor' }) })
  return report.call(ctx.routes.get('/editor-context/report')).then(() => {
    const registered = []
    const agentCtx = {
      get(name) {
        // 真实 DSH 里 ctx.get('agents') 可解析会话 cwd；这里用假服务覆盖该路径
        if (name === 'agents') return { get(id) { return id === 'session-1' ? { session: { header: { cwd: '/tmp/project' } } } : undefined } }
        if (name !== 'systemPrompt') return undefined
        return { context(options) { registered.push(options); return () => {} } }
      },
      effect() {},
    }
    ctx.listeners[0].handler({
      agent: {
        session: { id: 'session-1', header: { cwd: '/tmp/project' } },
        ctx: agentCtx,
      },
    })
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'editor-context')
    assert.equal(registered[0].order, 130)
    const text = registered[0].text()
    assert.match(text, /Active file: src\/a\.ts/)
    assert.match(text, /- View: cursor/)
    assert.match(text, /- Session working directory: \/tmp\/project/)
  })
})

test('POST /editor-context/report：官方侧栏推断的 active.source 原样保留并进入注入文本', async () => {
  const ctx = setup()
  const report = fakeRequest({
    body: JSON.stringify({
      sessionId: 'session-1',
      at: Date.now(),
      active: { path: '_dsh-preview-test/sample.xlsx', source: 'sheet' },
      open: [{ label: 'sample.xlsx', path: '' }, { label: 'sample.pdf', path: '' }],
    }),
  })
  await report.call(ctx.routes.get('/editor-context/report'))
  assert.equal(getLatestReport().active.source, 'sheet')

  const state = fakeRequest({ method: 'GET', url: '/editor-context/state?sessionId=session-1' })
  await state.call(ctx.routes.get('/editor-context/state'))
  const body = JSON.parse(state.res.body)
  assert.equal(body.latest.active.source, 'sheet')
  assert.match(body.text, /- Active file \(open in the editable spreadsheet tab\): _dsh-preview-test\/sample\.xlsx/)
  assert.match(body.text, /Open editor tabs: sample\.xlsx, sample\.pdf/)
})
