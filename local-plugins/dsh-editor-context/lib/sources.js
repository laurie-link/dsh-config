/**
 * dsh-editor-context — 官方右侧栏（side card）页签推断的纯函数。
 *
 * 用户大部分「正在看文件」场景其实在官方右侧栏：dsh-workbench-sheets 的 CSV/XLSX
 * 表格页签、官方 documentpreview 的 PDF/Word/PPT 预览页签。这些都不是 edrv Monaco
 * 页签，client 半通过本文件的纯函数把 DOM 里读到的属性（`data-textpreview-url`、
 * `data-workbench-sheets-path` 等）推断成活动文件。
 *
 * 本文件无 I/O、无 DOM 依赖，可被 `node --test` 直接覆盖；client.js 里有一份等价
 * 实现（浏览器插件不能 import 本地文件），并用沙盒测试做一致性校验。
 */

/** 官方 file 资源地址前缀（与 `@deepseek-ai/dsh-util-workspace-path` 语法一致）。 */
export const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** 是否为已知的官方资源地址。 */
export function isResourceAddress(value) {
  return typeof value === 'string' && value.startsWith(FILE_ADDRESS_PREFIX)
}

/**
 * 解析官方 `dsh-resource://file/…` 地址。
 *
 * - session 域：`dsh-resource://file/session/<sessionId>/<path>` → { sessionId, path }（path 可能是相对或绝对路径）
 * - absolute 域：`dsh-resource://file/absolute/<path>` → { path }（POSIX/Windows 盘符/UNC）
 *
 * Query/Fragment 后缀忽略；每段分别解码。不是已知作用域或解码失败时返回 null。
 */
export function parseResourceAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return null
  try {
    const end = address.search(/[?#]/)
    const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
    const [scope, ...rest] = body.split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return null
      const sessionId = decodeURIComponent(id)
      const path = segments.map((segment) => decodeURIComponent(segment)).join('/')
      if (!sessionId || !path) return null
      return { scope, sessionId, path }
    }
    if (scope === 'absolute') {
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map((segment) => decodeURIComponent(segment))
      if (segments.length === 0 || segments[0] === '') return null
      if (unc) return { scope, path: '//' + segments.join('/') }
      // Windows 盘符（C:）保持原样；其余按 POSIX 绝对路径补回前导 /
      if (/^[A-Za-z]:$/.test(segments[0])) return { scope, path: segments.join('/') }
      return { scope, path: '/' + segments.join('/') }
    }
    return null
  } catch (error) {
    return null
  }
}

/**
 * 从「官方侧栏活动 pane」里读到的属性推断活动文件（纯函数，输入是已取出的字符串）。
 *
 * 输入（都可缺省，DOM 属性可能暂不存在）：
 * - sheetPath / sheetAddress / sheetKind：dsh-workbench-sheets 正文根节点上的属性；
 * - previewUrl：官方 documentpreview 的 `data-textpreview-url`（文本/PDF/Word/PPT 都有）。
 *
 * 返回 `{ path, source: 'sheet'|'preview', sessionId? }`；推断不出返回 null。
 */
export function inferActiveSource(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const read = (name) => (typeof input[name] === 'string' ? input[name].trim() : '')

  const sheetPath = read('sheetPath')
  const sheetAddress = read('sheetAddress')
  const parsedSheet = sheetAddress ? parseResourceAddress(sheetAddress) : null
  // 表格页签：优先用属性里的「解析后路径」，缺省时回退地址里的 path
  const sheetResolved = sheetPath || (parsedSheet !== null ? parsedSheet.path : '')
  if (sheetResolved) {
    const result = { path: sheetResolved, source: 'sheet' }
    if (parsedSheet !== null && parsedSheet.sessionId) result.sessionId = parsedSheet.sessionId
    return result
  }

  const previewUrl = read('previewUrl')
  if (previewUrl) {
    const parsed = parseResourceAddress(previewUrl)
    if (parsed !== null && parsed.path) {
      const result = { path: parsed.path, source: 'preview' }
      if (parsed.sessionId) result.sessionId = parsed.sessionId
      return result
    }
  }
  return null
}

/**
 * 页签标题是否「像一个文件名」。
 *
 * 官方右侧栏还可以开非文件页签（终端/浏览器/计划/轨迹等，标题是本地化名词而不是
 * 文件名）。只把带扩展名、且扩展名不像版本号（纯数字）的标题当文件页签，
 * 避免把「对话/轨迹」这类页签收进打开列表。
 */
export function looksLikeFileTitle(title) {
  if (typeof title !== 'string') return false
  const text = title.trim()
  if (!text || text.length > 200) return false
  // 页签标题是 basename，不含路径分隔符与换行
  if (/[\\/\n\r]/.test(text)) return false
  const dot = text.lastIndexOf('.')
  if (dot <= 0) return false
  const stem = text.slice(0, dot)
  const ext = text.slice(dot + 1)
  if (!/^[A-Za-z0-9]{1,10}$/.test(ext)) return false
  // 纯数字扩展名多半是版本号/时间（如 v1.2），不当文件
  if (/^[0-9]+$/.test(ext)) return false
  return /\S/.test(stem)
}
