import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  baseName,
  isAbsolutePath,
  isHtmlPath,
  isInside,
  relOf,
  resolveRequestPath,
  safeRelPath,
  siteRootOf,
  suffixOf,
  validateRawPath,
  versionOf,
} from '../lib/paths.js'

describe('paths', () => {
  it('suffixOf / isHtmlPath', () => {
    assert.equal(suffixOf('a/B.HTML'), 'html')
    assert.equal(suffixOf('noext'), '')
    assert.equal(suffixOf('.hidden'), '')
    assert.equal(isHtmlPath('a/b.htm'), true)
    assert.equal(isHtmlPath('a/b.xhtml'), true)
    assert.equal(isHtmlPath('a/b.css'), false)
  })

  it('absolute detection', () => {
    assert.equal(isAbsolutePath('/a/b'), true)
    assert.equal(isAbsolutePath('C:/a/b'), true)
    assert.equal(isAbsolutePath('a/b'), false)
  })

  it('resolveRequestPath resolves relative and absolute', () => {
    assert.equal(resolveRequestPath('/work', 'a/b.html'), '/work/a/b.html')
    assert.equal(resolveRequestPath('/work', '/abs/x.html'), '/abs/x.html')
    assert.throws(() => resolveRequestPath('/work', ''), /path/)
    assert.throws(() => validateRawPath('bad\0path'), /非法/)
  })

  it('isInside and relOf reject escapes', () => {
    assert.equal(isInside('/work', '/work/a/b.html'), true)
    assert.equal(isInside('/work', '/work2/a.html'), false)
    assert.equal(isInside('/work', '/work'), true)
    assert.equal(relOf('/work', '/work/a/b.html'), 'a/b.html')
    assert.throws(() => relOf('/work', '/etc/passwd'), /不在/)
  })

  it('siteRootOf uses workspace when inside, page dir otherwise', () => {
    assert.deepEqual(siteRootOf('/work', '/work/a/b.html'), { root: '/work', rel: 'a/b.html' })
    assert.deepEqual(siteRootOf('/work', '/other/b.html'), { root: '/other', rel: 'b.html' })
  })

  it('safeRelPath blocks traversal and dots', () => {
    assert.equal(safeRelPath('/a/b.html'), 'a/b.html')
    assert.throws(() => safeRelPath('a/../b.html'), /非法/)
    assert.throws(() => safeRelPath(''), /非法/)
  })

  it('baseName and versionOf', () => {
    assert.equal(baseName('a/b.html'), 'b.html')
    assert.equal(versionOf({ mtimeMs: 1000.6, size: 12 }), '1001:12')
    assert.equal(versionOf(null), '0:0')
  })
})
