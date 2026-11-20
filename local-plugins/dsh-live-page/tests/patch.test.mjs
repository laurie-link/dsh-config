import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PatchError,
  patchHtml,
  sanitizeSavedHtml,
  saveHtmlBlock,
  getArticleContentBounds,
} from '../lib/patch.js'

const GENERIC = `<!doctype html>
<html><head><title>Test</title></head>
<body><main>
<h1>Hello page</h1>
<p>Hello world, this is a sufficiently long paragraph for matching.</p>
<p>Second paragraph, also sufficiently long for matching.</p>
</main></body></html>`

function payloadFor(html, block, newBlock, extra = {}) {
  return {
    outerHTML: block,
    newOuterHTML: newBlock,
    text: block.replace(/<[^>]+>/g, ' '),
    tag: (block.match(/^<([a-z0-9]+)/i) || [])[1] || 'p',
    ...extra,
  }
}

describe('patchHtml', () => {
  it('replaces a unique paragraph by exact outerHTML', () => {
    const oldBlock = '<p>Hello world, this is a sufficiently long paragraph for matching.</p>'
    const next = '<p>Hello <b>edited</b> world, this is a sufficiently long paragraph for matching.</p>'
    const result = patchHtml(GENERIC, payloadFor(GENERIC, oldBlock, next))
    assert.equal(result.changed, true)
    assert.match(result.html, /<b>edited<\/b>/)
    assert.match(result.method, /outerHTML/)
  })

  it('strips editor attributes from saved HTML', () => {
    const dirty = '<p contenteditable="true" spellcheck="false" class="dsh-live-editing article-body">x</p>'
    assert.equal(sanitizeSavedHtml(dirty), '<p class="article-body">x</p>')
  })

  it('deletes a block when newOuterHTML is empty', () => {
    const oldBlock = '<p>Second paragraph, also sufficiently long for matching.</p>'
    const result = patchHtml(GENERIC, payloadFor(GENERIC, oldBlock, ''))
    assert.equal(result.changed, true)
    assert.equal(result.html.includes(oldBlock), false)
  })

  it('rejects ambiguous blocks', () => {
    const html = '<body><main><p>Exactly same text in both blocks.</p><p>Exactly same text in both blocks.</p></main></body>'
    const payload = {
      outerHTML: '<p>Exactly same text in both blocks.</p>',
      newOuterHTML: '<p>changed</p>',
      text: 'Exactly same text in both blocks.',
      tag: 'p',
    }
    assert.throws(() => patchHtml(html, payload), (error) => error instanceof PatchError && error.status === 409)
  })

  it('rejects scripts and event handlers', () => {
    const oldBlock = '<p>Hello world, this is a sufficiently long paragraph for matching.</p>'
    const script = payloadFor(GENERIC, oldBlock, '<p><script>alert(1)</script></p>')
    assert.throws(() => patchHtml(GENERIC, script), (error) => error.code === 'unsafe_tag')
    const handler = payloadFor(GENERIC, oldBlock, '<p onclick="x()">hello world</p>')
    assert.throws(() => patchHtml(GENERIC, handler), (error) => error.code === 'unsafe_attribute')
  })

  it('keeps article-content bounds intact and uses anchors', () => {
    const html = `<html><body><div class="article-content-box"><div class="article-content">
<h2 id="part1">Part one</h2><p>First paragraph, sufficiently long for matching here.</p>
<h2 id="part2">Part two</h2><p>Second paragraph, sufficiently long for matching here.</p>
</div></div></body></html>`
    const block = '<p>Second paragraph, sufficiently long for matching here.</p>'
    const result = patchHtml(html, payloadFor(html, block, '<p>Second edited paragraph, long enough.</p>', { anchor: '#part2' }))
    assert.equal(result.changed, true)
    assert.match(result.html, /Second edited paragraph/)
    const bounds = getArticleContentBounds(result.html)
    assert.ok(bounds)
  })

  it('uses a unique text fingerprint when outerHTML classes changed', () => {
    const html = '<body><main><p class="old">A unique paragraph text that is long enough.</p></main></body>'
    const payload = {
      outerHTML: '<p class="new">A unique paragraph text that is long enough.</p>',
      newOuterHTML: '<p class="new">Edited unique paragraph text that is long enough.</p>',
      text: 'A unique paragraph text that is long enough.',
      tag: 'p',
    }
    const result = patchHtml(html, payload)
    assert.equal(result.changed, true)
    assert.match(result.html, /Edited unique paragraph/)
  })
})

describe('saveHtmlBlock', () => {
  let root
  let home
  let previousHome

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-live-patch-'))
    home = await mkdtemp(join(tmpdir(), 'dsh-live-home-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    await writeFile(join(root, 'a.html'), GENERIC, 'utf8')
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  it('writes the file, creates a backup and returns a version', async () => {
    const file = join(root, 'a.html')
    const oldBlock = '<p>Hello world, this is a sufficiently long paragraph for matching.</p>'
    const result = await saveHtmlBlock({
      root,
      absPath: file,
      relPath: 'a.html',
      payload: payloadFor(GENERIC, oldBlock, '<p>Edited hello world paragraph.</p>'),
      keepBackups: 2,
    })
    assert.equal(result.changed, true)
    assert.ok(result.backup.startsWith(home))
    assert.match(result.version, /^\d+:\d+$/)
    const content = await readFile(file, 'utf8')
    assert.match(content, /Edited hello world paragraph/)
    const backup = await readFile(result.backup, 'utf8')
    assert.equal(backup, GENERIC)
  })

  it('reports changed=false when the block content is identical', async () => {
    const file = join(root, 'a.html')
    const oldBlock = '<p>Hello world, this is a sufficiently long paragraph for matching.</p>'
    const result = await saveHtmlBlock({
      root,
      absPath: file,
      relPath: 'a.html',
      payload: payloadFor(GENERIC, oldBlock, oldBlock),
      keepBackups: 2,
    })
    assert.equal(result.changed, false)
    assert.equal(result.backup, '')
  })

  it('prunes old backups per file', async () => {
    const file = join(root, 'a.html')
    const oldBlock = '<p>Hello world, this is a sufficiently long paragraph for matching.</p>'
    for (let i = 0; i < 4; i += 1) {
      await saveHtmlBlock({
        root,
        absPath: file,
        relPath: 'a.html',
        payload: payloadFor(GENERIC, oldBlock, `<p>Edited ${i} hello world paragraph.</p>`),
        keepBackups: 2,
      })
      // reset the source so the next save matches the same original block
      await writeFile(file, GENERIC, 'utf8')
    }
    const dirs = await readdir(join(home, 'dsh-live-page', 'backups'), { withFileTypes: true })
    assert.equal(dirs.length, 1)
    const files = await readdir(join(home, 'dsh-live-page', 'backups', dirs[0].name))
    assert.ok(files.length <= 2, 'backups should be pruned to keep=2')
  })
})
