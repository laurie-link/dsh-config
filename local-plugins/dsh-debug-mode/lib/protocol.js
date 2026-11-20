/**
 * dsh-debug-mode — 纯逻辑层（无 I/O、不依赖 DSH 运行时）。
 *
 * 这里放可以 `node --test` 直接测的东西：
 *  - `/debug` 子命令解析
 *  - 给模型的 mission / 每步注入的 context 文本
 *  - 日志事件规范化、过滤与格式化
 *  - 埋点标记（marker）扫描的行匹配
 *
 * 真正的服务器、文件写入、命令/tool 注册都在 index.js。
 */

/** 运行时上下文在 prompt 中的注册名（同一 agent scope 内唯一）。 */
export const CONTEXT_NAME = 'debug-mode:context'
/** 排在 editor-context(130) 之后、sandbox(110)/working-directory(100) 之前后的位置。 */
export const CONTEXT_ORDER = 140
/** 每个埋点行都必须带上的标记前缀，后面紧跟会话 id。 */
export const MARKER_PREFIX = 'dsh-debug:'
/** 单次返回给模型/用户的事件条数上限。 */
export const MAX_LIMIT = 500
/** 每个调试会话最多接收的事件数（内存与文件同时受此保护）。 */
export const MAX_EVENTS = 10000
/** 默认返回条数。 */
export const DEFAULT_LIMIT = 100
/** 单条事件渲染到文本时的最大字符数。 */
export const MAX_EVENT_TEXT = 600
/** 单条事件 data JSON 的最大字符数（超出截断，避免一条事件撑爆日志）。 */
export const MAX_EVENT_DATA = 4096

/** 埋点标记：`dsh-debug:<sessionId>`。 */
export function markerFor(id) {
  return MARKER_PREFIX + id
}

/** 生成一次调试会话的短 id（不含时间信息，便于在日志/代码里搜索）。 */
export function newSessionId(random) {
  const bytes = random(3)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return 'dbg-' + out
}

/** 把用户输入截成单行短文本（context 里只放一行摘要）。 */
export function oneLine(text, max = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/**
 * 解析 `/debug` 后面的参数。
 *
 * - 空 / help          → { kind: 'help' }
 * - status / info      → { kind: 'status' }
 * - stop / off / end   → { kind: 'stop' }
 * - cleanup / check    → { kind: 'cleanup' }
 * - logs [n] [--grep x] → { kind: 'logs', limit, grep }
 * - 其它                → { kind: 'start', bug }（整段当作 bug 描述）
 *
 * @param {string} raw
 * @returns {{kind: 'help'}|{kind:'status'}|{kind:'stop'}|{kind:'cleanup'}|{kind:'logs',limit:number,grep?:string}|{kind:'start',bug:string}}
 */
export function parseDebugInput(raw) {
  const input = String(raw ?? '').trim()
  if (input === '') return { kind: 'help' }
  const lower = input.toLowerCase()
  if (lower === 'help' || lower === '?' || lower === '-h' || lower === '--help') return { kind: 'help' }
  if (lower === 'status' || lower === 'info') return { kind: 'status' }
  if (lower === 'stop' || lower === 'off' || lower === 'end') return { kind: 'stop' }
  if (lower === 'cleanup' || lower === 'check') return { kind: 'cleanup' }

  const logsMatch = /^(?:logs?|tail)\b([\s\S]*)$/i.exec(input)
  if (logsMatch !== null) {
    const rest = logsMatch[1] ?? ''
    const limitMatch = /(?:^|\s)(\d{1,6})(?=\s|$)/.exec(rest)
    const grepMatch = /--grep\s+(\S[\s\S]*)$/i.exec(rest)
    let limit = limitMatch === null ? DEFAULT_LIMIT : Number(limitMatch[1])
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT
    limit = Math.min(limit, MAX_LIMIT)
    if (grepMatch !== null && grepMatch[1].trim() !== '') return { kind: 'logs', limit, grep: grepMatch[1].trim() }
    return { kind: 'logs', limit }
  }

  return { kind: 'start', bug: input }
}

/** millisecond → `HH:MM:SS.mmm`（本地时区，只用于人看）。 */
export function clockTime(timestamp) {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now())
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3)
}

