/**
 * dsh-editor-context — Host 半的纯逻辑（无 I/O、不依赖 DSH 运行时）。
 *
 * 这里只有三件事：把浏览器上报规范化（坏字段丢弃）、保存最近一次快照、
 * 把快照渲染成给模型看的短文本。抽成独立文件是为了能用 `node --test` 直接
 * 覆盖 normalizeReport / contextTextFor，不需要起 DSH 实例。
 */

/** 上报快照的最长有效期（毫秒）。超过后视为没有编辑器上下文，避免陈旧事实误导模型。 */
export const STATE_TTL_MS = 30 * 60 * 1000
/** 运行时上下文在 prompt 中的排序（排在 working-directory(100)/sandbox(110) 之后）。 */
export const CONTEXT_ORDER = 130
/** 注入用的上下文名称（同名注册会被 DSH 去重/替换）。 */
export const CONTEXT_NAME = 'editor-context'

/** 最多记住多少条打开页签（防止异常上报撑爆内存与文本）。 */
const MAX_OPEN_ITEMS = 50
/** 注入文本里最多列出多少条打开页签。 */
const MAX_OPEN_LISTED = 12
/** 快照年龄超过该值才在文本里提「as of Ns ago」，避免每步都出现秒数噪音。 */
const AGE_HINT_MIN_MS = 3000

/** 最近一次上报（单浏览器客户端假设；多客户端时后到者覆盖）。 */
let latest = null

export function setLatestReport(report) { latest = report }
export function getLatestReport() { return latest }
export function clearLatestReport() { latest = null }

/** 非负有限数字；不合法时返回 undefined。 */
function finitePositive(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : undefined
}

/** 规范化一条打开页签：任取 label/path 其一，保留 active 标记。 */
function normalizeOpenItem(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  const label = typeof item.label === 'string' ? item.label.trim() : ''
  const path = typeof item.path === 'string' ? item.path.trim() : ''
  if (!label && !path) return null
  const entry = { label: label || path, path }
  // active 只认严格的 true：活动页签（含 PDF 等非文本页签）由它标出。
  if (item.active === true) entry.active = true
  return entry
}

/** 规范化活动文件（路径必填；语言/选区/光标行都是可选补充事实）。 */
function normalizeActive(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.path !== 'string' || !raw.path) return null
  const active = { path: raw.path }
  if (typeof raw.language === 'string' && raw.language) active.language = raw.language
  // source 表示这份文件不是 Monaco 文本编辑器，而是官方侧栏的预览（PDF/Word/PPT/文本预览）
  // 或表格页签（CSV/XLSX）；其它值一律丢弃。
  if (raw.source === 'preview' || raw.source === 'sheet') active.source = raw.source
  const selection = raw.selection
  if (selection !== null && typeof selection === 'object' && !Array.isArray(selection)) {
    const start = Math.round(Number(selection.startLine))
    const end = Math.round(Number(selection.endLine))
    if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
      active.selection = { startLine: start, endLine: end }
    }
  }
  const cursor = Math.round(Number(raw.cursorLine))
  if (Number.isFinite(cursor) && cursor > 0) active.cursorLine = cursor
  return active
}

/**
 * 规范化浏览器上报。坏输入（非对象/数组）返回 null；对象里的坏字段直接丢弃，
 * 只保留注入所需的最小事实。永不抛错。
 */
export function normalizeReport(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const sessionId = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null
  const at = Number(input.at)
  const view = input.view === 'cursor' || input.view === 'agent' ? input.view : undefined
  const active = normalizeActive(input.active)
  const open = []
  if (Array.isArray(input.open)) {
    for (const item of input.open.slice(0, MAX_OPEN_ITEMS)) {
      const entry = normalizeOpenItem(item)
      if (entry !== null) open.push(entry)
    }
  }
  return {
    sessionId,
    at: Number.isFinite(at) ? at : Date.now(),
    view,
    active,
    open,
  }
}

/** 选区文案：单行「line N selected」，多行「lines A-B selected」。 */
function selectionText(selection) {
  return selection.startLine === selection.endLine
    ? 'line ' + selection.startLine + ' selected'
    : 'lines ' + selection.startLine + '-' + selection.endLine + ' selected'
}

