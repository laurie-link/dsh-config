/**
 * dsh-workbench-sheets — Host half。
 *
 * 职责：为官方右侧 Sidebar 里的表格页签提供本地回环读写路由。
 *  1. GET  /workbench-sheets/file?sessionId=&path=  读取 CSV/TSV/XLSX → 契约 JSON
 *  2. POST /workbench-sheets/save                   校验版本后写回原文件（CSV 整表 / XLSX 只 diff）
 *  3. GET  /workbench-sheets/ping                   存活探针（保留）
 *
 * 设计约束：
 *  - 只接受 loopback 同源请求（DSH webServer 自身即 localhost）；
 *  - 不注册模型工具、不注入系统提示；
 *  - 相对路径依赖会话 cwd：agents/sessions/workingDirectory 都是「可选探测」，
 *    拿不到时返回可读错误，绝不让插件因旧版 DSH 缺服务而加载失败。
 */
import { toHttpError, wbError } from './lib/errors.js'
import { extKind, isAbsolutePath, resolveTargetPath } from './lib/paths.js'
import { MAX_BODY_BYTES } from './lib/limits.js'
import { readSheetFile, saveCsvFile, saveXlsxFile } from './lib/sheetIo.js'

export const inject = ['webServer']

/** 读取请求体（超限直接 413，不把内存打满）。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(wbError(413, 'body_too_large', '请求体过大，无法保存'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** 请求 URL（只用于取 query；host 由 webServer 固定为 loopback）。 */
function requestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

function queryValue(url, name) {
  const value = url.searchParams.get(name)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 安全探测一个服务（ctx.get 在服务未注册时可能抛错）。 */
function serviceOf(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** 从 session 对象取「当前工作目录」：优先 workingDirectory 投影（跟随会话内 cd），回落 header.cwd。 */
function cwdOfSession(ctx, session) {
  if (!session) return null
  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  if (workingDirectory && typeof workingDirectory.get === 'function') {
    try {
      const current = workingDirectory.get(session)
      if (typeof current === 'string' && current !== '') return current
    } catch {
      // 投影未就绪/会话已销毁：回落到 header.cwd
    }
  }
  const headerCwd = session.header && session.header.cwd
  return typeof headerCwd === 'string' && headerCwd !== '' ? headerCwd : null
}

/**
 * 解析会话工作目录（相对路径用）。
 * 顺序：agents 服务 → sessions 服务；都拿不到就返回 null（宁可报错，不猜目录写错文件）。
 * 没有 sessionId 时才用 workingDirectory.defaultDirectory 兜底（绝对路径本身不需要 cwd）。
 * @returns {string|null} 绝对路径；拿不到返回 null（调用方转成可读错误）
 */
export function sessionCwd(ctx, sessionId) {
  if (sessionId) {
    const agents = serviceOf(ctx, 'agents')
    if (agents && typeof agents.get === 'function') {
      try {
        const agent = agents.get(sessionId)
        const cwd = cwdOfSession(ctx, agent && agent.session)
        if (cwd) return cwd
      } catch {
        // 换下一个候选
      }
    }
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions && typeof sessions.get === 'function') {
      try {
        const cwd = cwdOfSession(ctx, sessions.get(sessionId))
        if (cwd) return cwd
      } catch {
        // 换下一个候选
      }
    }
    return null
  }
  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  if (workingDirectory) {
    try {
      const fallback = typeof workingDirectory.defaultDirectory === 'function'
        ? workingDirectory.defaultDirectory()
        : workingDirectory.defaultDirectory
      if (typeof fallback === 'string' && fallback !== '') return fallback
    } catch {
      // 没有默认目录
    }
  }
  return null
}

/** 把 (sessionId, path) 解析成宿主绝对路径。 */
function resolveRequestPath(ctx, sessionId, rawPath) {
  const cwd = isAbsolutePath(String(rawPath || '')) ? null : sessionCwd(ctx, sessionId)
  return resolveTargetPath(rawPath, cwd)
}

/** 由后缀得到 kind，非法后缀给可读错误。 */
function requireKind(absPath) {
  const kind = extKind(absPath)
  if (!kind) throw wbError(400, 'unsupported', '暂不支持该文件类型（仅支持 .csv / .tsv / .xlsx）')
  return kind
}

/** GET /workbench-sheets/file */
async function handleRead(ctx, req, res) {
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: '该路由只接受 GET', code: 'method_not_allowed' })
    return
  }
  const url = requestUrl(req)
  const absPath = resolveRequestPath(ctx, queryValue(url, 'sessionId'), queryValue(url, 'path'))
  const kind = requireKind(absPath)
  const data = await readSheetFile(absPath, kind)
  json(res, 200, data)
}

/** POST /workbench-sheets/save */
async function handleSave(ctx, req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: '该路由只接受 POST', code: 'method_not_allowed' })
    return
  }
  const rawBody = await readBody(req, MAX_BODY_BYTES)
  let body
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch {
    throw wbError(400, 'bad_json', '请求体不是合法 JSON')
  }
  if (body === null || typeof body !== 'object') throw wbError(400, 'bad_json', '请求体必须是对象')
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  const absPath = resolveRequestPath(ctx, sessionId, body.path)
  const kind = requireKind(absPath)
  if (body.kind !== undefined && body.kind !== kind) {
    throw wbError(400, 'kind_mismatch', '请求里的 kind 与文件扩展名不一致')
  }
  const expected = { mtimeMs: body.mtimeMs, size: body.size }
  if (kind === 'xlsx') {
    const result = await saveXlsxFile(absPath, body.edits, expected)
    json(res, 200, result)
    return
  }
  const result = await saveCsvFile(absPath, kind, body.rows, expected)
  json(res, 200, result)
}

/** 把 handler 的异常统一转成 JSON 错误（不泄漏堆栈）。 */
function guarded(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const { status, body } = toHttpError(error)
      try {
        json(res, status, body)
      } catch {
        // 响应已断开时忽略
      }
    }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/workbench-sheets/ping',
    handler: guarded((req, res) => {
      json(res, 200, { ok: true, at: new Date().toISOString(), plugin: 'dsh-workbench-sheets' })
    }),
  }), 'workbench-sheets: ping route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/workbench-sheets/file',
    handler: guarded((req, res) => handleRead(ctx, req, res)),
  }), 'workbench-sheets: file route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/workbench-sheets/save',
    handler: guarded((req, res) => handleSave(ctx, req, res)),
  }), 'workbench-sheets: save route')
}