/** 相对时间：`12s ago` / `3m ago` / `never`。 */
export function agoText(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'never'
  const delta = Math.max(0, now - timestamp)
  if (delta < 1500) return 'just now'
  if (delta < 60_000) return Math.round(delta / 1000) + 's ago'
  if (delta < 3_600_000) return Math.round(delta / 60_000) + 'm ago'
  return Math.round(delta / 3_600_000) + 'h ago'
}

/** 把任意 JSON 值渲染成单行短文本。 */
export function compactJson(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return '"[unserializable]"'
  }
  if (typeof text !== 'string') return 'null'
  return text.length > MAX_EVENT_DATA ? text.slice(0, MAX_EVENT_DATA) + '…' : text
}

/**
 * 规范化一条上报事件。接受任意 JSON 对象：
 *  - 常见形状：{ tag, msg, data, ts }
 *  - 也接受 { message, level, ...rest } 之类的松散结构：剩下的字段整体放进 data
 *
 * @param {unknown} raw
 * @param {number} receivedAt
 * @returns {{receivedAt:number, ts:number, tag:string, msg:string, data:unknown}|null}
 */
export function normalizeEvent(raw, receivedAt = Date.now()) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const object = /** @type {Record<string, unknown>} */ (raw)
  const tag = typeof object.tag === 'string' && object.tag.trim() !== '' ? object.tag.trim().slice(0, 80) : ''
  const msg = typeof object.msg === 'string' ? object.msg : typeof object.message === 'string' ? object.message : ''
  let data
  if (object.data !== undefined) {
    data = object.data
  } else {
    const rest = { ...object }
    delete rest.tag
    delete rest.msg
    delete rest.message
    delete rest.ts
    delete rest.data
    data = Object.keys(rest).length > 0 ? rest : undefined
  }
  const tsRaw = Number(object.ts)
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : receivedAt
  if (tag === '' && msg === '' && data === undefined) return null
  return { receivedAt, ts, tag, msg, data }
}

/**
 * 解析一轮 POST body：支持 NDJSON（每行一个 JSON 对象）以及单个 JSON 对象/数组。
 *
 * @param {string} text
 * @param {number} now
 * @returns {Array<{receivedAt:number, ts:number, tag:string, msg:string, data:unknown}>}
 */
export function parseEventBody(text, now = Date.now()) {
  const body = String(text ?? '').trim()
  if (body === '') return []
  const events = []
  const push = (value) => {
    const normalized = normalizeEvent(value, now)
    if (normalized !== null) events.push(normalized)
  }
  // 单个 JSON 对象/数组
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) {
        for (const item of parsed) push(item)
      } else {
        push(parsed)
      }
      if (events.length > 0) return events
    } catch {
      /* NDJSON 兜底 */
    }
  }
  // NDJSON
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      push(JSON.parse(trimmed))
    } catch {
      /* 单行坏 JSON：忽略，但把原文当 msg 保留一行，方便排查 */
      events.push({ receivedAt: now, ts: now, tag: '', msg: trimmed.slice(0, MAX_EVENT_TEXT), data: undefined })
    }
  }
  return events
}

/** 一条事件的单行渲染：`#12 [10:03:27.512] cart: items=3 {"total":0}`。 */
export function formatEventLine(event, index) {
  const parts = []
  if (Number.isFinite(index)) parts.push('#' + index)
  parts.push('[' + clockTime(event.ts) + ']')
  if (event.tag !== '') parts.push(event.tag + ':')
  let text = event.msg !== '' ? event.msg : ''
  if (event.data !== undefined) {
    const json = compactJson(event.data)
    text = text === '' ? json : text + ' ' + json
  }
  parts.push(text.slice(0, MAX_EVENT_TEXT))
  const line = parts.join(' ')
  return line.length > MAX_EVENT_TEXT ? line.slice(0, MAX_EVENT_TEXT) + '…' : line
}

