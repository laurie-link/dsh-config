/**
 * dsh-cursor-layout — Host half.
 *
 * The browser half owns the geometry projection. This half exists for two
 * reasons:
 *   1. the bundle needs a mounted loader row the Client module can hang off;
 *   2. it exposes a tiny local diagnostics route the Client half posts its
 *      measured frame geometry to (`GET /cursor-layout/report`), which is what
 *      makes a remote layout problem observable without a screenshot.
 *
 * The route is loopback-only by deployment (the DSH web server binds loopback)
 * and stores nothing but the latest report in memory.
 *
 * @author DSH user session 2026-11-03 
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['webServer']

/** Mirror the browser half's latest measurement next to the other DSH logs. */
function storeReport(text) {
  try {
    const dir = join(process.env.HOME ?? '.', '.dsh', 'logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'dsh-cursor-layout-report.json'), text, 'utf8')
  } catch { /* diagnostics only */ }
}

/** Max accepted report size; the payload is a few KiB of geometry. */
const MAX_REPORT_BYTES = 256 * 1024

/**
 * 这是
 */

/** Read a request body as UTF-8 text with a hard size cap. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('report too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function apply(ctx) {
  /** Probe route: report the live plugin config + LLM routes the AI paths depend on. */
  const probeHandler = async (req, res) => {
    const out = { at: new Date().toISOString() }
    try {
      const loader = ctx.get('loader')
      const entries = loader && typeof loader.entries === 'function' ? [...loader.entries()] : []
      out.entries = entries
        .filter((entry) => {
          const name = String((entry && entry.options && entry.options.name) || '')
          return name === 'dsh-vscode-mode' || name === 'dsh-cursor-layout'
        })
        .map((entry) => ({
          id: entry && entry.id,
          name: entry && entry.options && entry.options.name,
          disabled: entry && entry.options && entry.options.disabled === true,
          config: entry && entry.options && entry.options.config,
        }))
    } catch (error) {
      out.entriesError = String((error && error.message) || error)
    }
    try {
      const llm = ctx.get('llm')
      out.llm = {
        providers: typeof llm?.listProviders === 'function' ? llm.listProviders() : null,
      }
      if (typeof llm?.listModels === 'function' && Array.isArray(out.llm.providers) && out.llm.providers.length > 0) {
        const routes = {}
        for (const provider of out.llm.providers.slice(0, 6)) {
          const id = provider && provider.id ? provider.id : String(provider)
          try { routes[id] = await llm.listModels(id) } catch (error) { routes[id] = 'ERR: ' + String((error && error.message) || error) }
        }
        out.llm.models = routes
      }
    } catch (error) {
      out.llmError = String((error && error.message) || error)
    }
    try {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        out.settings = null
      } else {
        out.settings = {
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(settings) || {}).slice(0, 40),
        }
        const sources = {}
        for (const name of ['describe', 'update', 'read', 'get', 'replace', 'write']) {
          if (typeof settings[name] === 'function') sources[name] = String(settings[name]).slice(0, 2500)
        }
        out.settings.sources = sources
        try { out.settings.documentPath = typeof settings.documentPath === 'function' ? settings.documentPath() : String(settings.documentPath) } catch (error) { out.settings.documentPathError = String((error && error.message) || error) }
        try { out.settings.describeResult = await settings.describe() } catch (error) { out.settings.describeError = String((error && error.message) || error) }
      }
    } catch (error) {
      out.settingsError = String((error && error.message) || error)
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(out, null, 1))
  }
  let lastReport = null
  const handler = async (req, res) => {
    try {
      if (req.method === 'POST') {
        const text = await readBody(req, MAX_REPORT_BYTES)
        try {
          lastReport = JSON.parse(text)
        } catch {
          lastReport = { parseError: true, text: text.slice(0, 2000) }
        }
        storeReport(JSON.stringify(lastReport))
        res.statusCode = 204
        res.setHeader('cache-control', 'no-store')
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({ report: lastReport }))
    } catch (error) {
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(String(error))
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/cursor-layout/report', handler }),
    'cursor-layout: diagnostics route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/cursor-layout/probe', handler: probeHandler }),
    'cursor-layout: probe route',
  )
}
