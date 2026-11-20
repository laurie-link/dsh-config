/**
 * dsh-edit-diff — 宿主半。
 *
 * 只做一件事：把「改动卡片要显示绝对行号」需要的那份文件文本读出来，交给浏览器半。
 *
 *   GET /edit-diff/file?path=<绝对路径或相对路径>&cwd=<会话工作目录>
 *     → { ok: true, path, text, truncated }
 *     → { ok: false, reason }
 *
 * 为什么不在浏览器半想办法：diff 卡片拿到的只有 meta.diffs 的 `{path, oldText, newText}`，
 * 没有行号；要显示和 Cursor 一样的行号、并且点击时能跳到具体行，就得知道这段改动落在
 * 文件的第几行。edit 的 old_string / new_string 是文件里的连续片段，用它去文件里定位
 * 就能反推出绝对行号，定位失败就退化成「不显示行号」（卡片本身照常渲染）。
 *
 * 读文件走 node:fs：宿主进程本来就是用户权限，且本机策略是 danger-full-access。
 * 大小上限 512KB，超了只回前 512KB（truncated: true）；二进制不返回文本。
 *
 * @author DSH local maintenance 2026-11-18
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Loader row name. */
export const name = 'edit-diff'

/** 只需要 loopback 路由。 */
export const inject = ['webServer']

/** 单个文件最多读这么多字节。 */
const MAX_BYTES = 512 * 1024

/** UTF-8 判定时前面看这么多字节。 */
const SNIFF_BYTES = 4096

/** 展开 `~/` 与 `~`。 */
function expandHome(raw) {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return homedir() + raw.slice(1)
  return raw
}

/** 把请求里的 path + cwd 解析成一个绝对路径。 */
function absolutePath(rawPath, rawCwd) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null
  const expanded = expandHome(rawPath.trim())
  if (isAbsolute(expanded)) return expanded
  const cwd = typeof rawCwd === 'string' && rawCwd.trim() !== '' ? expandHome(rawCwd.trim()) : null
  if (cwd === null || !isAbsolute(cwd)) return null
  return resolve(cwd, expanded)
}

/** 看起来像二进制吗（NUL 字节）。 */
function looksBinary(buffer) {
  const end = Math.min(buffer.length, SNIFF_BYTES)
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

/** 统一的 JSON 响应。 */
function respond(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * 读文件路由。
 * @param req - Node 请求
 * @param res - Node 响应
 */
async function handle(req, res) {
  let url = null
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1')
  } catch (error) {
    respond(res, 400, { ok: false, reason: 'bad-url' })
    return
  }
  const target = absolutePath(url.searchParams.get('path'), url.searchParams.get('cwd'))
  if (target === null) {
    respond(res, 400, { ok: false, reason: 'missing-path' })
    return
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      respond(res, 404, { ok: false, reason: 'not-a-file' })
      return
    }
    const handle = await readFile(target)
    if (looksBinary(handle)) {
      respond(res, 200, { ok: false, reason: 'binary' })
      return
    }
    const truncated = handle.length > MAX_BYTES
    const slice = truncated ? handle.subarray(0, MAX_BYTES) : handle
    respond(res, 200, { ok: true, path: target, text: slice.toString('utf8'), truncated })
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'read-failed'
    respond(res, 404, { ok: false, reason: code })
  }
}

/** 诊断日志目录 + 文件。 */
const LOG_DIR = join(homedir(), '.dsh', 'logs')

/** 诊断日志文件。 */
const LOG_FILE = join(LOG_DIR, 'dsh-edit-diff.log')

/**
 * 诊断路由：浏览器半启动 / 注册结果打一行到日志，用来确认客户端插件真的加载了。
 * 宿主路由只接受 GET / HEAD，所以诊断信息全部走 query。
 * @param req - Node 请求
 * @param res - Node 响应
 */
async function handlePing(req, res) {
  let url = null
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1')
  } catch (error) {
    respond(res, 400, { ok: false, reason: 'bad-url' })
    return
  }
  const body = url.search.slice(1).replace(/&/g, ' ').slice(0, 2000)
  const line = new Date().toISOString() + ' ' + body + '\n'
  try {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(LOG_FILE, line, 'utf8')
  } catch (error) {
    respond(res, 200, { ok: false, reason: 'log-failed' })
    return
  }
  respond(res, 200, { ok: true })
}

/**
 * 临时诊断：查询客户端模块图里有没有本插件。
 * @param ctx - Cordis 上下文
 * @returns Node 请求处理函数
 */
function handleEnv(ctx) {
  return (req, res) => {
    const out = { ok: true }
    let modules = null
    try {
      modules = ctx.get('clientModules')
    } catch (error) {
      out.clientModulesError = String(error && error.message)
    }
    out.hasClientModules = Boolean(modules)
    if (modules !== null && modules !== undefined) {
      try {
        const graph = modules.graph()
        const entries = Array.isArray(graph?.entries) ? graph.entries : []
        out.entryCount = entries.length
        out.mine = entries.filter((row) => String(row.id).includes('edit-diff'))
        out.preview = entries.slice(0, 3).map((row) => ({ id: row.id, inject: row.inject, immediately: row.immediately }))
      } catch (error) {
        out.graphError = String(error && error.message)
      }
    }
    let hmr = null
    try {
      hmr = ctx.get('hmr')
    } catch (error) {
      out.hmrError = String(error && error.message)
    }
    out.hasHmr = Boolean(hmr)
    respond(res, 200, out)
  }
}

/**
 * 临时：让桌面窗口刷新一次（客户端插件增删后必须重载页面才会生效）。
 * @param req - Node 请求
 * @param res - Node 响应
 */
async function handleReload(req, res) {
  const out = { ok: false, windows: 0, error: null }
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const electron = require('electron')
    const windows = typeof electron?.BrowserWindow?.getAllWindows === 'function' ? electron.BrowserWindow.getAllWindows() : []
    out.windows = windows.length
    for (const win of windows) {
      if (win?.webContents?.reload) win.webContents.reload()
    }
    out.ok = true
  } catch (error) {
    out.error = String(error && error.message)
  }
  respond(res, 200, out)
}

/**
 * 注册路由。
 * @param ctx - Cordis 上下文（webServer）
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/edit-diff/file', handler: handle }),
    'edit-diff: file text route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/edit-diff/ping', handler: handlePing }),
    'edit-diff: client diagnostics route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/edit-diff/env', handler: handleEnv(ctx) }),
    'edit-diff: env diagnostics route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/edit-diff/reload', handler: handleReload }),
    'edit-diff: reload route',
  )
}
