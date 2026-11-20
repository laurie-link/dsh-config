/**
 * dsh-debug-mode — Cursor 式 Debug 模式的 DSH 宿主插件。
 *
 * 用户用 `/debug <bug 描述>`（或模型调用 `debug_mode` 工具）开启一次调试会话：
 *  1. 插件在本机 127.0.0.1 起一个日志收集端点（随机端口、每会话独立 token）；
 *  2. 往该 agent 的 systemPrompt 注册动态上下文（只在调试模式激活时非空），
 *     并给模型一段 mission（先列假设 → 插桩 → 请你复现 → 读日志 → 最小修复 → 验证 → 清理）；
 *  3. 注册 `debug_mode` 工具（start/status/logs/stop/cleanup），模型据此读日志、收尾；
 *  4. `stop` 时扫描工作区里带 `dsh-debug:<id>` 标记的残留埋点并报告。
 *
 * 产出物全部落在会话工作区的 `.dsh-debug/<id>/`（events.ndjson / meta.json / README.md），
 * 目录自带 `.gitignore`（内容 `*`），不会污染 git。
 *
 * 纯逻辑在 lib/protocol.js，本文件只负责 HTTP、文件、命令/工具注册与生命周期。
 */
import http from 'node:http'
import { promises as fs } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  CONTEXT_NAME,
  CONTEXT_ORDER,
  MAX_EVENTS,
  buildContextText,
  buildInstrumentationReadme,
  buildLeftoverText,
  buildMission,
  buildStatusText,
  findMarkerLines,
  formatEvents,
  markerFor,
  newSessionId,
  parseDebugInput,
  parseEventBody,
} from './lib/protocol.js'

export const name = 'debug-mode'
export const inject = ['commands', 'tools', 'systemPrompt']

/** 单次 POST body 上限（超过直接 413，避免被灌爆）。 */
const MAX_BODY_BYTES = 512 * 1024
/** 每会话最多接收的事件数（内存/文件都按这个上限保护）。 */
const MAX_EVENTS_PER_SESSION = MAX_EVENTS
/** 残留埋点扫描：最多看多少个文件。 */
const MAX_SCAN_FILES = 20000
/** 残留埋点扫描：最多收集多少个文件命中。 */
const MAX_SCAN_MATCHES = 200
/** 残留埋点扫描：单个文件大小上限。 */
const MAX_SCAN_BYTES = 1024 * 1024
/** 残留埋点扫描：整体时间预算。 */
const SCAN_BUDGET_MS = 5000
/** 扫描时跳过的目录名。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.dsh-debug', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', 'vendor', '.venv', 'venv', '__pycache__', '.cache',
  '.turbo', '.parcel-cache', 'coverage', '.idea', '.vscode', '.gradle', '.mvn',
])
/** 明显是二进制的扩展名（扫描时跳过）。 */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.pdf', '.zip', '.gz',
  '.tar', '.tgz', '.7z', '.rar', '.dmg', '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
  '.mp3', '.mp4', '.mov', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.wasm', '.bin',
  '.db', '.sqlite', '.lock',
])

/** 会话 id（agent.session.id）→ 当前调试会话。 */
const modes = new Map()
/** ingest token → 调试会话。 */
const byToken = new Map()
/** 会话 id → 该 agent 的 systemPrompt context disposer。 */
const contextDisposers = new Map()

/** 收集端点（懒启动，插件生命周期内复用；绑 127.0.0.1 + 随机端口）。 */
let server = null
let serverPort = 0
let serverStarting = null

/** 插件内的日志兜底：logger 不可用时静默。 */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.('[debug-mode] ' + message)
  } catch {
    /* 静默 */
  }
}

