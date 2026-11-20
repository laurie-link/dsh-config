import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearFileListCache, listHtmlFiles } from '../lib/files.js'

describe('listHtmlFiles', () => {
  it('lists HTML files, skips ignored and hidden dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-live-files-'))
    try {
      await writeFile(join(root, 'index.html'), '<p>a</p>')
      await writeFile(join(root, 'a.htm'), '<p>a</p>')
      await writeFile(join(root, 'skip.txt'), 'x')
      await mkdir(join(root, 'sub'))
      await writeFile(join(root, 'sub', 'b.html'), '<p>b</p>')
      await mkdir(join(root, 'node_modules'))
      await writeFile(join(root, 'node_modules', 'c.html'), '<p>c</p>')
      await mkdir(join(root, '.git'))
      await writeFile(join(root, '.git', 'd.html'), '<p>d</p>')
      clearFileListCache()
      const listing = await listHtmlFiles(root, { fresh: true })
      assert.deepEqual(
        listing.files.map((file) => file.path),
        ['a.htm', 'index.html', 'sub/b.html'],
      )
      assert.equal(listing.truncated, false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('caps the number of files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-live-files-'))
    try {
      for (let i = 0; i < 5; i += 1) await writeFile(join(root, `p${i}.html`), '<p>x</p>')
      clearFileListCache()
      const listing = await listHtmlFiles(root, { max: 3, fresh: true })
      assert.equal(listing.files.length, 3)
      assert.equal(listing.truncated, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
