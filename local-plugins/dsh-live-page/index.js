/**
 * dsh-live-page — Host half.
 *
 * Client-facing routes (DSH host origin):
 *   POST /live-page/open     resolve a workspace HTML file and return a live URL
 *   GET  /live-page/files    bounded workspace HTML file list
 *   POST /live-page/report   active IDE-browser page snapshot
 *   GET  /live-page/state    diagnostics + the prompt text for one session
 *   GET  /live-page/servers  live server origins (Web overlay postMessage guard)
 *
 * Per workspace root, a loopback live server serves the real files, injects the
 * edit overlay and accepts block saves. The agent gets a small runtime context
 * block describing the current browser page; selected text itself is inserted
 * into the composer by the Client half.
 */
import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createPageStore, contextTextFor, enrichPageWithLive, normalizeReport } from './lib/context.js'
import { createCompleter, lastCompletionOf } from './lib/completion.js'
import { createRewriter, lastRewriteOf } from './lib/rewrite.js'
import { listHtmlFiles } from './lib/files.js'
import { saveHtmlBlock } from './lib/patch.js'
import { dshHome, isHtmlPath, isInside, relOf, resolveRequestPath, baseName } from './lib/paths.js'
import { startLiveSite } from './lib/liveSite.js'

export const name = 'dsh-live-page'
export const inject = ['webServer']

/** Prompt context order: editor-context uses 130. */
const CONTEXT_ORDER = 131
const CONTEXT_NAME = 'live-page-context'
const MAX_SITES = 8
const MAX_BODY_BYTES = 256 * 1024
const MAX_BACKUPS_PER_FILE = 20

/** Live server Promises keyed by real workspace root (insertion order = age). */
const sites = new Map()

/** Probe a service without letting a missing registration break the plugin. */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function cwdOfSession(ctx, session) {
  if (!session) return null
  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  if (workingDirectory && typeof workingDirectory.get === 'function') {
    try {
      const current = workingDirectory.get(session)
      if (typeof current === 'string' && current !== '') return current
    } catch {
      // fall through to header.cwd
    }
  }
  const headerCwd = session.header && session.header.cwd
  return typeof headerCwd === 'string' && headerCwd !== '' ? headerCwd : null
}

/** Resolve the session workspace; null when unavailable (do not guess). */
function sessionCwd(ctx, sessionId) {
  if (sessionId) {
    const agents = serviceOf(ctx, 'agents')
    if (agents && typeof agents.get === 'function') {
      try {
        const agent = agents.get(sessionId)
        const cwd = cwdOfSession(ctx, agent && agent.session)
        if (cwd) return cwd
      } catch {
        // next candidate
      }
    }
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions && typeof sessions.get === 'function') {
      try {
        const cwd = cwdOfSession(ctx, sessions.get(sessionId))
        if (cwd) return cwd
      } catch {
        // next candidate
      }
    }
    return null
  }
  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  if (workingDirectory) {
    try {
      const fallback =
        typeof workingDirectory.defaultDirectory === 'function'
          ? workingDirectory.defaultDirectory()
          : workingDirectory.defaultDirectory
      if (typeof fallback === 'string' && fallback !== '') return fallback
    } catch {
      // no default
    }
  }
  return null
}

function readBody(req, limit) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error('请求体过大'), { status: 413, code: 'body_too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

async function readJson(req) {
  const text = await readBody(req, MAX_BODY_BYTES)
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'bad_json' })
  }
}

function json(res, status, value) {
  const payload = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(payload))
  res.end(payload)
}

function queryValue(req, name) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').searchParams.get(name) || undefined
  } catch {
    return undefined
  }
}

/** Wrap a route handler so no rejection escapes into the host. */
function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      json(res, status, { ok: false, error: String(error?.message || error), ...(error?.code ? { code: error.code } : {}) })
    }
  }
}

/** Overlay assets live at <package>/assets/live. */
function overlayDir() {
  const override = process.env.DSH_LIVE_PAGE_OVERLAY_DIR
  if (typeof override === 'string' && override !== '') return resolve(override)
  return fileURLToPath(new URL('./assets/live/', import.meta.url))
}

/** Refuse to serve the DSH home/profile itself as a live site. */
function assertWorkspaceRoot(realRoot) {
  if (isInside(dshHome(), realRoot)) {
    throw Object.assign(new Error('当前会话没有可编辑的工作区，请先打开一个工作区'), {
      status: 400,
      code: 'no_workspace',
    })
  }
  return realRoot
}

function logLine(ctx, message) {
  try {
    if (ctx?.logger?.warn) ctx.logger.warn('dsh-live-page: ' + message)
    else console.warn('dsh-live-page: ' + message)
  } catch {
    // logging must never break a request
  }
}