/** 会话的工作目录（优先 workingDirectory 服务，其次 session.header.cwd）。 */
function sessionCwd(ctx, agent) {
  try {
    const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.get === 'function') {
      const value = workingDirectory.get(agent.session)
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    /* 回落到 header */
  }
  const header = agent.session?.header
  const cwd = header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

/** 调试会话的对外摘要（不暴露 token，命令/诊断用）。 */
function modeSummary(mode) {
  return {
    id: mode.id,
    sessionId: mode.sessionId,
    bug: mode.bug,
    status: mode.status,
    startedAt: mode.startedAt,
    stoppedAt: mode.stoppedAt,
    events: mode.events.length,
    lastEventAt: mode.lastEventAt,
    endpoint: mode.endpoint,
    dir: mode.dir,
    logFile: mode.logFile,
    marker: markerFor(mode.id),
  }
}

/** 写 meta.json（失败只告警，不影响主流程）。 */
async function writeMeta(mode) {
  try {
    await fs.writeFile(mode.metaPath, JSON.stringify(modeSummary(mode), null, 2) + '\n', 'utf8')
  } catch {
    /* 元数据不是关键路径 */
  }
}

/** 读取请求 body，超过上限抛错（调用方转 413）。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 统一的 JSON 响应（带 CORS，方便浏览器里的前端代码直接 POST）。 */
function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('access-control-allow-origin', '*')
  res.end(JSON.stringify(value))
}

/** 写一行事件到 NDJSON（串行化，避免并发交错）。 */
function appendEvent(mode, event) {
  mode.events.push(event)
  mode.lastEventAt = event.receivedAt
  const line = JSON.stringify(event) + '\n'
  mode.writeChain = mode.writeChain
    .then(() => fs.appendFile(mode.logFile, line, 'utf8'))
    .catch(() => {
      /* 磁盘写失败不阻断收集 */
    })
  return mode.writeChain
}

/** 处理一次 ingest/诊断请求。 */
async function handleRequest(req, res) {
  // CORS 预检：浏览器的 fetch 带 content-type: application/json 时会先发 OPTIONS。
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-max-age', '600')
    res.end()
    return
  }

  let url
  try {
    url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
  } catch {
    json(res, 400, { ok: false, error: 'bad url' })
    return
  }
  const parts = url.pathname.split('/').filter((part) => part !== '')

  // GET /health：插件存活探针。
  if (parts.length === 1 && parts[0] === 'health') {
    json(res, 200, { ok: true, plugin: 'debug-mode', sessions: modes.size, port: serverPort })
    return
  }

  // GET /_state：本机诊断（只回状态与将注入的上下文文本，便于测试）。
  if (parts.length === 1 && parts[0] === '_state') {
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId !== null && sessionId !== '') {
      const mode = modes.get(sessionId)
      json(res, 200, {
        ok: true,
        active: mode !== undefined && mode.status === 'active',
        mode: mode === undefined ? null : modeSummary(mode),
        contextText: mode === undefined ? '' : buildContextText(mode, Date.now()),
      })
      return
    }
    json(res, 200, { ok: true, modes: [...modes.values()].map(modeSummary) })
    return
  }

  // POST /ingest/<token>
  if (parts.length === 2 && parts[0] === 'ingest') {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'POST only' })
      return
    }
    const mode = byToken.get(parts[1])
    if (mode === undefined || mode.status !== 'active') {
      json(res, 404, { ok: false, error: 'unknown or inactive debug token' })
      return
    }
    if (mode.events.length >= MAX_EVENTS_PER_SESSION) {
      json(res, 413, { ok: false, error: 'event limit reached for this debug session; stop it and read the log file' })
      return
    }
    let text
    try {
      text = await readBody(req, MAX_BODY_BYTES)
    } catch (error) {
      json(res, error && error.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: String((error && error.message) || error) })
      return
    }
    let events
    try {
      events = parseEventBody(text, Date.now())
    } catch (error) {
      json(res, 400, { ok: false, error: String((error && error.message) || error) })
      return
    }
    if (events.length === 0) {
      json(res, 400, { ok: false, error: 'no loggable JSON event in body' })
      return
    }
    const room = MAX_EVENTS_PER_SESSION - mode.events.length
    const accepted = events.slice(0, room)
    await Promise.all(accepted.map((event) => appendEvent(mode, event)))
    await writeMeta(mode)
    json(res, 200, { ok: true, accepted: accepted.length, events: mode.events.length })
    return
  }

  // GET /status/<token>：调试端点自检。
  if (parts.length === 2 && parts[0] === 'status' && req.method === 'GET') {
    const mode = byToken.get(parts[1])
    if (mode === undefined) {
      json(res, 404, { ok: false, error: 'unknown debug token' })
      return
    }
    json(res, 200, { ok: true, mode: modeSummary(mode) })
    return
  }

  json(res, 404, { ok: false, error: 'not found' })
}

