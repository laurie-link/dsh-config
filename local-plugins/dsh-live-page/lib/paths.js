/**
 * dsh-live-page — path helpers (host side).
 *
 * Pure functions only: no DSH service, no filesystem reads. Every path that reaches
 * the live server goes through these guards before it can be served or written.
 */
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** Supported page suffixes (lowercase, no dot). */
export const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'shtml'])

/** Plugin id / home directory segment. */
export const PLUGIN_ID = 'dsh-live-page'

/** Lower-case suffix without the dot; '' when there is none. */
export function suffixOf(value) {
  const base = String(value ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** True for a browser-renderable page path. */
export function isHtmlPath(value) {
  const suffix = suffixOf(value)
  return suffix !== '' && HTML_EXTENSIONS.has(suffix)
}

/** Normalize separators to `/`. */
export function normalizeSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** POSIX, Windows drive or UNC absolute path. */
export function isAbsolutePath(value) {
  const text = String(value ?? '')
  return text.startsWith('/') || text.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(text)
}

/** DSH home (`DSH_HOME` override, then `~/.dsh`). */
export function dshHome() {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') return resolve(override)
  return join(homedir(), '.dsh')
}

/** Backup root: ~/.dsh/dsh-live-page/backups. */
export function backupRoot() {
  return join(dshHome(), PLUGIN_ID, 'backups')
}

/** Stable short hash (workspace directory segment). */
export function hashOf(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

/** Workspace backup directory for one root. */
export function backupDirOf(root) {
  return join(backupRoot(), hashOf(root))
}

/** Reject a raw client path before any resolution. */
export function validateRawPath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw pathError('缺少 path 参数')
  if (raw.includes('\0')) throw pathError('路径包含非法字符')
  return raw
}

/** Resolve a client path against the session cwd. */
export function resolveRequestPath(cwd, raw) {
  validateRawPath(raw)
  if (isAbsolutePath(raw)) return resolve(raw)
  if (typeof cwd !== 'string' || cwd === '') throw pathError('无法确定会话工作目录')
  return resolve(cwd, raw)
}

/** Error with an HTTP status + stable code (routes translate it). */
export function pathError(message, status = 400, code = 'bad_request') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** True when target is root itself or a descendant (POSIX-normalized, case-sensitive). */
export function isInside(root, target) {
  const base = resolve(String(root))
  const file = resolve(String(target))
  const rel = relative(base, file)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/**
 * Site root for a page: workspace when the page lives inside it, else the page directory.
 * Mirrors dsh-vscode-mode's htmlPreview contract.
 */
export function siteRootOf(workspace, file) {
  const target = normalizeSlashes(resolve(String(file)))
  const base = String(workspace ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && target.length > base.length && target.slice(0, base.length + 1) === base + '/') {
    return { root: base, rel: target.slice(base.length + 1) }
  }
  const cut = target.lastIndexOf('/')
  if (cut <= 0) return { root: '/', rel: target.replace(/^\/+/, '') }
  return { root: target.slice(0, cut), rel: target.slice(cut + 1) }
}

/** Relative URL path (forward slashes) for a file under root; throws when outside. */
export function relOf(root, file) {
  const rel = relative(resolve(String(root)), resolve(String(file)))
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw pathError('文件不在站点根目录内', 403, 'outside_root')
  }
  return normalizeSlashes(rel)
}

/** Reject traversal inside an already-decoded URL-relative path. */
export function safeRelPath(value) {
  const rel = normalizeSlashes(String(value ?? '')).replace(/^\/+/, '')
  if (rel === '' || rel.includes('\0')) throw pathError('路径非法')
  const parts = rel.split('/')
  if (parts.some((part) => part === '..' || part === '.')) throw pathError('路径非法')
  return rel
}

/** Version token used by the overlay/version route. */
export function versionOf(info) {
  const mtime = typeof info?.mtimeMs === 'number' && Number.isFinite(info.mtimeMs) ? Math.round(info.mtimeMs) : 0
  const size = typeof info?.size === 'number' && Number.isFinite(info.size) ? info.size : 0
  return `${mtime}:${size}`
}

/** Parent directory (file path or directory path). */
export function parentOf(value) {
  return dirname(String(value))
}

/** Basename for labels. */
export function baseName(value) {
  const text = normalizeSlashes(value)
  return text.slice(text.lastIndexOf('/') + 1) || text
}
