/**
 * dsh-live-page — per-session browser page snapshot and prompt text.
 *
 * The client reports the active IDE-browser page; this module normalizes it,
 * keeps one entry per session with a 30 minute TTL, and renders the short
 * runtime-context block the agent sees on every step.
 */
import { isHtmlPath, normalizeSlashes } from './paths.js'

/** Page snapshot TTL. */
export const PAGE_TTL_MS = 30 * 60 * 1000

/** Normalize one page payload; returns null for malformed input. */
export function normalizePage(input) {
  if (input === null || input === undefined) return null
  if (typeof input !== 'object') return null
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : ''
  if (rawUrl === '' || rawUrl.length > 2048) return null
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const titleRaw = typeof input.title === 'string' ? input.title : ''
  const title = titleRaw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  const kind = input.kind === 'live' || input.kind === 'live-index' ? input.kind : 'browser'
  let file = ''
  if (typeof input.file === 'string' && input.file !== '') {
    const normalized = normalizeSlashes(input.file).replace(/^\/+/, '')
    if (!normalized.includes('..') && normalized.length <= 1024) file = normalized
  }
  return {
    url: url.href,
    title: title || url.hostname,
    kind,
    ...(file ? { file } : {}),
  }
}

/** Validate one client report. */
export function normalizeReport(payload) {
  if (!payload || typeof payload !== 'object') return null
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
  if (!sessionId || sessionId.length > 200) return null
  if (payload.page === null) return { sessionId, page: null }
  const page = normalizePage(payload.page)
  if (!page) return null
  return { sessionId, page }
}

/** Enrich a page with the live server's file mapping when its origin matches. */
export function enrichPageWithLive(page, servers) {
  if (!page) return page
  let url
  try {
    url = new URL(page.url)
  } catch {
    return page
  }
  const origin = url.origin
  const hit = (Array.isArray(servers) ? servers : []).find((server) => server && server.origin === origin)
  if (!hit) return page
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return { ...page, kind: 'live-index' }
  }
  let rel = normalizeSlashes(pathname).replace(/^\/+/, '')
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  if (!isHtmlPath(rel) || rel.includes('..')) return { ...page, kind: 'live-index' }
  return { ...page, kind: 'live', file: rel }
}

/** Render the runtime context block; '' when there is no fresh page. */
export function contextTextFor(store, sessionId, now = Date.now()) {
  const entry = store?.get?.(sessionId, now)
  if (!entry || !entry.page) return ''
  const page = entry.page
  const ageSeconds = Math.max(0, Math.round((now - entry.at) / 1000))
  const ageNote = ageSeconds >= 60 ? ` (as of ${ageSeconds}s ago)` : ''
  const lines = ['Browser page in the IDE (live):']
  lines.push(`- Title: ${page.title}`)
  lines.push(`- URL: ${page.url}${ageNote}`)
  if (page.kind === 'live' && page.file) {
    lines.push(
      `- This is a local HTML page opened in the IDE live editor; its source file is ${page.file}. Edits made in the page save to that file.`,
    )
  } else if (page.kind === 'live-index') {
    lines.push('- This is the live editor file picker, not a content page.')
  } else {
    lines.push('- This is an external web page opened in the IDE browser.')
  }
  return lines.join('\n')
}

/** Create an isolated page store (one per plugin instance / test). */
export function createPageStore({ ttlMs = PAGE_TTL_MS } = {}) {
  const bySession = new Map()
  return {
    set(sessionId, page, at = Date.now()) {
      if (!sessionId) return
      if (!page) {
        bySession.delete(sessionId)
        return
      }
      bySession.set(sessionId, { page, at })
    },
    get(sessionId, now = Date.now()) {
      const entry = bySession.get(sessionId)
      if (!entry) return null
      if (now - entry.at > ttlMs) {
        bySession.delete(sessionId)
        return null
      }
      return entry
    },
    clear(sessionId) {
      bySession.delete(sessionId)
    },
    entries(now = Date.now()) {
      const out = []
      for (const [sessionId, entry] of bySession) {
        if (now - entry.at > ttlMs) {
          bySession.delete(sessionId)
          continue
        }
        out.push({ sessionId, ...entry })
      }
      return out
    },
    textFor(sessionId, now = Date.now()) {
      return contextTextFor(this, sessionId, now)
    },
  }
}