/** 确保收集端点已启动，返回端口。 */
async function ensureServer(ctx) {
  if (server !== null) return serverPort
  if (serverStarting !== null) return serverStarting
  serverStarting = (async () => {
    const instance = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        try {
          json(res, 500, { ok: false, error: String((error && error.message) || error) })
        } catch {
          /* 响应可能已发送 */
        }
      })
    })
    instance.on('clientError', (_error, socket) => {
      try {
        socket.destroy()
      } catch {
        /* 已断开 */
      }
    })
    await new Promise((resolve, reject) => {
      instance.once('error', reject)
      instance.listen(0, '127.0.0.1', () => resolve())
    })
    instance.unref()
    server = instance
    serverPort = instance.address().port
    warn(ctx, 'ingest endpoint listening on 127.0.0.1:' + serverPort)
    return serverPort
  })()
  try {
    return await serverStarting
  } finally {
    serverStarting = null
  }
}

/** 关闭收集端点（插件卸载时）。 */
function closeServer() {
  if (server === null) return
  try {
    server.close()
  } catch {
    /* 已关闭 */
  }
  server = null
  serverPort = 0
}

/**
 * 给某个 agent 注册（agent 作用域的）Debug 上下文。
 * 文本函数每次 assemble 时求值：只有该会话处于 active 调试模式才返回内容。
 */
function registerContext(agent) {
  const sessionId = agent.session?.id
  const agentCtx = agent.ctx
  if (typeof sessionId !== 'string' || sessionId === '' || agentCtx === undefined) return
  if (contextDisposers.has(sessionId)) return
  const systemPrompt = typeof agentCtx.get === 'function' ? agentCtx.get('systemPrompt') : undefined
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== 'function') return
  const disposer = systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: () => {
      const mode = modes.get(sessionId)
      return mode === undefined || mode.status !== 'active' ? '' : buildContextText(mode, Date.now())
    },
  })
  contextDisposers.set(sessionId, disposer)
  try {
    agentCtx.effect(() => () => {
      contextDisposers.delete(sessionId)
    }, 'debug-mode: context bookkeeping')
  } catch {
    /* 记不上也无妨：disposer 仍在 map 里 */
  }
}

/** 扫描工作区里的残留埋点标记。 */
async function scanMarkers(cwd, marker) {
  const result = { marker, scanned: 0, matches: [], truncated: false }
  if (typeof cwd !== 'string' || cwd === '') return result
  const deadline = Date.now() + SCAN_BUDGET_MS
  const queue = [cwd]
  while (queue.length > 0) {
    if (Date.now() > deadline || result.scanned >= MAX_SCAN_FILES || result.matches.length >= MAX_SCAN_MATCHES) {
      result.truncated = true
      break
    }
    const dir = queue.shift()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (Date.now() > deadline || result.scanned >= MAX_SCAN_FILES || result.matches.length >= MAX_SCAN_MATCHES) {
        result.truncated = true
        break
      }
      if (entry.name.startsWith('.') && entry.name !== '.cursor' && entry.name !== '.github' && entry.name !== '.agents') {
        if (entry.isDirectory()) continue
      }
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      result.scanned += 1
      try {
        const stat = await fs.stat(absolute)
        if (stat.size > MAX_SCAN_BYTES) continue
        const text = await fs.readFile(absolute, 'utf8')
        if (!text.includes(marker)) continue
        const hits = findMarkerLines(text, marker)
        if (hits.length === 0) continue
        result.matches.push({ path: path.relative(cwd, absolute), lines: hits })
      } catch {
        /* 读不了就跳过 */
      }
    }
  }
  return result
}

/**
 * 开启一次调试会话。
 * @returns {Promise<{mode?:object, error?:string, already?:boolean}>}
 */
