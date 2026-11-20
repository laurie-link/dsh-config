/**
 * dsh-editor-context — 官方右侧栏推断纯函数单测（node --test）。
 *
 * 覆盖官方 `dsh-resource://file/…` 地址语法、活动预览/表格页签推断、文件页签标题判定。
 * 运行：cd ~/dsh-plugins/dsh-editor-context && node --test tests/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FILE_ADDRESS_PREFIX,
  inferActiveSource,
  isResourceAddress,
  looksLikeFileTitle,
  parseResourceAddress,
} from '../lib/sources.js'

test('parseResourceAddress：session 域 → { sessionId, path }', () => {
  assert.deepEqual(parseResourceAddress(FILE_ADDRESS_PREFIX + 'session/s-1/_dsh-preview-test/sample.xlsx'), {
    scope: 'session',
    sessionId: 's-1',
    path: '_dsh-preview-test/sample.xlsx',
  })
  // 每段单独解码：空格、#、? 都按字面读回
  assert.deepEqual(parseResourceAddress(FILE_ADDRESS_PREFIX + 'session/s%201/a/b%20c%23%3F.ts'), {
    scope: 'session',
    sessionId: 's 1',
    path: 'a/b c#?.ts',
  })
  // query/fragment 后缀忽略
  assert.deepEqual(parseResourceAddress(FILE_ADDRESS_PREFIX + 'session/s-1/a.csv?x=1#frag'), {
    scope: 'session',
    sessionId: 's-1',
    path: 'a.csv',
  })
})

test('parseResourceAddress：absolute 域（POSIX / Windows 盘符 / UNC）', () => {
  assert.deepEqual(parseResourceAddress(FILE_ADDRESS_PREFIX + 'absolute/Users/x/a.pdf'), {
    scope: 'absolute',
    path: '/Users/x/a.pdf',
  })
  assert.deepEqual(parseResourceAddress(FILE_ADDRESS_PREFIX + 'absolute/C:/work/a.xlsx'), {
    scope: 'absolute',
    path: 'C:/work/a.xlsx',
  })
  assert.deepEqual(parseResourceAddress(FILE_ADDRESS_PREFIX + 'absolute//server/share/doc.docx'), {
    scope: 'absolute',
    path: '//server/share/doc.docx',
  })
})

test('parseResourceAddress：坏输入与坏作用域返回 null', () => {
  for (const bad of [
    null,
    undefined,
    42,
    '',
    'not-an-address',
    'dsh-resource://other/x',
    FILE_ADDRESS_PREFIX,
    FILE_ADDRESS_PREFIX + 'other/a',
    FILE_ADDRESS_PREFIX + 'session',
    FILE_ADDRESS_PREFIX + 'session/',
    FILE_ADDRESS_PREFIX + 'session/s-1/',
    FILE_ADDRESS_PREFIX + 'absolute/',
    FILE_ADDRESS_PREFIX + 'session/s%ZZ/x',
  ]) {
    assert.equal(parseResourceAddress(bad), null)
  }
  assert.equal(isResourceAddress(FILE_ADDRESS_PREFIX + 'session/s/a'), true)
  assert.equal(isResourceAddress('/tmp/a'), false)
})

test('inferActiveSource：表格页签属性优先（path 或地址回退）', () => {
  // 表格插件加了 path 属性：直接用它（解析后的路径）
  assert.deepEqual(inferActiveSource({
    sheetPath: '_dsh-preview-test/sample.xlsx',
    sheetAddress: FILE_ADDRESS_PREFIX + 'session/s-1/_dsh-preview-test/sample.xlsx',
    sheetKind: 'xlsx',
  }), { path: '_dsh-preview-test/sample.xlsx', source: 'sheet', sessionId: 's-1' })

  // 只有地址（path 属性暂缺）：用地址里的 path
  assert.deepEqual(inferActiveSource({ sheetAddress: FILE_ADDRESS_PREFIX + 'session/s-1/a/b.csv' }), {
    path: 'a/b.csv',
    source: 'sheet',
    sessionId: 's-1',
  })

  // 表格属性的地址是 absolute 域（无 sessionId）
  assert.deepEqual(inferActiveSource({ sheetPath: '/Users/x/a.csv', sheetAddress: FILE_ADDRESS_PREFIX + 'absolute/Users/x/a.csv' }), {
    path: '/Users/x/a.csv',
    source: 'sheet',
  })
})

test('inferActiveSource：官方 documentpreview 预览（文本/PDF/Word/PPT 同属性）', () => {
  assert.deepEqual(inferActiveSource({ previewUrl: FILE_ADDRESS_PREFIX + 'session/s-1/_dsh-preview-test/sample.pdf' }), {
    path: '_dsh-preview-test/sample.pdf',
    source: 'preview',
    sessionId: 's-1',
  })
  assert.deepEqual(inferActiveSource({ previewUrl: FILE_ADDRESS_PREFIX + 'session/s-1/_dsh-preview-test/sample.docx' }), {
    path: '_dsh-preview-test/sample.docx',
    source: 'preview',
    sessionId: 's-1',
  })
  assert.deepEqual(inferActiveSource({ previewUrl: FILE_ADDRESS_PREFIX + 'absolute/Users/x/sample.pptx' }), {
    path: '/Users/x/sample.pptx',
    source: 'preview',
  })
})

test('inferActiveSource：属性缺失/坏值时返回 null（容错）', () => {
  assert.equal(inferActiveSource(null), null)
  assert.equal(inferActiveSource('x'), null)
  assert.equal(inferActiveSource([]), null)
  assert.equal(inferActiveSource({}), null)
  assert.equal(inferActiveSource({ previewUrl: 'bad-address' }), null)
  assert.equal(inferActiveSource({ sheetPath: '', sheetAddress: 'bad', previewUrl: '' }), null)
})

test('looksLikeFileTitle：文件页签名 vs 非文件页签', () => {
  for (const title of ['sample.xlsx', 'sample.csv', 'my report.docx', 'a.py', 'README.md', 'v1.0-notes.txt']) {
    assert.equal(looksLikeFileTitle(title), true, title)
  }
  for (const title of ['', ' ', '终端', '浏览器', '轨迹', '计划', 'Makefile', 'v1.2', '18:30', 'a.', 'dir/sample.pdf', 'x' + 'y'.repeat(200)]) {
    assert.equal(looksLikeFileTitle(title), false, title)
  }
})