/** Start or reuse one live site for a real workspace root. */
function ensureSite(ctx, root, complete, rewrite) {
  const existing = sites.get(root)
  if (existing) return existing
  if (sites.size >= MAX_SITES) {
    const oldestRoot = sites.keys().next().value
    const oldest = sites.get(oldestRoot)
    sites.delete(oldestRoot)
    Promise.resolve(oldest)
      .then((site) => site.close())
      .catch(() => {})
  }
  const token = randomBytes(24).toString('hex')
  const nonce = randomBytes(16).toString('hex')
  const entry = startLiveSite({
    root,
    token,
    nonce,
    overlayDir: overlayDir(),
    listFiles: (workspace) => listHtmlFiles(workspace),
    saveBlock: (args) => saveHtmlBlock({ ...args, keepBackups: MAX_BACKUPS_PER_FILE }),
    complete,
    rewrite,
    log: (message) => logLine(ctx, message),
  }).catch((error) => {
    if (sites.get(root) === entry) sites.delete(root)
    throw error
  })
  sites.set(root, entry)
  return entry
}

/** Resolve one file for /live-page/open (must be inside the session workspace). */
async function resolveOpenTarget(ctx, sessionId, rawPath) {
  const cwd = sessionCwd(ctx, sessionId)
  if (!cwd) throw Object.assign(new Error('无法确定会话工作目录'), { status: 400, code: 'no_cwd' })
  const abs = resolveRequestPath(cwd, rawPath)
  let realCwd
  let realFile
  try {
    realCwd = await realpath(cwd)
    realFile = await realpath(abs)
  } catch {
    throw Object.assign(new Error('文件不存在'), { status: 404, code: 'missing' })
  }
  assertWorkspaceRoot(realCwd)
  if (!isInside(realCwd, realFile)) {
    throw Object.assign(new Error('只能编辑会话工作区内的文件'), { status: 403, code: 'outside_root' })
  }
  const info = await stat(realFile).catch(() => null)
  if (!info?.isFile()) throw Object.assign(new Error('目标不是普通文件'), { status: 400, code: 'not_file' })
  if (!isHtmlPath(realFile)) {
    throw Object.assign(new Error('只支持 HTML 页面（.html/.htm/.xhtml/.shtml）'), { status: 400, code: 'not_html' })
  }
  return { root: realCwd, absPath: realFile, relPath: relOf(realCwd, realFile), info }
}

/** Resolve just the workspace root for the file picker. */
async function resolveWorkspace(ctx, sessionId) {
  const cwd = sessionCwd(ctx, sessionId)
  if (!cwd) throw Object.assign(new Error('无法确定会话工作目录'), { status: 400, code: 'no_cwd' })
  return assertWorkspaceRoot(await realpath(cwd))
}

/** Merge live server origins/files into one page snapshot. */
async function liveServers() {
  const out = []
  for (const [root, entry] of sites) {
    try {
      const site = await entry
      out.push({ root, origin: site.origin, port: site.port, nonce: site.nonce })
    } catch {
      // failed site entries are ignored
    }
  }
  return out
}

