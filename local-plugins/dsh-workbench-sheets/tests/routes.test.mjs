/**
 * Host 路由端到端测试：用假的 ctx/webServer 注册路由，直接以伪 HTTP 请求驱动
 * GET /file、POST /save、/ping，验证契约字段、错误分类与写回原文件的行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { apply } from '../index.js'
import { copySample, withTempDir } from './helpers.mjs'

/** 建假 DSH 上下文：收集 webServer 路由、提供会话 cwd 服务。 */
function makeContext(cwd, servicesOverride = {}) {
  const routes = new Map()
  const services = Object.assign({
    agents: { get: (sessionId) => (sessionId === 's1' ? { session: { header: { cwd } } } : undefined) },
    workingDirectory: { get: () => cwd, defaultDirectory: cwd },
  }, servicesOverride)
  const ctx = {
    get(name) { return services[name] },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  apply(ctx)
  return routes
}

/** 伪请求（body 走 data/end 事件，和真实 IncomingMessage 一致）。 */
function makeRequest(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

/** 调一次路由并返回 { status, headers, json }。 */
async function call(handler, method, url, body) {
  const req = makeRequest(method, url, body)
  let resolveResponse
  const finished = new Promise((resolve) => { resolveResponse = resolve })
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
      resolveResponse(this)
    },
  }
  await handler(req, res)
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('路由响应超时')), 5000))])
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null }
}

function fileUrl(absPath, sessionId) {
  const params = new URLSearchParams()
  if (sessionId) params.set('sessionId', sessionId)
  params.set('path', absPath)
  return '/workbench-sheets/file?' + params.toString()
}

test('ping 路由保留', async () => {
  await withTempDir(async (dir) => {
    const routes = makeContext(dir)
    const response = await call(routes.get('/workbench-sheets/ping'), 'GET', '/workbench-sheets/ping')
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.plugin, 'dsh-workbench-sheets')
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  })
})

test('GET /file：相对路径按会话 cwd 解析，返回 CSV 契约字段', async () => {
  await withTempDir(async (dir) => {
    await copySample(dir, 'sample.csv')
    const routes = makeContext(dir)
    const response = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl('sample.csv', 's1'))
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.kind, 'csv')
    assert.equal(response.json.delimiter, ',')
    assert.equal(response.json.encoding, 'utf-8')
    assert.equal(response.json.hasBom, false)
    assert.equal(response.json.rows.length, 21)
    assert.deepEqual(response.json.rows[0], ['name', 'qty', 'price', 'note'])
    assert.ok(response.json.mtimeMs > 0)
    assert.ok(response.json.size > 0)
  })
})

test('GET /file：绝对路径（含中文/空格）不依赖 session', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, '含 空格 的表.tsv')
    await fsp.writeFile(target, 'a\tb\n1\t2\n')
    const routes = makeContext(dir)
    const response = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl(target))
    assert.equal(response.status, 200)
    assert.equal(response.json.kind, 'tsv')
    assert.equal(response.json.delimiter, '\t')
    assert.deepEqual(response.json.rows, [['a', 'b'], ['1', '2']])
  })
})

test('GET /file：相对路径缺 sessionId/cwd → 400 no_cwd', async () => {
  await withTempDir(async (dir) => {
    const routes = makeContext(dir, { agents: undefined, workingDirectory: undefined })
    const response = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl('sample.csv'))
    assert.equal(response.status, 400)
    assert.equal(response.json.ok, false)
    assert.equal(response.json.code, 'no_cwd')
  })
})

test('GET /file：文件不存在 → 404；类型不支持 → 400', async () => {
  await withTempDir(async (dir) => {
    const routes = makeContext(dir)
    const missing = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl('nope.csv', 's1'))
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'not_found')

    await fsp.writeFile(path.join(dir, 'a.txt'), 'hello')
    const unsupported = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl('a.txt', 's1'))
    assert.equal(unsupported.status, 400)
    assert.equal(unsupported.json.code, 'unsupported')
  })
})