/**
 * 某个会话当前应注入的编辑器上下文文本（没有可用快照时返回空串）。
 *
 * @param {string|undefined} sessionId 目标会话；`undefined` 表示不过滤（诊断路由）。
 * @param {number} [now] 注入时刻（测试用，便于验证 TTL）。
 * @param {string} [cwd] 会话工作目录（已知时写进文本，帮助模型解析相对路径）。
 */
export function contextTextFor(sessionId, now = Date.now(), cwd = '') {
  const snapshot = latest
  if (snapshot === null || typeof snapshot !== 'object') return ''
  // 未来时间戳（时钟回拨）按刚上报处理；负年龄不算过期。
  const ageMs = Math.max(0, (Number.isFinite(now) ? now : Date.now()) - (Number.isFinite(snapshot.at) ? snapshot.at : 0))
  if (ageMs > STATE_TTL_MS) return ''
  // 会话不匹配必须返回空串：不能把别的会话的编辑器状态注入给无关 Agent。
  // （snapshot.sessionId 为 null/undefined 表示上报方不知道会话，按全局状态处理。）
  if (snapshot.sessionId !== null && snapshot.sessionId !== undefined && sessionId !== undefined && snapshot.sessionId !== sessionId) return ''

  const open = Array.isArray(snapshot.open) ? snapshot.open : []
  const active = snapshot.active !== null && typeof snapshot.active === 'object' && typeof snapshot.active.path === 'string'
    ? snapshot.active
    : null

  const lines = []
  let header = 'User editor state (DSH VSCode workbench on the right, Cursor-style layout'
  if (ageMs >= AGE_HINT_MIN_MS) header += ', as of ' + Math.round(ageMs / 1000) + 's ago'
  lines.push(header + '):')

  if (snapshot.view === 'cursor') lines.push('- View: cursor (file editor and chat side by side)')
  else if (snapshot.view === 'agent') lines.push('- View: agent (chat focused; the editor pane may be hidden)')
  if (typeof cwd === 'string' && cwd) lines.push('- Session working directory: ' + cwd)

  if (active !== null && active.source === 'sheet') {
    // 我们是自己的可编辑表格页签（CSV/XLSX），不能写成只读查看器。
    lines.push('- Active file (open in the editable spreadsheet tab): ' + active.path)
  } else if (active !== null && active.source === 'preview') {
    // 官方 documentpreview：PDF/Word/PPT/文本预览都是只读查看器。
    lines.push('- Active file (open in a read-only viewer): ' + active.path)
  } else if (active !== null) {
    let line = '- Active file: ' + active.path
    const meta = []
    if (active.language) meta.push('language ' + active.language)
    if (active.selection) meta.push(selectionText(active.selection))
    else if (active.cursorLine) meta.push('cursor at line ' + active.cursorLine)
    if (meta.length) line += ' (' + meta.join('; ') + ')'
    lines.push(line)
  } else {
    const activeTab = open.find((item) => item !== null && typeof item === 'object' && item.active === true)
    if (activeTab) {
      // 非文本页签（PDF 等没有 Monaco 文本模型的页签）：不冒充活动文件，但仍给出事实。
      lines.push('- Active tab: ' + (activeTab.path || activeTab.label) + ' (not a text editor — read it with file tools if its content matters)')
    } else {
      lines.push('- No active text file in the editor.')
    }
  }

  if (open.length) {
    const names = []
    for (const item of open.slice(0, MAX_OPEN_LISTED)) {
      const name = (item !== null && typeof item === 'object' && (item.label || item.path)) || ''
      if (name) names.push(name)
    }
    if (names.length) lines.push('- Open editor tabs: ' + names.join(', ') + (open.length > names.length ? ', …' : ''))
  }

  lines.push('Paths are workspace-relative to the session working directory unless absolute. Interpret "this file" / "当前文件" / "这里" as the active file when it exists; use the file tools to read it before editing.')
  return lines.join('\n')
}