async function startSession(ctx, agent, bug) {
  const sessionId = agent?.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') return { error: 'This session has no id; cannot start Debug Mode.' }
  const existing = modes.get(sessionId)
  if (existing !== undefined && existing.status === 'active') return { mode: existing, already: true }
  const cwd = sessionCwd(ctx, agent)
  if (cwd === '') {
    return { error: 'This session has no working directory. Open the session inside the project you want to debug, then run /debug again.' }
  }
  const description = String(bug ?? '').trim()
  if (description === '') {
    return { error: 'Describe the bug after /debug, e.g. "/debug the export button writes an empty file". Include reproduction steps when you know them.' }
  }

  let port
  try {
    port = await ensureServer(ctx)
  } catch (error) {
    return { error: 'Could not start the local log ingest endpoint: ' + String((error && error.message) || error) }
  }

  const id = newSessionId((size) => randomBytes(size))
  const token = randomBytes(24).toString('hex')
  const dir = path.join(cwd, '.dsh-debug', id)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.mkdir(path.join(cwd, '.dsh-debug'), { recursive: true })
    // 让 .dsh-debug 目录整体不进 git（git 会读取目录内的 .gitignore）。
    await fs.writeFile(path.join(cwd, '.dsh-debug', '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' }).catch(() => {})
  } catch (error) {
    return { error: 'Could not create the debug directory ' + dir + ': ' + String((error && error.message) || error) }
  }

  const mode = {
    id,
    token,
    sessionId,
    cwd,
    bug: description,
    startedAt: Date.now(),
    status: 'active',
    dir,
    logFile: path.join(dir, 'events.ndjson'),
    metaPath: path.join(dir, 'meta.json'),
    readmePath: path.join(dir, 'README.md'),
    endpoint: 'http://127.0.0.1:' + port + '/ingest/' + token,
    events: [],
    lastEventAt: 0,
    writeChain: Promise.resolve(),
  }
  modes.set(sessionId, mode)
  byToken.set(token, mode)

  try {
    await fs.writeFile(mode.readmePath, buildInstrumentationReadme(mode), 'utf8')
    await fs.writeFile(mode.logFile, '', { encoding: 'utf8', flag: 'a' })
    await writeMeta(mode)
  } catch (error) {
    warn(ctx, 'artifact write failed: ' + String((error && error.message) || error))
  }
  registerContext(agent)
  return { mode }
}

/** 结束一次调试会话（可选扫描残留埋点）。 */
async function stopSession(ctx, mode, options = {}) {
  if (mode === undefined || mode === null) return { error: 'no active debug session' }
  if (mode.status !== 'active') {
    return { mode, leftover: null, already: true }
  }
  mode.status = 'stopped'
  mode.stoppedAt = Date.now()
  byToken.delete(mode.token)
  if (modes.get(mode.sessionId) === mode) modes.delete(mode.sessionId)
  await writeMeta(mode)
  let leftover = null
  if (options.scan !== false) {
    try {
      leftover = await scanMarkers(mode.cwd, markerFor(mode.id))
    } catch (error) {
      warn(ctx, 'marker scan failed: ' + String((error && error.message) || error))
    }
  }
  return { mode, leftover }
}

/** 当前会话的调试模式（没有则 undefined）。 */
function sessionMode(agent) {
  const sessionId = agent?.session?.id
  if (typeof sessionId !== 'string') return undefined
  return modes.get(sessionId)
}

/** 统一的会话错误文本（中文，命令结果用）。 */
function noSessionError() {
  return '当前会话没有进行中的 Debug 会话。用 `/debug <bug 描述>` 开始一个。'
}

/**
 * `/debug` 命令实现。
 * @returns {Promise<{kind:'success'|'error', text:string}>}
 */