test('GET /file 只接受 GET', async () => {
  await withTempDir(async (dir) => {
    const routes = makeContext(dir)
    const response = await call(routes.get('/workbench-sheets/file'), 'POST', '/workbench-sheets/file')
    assert.equal(response.status, 405)
  })
})

test('POST /save：CSV 整表写回并返回新版本', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.csv')
    const routes = makeContext(dir)
    const read = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl('sample.csv', 's1'))
    const rows = read.json.rows
    rows[1][0] = 'route-changed'
    const body = JSON.stringify({
      sessionId: 's1',
      path: 'sample.csv',
      kind: 'csv',
      mtimeMs: read.json.mtimeMs,
      size: read.json.size,
      rows,
    })
    const saved = await call(routes.get('/workbench-sheets/save'), 'POST', '/workbench-sheets/save', body)
    assert.equal(saved.status, 200)
    assert.equal(saved.json.ok, true)
    assert.ok(saved.json.mtimeMs >= read.json.mtimeMs)
    assert.equal(typeof saved.json.size, 'number')

    const text = await fsp.readFile(file, 'utf8')
    assert.ok(text.includes('route-changed'))
    assert.ok(text.includes('\r\n'))
  })
})

test('POST /save：XLSX 只提交 edits，写回后可读回新值', async () => {
  await withTempDir(async (dir) => {
    await copySample(dir, 'sample.xlsx')
    const routes = makeContext(dir)
    const read = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl('sample.xlsx', 's1'))
    assert.deepEqual(read.json.sheets.map((sheet) => sheet.name), ['Sheet1', 'Second'])
    const body = JSON.stringify({
      sessionId: 's1',
      path: 'sample.xlsx',
      kind: 'xlsx',
      mtimeMs: read.json.mtimeMs,
      size: read.json.size,
      edits: [{ sheet: 'Sheet1', row: 2, col: 2, v: '321' }],
    })
    const saved = await call(routes.get('/workbench-sheets/save'), 'POST', '/workbench-sheets/save', body)
    assert.equal(saved.status, 200)
    assert.equal(saved.json.ok, true)
    assert.deepEqual(saved.json.lossy, [])

    const reread = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl('sample.xlsx', 's1'))
    assert.equal(reread.json.sheets[0].rows[1][1].v, 321)
    assert.equal(reread.json.sheets[1].rows[1][0].v, 1)
  })
})

test('POST /save：版本冲突 → 409；坏 JSON → 400；kind 不一致 → 400', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.csv')
    const routes = makeContext(dir)
    const read = await call(routes.get('/workbench-sheets/file'), 'GET', fileUrl('sample.csv', 's1'))
    await fsp.appendFile(file, 'external,1\r\n')

    const conflict = await call(routes.get('/workbench-sheets/save'), 'POST', '/workbench-sheets/save', JSON.stringify({
      sessionId: 's1',
      path: 'sample.csv',
      kind: 'csv',
      mtimeMs: read.json.mtimeMs,
      size: read.json.size,
      rows: read.json.rows,
    }))
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.code, 'conflict')

    const badJson = await call(routes.get('/workbench-sheets/save'), 'POST', '/workbench-sheets/save', '{oops')
    assert.equal(badJson.status, 400)
    assert.equal(badJson.json.code, 'bad_json')

    const kindMismatch = await call(routes.get('/workbench-sheets/save'), 'POST', '/workbench-sheets/save', JSON.stringify({
      sessionId: 's1',
      path: 'sample.csv',
      kind: 'xlsx',
      mtimeMs: read.json.mtimeMs,
      size: read.json.size,
      edits: [],
    }))
    assert.equal(kindMismatch.status, 400)
    assert.equal(kindMismatch.json.code, 'kind_mismatch')
  })
})

test('POST /save 只接受 POST', async () => {
  await withTempDir(async (dir) => {
    const routes = makeContext(dir)
    const response = await call(routes.get('/workbench-sheets/save'), 'GET', '/workbench-sheets/save')
    assert.equal(response.status, 405)
  })
})
