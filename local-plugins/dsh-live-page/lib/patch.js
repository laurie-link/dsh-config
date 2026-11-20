/**
 * dsh-live-page — HTML block patching, sanitizing, backups and atomic writes.
 *
 * The matching core is adapted from the user's standalone visual editor
 * (visual-editor/lib/locate.mjs + patch.mjs): exact outerHTML first, then a
 * normalized outerHTML, then a unique text fingerprint. The PoKeep-specific
 * `.article-content` anchor is kept when present, with a generic <body>
 * fallback for other static pages.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { backupDirOf, baseName } from './paths.js'

/** Blocks larger than this are rejected to protect the page layout. */
export const MAX_BLOCK_LENGTH = 12000

/** Patch failure with an HTTP status + stable code. */
export class PatchError extends Error {
  constructor(message, status = 409, code = 'patch_failed') {
    super(message)
    this.name = 'PatchError'
    this.status = status
    this.code = code
  }
}

/** Normalize text for fuzzy matching. */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Decode the small entity set that appears in static pages. */
function decodeHtmlEntities(html) {
  return String(html ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&times;/gi, '×')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

/** Text fingerprint used as a fallback when the DOM outerHTML was rewritten. */
function matchFingerprint(payload) {
  const fromOuter = normalizeText(
    decodeHtmlEntities(String(payload.outerHTML ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')),
  )
  const fromText = normalizeText(payload.text)
  if (fromOuter.length >= 12) return fromOuter
  if (fromText.length >= 12) return fromText
  return fromOuter || fromText
}

/** Strip editor runtime attributes/classes before matching or writing. */
export function sanitizeSavedHtml(html) {
  if (!html || typeof html !== 'string') return ''
  let out = html
    .replace(/\scontenteditable="(?:true|false)"/gi, '')
    .replace(/\sspellcheck="(?:true|false)"/gi, '')
    .replace(/\sautocorrect="(?:on|off)"/gi, '')
    .replace(/\sdata-dsh-live-[a-z0-9-]+="[^"]*"/gi, '')
    .replace(/\sdata-dsh-live-[a-z0-9-]+='[^']*'/gi, '')
    .replace(/\sdata-ve-[a-z0-9-]+="[^"]*"/gi, '')
    .replace(/\sclass="([^"]*)"/gi, (match, classValue) => {
      const cleaned = String(classValue)
        .split(/\s+/)
        .filter((token) => token && !/^(?:dsh-live-|ve-)/i.test(token))
        .join(' ')
      return cleaned ? ` class="${cleaned}"` : ''
    })
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, ' $1="#"')
  return out.trim()
}