/**
 * 过滤 + 渲染事件列表（供 `debug_mode action=logs`、`/debug logs` 共用）。
 *
 * @param {Array<object>} events 已规范化的事件数组（时间升序）
 * @param {{limit?:number, grep?:string, tag?:string, sinceMs?:number}} [options]
 * @param {number} [now]
 * @returns {{text:string, matched:number, total:number}}
 */
export function formatEvents(events, options = {}, now = Date.now()) {
  const all = Array.isArray(events) ? events : []
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const grep = typeof options.grep === 'string' && options.grep !== '' ? options.grep.toLowerCase() : ''
  const tag = typeof options.tag === 'string' && options.tag !== '' ? options.tag.toLowerCase() : ''
  const sinceMs = Number(options.sinceMs)
  const filtered = []
  for (let index = 0; index < all.length; index += 1) {
    const event = all[index]
    if (!Number.isFinite(sinceMs) || sinceMs <= 0 ? false : event.receivedAt < now - sinceMs) continue
    if (tag !== '' && String(event.tag ?? '').toLowerCase() !== tag) continue
    if (grep !== '') {
      const haystack = (String(event.tag ?? '') + ' ' + String(event.msg ?? '') + ' ' + compactJson(event.data)).toLowerCase()
      if (!haystack.includes(grep)) continue
    }
    filtered.push({ event, index: index + 1 })
  }
  if (filtered.length === 0) {
    return {
      text: all.length === 0
        ? 'No events collected yet (' + all.length + ' total). The instrumented code has not posted anything: check the endpoint/URL in the instrumentation, confirm the code path executed, and ask the user to reproduce again.'
        : 'No events match the filter (' + all.length + ' collected).',
      matched: 0,
      total: all.length,
    }
  }
  const tail = filtered.slice(-limit)
  const lines = tail.map((entry) => formatEventLine(entry.event, entry.index))
  const header = 'Events: ' + tail.length + '/' + filtered.length + ' shown (' + all.length + ' collected' + (grep === '' ? '' : ', grep="' + grep + '"') + '). Oldest shown #' + tail[0].index + ', newest #' + tail[tail.length - 1].index + '.'
  return { text: header + '\n' + lines.join('\n'), matched: filtered.length, total: all.length }
}

/** README 里给各种语言的埋点片段（模型按需读取；也便于人手抄）。 */
export function instrumentationSnippets(endpoint, marker) {
  const jsBrowser = [
    '// Browser / Node 18+ — fire-and-forget, never throws:',
    'const dshDbg = (tag, data) => { try { fetch(' + JSON.stringify(endpoint) + ', { method: "POST", body: JSON.stringify({ tag, data }) }).catch(() => {}) } catch {} }',
    'dshDbg("cart:submit", { items, total }) // ' + marker,
  ].join('\n')
  const python = [
    '# Python — daemon thread so logging never blocks the app:',
    'import json, threading, urllib.request',
    'def dsh_dbg(tag, **data):',
    '    def send():',
    '        try:',
    '            req = urllib.request.Request(' + JSON.stringify(endpoint) + ', data=json.dumps({"tag": tag, "data": data}).encode(), headers={"content-type": "application/json"})',
    '            urllib.request.urlopen(req, timeout=1).read()',
    '        except Exception:',
    '            pass',
    '    threading.Thread(target=send, daemon=True).start()  # ' + marker,
  ].join('\n')
  const shell = [
    '# Anything else — one curl line per event:',
    'curl -s -m 1 -X POST ' + JSON.stringify(endpoint) + ' -d "{\\"tag\\":\\"probe\\",\\"data\\":{\\"step\\":\\"after-auth\\"}}" >/dev/null || true  # ' + marker,
  ].join('\n')
  const fileFallback = [
    '# If HTTP is blocked (CSP, firewall, container without host network), append NDJSON to the log file instead:',
    '#   <debug-dir>/events.ndjson',
    '# one event per line: {"tag":"cart:submit","data":{"items":3}}',
  ].join('\n')
  return [
    '## JS/TS',
    '```js',
    jsBrowser,
    '```',
    '',
    '## Python',
    '```python',
    python,
    '```',
    '',
    '## Shell / other languages',
    '```sh',
    shell,
    '```',
    '',
    fileFallback,
  ].join('\n')
}

