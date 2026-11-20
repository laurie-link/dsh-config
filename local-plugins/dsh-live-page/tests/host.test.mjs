import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

function fakeReq({ method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

function fakeRes() {
  const out = { statusCode: 0, headers: {}, body: '' }
  const res = {
    setHeader(name, value) {
      out.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) out.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      res.finished = true
    },
    destroy() {
      res.finished = true
    },
    get headersSent() {
      return false
    },
    get result() {
      return out
    },
  }
  Object.defineProperty(res, 'statusCode', {
    get: () => out.statusCode,
    set: (value) => {
      out.statusCode = value
    },
    enumerable: true,
  })
  return res
}

async function call(route, req) {
  const res = fakeRes()
  await route(req, res)
  let json = null
  try {
    json = JSON.parse(res.result.body)
  } catch {
    json = null
  }
  return { status: res.result.statusCode, headers: res.result.headers, body: res.result.body, json }
}

describe('host routes', () => {
  let root
  let routes
  let listeners
  let cleanups
  let previousHome

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-live-host-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-host-home-'))
    await writeFile(join(root, 'a.html'), '<html><head><title>A</title></head><body><main><p>Hello host route page.</p></main></body></html>', 'utf8')
    routes = new Map()
    listeners = new Map()
    cleanups = []
    const webServer = {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    }
    const fakeCtx = {
      webServer,
      effect(fn) {
        const disposer = fn()
        if (typeof disposer === 'function') cleanups.push(disposer)
        return () => {}
      },
      get(name) {
        if (name === 'webServer') return webServer
        if (name === 'agents') {
          return { get: (id) => (id === 's1' ? { session: { header: { cwd: root } } } : undefined) }
        }
        if (name === 'sessions') return { get: () => undefined }
        if (name === 'workingDirectory') return undefined
        return undefined
      },
      on(name, fn) {
        const list = listeners.get(name) ?? []
        list.push(fn)
        listeners.set(name, list)
        return () => {}
      },
      logger: { warn() {} },
    }
    apply(fakeCtx)
  })

  after(async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch {
        // ignore
      }
    }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })

  it('registers all routes', () => {
    for (const path of ['/live-page/open', '/live-page/files', '/live-page/report', '/live-page/state', '/live-page/servers']) {
      assert.equal(typeof routes.get(path), 'function', path)
    }
  })

  it('opens an HTML file and returns a token URL', async () => {
    const req = fakeReq({ method: 'POST', url: '/live-page/open', body: JSON.stringify({ sessionId: 's1', path: 'a.html' }) })
    const { status, json } = await call(routes.get('/live-page/open'), req)
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.match(json.url, /^http:\/\/127\.0\.0\.1:\d+\/a\.html\?__live=/)
    assert.equal(json.file, 'a.html')
  })

  it('rejects files outside the workspace', async () => {
    const req = fakeReq({ method: 'POST', url: '/live-page/open', body: JSON.stringify({ sessionId: 's1', path: '/etc/passwd' }) })
    const { status, json } = await call(routes.get('/live-page/open'), req)
    assert.equal(status, 403)
    assert.equal(json.ok, false)
  })

  it('reports a page and renders the prompt context', async () => {
    const report = {
      sessionId: 's1',
      page: { url: 'https://example.com/doc', title: 'Example doc' },
    }
    const reportRes = await call(
      routes.get('/live-page/report'),
      fakeReq({ method: 'POST', url: '/live-page/report', body: JSON.stringify(report) }),
    )
    assert.equal(reportRes.status, 200)
    const state = await call(routes.get('/live-page/state'), fakeReq({ url: '/live-page/state?sessionId=s1' }))
    assert.equal(state.json.page.title, 'Example doc')
    assert.match(state.json.text, /external web page/)

    const created = listeners.get('agent/created')?.[0]
    assert.equal(typeof created, 'function')
    let text = ''
    created({
      agent: {
        session: { id: 's1' },
        ctx: {
          get: (name) => (name === 'systemPrompt' ? { context: ({ text: getText }) => { text = getText(); return () => {} } } : undefined),
          effect: (fn) => {
            const disposer = fn()
            if (typeof disposer === 'function') cleanups.push(disposer)
          },
        },
      },
    })
    assert.match(text, /Browser page in the IDE/)
    assert.match(text, /Example doc/)
  })

  it('lists workspace HTML files', async () => {
    const { status, json } = await call(routes.get('/live-page/files'), fakeReq({ url: '/live-page/files?sessionId=s1' }))
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.ok(json.files.some((file) => file.path === 'a.html'))
  })
})
