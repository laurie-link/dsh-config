/** 路径解析与版本守卫的纯函数测试。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { extKind, isAbsolutePath, resolveTargetPath, validateRawPath } from '../lib/paths.js'
import { assertFresh } from '../lib/fsutil.js'
import { WbError } from '../lib/errors.js'

test('extKind：只认 csv/tsv/xlsx，大小写不敏感，其余返回 null', () => {
  assert.equal(extKind('a/b/data.CSV'), 'csv')
  assert.equal(extKind('/abs/表.tsv'), 'tsv')
  assert.equal(extKind('book.xlsx'), 'xlsx')
  assert.equal(extKind('book.xls'), null)
  assert.equal(extKind('README'), null)
  assert.equal(extKind('dir.v2/file'), null)
  assert.equal(extKind(''), null)
})

test('isAbsolutePath：POSIX / Windows 盘符 / UNC', () => {
  assert.equal(isAbsolutePath('/tmp/a.csv'), true)
  assert.equal(isAbsolutePath('C:\\work\\a.csv'), true)
  assert.equal(isAbsolutePath('\\\\server\\share\\a.csv'), true)
  assert.equal(isAbsolutePath('rel/a.csv'), false)
  assert.equal(isAbsolutePath('./a.csv'), false)
})

test('resolveTargetPath：相对路径按 cwd 解析', () => {
  const resolved = resolveTargetPath('sub/data.csv', '/tmp/work')
  assert.equal(resolved, path.resolve('/tmp/work', 'sub/data.csv'))
})

test('resolveTargetPath：绝对路径不需要 cwd', () => {
  assert.equal(resolveTargetPath('/tmp/work/data.csv', null), path.normalize('/tmp/work/data.csv'))
})

test('resolveTargetPath：相对路径缺 cwd → 400 no_cwd', () => {
  assert.throws(
    () => resolveTargetPath('data.csv', null),
    (error) => error instanceof WbError && error.status === 400 && error.code === 'no_cwd',
  )
})

test('validateRawPath：空值/NUL 拒绝', () => {
  assert.throws(() => validateRawPath(''), (error) => error instanceof WbError && error.status === 400)
  assert.throws(() => validateRawPath('a\0b.csv'), (error) => error instanceof WbError && error.status === 400)
  assert.equal(validateRawPath('  a.csv  '), '  a.csv  ')
})

test('assertFresh：版本一致通过', () => {
  assert.doesNotThrow(() => assertFresh({ mtimeMs: 1000.5, size: 10 }, { mtimeMs: 1000.5, size: 10 }))
  // 浮点尾差在 0.5ms 内放行
  assert.doesNotThrow(() => assertFresh({ mtimeMs: 1000.5, size: 10 }, { mtimeMs: 1000.75, size: 10 }))
})

test('assertFresh：mtime 或 size 变化 → 409 conflict', () => {
  assert.throws(
    () => assertFresh({ mtimeMs: 1000, size: 10 }, { mtimeMs: 2000, size: 10 }),
    (error) => error instanceof WbError && error.status === 409 && error.code === 'conflict',
  )
  assert.throws(
    () => assertFresh({ mtimeMs: 1000, size: 10 }, { mtimeMs: 1000, size: 11 }),
    (error) => error instanceof WbError && error.status === 409,
  )
})

test('assertFresh：缺少版本信息 → 400 bad_version', () => {
  assert.throws(
    () => assertFresh({}, { mtimeMs: 1, size: 1 }),
    (error) => error instanceof WbError && error.status === 400 && error.code === 'bad_version',
  )
})