/** 写进调试目录的 README（含端点、标记、各语言片段、硬规则）。 */
export function buildInstrumentationReadme(mode) {
  const marker = markerFor(mode.id)
  return [
    '# Debug Mode session ' + mode.id,
    '',
    '- Bug: ' + oneLine(mode.bug, 500),
    '- Started: ' + new Date(mode.startedAt).toISOString(),
    '- Ingest endpoint: ' + mode.endpoint,
    '- Log file: ' + mode.logFile,
    '- Cleanup marker (every instrumentation line must contain it): ' + marker,
    '',
    'POST JSON to the endpoint, one object per event:',
    '',
    '```json',
    '{ "tag": "cart:submit", "msg": "submit handler entered", "data": { "items": 3, "total": 0 } }',
    '```',
    '',
    'The endpoint also accepts NDJSON bodies (several JSON objects, one per line) and JSON arrays.',
    '',
    instrumentationSnippets(mode.endpoint, marker),
    '',
    '## Hard rules',
    '',
    '1. Instrumentation must never change behavior: wrap it so it cannot throw, never await it in a hot path, keep a short timeout.',
    '2. Every added line carries the marker above as a comment, so cleanup can find it (`/debug stop` scans the workspace).',
    '3. Do not refactor unrelated code, do not commit instrumentation, do not fix the bug before you have seen logs.',
    '4. Remove every instrumentation line before the final answer; the cleanup scan must report 0 leftovers.',
    '',
  ].join('\n')
}

/** 语言无关的六阶段流程（mission 与 context 共用）。 */
const WORKFLOW_LINES = [
  '1. Explore the relevant code and write down 3-5 concrete hypotheses (H1, H2, …) for the root cause.',
  '2. Instrument the code paths that distinguish those hypotheses (log variable states, timing, branch decisions, request/response values). Cover frontend and backend when the bug spans both.',
  '3. Stop and ask the user to reproduce the bug: give exact steps, then wait for their next message. Do not guess a fix before you have runtime evidence.',
  '4. Read the collected events (debug_mode action="logs"), correlate them with the reproduction, and name the root cause that the evidence supports (cite file:line).',
  '5. Make the minimal targeted fix that addresses that root cause — a few lines, not a rewrite.',
  '6. Ask the user to verify the fix. Once they confirm, remove ALL instrumentation, then call debug_mode action="stop" and confirm the leftover-marker scan is 0. Report root cause → evidence → fix → cleanup.',
]

/**
 * `/debug <bug>` 之后作为用户消息注入给模型的 mission。
 *
 * @param {{id:string, bug:string, endpoint:string, logFile:string, dir:string, startedAt:number}} mode
 */
