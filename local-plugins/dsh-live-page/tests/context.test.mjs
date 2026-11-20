import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPageStore,
  contextTextFor,
  enrichPageWithLive,
  normalizePage,
  normalizeReport,
} from '../lib/context.js'

describe('normalizePage', () => {
  it('accepts http(s) and normalizes the URL', () => {
    const page = normalizePage({ url: 'HTTP://Example.com/a b?x=1', title: '  Hello   world ', kind: 'browser' })
    assert.ok(page)
    assert.equal(page.url, 'http://example.com/a%20b?x=1')
    assert.equal(page.title, 'Hello world')
    assert.equal(page.kind, 'browser')
  })

  it('rejects non-http, malformed and oversized URLs', () => {
    assert.equal(normalizePage({ url: 'javascript:alert(1)' }), null)
    assert.equal(normalizePage({ url: 'ftp://x/y' }), null)
    assert.equal(normalizePage({ url: 'not a url' }), null)
    assert.equal(normalizePage({ url: 'https://x/' + 'a'.repeat(3000) }), null)
  })

  it('falls back to the hostname title and keeps a safe file', () => {
    const page = normalizePage({ url: 'https://example.com/a.html', title: '', file: '/a/b.html' })
    assert.equal(page.title, 'example.com')
    assert.equal(page.file, 'a/b.html')
    const bad = normalizePage({ url: 'https://example.com/a.html', file: '../secret.html' })
    assert.equal(bad.file, undefined)
  })
})

describe('normalizeReport', () => {
  it('validates session and page', () => {
    assert.equal(normalizeReport(null), null)
    assert.equal(normalizeReport({ page: null }), null)
    assert.equal(normalizeReport({ sessionId: 's1', page: { url: 'bad' } }), null)
    assert.deepEqual(normalizeReport({ sessionId: 's1', page: null }), { sessionId: 's1', page: null })
    const report = normalizeReport({ sessionId: 's1', page: { url: 'https://x/y' } })
    assert.equal(report.sessionId, 's1')
    assert.equal(report.page.title, 'x')
  })
})

describe('page store and prompt text', () => {
  it('expires after the TTL', () => {
    const store = createPageStore({ ttlMs: 1000 })
    store.set('s1', { url: 'https://x/y', title: 'Y', kind: 'browser' }, 1000)
    assert.ok(store.get('s1', 1500))
    assert.equal(store.get('s1', 2500), null)
  })

  it('renders live and external page text', () => {
    const store = createPageStore()
    store.set('s1', { url: 'http://127.0.0.1:5000/a.html', title: 'A', kind: 'live', file: 'a.html' })
    const live = contextTextFor(store, 's1')
    assert.match(live, /Browser page in the IDE/)
    assert.match(live, /a\.html/)
    assert.match(live, /save to that file/)
    store.set('s1', { url: 'https://example.com/x', title: 'X', kind: 'browser' })
    const external = contextTextFor(store, 's1')
    assert.match(external, /external web page/)
    store.set('s1', null)
    assert.equal(contextTextFor(store, 's1'), '')
  })
})

describe('enrichPageWithLive', () => {
  it('maps a live origin URL to a file', () => {
    const page = { url: 'http://127.0.0.1:5000/pokemon-go/a.html?x=1', title: 'A', kind: 'browser' }
    const out = enrichPageWithLive(page, [{ origin: 'http://127.0.0.1:5000', root: '/work' }])
    assert.equal(out.kind, 'live')
    assert.equal(out.file, 'pokemon-go/a.html')
  })

  it('maps a directory request to index.html and leaves other origins alone', () => {
    const dir = enrichPageWithLive(
      { url: 'http://127.0.0.1:5000/sub/', title: 'S', kind: 'browser' },
      [{ origin: 'http://127.0.0.1:5000' }],
    )
    assert.equal(dir.file, 'sub/index.html')
    const other = enrichPageWithLive(
      { url: 'https://example.com/x', title: 'X', kind: 'browser' },
      [{ origin: 'http://127.0.0.1:5000' }],
    )
    assert.equal(other.kind, 'browser')
  })
})
