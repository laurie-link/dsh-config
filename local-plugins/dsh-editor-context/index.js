/**
 * dsh-editor-context — Host half.
 *
 * 浏览器的 dsh-editor-context client 半把编辑器的实时状态 POST 到本机回环路由
 * `/editor-context/report`；这里按会话记住它，并在每个 Agent 创建时向该 Agent 的
 * systemPrompt 注册一条运行时上下文（runtime context）。模型每一步都会看到这段
 * 文字，但聊天记录里不会出现任何消息——行为对齐 Cursor 的 user context。
 *
 * 纯逻辑（规范化上报 / 渲染文本 / 快照状态）在 ./lib/context.js，便于 `node --test` 直测；
 * 本文件只负责路由与 agent/created 注册。
 *
 * 路由：
 *  POST /editor-context/report  上报快照（仅本机回环、无敏感数据）
 *  GET  /editor-context/state   诊断：返回最近一次上报与将要注入的文本
 *
 * 安全与失败策略：
 *  - 任何异常都不抛出到 agent/created（串行监听器抛错会否决会话创建）；
 *  - 文本过期（默认 30 分钟）后不再注入，避免陈旧的「当前文件」误导模型；
 *  - 未提供 systemPrompt 服务的旧版 DSH 静默跳过。
 */
import {
  CONTEXT_NAME,
  CONTEXT_ORDER,
  contextTextFor,
  getLatestReport,
  normalizeReport,
  setLatestReport,
} from './lib/context.js'

export const inject = ['webServer']

const MAX_BODY_BYTES = 256 * 1024

/** Agent 运行时上下文注册器（诊断用计数）。 */
const registrations = new Set()

// 保留对外的可测函数导出（旧代码与测试都可能直接引用宿主模块）。
export { normalizeReport, contextTextFor }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** 请求 URL 里的 sessionId 参数（没有则 undefined；坏 URL 不抛错）。 */
function sessionIdOf(req) {
  try {
    const url = new URL(String((req && req.url) || '/'), 'http://127.0.0.1')
    const value = url.searchParams.get('sessionId')
    return value === null || value === '' ? undefined : value
  } catch (error) {
    return undefined
  }
}

/** 会话工作目录（可选服务；拿不到返回空串，绝不影响注入）。 */
function sessionCwdOf(ctx, sessionId) {
  if (!sessionId) return ''
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    const header = agent && agent.session ? agent.session.header : undefined
    const cwd = header && header.cwd
    return typeof cwd === 'string' ? cwd : ''
  } catch (error) {
    return ''
  }
}

export function apply(ctx) {
  // 上报路由：浏览器半每 300ms 去抖后 POST 一次（变了才发）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/editor-context/report',
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return }
      try {
        const text = await readBody(req, MAX_BODY_BYTES)
        const report = normalizeReport(JSON.parse(text))
        if (report === null) { json(res, 400, { ok: false, error: 'bad report' }); return }
        setLatestReport(report)
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }), 'editor-context: report route')

  // 诊断路由：方便用 curl 验证上报与注入文本，不参与模型链路。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/editor-context/state',
    handler: (req, res) => {
      try {
        const sessionId = sessionIdOf(req)
        json(res, 200, {
          ok: true,
          latest: getLatestReport(),
          registrations: registrations.size,
          text: sessionId === undefined ? null : contextTextFor(sessionId, Date.now(), sessionCwdOf(ctx, sessionId)),
        })
      } catch (error) {
        json(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }), 'editor-context: state route')

  // 每个 Agent 创建时，把上下文注册进它自己的 systemPrompt 层：
  // agent.ctx 即该 Agent 的作用域上下文，注册随 Agent 销毁而释放。
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload && payload.agent
      const sessionId = agent && agent.session && agent.session.id
      const agentCtx = agent && agent.ctx
      if (!sessionId || !agentCtx) return
      const systemPrompt = typeof agentCtx.get === 'function' ? agentCtx.get('systemPrompt') : undefined
      if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') return
      // cwd 在 Agent 创建时取一次即可（会话工作目录不会中途变化），用于文本里的路径说明。
      const cwd = sessionCwdOf(agentCtx, sessionId)
      const disposer = systemPrompt.context({
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text: () => contextTextFor(sessionId, Date.now(), cwd),
      })
      registrations.add(disposer)
      agentCtx.effect(() => () => { registrations.delete(disposer) }, 'editor-context: prompt registration bookkeeping')
    } catch (error) {
      try { ctx.logger && ctx.logger.warn && ctx.logger.warn('editor-context: agent/created 挂载失败: ' + String((error && error.message) || error)) } catch {}
    }
  })
}
