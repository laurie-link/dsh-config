/**
 * dsh-live-page — one loopback live-editing site per workspace root.
 *
 * Responsibilities:
 *  - serve workspace files (real browser semantics for relative/absolute assets);
 *  - inject the edit overlay into HTML pages after a one-time token sets a
 *    SameSite=Strict cookie (the clean URL then stays in the address bar);
 *  - accept block saves only from that cookie + same-origin page, after the file
 *    has actually been visited (armed);
 *  - expose a version probe so the overlay can reload after external edits.
 */
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { buildFileListingPage, encodeUrlPath, injectOverlay, titleOfHtml } from './inject.js'
import { isHtmlPath, safeRelPath, versionOf } from './paths.js'

const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 256 * 1024
const MAX_INJECT_BYTES = 8 * 1024 * 1024
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  shtml: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
}

/** Block obviously sensitive workspace paths from being served. */
function isDeniedRel(rel) {
  const parts = String(rel).split('/')
  return parts.some(
    (part) =>
      part === 'node_modules' ||
      part === '.git' ||
      part === '.svn' ||
      part === '.hg' ||
      part === '.env' ||
      part.startsWith('.env.') ||
      part === '.dsh-live-page',
  )
}

function mimeOf(file) {
  const suffix = extname(String(file)).slice(1).toLowerCase()
  return MIME[suffix] || 'application/octet-stream'
}

function json(res, status, value) {
  const payload = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(payload))
  res.end(payload)
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function redirect(res, location, cookie) {
  res.statusCode = 302
  res.setHeader('location', location)
  if (cookie) res.setHeader('set-cookie', cookie)
  res.setHeader('cache-control', 'no-store')
  res.end()
}

function readBody(req, limit) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error('请求体过大'), { status: 413, code: 'body_too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const cut = part.indexOf('=')
    if (cut <= 0) continue
    const name = part.slice(0, cut).trim()
    const value = part.slice(cut + 1).trim()
    if (name) out[name] = value
  }
  return out
}