/** Normalize HTML for equality matching (also strips editor-only attrs). */
function normalizeHtmlForMatch(html) {
  return decodeHtmlEntities(html)
    .replace(/\scontenteditable="(?:true|false)"/gi, '')
    .replace(/\sspellcheck="(?:true|false)"/gi, '')
    .replace(/\sautocorrect="(?:on|off)"/gi, '')
    .replace(/\sdata-dsh-live-[a-z0-9-]+="[^"]*"/gi, '')
    .replace(/\sdata-dsh-live-[a-z0-9-]+='[^']*'/gi, '')
    .replace(/\sdata-ve-[a-z0-9-]+="[^"]*"/gi, '')
    .replace(/\sclass="([^"]*)"/gi, (match, classValue) => {
      const cleaned = String(classValue)
        .split(/\s+/)
        .filter((token) => token && !/^(?:dsh-live-|ve-)/i.test(token))
        .join(' ')
      return cleaned ? ` class="${cleaned}"` : ''
    })
    .replace(/<br\s*\/?>/gi, '<br>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Locate the outer/inner bounds of `.article-content` when present. */
export function getArticleContentBounds(html) {
  const divPattern = /<div[^>]*\bclass="([^"]*)"[^>]*>/gi
  let match
  while ((match = divPattern.exec(html)) !== null) {
    const tokens = String(match[1] || '').split(/\s+/).filter(Boolean)
    if (!tokens.includes('article-content')) continue
    const outerStart = match.index
    const innerStart = outerStart + match[0].length
    const tagRegex = /<\/?div\b[^>]*>/gi
    tagRegex.lastIndex = innerStart
    let depth = 1
    let closeMatch
    while ((closeMatch = tagRegex.exec(html)) !== null) {
      depth += closeMatch[0].startsWith('</') ? -1 : 1
      if (depth === 0) {
        return {
          outerStart,
          outerEnd: closeMatch.index + closeMatch[0].length,
          innerStart,
          innerEnd: closeMatch.index,
        }
      }
    }
  }
  return null
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Extract an anchor-id section inside `.article-content`. */
export function getAnchorSection(html, anchor) {
  const bounds = getArticleContentBounds(html)
  if (!bounds) return null
  const inner = html.slice(bounds.innerStart, bounds.innerEnd)
  const id = String(anchor ?? '').replace(/^#/, '')
  if (!id) return { start: bounds.innerStart, end: bounds.innerEnd, section: inner }
  const idPattern = new RegExp(`\\bid=["']${escapeRegExp(id)}["']`, 'i')
  const idMatch = idPattern.exec(inner)
  if (!idMatch) return null
  const headingPattern = new RegExp(`<h[1-4][^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>`, 'i')
  const headingMatch = headingPattern.exec(inner)
  let sectionStart = headingMatch ? headingMatch.index : inner.lastIndexOf('<', idMatch.index)
  if (sectionStart < 0) sectionStart = idMatch.index
  const nextHeading = inner.slice(sectionStart + 1).search(/<h[1-3][^>]*\bid=["'][^"']+["']/i)
  const sectionEnd = nextHeading === -1 ? inner.length : sectionStart + 1 + nextHeading
  return {
    start: bounds.innerStart + sectionStart,
    end: bounds.innerStart + sectionEnd,
    section: inner.slice(sectionStart, sectionEnd),
  }
}

/** Find a unique exact occurrence of outerHTML within [minIndex, maxIndex]. */
function findExactOuterHtml(sectionHtml, outerHTML, minIndex, maxIndex) {
  if (!outerHTML) return null
  const first = sectionHtml.indexOf(outerHTML, minIndex)
  if (first === -1 || first > maxIndex) return null
  const second = sectionHtml.indexOf(outerHTML, first + 1)
  if (second !== -1 && second <= maxIndex) return null
  const tagMatch = outerHTML.match(/^<([a-z0-9]+)/i)
  if (!tagMatch) return null
  const tagName = tagMatch[1].toLowerCase()
  const tagRegex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi')
  const normalizedMatches = []
  let match
  while ((match = tagRegex.exec(sectionHtml)) !== null) {
    if (match.index < minIndex || match.index > maxIndex) continue
    if (normalizeHtmlForMatch(match[0]) === normalizeHtmlForMatch(outerHTML)) {
      normalizedMatches.push({ index: match.index, length: match[0].length, method: 'outerHTML-normalized' })
    }
  }
  return normalizedMatches.length === 1 ? normalizedMatches[0] : null
}

/** Find a unique occurrence using exact/normalized outerHTML or a text fingerprint. */
export function findMatchIndex(sectionHtml, payload, options = {}) {
  const outer = String(payload?.outerHTML ?? '')
  const minIndex = Math.max(0, Number(options.minIndex ?? 0) || 0)
  const maxIndex = typeof options.maxIndex === 'number' ? options.maxIndex : sectionHtml.length
  const exact = findExactOuterHtml(sectionHtml, outer, minIndex, maxIndex)
  if (exact) return exact
  const fingerprint = matchFingerprint(payload)
  if (fingerprint.length < 12) return null
  const tagName = String(payload?.tag || 'p').toLowerCase().replace(/[^a-z0-9]/g, '') || 'p'
  const tagRegex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi')
  const candidates = []
  let match
  while ((match = tagRegex.exec(sectionHtml)) !== null) {
    if (match.index < minIndex || match.index > maxIndex) continue
    const inner = match[1].replace(/<[^>]+>/g, ' ')
    if (normalizeText(inner).includes(fingerprint.slice(0, Math.min(80, fingerprint.length)))) {
      candidates.push({ index: match.index, length: match[0].length, html: match[0] })
    }
  }
  if (candidates.length === 1) {
    return { index: candidates[0].index, length: candidates[0].length, method: 'text-fingerprint' }
  }
  if (candidates.length > 1 && outer) {
    const normalizedOuter = normalizeHtmlForMatch(outer)
    const matching = candidates.filter(
      (candidate) => candidate.html === outer || normalizeHtmlForMatch(candidate.html) === normalizedOuter,
    )
    if (matching.length === 1) {
      return { index: matching[0].index, length: matching[0].length, method: 'text-fingerprint+outerHTML' }
    }
  }
  return null
}

/** Body bounds used by the generic fallback. */
export function bodyBounds(html) {
  const open = /<body\b[^>]*>/i.exec(html)
  const close = html.toLowerCase().lastIndexOf('</body>')
  return {
    start: open ? open.index + open[0].length : 0,
    end: close > 0 ? close : html.length,
  }
}

/**
 * Locate one block. Returns absolute [start, end) offsets in `html`.
 * Article-anchored matching is tried first; the body fallback is generic.
 */
export function resolveBlockMatch(html, payload) {
  const anchors = []
  if (typeof payload?.anchor === 'string' && payload.anchor !== '') anchors.push(payload.anchor)
  anchors.push('')
  const hasArticle = getArticleContentBounds(html) !== null
  if (hasArticle) {
    for (const anchor of anchors) {
      const section = getAnchorSection(html, anchor)
      if (!section) continue
      const match = findMatchIndex(section.section, payload)
      if (match) {
        return {
          start: section.start + match.index,
          end: section.start + match.index + match.length,
          method: match.method,
          scope: 'article',
        }
      }
    }
  }
  const body = bodyBounds(html)
  const match = findMatchIndex(html, payload, { minIndex: body.start, maxIndex: body.end })
  if (match) {
    return { start: match.index, end: match.index + match.length, method: match.method, scope: 'body' }
  }
  return null
}

/** Reject container/script injection in a new block. */
export function assertSafeNewBlock(newBlock) {
  if (!newBlock) return
  if (newBlock.length > MAX_BLOCK_LENGTH) {
    throw new PatchError('修改后的内容过大，保存已拒绝', 413, 'block_too_large')
  }
  if (/<(?:script|style|iframe|object|embed|link|meta|base)\b/i.test(newBlock)) {
    throw new PatchError('修改后的内容包含不允许的标签（script/style/iframe 等）', 400, 'unsafe_tag')
  }
  if (/\son[a-z]+\s*=/i.test(newBlock) || /(?:href|src)\s*=\s*["']?\s*javascript:/i.test(newBlock)) {
    throw new PatchError('修改后的内容包含可执行属性，保存已拒绝', 400, 'unsafe_attribute')
  }
  if (/<body\b|<html\b|article-content-box/i.test(newBlock)) {
    throw new PatchError('保存已拒绝：修改内容疑似包含页面容器标记', 400, 'container_markup')
  }
  if (/class="[^"]*\barticle-content\b/i.test(newBlock)) {
    throw new PatchError('保存已拒绝：修改内容疑似包含 article-content 容器', 400, 'container_markup')
  }
}

/** Keep `.article-content` position stable when it exists in both versions. */
function assertArticleContentIntact(before, after) {
  const a = getArticleContentBounds(before)
  if (!a) return
  const b = getArticleContentBounds(after)
  if (!b) throw new PatchError('保存已拒绝：article-content 容器在修改后消失', 400, 'container_lost')
  if (a.outerStart !== b.outerStart || a.innerStart !== b.innerStart) {
    throw new PatchError('保存已拒绝：article-content 容器位置发生变化', 400, 'container_moved')
  }
}

/**
 * Apply one block save to an HTML string.
 * @returns {{changed:boolean,html:string,method:string,oldBlock:string,newBlock:string}}
 */
export function patchHtml(html, payload) {
  if (typeof payload?.newOuterHTML !== 'string') throw new PatchError('缺少 newOuterHTML', 400, 'bad_payload')
  const originalOuter = sanitizeSavedHtml(String(payload?.outerHTML ?? ''))
  const probe = {
    outerHTML: originalOuter,
    text: String(payload?.text ?? ''),
    tag: String(payload?.tag ?? 'p'),
    anchor: typeof payload?.anchor === 'string' ? payload.anchor : '',
  }
  const match = resolveBlockMatch(html, probe)
  if (!match) {
    throw new PatchError('无法在源文件中定位选中内容（源文件可能已变化，或内容不唯一）', 409, 'match_missing')
  }
  const oldBlock = html.slice(match.start, match.end)
  if (oldBlock.length > MAX_BLOCK_LENGTH) {
    throw new PatchError('选中的源 HTML 块过大，保存已拒绝', 413, 'block_too_large')
  }
  const rawNew = String(payload.newOuterHTML)
  if (/\son[a-z]+\s*=/i.test(rawNew) || /(?:href|src)\s*=\s*["']?\s*javascript:/i.test(rawNew)) {
    throw new PatchError('修改后的内容包含可执行属性，保存已拒绝', 400, 'unsafe_attribute')
  }
  const newBlock = sanitizeSavedHtml(payload.newOuterHTML)
  assertSafeNewBlock(newBlock)
  if (newBlock === oldBlock || (newBlock === '' && oldBlock === '')) {
    return { changed: false, html, method: match.method, oldBlock, newBlock }
  }
  const updated = html.slice(0, match.start) + newBlock + html.slice(match.end)
  assertArticleContentIntact(html, updated)
  return { changed: true, html: updated, method: match.method, oldBlock, newBlock }
}

// --region file IO: backup + atomic write + per-file lock

/** Short stable name for one relative file. */
function safeBackupName(relPath) {
  const hash = createHash('sha1').update(String(relPath)).digest('hex').slice(0, 10)
  const base = baseName(relPath).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'page.html'
  return `${hash}-${base}`
}

function stampOf(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Write one backup and prune old ones for the same file. */
export async function backupFile({ root, relPath, html, keep = 20 }) {
  const dir = backupDirOf(root)
  await mkdir(dir, { recursive: true })
  const prefix = safeBackupName(relPath) + '.'
  const name = `${prefix}${stampOf()}.html`
  await writeFile(join(dir, name), html, 'utf8')
  try {
    const entries = (await readdir(dir)).filter((entry) => entry.startsWith(prefix) && entry.endsWith('.html')).sort()
    const excess = entries.slice(0, Math.max(0, entries.length - keep))
    for (const entry of excess) await unlink(join(dir, entry)).catch(() => {})
  } catch {
    // Pruning is best-effort; a failed prune must not fail the save.
  }
  return join(dir, name)
}

/** Replace a file atomically (temp file in the same directory + rename). */
export async function atomicWrite(absPath, content) {
  const info = await stat(absPath).catch(() => null)
  const mode = info?.mode ? info.mode & 0o777 : undefined
  const temp = `${absPath}.dsh-live-${process.pid}-${Date.now().toString(36)}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode })
    if (mode !== undefined) await chmod(temp, mode).catch(() => {})
    await rename(temp, absPath)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** Per-absolute-path promise chain: saves to one file never interleave. */
const fileLocks = new Map()

export function withFileLock(key, fn) {
  const previous = fileLocks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(fn)
  fileLocks.set(key, next)
  return next.finally(() => {
    if (fileLocks.get(key) === next) fileLocks.delete(key)
  })
}

/**
 * Read → patch → backup → atomic write, serialized per file.
 * @returns {{method:string,backup:string,version:string,changed:boolean}}
 */
export async function saveHtmlBlock({ absPath, relPath, root, payload, keepBackups = 20 }) {
  return withFileLock(absPath, async () => {
    const html = await readFile(absPath, 'utf8')
    const result = patchHtml(html, payload)
    if (!result.changed) {
      const info = await stat(absPath)
      return { method: result.method, backup: '', version: versionOfStat(info), changed: false }
    }
    const backup = await backupFile({ root, relPath, html, keep: keepBackups })
    await atomicWrite(absPath, result.html)
    const info = await stat(absPath)
    return { method: result.method, backup, version: versionOfStat(info), changed: true }
  })
}

function versionOfStat(info) {
  const mtime = typeof info?.mtimeMs === 'number' ? Math.round(info.mtimeMs) : 0
  const size = typeof info?.size === 'number' ? info.size : 0
  return `${mtime}:${size}`
}

// --endregion