async function handleDebugCommand(ctx, invocation) {
  const agent = invocation.agent
  const parsed = parseDebugInput(invocation.rawInput)
  const mode = sessionMode(agent)
  try {
    if (parsed.kind === 'help') {
      return { kind: 'success', text: renderHelpZh(mode) }
    }
    if (parsed.kind === 'status') {
      return { kind: 'success', text: buildStatusText(mode, Date.now(), 'zh') }
    }
    if (parsed.kind === 'logs') {
      if (mode === undefined) return { kind: 'error', text: noSessionError() }
      const formatted = formatEvents(mode.events, { limit: parsed.limit, grep: parsed.grep }, Date.now())
      return { kind: 'success', text: formatted.text }
    }
    if (parsed.kind === 'cleanup') {
      if (mode === undefined) {
        // 没有 active 会话时也允许清理扫描：按 cwd 扫所有标记前缀？只扫当前会话更安全。
        const cwd = sessionCwd(ctx, agent)
        if (cwd === '') return { kind: 'error', text: '当前会话没有工作目录，无法扫描。' }
        const scan = await scanMarkers(cwd, 'dsh-debug:')
        return { kind: 'success', text: '本会话没有 active 调试会话；按前缀 dsh-debug: 扫描结果：\n' + buildLeftoverText(scan, 'zh') }
      }
      const scan = await scanMarkers(mode.cwd, markerFor(mode.id))
      return { kind: 'success', text: buildLeftoverText(scan, 'zh') }
    }
    if (parsed.kind === 'stop') {
      if (mode === undefined) return { kind: 'success', text: noSessionError() }
      const stopped = await stopSession(ctx, mode, { scan: true })
      if (stopped.error !== undefined) return { kind: 'error', text: stopped.error }
      const lines = ['Debug 会话 ' + stopped.mode.id + ' 已结束。', '事件总数：' + stopped.mode.events.length + '，日志：' + stopped.mode.logFile]
      if (stopped.leftover !== null) lines.push('', '残留埋点检查：', buildLeftoverText(stopped.leftover, 'zh'))
      lines.push('', '如果上面的检查发现残留，请让模型删掉这些带标记的行，或再跑一次 `/debug cleanup` 确认。')
      return { kind: 'success', text: lines.join('\n') }
    }
    // start
    const started = await startSession(ctx, agent, parsed.bug)
    if (started.error !== undefined) return { kind: 'error', text: started.error }
    if (started.already === true) {
      return {
        kind: 'error',
        text: '已有进行中的 Debug 会话 ' + started.mode.id + '。先 `/debug stop` 结束它，再用新的 bug 描述开启。\n\n' + buildStatusText(started.mode, Date.now(), 'zh'),
      }
    }
    const active = started.mode
    // 用 followup 起一轮新 turn：模型收到 mission（用户消息），会先给假设和插桩计划。
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: buildMission(active) }],
      source: { kind: 'user' },
    })
    const lines = [
      '🔎 Debug 模式已开启 · ' + active.id,
      '上报端点：' + active.endpoint,
      '日志文件：' + active.logFile,
      '清理标记：' + markerFor(active.id),
      '会话目录：' + active.dir + '（README.md 里有各语言埋点片段）',
      '',
      '接下来：模型会先列出根因假设并给你的代码插桩；插好后请按它的步骤手动复现 bug，再把结果告诉它。',
      '随时可用：`/debug status`、`/debug logs [条数] [--grep 关键词]`；结束后 `/debug stop`（会扫描残留埋点）。',
    ]
    return { kind: 'success', text: lines.join('\n') }
  } catch (error) {
    return { kind: 'error', text: 'debug: ' + String((error && error.message) || error) }
  }
}

/** 帮助文本（单独抽出来避免 handler 过长）。 */
function renderHelpZh(mode) {
  const active = mode === undefined || mode.status !== 'active' ? undefined : mode
  const lines = [
    'Debug 模式 —— 用运行时证据定位根因（Cursor 式）。',
    '',
    '/debug <bug 描述>      开启调试：agent 先列假设、给代码插桩、请你复现、读运行时日志、再做最小修复',
    '/debug status          查看当前调试会话与已收集事件数',
    '/debug logs [条数] [--grep 关键词]   查看最近收集到的事件（默认 100 条）',
    '/debug stop            结束调试并扫描工作区里的残留埋点',
    '/debug cleanup         只扫描残留埋点',
    '',
    active === undefined ? '当前没有进行中的调试会话。' : '已有进行中的会话：' + active.id + '，先用 /debug stop 结束再开新的。',
    '用法：插桩写进代码后，请手动复现 bug，再把结果告诉模型。',
  ]
  return lines.join('\n')
}