export function buildMission(mode) {
  const marker = markerFor(mode.id)
  return [
    'Debug Mode is now ACTIVE for this session (started by the user with `/debug`).',
    '',
    'Bug report / reproduction the user gave:',
    '"""',
    String(mode.bug ?? '').trim(),
    '"""',
    '',
    'This is a runtime-evidence debugging task, not a normal fix request. Do NOT start by editing a fix.',
    '',
    '## Runtime channel (already running for you)',
    '',
    '- Ingest endpoint: ' + mode.endpoint,
    '- Every instrumentation line must carry this comment marker: ' + marker,
    '- Log file (durable copy, readable with normal file tools): ' + mode.logFile,
    '- Session directory: ' + mode.dir,
    '- Instrumentation guide (snippets for JS/Python/shell, event format): ' + mode.dir + '/README.md',
    '',
    'POST a JSON object to the endpoint, e.g. {"tag":"cart:submit","msg":"handler entered","data":{"items":3}}. It accepts NDJSON and JSON arrays too. The endpoint is local (127.0.0.1) and needs no auth beyond its path.',
    '',
    '## Workflow',
    ...WORKFLOW_LINES.map((line) => line),
    '',
    '## Rules',
    '',
    '- Instrumentation must be fire-and-forget and unable to throw, timeout, or change control flow; never await it in a hot path.',
    '- Keep instrumentation easy to remove: one line per probe, each carrying the marker, no refactors around it.',
    '- Do not modify unrelated code. Do not commit instrumentation.',
    '- If no events arrive after reproduction: verify the endpoint with a one-off curl, check that the instrumented path actually ran, ask the user to reproduce again, and consider the file fallback in README.md (append NDJSON to the log file).',
    '- Use the debug_mode tool for status/logs/stop/cleanup. When the bug is fixed and verified, you MUST stop Debug Mode (debug_mode action="stop") and confirm 0 leftover markers.',
    '',
    'Begin with the hypotheses and the instrumentation plan for THIS bug.',
  ].join('\n')
}

/**
 * 每个模型步骤注入的上下文（只在会话处于 active 调试模式时返回非空）。
 *
 * @param {{id:string, bug:string, endpoint:string, logFile:string, startedAt:number, events:Array<object>, lastEventAt:number}} mode
 * @param {number} now
 */
export function buildContextText(mode, now = Date.now()) {
  if (mode === null || mode === undefined) return ''
  const count = Array.isArray(mode.events) ? mode.events.length : 0
  return [
    '## Debug Mode active (runtime-evidence debugging)',
    '',
    'Bug under investigation: ' + oneLine(mode.bug),
    'Session: ' + mode.id + ' · started ' + agoText(mode.startedAt, now) + ' · events collected: ' + count + ' · last event: ' + agoText(mode.lastEventAt, now) + '.',
    'Ingest endpoint: ' + mode.endpoint,
    'Cleanup marker (every instrumentation line must contain it): ' + markerFor(mode.id),
    'Log file: ' + mode.logFile,
    '',
    'Loop: hypotheses → instrument → ask the user to reproduce and wait → read logs (debug_mode action="logs") → minimal fix → ask the user to verify → remove all instrumentation → debug_mode action="stop".',
    'Do not fix before runtime evidence exists; keep every instrumentation line marked and fire-and-forget.',
  ].join('\n')
}

/** 状态文本（command 用中文，tool 用英文）。 */
export function buildStatusText(mode, now = Date.now(), lang = 'en') {
  if (mode === null || mode === undefined) {
    return lang === 'zh'
      ? '当前会话没有处于 Debug 模式。用 `/debug <bug 描述>` 开始一次调试。'
      : 'Debug Mode is not active in this session. Start one with debug_mode action="start" (or /debug <bug>).'
  }
  const count = Array.isArray(mode.events) ? mode.events.length : 0
  if (lang === 'zh') {
    const lines = [
      'Debug 模式进行中 · ' + mode.id,
      'Bug：' + oneLine(mode.bug, 160),
      '状态：' + mode.status + ' · 开始于 ' + agoText(mode.startedAt, now) + ' · 已收集事件 ' + count,
      '最近事件：' + agoText(mode.lastEventAt, now),
      '上报端点：' + mode.endpoint,
      '清理标记：' + markerFor(mode.id),
      '日志文件：' + mode.logFile,
      '结束：`/debug stop`（会扫描残留埋点）；查看日志：`/debug logs [条数] [--grep 关键词]`',
    ]
    return lines.join('\n')
  }
  const lines = [
    'Debug Mode is ACTIVE · ' + mode.id,
    'Bug: ' + oneLine(mode.bug, 160),
    'Status: ' + mode.status + ' · started ' + agoText(mode.startedAt, now) + ' · events: ' + count,
    'Last event: ' + agoText(mode.lastEventAt, now),
    'Endpoint: ' + mode.endpoint,
    'Marker: ' + markerFor(mode.id),
    'Log file: ' + mode.logFile,
  ]
  return lines.join('\n')
}

