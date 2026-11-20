/**
 * dsh-editor-context — Host 半纯逻辑单测（node --test）。
 *
 * 运行：cd ~/dsh-plugins/dsh-editor-context && node --test tests/*.test.mjs
 */
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATE_TTL_MS,
  clearLatestReport,
  contextTextFor,
  normalizeReport,
  setLatestReport,
} from '../lib/context.js'
import * as host from '../index.js'

const NOW = 1_700_000_000_000

function reportOf(extra) {
  return normalizeReport({ sessionId: 'session-1', at: NOW, ...extra })
}

beforeEach(() => { clearLatestReport() })

test('normalizeReport：坏输入（非对象/数组）返回 null', () => {
  for (const bad of [null, undefined, 'x', 42, true, [], [1, 2], () => {}]) {
    assert.equal(normalizeReport(bad), null)
  }
})

test('normalizeReport：坏字段丢弃，不抛错', () => {
  const report = normalizeReport({
    sessionId: 7,
    at: 'not-a-number',
    view: 'weird',
    evil: 'should be dropped',
    active: { path: '', language: 'ts', selection: { startLine: 2, endLine: 1 }, cursorLine: 0 },
    open: [{ label: '', path: '' }, null, 3, { label: 'a.ts' }, { path: 'b/c.py' }],
  })
  assert.equal(report.sessionId, null)
  assert.equal(report.view, undefined)
  assert.equal(report.active, null)
  assert.equal('evil' in report, false)
  assert.ok(Number.isFinite(report.at) && report.at > 0)
  assert.deepEqual(report.open, [
    { label: 'a.ts', path: '' },
    { label: 'b/c.py', path: 'b/c.py' },
  ])
})

test('normalizeReport：合法字段原样保留（语言/选区/光标/active 标记）', () => {
  const report = reportOf({
    view: 'cursor',
    active: { path: 'src/a.ts', language: 'typescript', selection: { startLine: 3, endLine: 7 }, cursorLine: 5 },
    open: [{ label: 'a.ts', path: 'src/a.ts', active: true }, { label: 'README.md', path: 'README.md', active: false }],
  })
  assert.equal(report.sessionId, 'session-1')
  assert.equal(report.at, NOW)
  assert.equal(report.view, 'cursor')
  assert.deepEqual(report.active, {
    path: 'src/a.ts',
    language: 'typescript',
    selection: { startLine: 3, endLine: 7 },
    cursorLine: 5,
  })
  // active 只认严格 true：false 不保留键位
  assert.deepEqual(report.open, [
    { label: 'a.ts', path: 'src/a.ts', active: true },
    { label: 'README.md', path: 'README.md' },
  ])
})

test('normalizeReport：打开页签最多保留 50 条', () => {
  const open = Array.from({ length: 60 }, (_, index) => ({ label: 'f' + index + '.ts', path: 'f' + index + '.ts' }))
  assert.equal(normalizeReport({ sessionId: 's', at: NOW, open }).open.length, 50)
})

test('contextTextFor：没有上报时返回空串', () => {
  assert.equal(contextTextFor('session-1', NOW), '')
})

test('contextTextFor：超过 30 分钟 TTL 返回空串，边界内仍注入', () => {
  setLatestReport(reportOf({ active: { path: 'a.ts' } }))
  assert.match(contextTextFor('session-1', NOW), /Active file: a\.ts/)
  assert.notEqual(contextTextFor('session-1', NOW + STATE_TTL_MS), '')
  assert.equal(contextTextFor('session-1', NOW + STATE_TTL_MS + 1), '')
})

test('contextTextFor：session 不匹配返回空串，未带 session 的快照对任意会话可用', () => {
  setLatestReport(reportOf({ active: { path: 'secret.ts' } }))
  assert.equal(contextTextFor('session-2', NOW), '')
  assert.equal(contextTextFor(undefined, NOW), contextTextFor('session-1', NOW))

  clearLatestReport()
  const anonymous = normalizeReport({ at: NOW, active: { path: 'global.ts' } })
  assert.equal(anonymous.sessionId, null)
  setLatestReport(anonymous)
  assert.match(contextTextFor('session-3', NOW), /Active file: global\.ts/)
})

test('contextTextFor：活动文件附带语言、单行/多行选区与光标文案', () => {
  setLatestReport(reportOf({
    active: { path: 'src/a.ts', language: 'typescript', selection: { startLine: 3, endLine: 7 } },
  }))
  let text = contextTextFor('session-1', NOW)
  assert.match(text, /- Active file: src\/a\.ts \(language typescript; lines 3-7 selected\)/)

  clearLatestReport()
  setLatestReport(reportOf({ active: { path: 'src/a.ts', selection: { startLine: 5, endLine: 5 } } }))
  text = contextTextFor('session-1', NOW)
  assert.match(text, /line 5 selected/)

  clearLatestReport()
  setLatestReport(reportOf({ active: { path: 'src/a.ts', cursorLine: 7 } }))
  text = contextTextFor('session-1', NOW)
  assert.match(text, /cursor at line 7/)
})

test('contextTextFor：没有活动文件但有打开列表', () => {
  setLatestReport(reportOf({
    active: null,
    open: [{ label: 'a.ts', path: 'a.ts' }, { label: 'b.md', path: 'b.md' }],
  }))
  const text = contextTextFor('session-1', NOW)
  assert.match(text, /- No active text file in the editor\./)
  assert.match(text, /- Open editor tabs: a\.ts, b\.md/)
  assert.doesNotMatch(text, /- Active file:/)
})

