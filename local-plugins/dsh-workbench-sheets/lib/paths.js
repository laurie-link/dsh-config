/**
 * dsh-workbench-sheets — 路径解析与文件类型识别。
 * 支持「会话相对路径」与「绝对路径」两种形态；相对路径必须有 cwd（由路由层从
 * session/workingDirectory 解析），拿不到时返回可读错误而不是猜一个目录。
 */
import path from 'node:path'
import { wbError } from './errors.js'

/** 扩展名 → 业务 kind（只认这三个；其余在路由层报「暂不支持」）。 */
const KIND_BY_EXT = { csv: 'csv', tsv: 'tsv', xlsx: 'xlsx' }

/** 文件路径后缀（小写、无前导点）→ 'csv' | 'tsv' | 'xlsx' | null。 */
export function extKind(filePath) {
  const base = String(filePath || '').replace(/\\/g, '/').split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return KIND_BY_EXT[base.slice(dot + 1).toLowerCase()] || null
}

/** 是否绝对路径（POSIX 前导 /、Windows 盘符、UNC 双反斜杠）。 */
export function isAbsolutePath(filePath) {
  const value = String(filePath || '')
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

/** 校验客户端传来的原始 path 字符串（空值/NUL 一律 400）。 */
export function validateRawPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw wbError(400, 'bad_request', '缺少 path 参数')
  }
  if (rawPath.includes('\0')) throw wbError(400, 'bad_request', '路径包含非法字符')
  return rawPath
}

/**
 * 解析出宿主绝对路径。
 * @param {string} rawPath 客户端路径（相对或绝对）
 * @param {string|null|undefined} cwd 会话工作目录（相对路径必需）
 */
export function resolveTargetPath(rawPath, cwd) {
  validateRawPath(rawPath)
  if (isAbsolutePath(rawPath)) return path.normalize(rawPath)
  if (typeof cwd !== 'string' || cwd === '') {
    throw wbError(400, 'no_cwd', '无法确定会话工作目录（缺少 sessionId 或 cwd），无法解析相对路径')
  }
  return path.resolve(cwd, rawPath)
}

/** 路径最后一段（错误文案/标题用）。 */
export function basename(filePath) {
  return path.basename(String(filePath || ''))
}