function cookieOf(name, value) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`
}

function inside(root, target) {
  const rel = target.startsWith(root + sep) ? target.slice(root.length + 1) : ''
  return target === root ? false : rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Resolve a URL-relative path to a real file under root (directory → index.html). */
async function resolveTarget(root, rel) {
  const safe = safeRelPath(rel)
  if (isDeniedRel(safe)) throw Object.assign(new Error('该路径不允许访问'), { status: 403, code: 'denied' })
  const candidate = resolve(root, safe)
  let real
  try {
    real = await realpath(candidate)
  } catch {
    throw Object.assign(new Error('文件不存在'), { status: 404, code: 'missing' })
  }
  if (!inside(root, real)) throw Object.assign(new Error('路径越界'), { status: 403, code: 'outside_root' })
  const info = await stat(real).catch(() => null)
  if (!info) throw Object.assign(new Error('文件不存在'), { status: 404, code: 'missing' })
  if (info.isDirectory()) {
    const index = join(real, 'index.html')
    const realIndex = await realpath(index).catch(() => null)
    if (!realIndex || !inside(root, realIndex)) throw Object.assign(new Error('文件不存在'), { status: 404, code: 'missing' })
    const indexInfo = await stat(realIndex).catch(() => null)
    if (!indexInfo?.isFile()) throw Object.assign(new Error('文件不存在'), { status: 404, code: 'missing' })
    return { absPath: realIndex, relPath: realIndex.slice(root.length + 1).split(sep).join('/'), info: indexInfo }
  }
  if (!info.isFile()) throw Object.assign(new Error('文件不存在'), { status: 404, code: 'missing' })
  return { absPath: real, relPath: real.slice(root.length + 1).split(sep).join('/'), info }
}

/**
 * Start one live site.
 * @returns {Promise<{root:string,port:number,origin:string,token:string,nonce:string,cookieName:string,urlFor:(rel:string,token?:boolean)=>string,close:()=>Promise<void>}>}
 */
export async function startLiveSite(options) {
  const root = await realpath(String(options.root))
  const token = String(options.token)
  const nonce = String(options.nonce)
  const overlayDir = String(options.overlayDir)
  const listFiles = options.listFiles
  const saveBlock = options.saveBlock
  const completeText = typeof options.complete === 'function' ? options.complete : null
  const rewriteText = typeof options.rewrite === 'function' ? options.rewrite : null
  /** One completion at a time per live site: typing faster than the model must
   *  never queue up a backlog of stale requests. */
  let completing = false
  /** One selection rewrite at a time; the overlay disables its button meanwhile. */
  let rewriting = false
  const log = typeof options.log === 'function' ? options.log : () => {}
  const armed = new Set()

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log('live site request failed: ' + String(error?.stack || error))
      if (!res.headersSent) json(res, error?.status || 500, { ok: false, error: String(error?.message || error) })
      else res.destroy()
    })
  })
  server.on('error', (error) => log('live site server error: ' + String(error)))

  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, HOST, () => {
      server.off('error', fail)
      done()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const origin = `http://${HOST}:${String(port)}`
  const cookieName = `dsh_live_${String(port)}`

  function validCookie(req) {
    return parseCookies(req.headers.cookie)[cookieName] === token
  }

  function cookieHeader() {
    return cookieOf(cookieName, token)
  }

  function urlFor(rel, includeToken = false) {
    const path = String(rel || '').replace(/^\/+/, '')
    const encoded = path === '' ? '' : encodeUrlPath(path)
    return `${origin}/${encoded}${includeToken ? `?__live=${encodeURIComponent(token)}` : ''}`
  }

  async function handle(req, res) {
    const method = (req.method || 'GET').toUpperCase()
    let url
    try {
      url = new URL(req.url || '/', origin)
    } catch {
      json(res, 400, { ok: false, error: '请求地址无法解析' })
      return
    }

    // -- overlay assets -------------------------------------------------
    if ((method === 'GET' || method === 'HEAD') && url.pathname === '/__live/overlay.js') {
      await serveAsset(res, join(overlayDir, 'overlay.js'), 'text/javascript; charset=utf-8', method === 'HEAD')
      return
    }
    if ((method === 'GET' || method === 'HEAD') && url.pathname === '/__live/overlay.css') {
      await serveAsset(res, join(overlayDir, 'overlay.css'), 'text/css; charset=utf-8', method === 'HEAD')
      return
    }

    // -- version probe --------------------------------------------------
    if (method === 'GET' && url.pathname === '/__live/version') {
      if (!validCookie(req)) {
        json(res, 403, { ok: false, error: '需要从 IDE 页面编辑按钮重新打开' })
        return
      }
      const file = url.searchParams.get('file') || ''
      let target
      try {
        target = await resolveTarget(root, file)
      } catch (error) {
        json(res, error.status || 404, { ok: false, error: error.message })
        return
      }
      if (!isHtmlPath(target.relPath)) {
        json(res, 400, { ok: false, error: '不是 HTML 页面' })
        return
      }
      json(res, 200, { ok: true, version: versionOf(target.info) })
      return
    }

    // -- inline completion ----------------------------------------------
    if (method === 'POST' && url.pathname === '/__live/complete') {
      await handleComplete(req, res)
      return
    }

    // -- selection rewrite ----------------------------------------------
    if (method === 'POST' && url.pathname === '/__live/rewrite') {
      await handleRewrite(req, res)
      return
    }

    // -- save -----------------------------------------------------------
    if (method === 'POST' && url.pathname === '/__live/save') {
      await handleSave(req, res)
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD, POST')
      text(res, 405, 'Method Not Allowed')
      return
    }

    const tokenParam = url.searchParams.get('__live')
    if (tokenParam !== null) {
      if (tokenParam !== token) {
        text(res, 403, '页面编辑令牌无效，请从 IDE 的「页面编辑」按钮重新打开。', 'text/html; charset=utf-8')
        return
      }
      const edit = url.searchParams.get('__live_edit') === '1'
      const clean = (url.pathname || '/') + (edit ? '?__live_edit=1' : '')
      redirect(res, clean, cookieHeader())
      return
    }

    // -- root listing ---------------------------------------------------
    if (url.pathname === '/' || url.pathname === '') {
      if (!validCookie(req)) {
        text(
          res,
          403,
          '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:32px"><h1>请从 IDE 打开</h1><p>在 DSH IDE 里打开一个 HTML，点击编辑器或输入框旁的「页面编辑」按钮。</p></body>',
          'text/html; charset=utf-8',
        )
        return
      }
      let listing
      try {
        listing = await listFiles(root)
      } catch (error) {
        json(res, 500, { ok: false, error: '无法列出工作区文件' })
        return
      }
      const page = buildFileListingPage(listing)
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(method === 'HEAD' ? '' : page)
      return
    }

    // -- workspace file -------------------------------------------------
    let rel
    try {
      rel = safeRelPath(decodeURIComponent(url.pathname))
    } catch (error) {
      text(res, error.status || 400, error.message || '路径非法')
      return
    }
    let target
    try {
      target = await resolveTarget(root, rel)
    } catch (error) {
      text(res, error.status || 404, error.message || '文件不存在')
      return
    }
    const isPage = isHtmlPath(target.relPath)
    if (isPage && validCookie(req)) armed.add(target.absPath)

    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')

    if (isPage && validCookie(req) && target.info.size <= MAX_INJECT_BYTES) {
      let html
      try {
        html = await readFile(target.absPath, 'utf8')
      } catch {
        text(res, 500, '读取页面失败')
        return
      }
      const injected = injectOverlay(html, {
        file: target.relPath,
        version: versionOf(target.info),
        title: titleOfHtml(html) || target.relPath.split('/').pop(),
        nonce,
      })
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(method === 'HEAD' ? '' : injected)
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', mimeOf(target.absPath))
    res.setHeader('content-length', String(target.info.size))
    if (method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(target.absPath)
    stream.once('error', () => {
      if (!res.headersSent) text(res, 500, '读取文件失败')
      else res.destroy()
    })
    stream.pipe(res)
  }

  async function handleComplete(req, res) {
    if (!validCookie(req)) {
      json(res, 403, { ok: false, error: '需要从 IDE 页面编辑按钮重新打开' })
      return
    }
    const originHeader = req.headers.origin
    if (typeof originHeader === 'string' && originHeader !== '' && originHeader !== origin) {
      json(res, 403, { ok: false, error: '请求来源不匹配' })
      return
    }
    if (!completeText) {
      json(res, 200, { ok: true, text: '', note: 'AI 补全未启用' })
      return
    }
    let payload
    try {
      payload = JSON.parse(await readBody(req, 64 * 1024))
    } catch (error) {
      json(res, error.status || 400, { ok: false, error: error.message || '请求体不是合法 JSON' })
      return
    }
    if (completing) {
      json(res, 200, { ok: true, text: '', note: 'busy' })
      return
    }
    completing = true
    try {
      const result = await completeText(payload)
      json(res, 200, {
        ok: true,
        text: typeof result?.text === 'string' ? result.text : '',
        ...(result?.note ? { note: String(result.note) } : {}),
        ...(typeof result?.ms === 'number' ? { ms: result.ms } : {}),
        ...(result?.route ? { route: String(result.route) } : {}),
      })
    } catch (error) {
      json(res, 500, { ok: false, error: '补全失败：' + String(error?.message || error) })
    } finally {
      completing = false
    }
  }

  async function handleRewrite(req, res) {
    if (!validCookie(req)) {
      json(res, 403, { ok: false, error: '需要从 IDE 页面编辑按钮重新打开' })
      return
    }
    const originHeader = req.headers.origin
    if (typeof originHeader === 'string' && originHeader !== '' && originHeader !== origin) {
      json(res, 403, { ok: false, error: '请求来源不匹配' })
      return
    }
    if (!rewriteText) {
      json(res, 200, { ok: false, blocks: [], note: 'AI 改写未启用' })
      return
    }
    let payload
    try {
      payload = JSON.parse(await readBody(req, MAX_BODY_BYTES))
    } catch (error) {
      json(res, error.status || 400, { ok: false, error: error.message || '请求体不是合法 JSON' })
      return
    }
    const file = typeof payload?.file === 'string' ? payload.file : ''
    let target
    try {
      target = await resolveTarget(root, file)
    } catch (error) {
      json(res, error.status || 400, { ok: false, error: error.message || '文件不存在' })
      return
    }
    if (!isHtmlPath(target.relPath)) {
      json(res, 400, { ok: false, error: '只能改写 HTML 页面' })
      return
    }
    if (!armed.has(target.absPath)) {
      json(res, 403, { ok: false, error: '该页面尚未通过页面编辑打开，改写已拒绝' })
      return
    }
    if (rewriting) {
      json(res, 200, { ok: false, blocks: [], note: '上一条改写还在进行中，请稍后再试' })
      return
    }
    rewriting = true
    try {
      const result = await rewriteText({ ...payload, file: target.relPath })
      json(res, 200, {
        ok: result?.ok !== false && Array.isArray(result?.blocks) && result.blocks.length > 0,
        blocks: Array.isArray(result?.blocks) ? result.blocks : [],
        ...(result?.note ? { note: String(result.note) } : {}),
        ...(typeof result?.ms === 'number' ? { ms: result.ms } : {}),
        ...(result?.route ? { route: String(result.route) } : {}),
      })
    } catch (error) {
      json(res, 500, { ok: false, blocks: [], error: '改写失败：' + String(error?.message || error) })
    } finally {
      rewriting = false
    }
  }

  async function handleSave(req, res) {
    if (!validCookie(req)) {
      json(res, 403, { ok: false, error: '需要从 IDE 页面编辑按钮重新打开' })
      return
    }
    const originHeader = req.headers.origin
    if (typeof originHeader === 'string' && originHeader !== '' && originHeader !== origin) {
      json(res, 403, { ok: false, error: '保存来源不匹配' })
      return
    }
    let payload
    try {
      payload = JSON.parse(await readBody(req, MAX_BODY_BYTES))
    } catch (error) {
      json(res, error.status || 400, { ok: false, error: error.message || '请求体不是合法 JSON' })
      return
    }
    const file = typeof payload?.file === 'string' ? payload.file : ''
    let target
    try {
      target = await resolveTarget(root, file)
    } catch (error) {
      json(res, error.status || 400, { ok: false, error: error.message || '文件不存在' })
      return
    }
    if (!isHtmlPath(target.relPath)) {
      json(res, 400, { ok: false, error: '只能保存 HTML 页面' })
      return
    }
    if (!armed.has(target.absPath)) {
      json(res, 403, { ok: false, error: '该页面尚未通过页面编辑打开，保存已拒绝' })
      return
    }
    try {
      const result = await saveBlock({
        root,
        absPath: target.absPath,
        relPath: target.relPath,
        payload,
      })
      json(res, 200, { ok: true, file: target.relPath, ...result })
    } catch (error) {
      json(res, error.status || 409, { ok: false, error: error.message || '保存失败', code: error.code })
    }
  }

  async function serveAsset(res, file, type, headOnly) {
    let bytes
    try {
      bytes = await readFile(file)
    } catch {
      text(res, 500, 'overlay 资源缺失')
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', type)
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(bytes.byteLength))
    res.end(headOnly ? '' : bytes)
  }

  async function close() {
    armed.clear()
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((done) => server.close(() => done()))
  }

  return { root, port, origin, token, nonce, cookieName, urlFor, close }
}