test('contextTextFor：非文本活动页签（PDF）报活动页签而不是活动文件', () => {
  setLatestReport(reportOf({
    active: null,
    open: [{ label: 'sample.pdf', path: '_dsh-preview-test/sample.pdf', active: true }],
  }))
  const text = contextTextFor('session-1', NOW)
  assert.match(text, /- Active tab: _dsh-preview-test\/sample\.pdf \(not a text editor/)
  assert.doesNotMatch(text, /- Active file:/)
  assert.match(text, /Open editor tabs: sample\.pdf/)
})

test('contextTextFor：view（cursor/agent）事实；无 view 时不出现该行', () => {
  setLatestReport(reportOf({ view: 'cursor', active: { path: 'a.ts' } }))
  assert.match(contextTextFor('session-1', NOW), /- View: cursor/)
  clearLatestReport()
  setLatestReport(reportOf({ view: 'agent', active: { path: 'a.ts' } }))
  assert.match(contextTextFor('session-1', NOW), /- View: agent/)
  clearLatestReport()
  setLatestReport(reportOf({ active: { path: 'a.ts' } }))
  assert.doesNotMatch(contextTextFor('session-1', NOW), /- View:/)
})

test('contextTextFor：cwd 说明（相对路径基准）', () => {
  setLatestReport(reportOf({ active: { path: '_dsh-preview-test/sample.py' } }))
  const text = contextTextFor('session-1', NOW, '/Users/laruielaurence/Documents/视频')
  assert.match(text, /- Session working directory: \/Users\/laruielaurence\/Documents\/视频/)
  assert.match(text, /Paths are workspace-relative to the session working directory unless absolute\./)
  // 未提供 cwd 时不出现该行
  assert.doesNotMatch(contextTextFor('session-1', NOW), /Session working directory:/)
})

test('contextTextFor：快照较旧时提示 as of Ns ago，刚上报时不啰嗦', () => {
  setLatestReport(reportOf({ active: { path: 'a.ts' } }))
  assert.match(contextTextFor('session-1', NOW + 12_000), /as of 12s ago/)
  assert.doesNotMatch(contextTextFor('session-1', NOW + 1_000), /as of /)
})

test('contextTextFor：打开列表超过 12 条时截断并加省略号', () => {
  const open = Array.from({ length: 20 }, (_, index) => ({ label: 'f' + index + '.ts', path: 'f' + index + '.ts' }))
  setLatestReport(reportOf({ open }))
  const text = contextTextFor('session-1', NOW)
  assert.match(text, /Open editor tabs: f0\.ts, f1\.ts.*…/)
})

test('contextTextFor：字段缺失的陈旧快照不抛错', () => {
  setLatestReport({ sessionId: null, at: NOW, active: null })
  const text = contextTextFor('session-1', NOW)
  assert.match(text, /No active text file in the editor\./)
})

test('normalizeReport：active.source 只保留 preview/sheet，其它值丢弃', () => {
  for (const source of ['preview', 'sheet']) {
    const report = reportOf({ active: { path: 'a/x.xlsx', source } })
    assert.equal(report.active.source, source)
  }
  for (const source of ['monaco', 'other', 42, null, undefined, true]) {
    const report = reportOf({ active: { path: 'a/x.xlsx', source } })
    assert.equal('source' in report.active, false)
  }
})

test('contextTextFor：官方侧栏表格页签写「可编辑表格」、预览页签写「只读查看器」', () => {
  setLatestReport(reportOf({ active: { path: '_dsh-preview-test/sample.xlsx', source: 'sheet' } }))
  let text = contextTextFor('session-1', NOW)
  assert.match(text, /- Active file \(open in the editable spreadsheet tab\): _dsh-preview-test\/sample\.xlsx/)
  assert.doesNotMatch(text, /read-only viewer/)

  clearLatestReport()
  setLatestReport(reportOf({ active: { path: '_dsh-preview-test/sample.pdf', source: 'preview' } }))
  text = contextTextFor('session-1', NOW)
  assert.match(text, /- Active file \(open in a read-only viewer\): _dsh-preview-test\/sample\.pdf/)
  assert.doesNotMatch(text, /editable spreadsheet tab/)

  // Monaco 文本文件（无 source）措辞不变
  clearLatestReport()
  setLatestReport(reportOf({ active: { path: 'src/a.ts', language: 'typescript' } }))
  text = contextTextFor('session-1', NOW)
  assert.match(text, /- Active file: src\/a\.ts \(language typescript\)/)
  assert.doesNotMatch(text, /read-only viewer/)

  // source 存在时不再附加语言/选区等文本编辑器细节
  clearLatestReport()
  setLatestReport(reportOf({ active: { path: 'a.xlsx', source: 'sheet', language: 'xlsx', cursorLine: 3 } }))
  text = contextTextFor('session-1', NOW)
  assert.doesNotMatch(text, /language/)
  assert.doesNotMatch(text, /cursor at line/)
})

test('index.js 重新导出可测函数，并与 lib 共享同一份快照状态', () => {
  assert.equal(typeof host.normalizeReport, 'function')
  assert.equal(typeof host.contextTextFor, 'function')
  assert.equal(host.normalizeReport, normalizeReport)
  setLatestReport(reportOf({ active: { path: 'shared.ts' } }))
  assert.equal(host.contextTextFor('session-1', NOW), contextTextFor('session-1', NOW))
  assert.match(host.contextTextFor('session-1', NOW), /Active file: shared\.ts/)
})