/**
 * `debug_mode` 工具实现（模型侧入口，与 /debug 命令共用同一套状态）。
 * @returns {Promise<{text:string}>}
 */
async function handleDebugTool(ctx, args, exec) {
  const agent = exec?.agent
  if (agent === undefined) return { text: 'debug_mode can only run inside an agent session.' }
  const object = args !== null && typeof args === 'object' ? args : {}
  const action = typeof object.action === 'string' ? object.action : ''
  const mode = sessionMode(agent)
  try {
    switch (action) {
      case 'start': {
        const bug = typeof object.bug === 'string' ? object.bug : ''
        const started = await startSession(ctx, agent, bug)
        if (started.error !== undefined) return { text: 'debug_mode start error: ' + started.error }
        if (started.already === true) {
          return {
            text: 'Debug Mode is already active for this session with the same or another bug. Stop it first with debug_mode action="stop".\n\n' + buildStatusText(started.mode, Date.now(), 'en'),
          }
        }
        return { text: buildMission(started.mode) + '\n\n---\n' + buildStatusText(started.mode, Date.now(), 'en') }
      }
      case 'status':
        return { text: buildStatusText(mode, Date.now(), 'en') }
      case 'logs': {
        if (mode === undefined) return { text: 'Debug Mode is not active in this session. Start it with debug_mode action="start".' }
        const limit = Number(object.limit)
        const grep = typeof object.grep === 'string' && object.grep !== '' ? object.grep : undefined
        const tag = typeof object.tag === 'string' && object.tag !== '' ? object.tag : undefined
        const formatted = formatEvents(mode.events, { limit: Number.isFinite(limit) && limit > 0 ? limit : undefined, grep, tag }, Date.now())
        return { text: buildStatusText(mode, Date.now(), 'en') + '\n\n' + formatted.text }
      }
      case 'stop': {
        if (mode === undefined) return { text: 'Debug Mode is not active in this session; nothing to stop.' }
        const stopped = await stopSession(ctx, mode, { scan: true })
        if (stopped.error !== undefined) return { text: 'debug_mode stop error: ' + stopped.error }
        const lines = [
          'Debug Mode stopped (' + stopped.mode.id + ').',
          'Events collected: ' + stopped.mode.events.length + ' · log: ' + stopped.mode.logFile,
          '',
          'Leftover marker scan:',
          buildLeftoverText(stopped.leftover, 'en'),
          '',
          stopped.leftover !== null && Array.isArray(stopped.leftover.matches) && stopped.leftover.matches.length > 0
            ? 'Remove every marked instrumentation line listed above, then call debug_mode action="cleanup" (or run the scan again) to confirm 0 leftovers.'
            : 'Cleanup is complete: the final answer can now state that no instrumentation remains.',
        ]
        return { text: lines.join('\n') }
      }
      case 'cleanup': {
        if (mode === undefined) {
          const cwd = sessionCwd(ctx, agent)
          if (cwd === '') return { text: 'This session has no working directory; cannot scan.' }
          const scan = await scanMarkers(cwd, 'dsh-debug:')
          return { text: 'No active debug session in this session; scanned for any dsh-debug: marker.\n\n' + buildLeftoverText(scan, 'en') }
        }
        const scan = await scanMarkers(mode.cwd, markerFor(mode.id))
        return { text: buildLeftoverText(scan, 'en') }
      }
      case 'help':
      default:
        return {
          text: [
            'debug_mode — Cursor-style runtime-evidence debugging.',
            '',
            'action="start"  bug="<bug report + reproduction steps>"  start a session (creates a local ingest endpoint + this session\'s Debug context)',
            'action="status"                                           active session, endpoint, collected event count',
            'action="logs"   [limit] [grep] [tag]                      read collected runtime events (default 100, max 500)',
            'action="stop"                                             stop the session and scan for leftover instrumentation',
            'action="cleanup"                                          scan only',
            '',
            'Workflow: hypotheses → instrument with fire-and-forget logs carrying the marker → ask the user to reproduce and wait → read logs → minimal fix → ask the user to verify → remove all instrumentation → stop.',
          ].join('\n'),
        }
    }
  } catch (error) {
    return { text: 'debug_mode error: ' + String((error && error.message) || error) }
  }
}

