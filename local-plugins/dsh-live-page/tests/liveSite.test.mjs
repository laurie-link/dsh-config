import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startLiveSite } from '../lib/liveSite.js'
import { listHtmlFiles } from '../lib/files.js'
import { saveHtmlBlock } from '../lib/patch.js'

const PAGE = `<!doctype html><html><head><title>Page A</title></head><body><main>
<p>Hello live site, this paragraph is long enough to match safely.</p>
</main></body></html>`

function extractCookie(response) {
  const raw = response.headers.get('set-cookie') || ''
  const first = raw.split(';')[0]
  return first.includes('=') ? first : ''
}

describe('liveSite', () => {
  let root
  let home
  let previousHome
  let overlayDir
  let site
  let cookie
  let pageUrl
  const rewritePayloads = []

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-live-site-'))
    home = await mkdtemp(join(tmpdir(), 'dsh-live-home-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    overlayDir = await mkdtemp(join(tmpdir(), 'dsh-live-overlay-'))
    await writeFile(join(overlayDir, 'overlay.js'), 'window.__overlay = true\n', 'utf8')
    await writeFile(join(overlayDir, 'overlay.css'), '.dsh-live{}\n', 'utf8')
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'style.css'), 'body{color:red}\n', 'utf8')
    await writeFile(join(root, 'a.html'), PAGE, 'utf8')
    await writeFile(join(root, 'other.html'), '<html><body><p>other</p></body></html>', 'utf8')
    try {
      await symlink('/etc/passwd', join(root, 'escape.html'))
    } catch {
      // symlink creation is optional
    }
    site = await startLiveSite({
      root,
      token: 'test-token',
      nonce: 'test-nonce',
      overlayDir,
      listFiles: (workspace) => listHtmlFiles(workspace),
      saveBlock: (args) => saveHtmlBlock({ ...args, keepBackups: 2 }),
      rewrite: async (payload) => {
        rewritePayloads.push(payload)
        return {
          blocks: payload.blocks.map((block, index) => ({ index, html: 'Rewritten ' + index })),
          route: 'test/model',
          ms: 12,
        }
      },
      log: () => {},
    })
    pageUrl = site.origin + '/a.html'
    const tokenResponse = await fetch(pageUrl + '?__live=test-token', { redirect: 'manual' })
    assert.equal(tokenResponse.status, 302)
    cookie = extractCookie(tokenResponse)
    assert.ok(cookie.startsWith('dsh_live_'))
  })

  after(async () => {
    if (site) await site.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(overlayDir, { recursive: true, force: true })
  })

  it('keeps the clean token redirect and preserves __live_edit for the first page', async () => {
    const plain = await fetch(pageUrl + '?__live=test-token', { redirect: 'manual' })
    assert.equal(plain.status, 302)
    assert.equal(plain.headers.get('location'), '/a.html')
    const edit = await fetch(pageUrl + '?__live=test-token&__live_edit=1', { redirect: 'manual' })
    assert.equal(edit.status, 302)
    assert.equal(edit.headers.get('location'), '/a.html?__live_edit=1')
  })

  it('serves the injected page with the live cookie', async () => {
    const response = await fetch(pageUrl, { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') || '', /text\/html/)
    const body = await response.text()
    assert.match(body, /id="dsh-live-overlay"/)
    assert.match(body, /data-file="a\.html"/)
    assert.match(body, /data-nonce="test-nonce"/)
  })

  it('serves the page without the overlay when the cookie is absent', async () => {
    const response = await fetch(pageUrl)
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.equal(body.includes('dsh-live-overlay'), false)
  })

  it('serves the root file listing with the cookie', async () => {
    const response = await fetch(site.origin + '/', { headers: { cookie } })
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.match(body, /a\.html/)
    assert.match(body, /页面编辑/)
  })

  it('serves static assets', async () => {
    const response = await fetch(site.origin + '/assets/style.css', { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'body{color:red}\n')
  })

  it('rejects saves without the cookie and with a foreign origin', async () => {
    const payload = {
      file: 'a.html',
      tag: 'p',
      text: 'Hello live site, this paragraph is long enough to match safely.',
      outerHTML: '<p>Hello live site, this paragraph is long enough to match safely.</p>',
      newOuterHTML: '<p>Edited without cookie.</p>',
    }
    const noCookie = await fetch(site.origin + '/__live/save', { method: 'POST', body: JSON.stringify(payload) })
    assert.equal(noCookie.status, 403)
    const badOrigin = await fetch(site.origin + '/__live/save', {
      method: 'POST',
      headers: { cookie, origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(badOrigin.status, 403)
  })

  it('saves a block and exposes the new version', async () => {
    const versionBefore = await (await fetch(site.origin + '/__live/version?file=a.html', { headers: { cookie } })).json()
    const payload = {
      file: 'a.html',
      tag: 'p',
      text: 'Hello live site, this paragraph is long enough to match safely.',
      outerHTML: '<p>Hello live site, this paragraph is long enough to match safely.</p>',
      newOuterHTML: '<p>Edited live site paragraph, long enough to match.</p>',
      selectorPath: 'main > p:nth-of-type(1)',
    }
    const response = await fetch(site.origin + '/__live/save', {
      method: 'POST',
      headers: { cookie, origin: site.origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.ok, true)
    assert.equal(result.file, 'a.html')
    assert.ok(result.backup)
    const content = await readFile(join(root, 'a.html'), 'utf8')
    assert.match(content, /Edited live site paragraph/)
    const versionAfter = await (await fetch(site.origin + '/__live/version?file=a.html', { headers: { cookie } })).json()
    assert.notEqual(versionAfter.version, versionBefore.version)
  })

  it('rejects traversal and symlink escapes', async () => {
    const traversal = await fetch(site.origin + '/%2e%2e/%2e%2e/etc/passwd', { headers: { cookie } })
    assert.ok([400, 403, 404].includes(traversal.status))
    const escape = await fetch(site.origin + '/escape.html', { headers: { cookie } })
    assert.ok([403, 404].includes(escape.status))
  })

  it('proxies a selection rewrite and forwards the relative file', async () => {
    const payload = {
      file: 'a.html',
      title: 'Page A',
      before: 'Before',
      after: 'After',
      instruction: 'Make it shorter.',
      blocks: [{ text: 'Hello live site, this paragraph is long enough to match safely.', start: 0, end: 5, tag: 'p' }],
    }
    const noCookie = await fetch(site.origin + '/__live/rewrite', { method: 'POST', body: JSON.stringify(payload) })
    assert.equal(noCookie.status, 403)

    const badOrigin = await fetch(site.origin + '/__live/rewrite', {
      method: 'POST',
      headers: { cookie, origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(badOrigin.status, 403)

    const response = await fetch(site.origin + '/__live/rewrite', {
      method: 'POST',
      headers: { cookie, origin: site.origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.ok, true)
    assert.deepEqual(result.blocks, [{ index: 0, html: 'Rewritten 0' }])
    assert.equal(result.route, 'test/model')
    assert.equal(rewritePayloads.at(-1).file, 'a.html')
  })

  it('rejects a rewrite for a page that was not opened through the editor', async () => {
    const payload = {
      file: 'other.html',
      instruction: 'Make it shorter.',
      blocks: [{ text: 'other', start: 0, end: 3, tag: 'p' }],
    }
    const response = await fetch(site.origin + '/__live/rewrite', {
      method: 'POST',
      headers: { cookie, origin: site.origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 403)
  })

  it('proxies inline completion with cookie and origin checks', async () => {    const payload = { file: 'a.html', title: 'Page A', tag: 'p', before: '', prefix: 'Hello live site', suffix: '' }
    const noCookie = await fetch(site.origin + '/__live/complete', { method: 'POST', body: JSON.stringify(payload) })
    assert.equal(noCookie.status, 403)

    const badOrigin = await fetch(site.origin + '/__live/complete', {
      method: 'POST',
      headers: { cookie, origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(badOrigin.status, 403)
  })

  it('serves overlay assets', async () => {
    const js = await fetch(site.origin + '/__live/overlay.js')
    assert.equal(js.status, 200)
    assert.match(await js.text(), /__overlay/)
    const css = await fetch(site.origin + '/__live/overlay.css')
    assert.equal(css.status, 200)
  })
})