export function apply(ctx) {
  const store = createPageStore()
  /** One shared completer: the route decision is cached across live sites. */
  const completeRaw = createCompleter(ctx)
  /** Wrap so the AI diagnostic route can show the latest completion attempt. */
  const complete = async (request) => {
    const result = await completeRaw(request)
    try {
      ctx.__dshLivePageLastCompletion = { at: new Date().toISOString(), ...result }
    } catch {
      // diagnostics only
    }
    return result
  }
  /** Selection rewrite uses the same cached model route as completion. */
  const rewriteRaw = createRewriter(ctx)
  const rewrite = async (request) => {
    const result = await rewriteRaw(request)
    try {
      ctx.__dshLivePageLastRewrite = { at: new Date().toISOString(), ...result }
    } catch {
      // diagnostics only
    }
    return result
  }
  /** Session ids that already carry this plugin's prompt context. */
  const registeredAgents = new Set()

  /** Attach the live page context to one live agent; idempotent per session. */
  function installAgentContext(agent) {
    try {
      const sessionId = (agent && agent.id) || (agent && agent.session && agent.session.id)
      const agentCtx = agent && agent.ctx
      if (!sessionId || !agentCtx || registeredAgents.has(sessionId)) return
      const systemPrompt = typeof agentCtx.get === 'function' ? agentCtx.get('systemPrompt') : undefined
      if (!systemPrompt || typeof systemPrompt.context !== 'function') return
      const disposer = systemPrompt.context({
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text: () => contextTextFor(store, sessionId),
      })
      registeredAgents.add(sessionId)
      if (typeof agentCtx.effect === 'function') {
        agentCtx.effect(() => () => {
          try {
            if (typeof disposer === 'function') disposer()
          } catch {
            // disposal is best-effort
          }
          registeredAgents.delete(sessionId)
        }, 'live-page: prompt context bookkeeping')
      }
    } catch (error) {
      logLine(ctx, 'prompt context registration failed: ' + String(error?.message || error))
    }
  }

  // -- routes ---------------------------------------------------------
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/live-page/open',
        handler: route(async (req, res) => {
          if ((req.method || 'GET').toUpperCase() !== 'POST') {
            json(res, 405, { ok: false, error: '只接受 POST' })
            return
          }
          const body = await readJson(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
          const rawPath = typeof body.path === 'string' ? body.path : ''
          if (rawPath.trim() === '') {
            const root = await resolveWorkspace(ctx, sessionId)
            const site = await ensureSite(ctx, root, complete, rewrite)
            json(res, 200, { ok: true, url: site.urlFor('', true), file: null, title: '页面编辑', port: site.port, nonce: site.nonce })
            return
          }
          const target = await resolveOpenTarget(ctx, sessionId, rawPath)
          const site = await ensureSite(ctx, target.root, complete, rewrite)
          json(res, 200, {
            ok: true,
            url: site.urlFor(target.relPath, true) + '&__live_edit=1',
            file: target.relPath,
            title: baseName(target.relPath),
            port: site.port,
            nonce: site.nonce,
          })
        }),
      }),
    'live-page: open route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/live-page/files',
        handler: route(async (req, res) => {
          if ((req.method || 'GET').toUpperCase() !== 'GET') {
            json(res, 405, { ok: false, error: '只接受 GET' })
            return
          }
          const root = await resolveWorkspace(ctx, queryValue(req, 'sessionId'))
          const listing = await listHtmlFiles(root)
          json(res, 200, { ok: true, ...listing })
        }),
      }),
    'live-page: files route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/live-page/report',
        handler: route(async (req, res) => {
          if ((req.method || 'GET').toUpperCase() !== 'POST') {
            json(res, 405, { ok: false, error: '只接受 POST' })
            return
          }
          const report = normalizeReport(await readJson(req))
          if (!report) {
            json(res, 400, { ok: false, error: '页面快照格式不正确' })
            return
          }
          if (!report.page) {
            store.clear(report.sessionId)
            json(res, 200, { ok: true })
            return
          }
          const page = enrichPageWithLive(report.page, await liveServers())
          store.set(report.sessionId, page)
          json(res, 200, { ok: true })
        }),
      }),
    'live-page: report route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/live-page/state',
        handler: route(async (req, res) => {
          if ((req.method || 'GET').toUpperCase() !== 'GET') {
            json(res, 405, { ok: false, error: '只接受 GET' })
            return
          }
          const sessionId = queryValue(req, 'sessionId')
          const entry = sessionId ? store.entries().find((item) => item.sessionId === sessionId) : undefined
          json(res, 200, {
            ok: true,
            page: entry ? entry.page : null,
            at: entry ? entry.at : null,
            text: sessionId ? contextTextFor(store, sessionId) : null,
            quotes: 0,
            servers: await liveServers(),
          })
        }),
      }),
    'live-page: state route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/live-page/ai-probe',
        handler: route(async (req, res) => {
          const llm = serviceOf(ctx, 'llm')
          const out = { ok: true, available: !!llm }
          if (llm && typeof llm.listProviders === 'function') {
            const providers = (llm.listProviders() || []).map((provider) => provider.id)
            out.providers = providers
            out.models = {}
            out.efforts = {}
            for (const provider of providers) {
              try {
                const models = await Promise.resolve(llm.listModels(provider))
                out.models[provider] = (models || []).map((model) => model.id)
                if (typeof llm.resolveModelInfo === 'function') {
                  for (const model of (models || []).slice(0, 8)) {
                    try {
                      const info = await llm.resolveModelInfo(provider, model.id)
                      const efforts = (info?.reasoning?.efforts || []).map((effort) => effort.id + (effort.name ? '(' + effort.name + ')' : ''))
                      out.efforts[provider + '/' + model.id] = {
                        efforts,
                        defaultEffort: info?.reasoning?.defaultEffort || '',
                      }
                    } catch (error) {
                      out.efforts[provider + '/' + model.id] = { error: String(error?.message || error) }
                    }
                  }
                }
              } catch (error) {
                out.models[provider] = ['ERR: ' + String(error?.message || error)]
              }
            }
          }
          try {
            const selection = serviceOf(ctx, 'agentDefaultModel')?.currentSelection?.()
            if (selection) out.agentDefault = { provider: selection.provider, model: selection.model, effort: selection.reasoningEffort }
          } catch {
            // ignore
          }
          out.lastCompletion = lastCompletionOf(ctx) || null
          out.lastRewrite = lastRewriteOf(ctx) || null
          json(res, 200, out)
        }),
      }),
    'live-page: ai probe route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/live-page/servers',
        handler: route(async (req, res) => {
          json(res, 200, { ok: true, servers: await liveServers() })
        }),
      }),
    'live-page: servers route',
  )

  // -- runtime context ------------------------------------------------
  ctx.on('agent/created', (payload) => {
    installAgentContext(payload && payload.agent)
  })
  // Existing agents were created before this plugin mounted: attach the same
  // context to them so the current session sees the page without a new session.
  try {
    const agents = serviceOf(ctx, 'agents')
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) installAgentContext(agent)
    }
  } catch (error) {
    logLine(ctx, 'existing agent context registration failed: ' + String(error?.message || error))
  }

  // -- teardown -------------------------------------------------------
  ctx.effect(() => () => {
    const entries = [...sites.values()]
    sites.clear()
    for (const entry of entries) {
      Promise.resolve(entry)
        .then((site) => site.close())
        .catch(() => {})
    }
  }, 'live-page: close live sites')
}