/** 残留埋点扫描结果文本。 */
export function buildLeftoverText(scan, lang = 'en') {
  if (scan === null || scan === undefined) return lang === 'zh' ? '（未执行扫描）' : '(scan not run)'
  const matches = Array.isArray(scan.matches) ? scan.matches : []
  if (matches.length === 0) {
    return lang === 'zh'
      ? '工作区没有残留埋点（扫描了 ' + scan.scanned + ' 个文件）。'
      : 'No leftover instrumentation found (' + scan.scanned + ' files scanned).'
  }
  const lines = []
  lines.push(lang === 'zh'
    ? '发现 ' + matches.length + ' 个文件仍有埋点（扫描了 ' + scan.scanned + ' 个文件）：'
    : matches.length + ' file(s) still contain the marker (' + scan.scanned + ' scanned):')
  for (const match of matches.slice(0, 20)) {
    lines.push('- ' + match.path + ' (' + match.lines.length + ' hit' + (match.lines.length === 1 ? '' : 's') + ')')
    for (const line of match.lines.slice(0, 5)) lines.push('    L' + line.line + ': ' + line.text.slice(0, 160))
  }
  if (matches.length > 20) lines.push(lang === 'zh' ? '…（更多省略）' : '… (more omitted)')
  if (scan.truncated === true) lines.push(lang === 'zh' ? '（扫描达到上限，可能还有遗漏）' : '(scan hit its limit; more may remain)')
  return lines.join('\n')
}

/** `/debug` 帮助文本。 */
export function renderHelp(lang = 'zh', active = undefined) {
  if (lang === 'en') {
    return [
      'Debug Mode — runtime-evidence debugging (Cursor-style).',
      '',
      '/debug <bug description>   start a session; the agent forms hypotheses, instruments your code,',
      '                           asks you to reproduce, reads the collected logs, then makes a minimal fix',
      '/debug status              show the active session and collected event count',
      '/debug logs [n] [--grep x] show the last n collected events (default 100)',
      '/debug stop                stop the session and scan the workspace for leftover instrumentation',
      '/debug cleanup             only scan for leftover markers',
      '',
      active === undefined ? 'No session is active.' : 'A session is already active: ' + active.id + ' — stop it first with /debug stop.',
    ].join('\n')
  }
  return [
    'Debug 模式 —— 用运行时证据定位根因（Cursor 式）。',
    '',
    '/debug <bug 描述>      开启调试：agent 先列假设、给代码插桩、请你复现、读运行时日志、再做最小修复',
    '/debug status          查看当前调试会话与已收集事件数',
    '/debug logs [条数] [--grep 关键词]   查看最近收集到的事件（默认 100 条）',
    '/debug stop            结束调试并扫描工作区里的残留埋点',
    '/debug cleanup         只扫描残留埋点',
    '',
    active === undefined ? '当前没有进行中的调试会话。' : '已有进行中的会话：' + active.id + '，先用 /debug stop 结束。',
    '提示：插桩写进代码后，请手动复现 bug，再把结果告诉我。',
  ].join('\n')
}

/**
 * 扫描文本里的标记行。
 *
 * @param {string} text 文件内容
 * @param {string} marker 标记字符串
 * @param {number} [maxHits]
 * @returns {Array<{line:number, text:string}>}
 */
export function findMarkerLines(text, marker, maxHits = 50) {
  if (typeof text !== 'string' || marker === '') return []
  const hits = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length && hits.length < maxHits; index += 1) {
    const line = lines[index]
    if (line.includes(marker)) hits.push({ line: index + 1, text: line.trim() })
  }
  return hits
}
