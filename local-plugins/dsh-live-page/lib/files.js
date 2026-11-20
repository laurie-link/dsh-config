/**
 * dsh-live-page — workspace HTML file enumeration for the live server's picker.
 *
 * Read-only, bounded and cached for 10s. Symlinks are skipped: the picker must
 * never advertise a file outside the workspace.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isHtmlPath, normalizeSlashes } from './paths.js'

/** Directories that never contain editable site pages. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.cache',
  '.venv',
  'venv',
  'vendor',
  '.idea',
  '.vscode',
])

const CACHE_TTL_MS = 10_000
const CACHE = new Map()

/**
 * List HTML files under root.
 * @param {string} root absolute workspace root
 * @param {{max?:number,maxDepth?:number,budgetMs?:number,fresh?:boolean}} [options]
 * @returns {Promise<{root:string,files:Array<{path:string,rel:string}>,truncated:boolean}>}
 */
export async function listHtmlFiles(root, options = {}) {
  const key = String(root)
  const now = Date.now()
  const cached = CACHE.get(key)
  if (!options.fresh && cached && now - cached.at < CACHE_TTL_MS) return cached.data
  const data = await walkRoot(key, options)
  CACHE.set(key, { at: Date.now(), data })
  return data
}

/** Drop one root (or all) from the cache. */
export function clearFileListCache(root) {
  if (root === undefined) CACHE.clear()
  else CACHE.delete(String(root))
}

async function walkRoot(root, options) {
  const max = clampInt(options.max, 1000, 1, 5000)
  const maxDepth = clampInt(options.maxDepth, 8, 1, 32)
  const budgetMs = clampInt(options.budgetMs, 2500, 200, 15000)
  const start = Date.now()
  const files = []
  let truncated = false

  async function walk(dir, depth) {
    if (truncated) return
    if (Date.now() - start > budgetMs) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (depth >= maxDepth) {
          truncated = true
          return
        }
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(join(dir, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!isHtmlPath(entry.name)) continue
      const absolute = join(dir, entry.name)
      const rel = normalizeSlashes(absolute.slice(root.length + 1))
      files.push({ path: rel, rel })
      if (files.length >= max) {
        truncated = true
        return
      }
    }
  }

  await walk(root, 0)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { root, files, truncated }
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}