/** `debug_mode` 工具定义。 */
const DEBUG_TOOL = {
  name: 'debug_mode',
  description: 'Cursor-style Debug Mode for runtime-evidence debugging. start: opens a local log ingest endpoint for this session and instructs you to form hypotheses, instrument the code, ask the user to reproduce, read the collected runtime logs, then make a minimal fix and remove all instrumentation. Use status/logs to inspect collected events, stop/cleanup to finish and check for leftover instrumentation. Prefer the /debug slash command for the user-facing entry.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'status', 'logs', 'stop', 'cleanup', 'help'],
        description: 'start | status | logs | stop | cleanup | help',
      },
      bug: {
        type: 'string',
        description: 'For action="start": the bug report, expected vs actual behavior, and exact reproduction steps.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description: 'For action="logs": how many recent events to return (default 100, max 500).',
      },
      grep: {
        type: 'string',
        description: 'For action="logs": only return events whose tag/message/data contains this text.',
      },
      tag: {
        type: 'string',
        description: 'For action="logs": only return events with this exact tag.',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  },
  /**
   * 由 apply() 在注册时用闭包覆盖（需要插件 ctx 访问工作目录服务）；
   * 这里保留占位实现，避免工具定义缺少 execute 字段。
   */
  async execute() {
    return { text: 'debug_mode is not wired to the host yet.' }
  },
}

export function apply(ctx) {
  // 每个 Agent 创建时给它自己的 scope 注册动态 Debug 上下文（未激活时文本为空）。
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      if (agent === undefined) return
      registerContext(agent)
    } catch (error) {
      warn(ctx, 'agent/created context registration failed: ' + String((error && error.message) || error))
    }
  })

  // Agent 销毁：结束它名下的调试会话（不做扫描，避免拖慢会话关闭）。
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string') return
      const mode = modes.get(sessionId)
      if (mode !== undefined) {
        mode.status = 'stopped'
        mode.stoppedAt = Date.now()
        byToken.delete(mode.token)
        modes.delete(sessionId)
        void writeMeta(mode)
      }
      const disposer = contextDisposers.get(sessionId)
      if (disposer !== undefined) {
        try {
          disposer()
        } catch {
          /* 已释放 */
        }
        contextDisposers.delete(sessionId)
      }
    } catch {
      /* 销毁路径不抛错 */
    }
  })

  // /debug 斜杠命令。
  try {
    ctx.effect(
      () => ctx.commands.register({
        name: 'debug',
        description: 'Debug 模式：用运行时证据定位根因（插桩 → 复现 → 读日志 → 最小修复；Cursor-style）',
        input: { hint: '<bug 描述> | status | logs [n] | stop | cleanup | help' },
        handler: (invocation) => handleDebugCommand(ctx, invocation),
      }),
      'debug-mode: /debug command',
    )
  } catch (error) {
    warn(ctx, '/debug command registration failed (name may be taken): ' + String((error && error.message) || error))
  }

  // debug_mode 工具（模型侧入口）。
  try {
    ctx.effect(
      () => ctx.tools.register({
        ...DEBUG_TOOL,
        execute: (args, exec) => handleDebugTool(ctx, args, exec),
      }),
      'debug-mode: debug_mode tool',
    )
  } catch (error) {
    warn(ctx, 'debug_mode tool registration failed: ' + String((error && error.message) || error))
  }

  // 插件卸载：关端点、清状态、释放上下文注册。
  ctx.effect(() => () => {
    for (const disposer of contextDisposers.values()) {
      try {
        disposer()
      } catch {
        /* 已释放 */
      }
    }
    contextDisposers.clear()
    for (const mode of modes.values()) {
      mode.status = 'stopped'
      byToken.delete(mode.token)
    }
    modes.clear()
    byToken.clear()
    closeServer()
  }, 'debug-mode: teardown')
}
