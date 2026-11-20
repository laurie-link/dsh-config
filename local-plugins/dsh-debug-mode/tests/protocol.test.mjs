import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildContextText,
  buildInstrumentationReadme,
  buildLeftoverText,
  buildMission,
  buildStatusText,
  findMarkerLines,
  formatEvents,
  markerFor,
  newSessionId,
  normalizeEvent,
  parseDebugInput,
  parseEventBody,
} from '../lib/protocol.js'

test('parseDebugInput: subcommands and start fallback', () => {
  assert.deepEqual(parseDebugInput(''), { kind: 'help' })
  assert.deepEqual(parseDebugInput('  HELP '), { kind: 'help' })
  assert.deepEqual(parseDebugInput('status'), { kind: 'status' })
  assert.deepEqual(parseDebugInput('Info'), { kind: 'status' })
  assert.deepEqual(parseDebugInput('stop'), { kind: 'stop' })
  assert.deepEqual(parseDebugInput('off'), { kind: 'stop' })
  assert.deepEqual(parseDebugInput('cleanup'), { kind: 'cleanup' })
  assert.deepEqual(parseDebugInput('logs'), { kind: 'logs', limit: 100 })
  assert.deepEqual(parseDebugInput('logs 25'), { kind: 'logs', limit: 25 })
  assert.deepEqual(parseDebugInput('tail 99999'), { kind: 'logs', limit: 500 })
  assert.deepEqual(parseDebugInput('logs 10 --grep cart'), { kind: 'logs', limit: 10, grep: 'cart' })
  assert.deepEqual(parseDebugInput('logs --grep "empty file"'), { kind: 'logs', limit: 100, grep: '"empty file"' })
  // 任何别的文本都是 bug 描述（含以 logs 开头的自然语言也算 logs 子命令，这是约定）
  const started = parseDebugInput('the export button writes an empty file')
  assert.equal(started.kind, 'start')
  assert.equal(started.bug, 'the export button writes an empty file')
})

test('newSessionId + markerFor', () => {
  const id = newSessionId((size) => Buffer.from([0x01, 0x7f, 0xab]))
  assert.equal(id, 'dbg-017fab')
  assert.equal(markerFor(id), 'dsh-debug:dbg-017fab')
})

test('normalizeEvent: loose shapes, ts seconds vs ms, rejects blanks', () => {
  assert.equal(normalizeEvent(null), null)
  assert.equal(normalizeEvent([]), null)
  assert.equal(normalizeEvent({}), null)
  const now = 1_700_000_000_000
  const event = normalizeEvent({ tag: 'cart', msg: 'enter', data: { items: 3 }, ts: 1700000000 }, now)
  assert.equal(event.tag, 'cart')
  assert.equal(event.msg, 'enter')
  assert.deepEqual(event.data, { items: 3 })
  assert.equal(event.ts, 1_700_000_000_000) // 秒 → 毫秒
  const rest = normalizeEvent({ level: 'warn', message: 'slow path', extra: 1 }, now)
  assert.equal(rest.msg, 'slow path')
  assert.deepEqual(rest.data, { level: 'warn', extra: 1 })
  const noTs = normalizeEvent({ tag: 'x' }, now)
  assert.equal(noTs.ts, now)
})

test('parseEventBody: single object, array, NDJSON, garbage lines', () => {
  const now = 1_700_000_000_000
  assert.equal(parseEventBody('', now).length, 0)
  const single = parseEventBody('{"tag":"a","data":{"x":1}}', now)
  assert.equal(single.length, 1)
  assert.equal(single[0].tag, 'a')
  const array = parseEventBody('[{"tag":"a"},{"tag":"b"}]', now)
  assert.deepEqual(array.map((e) => e.tag), ['a', 'b'])
  const ndjson = parseEventBody('{"tag":"a"}\n{"tag":"b"}\n\n', now)
  assert.deepEqual(ndjson.map((e) => e.tag), ['a', 'b'])
  const mixed = parseEventBody('{"tag":"a"}\nnot json\n{"tag":"b"}', now)
  assert.deepEqual(mixed.map((e) => e.tag), ['a', '', 'b'])
  assert.equal(mixed[1].msg, 'not json')
})

test('formatEvents: limit, grep, tag, since filter', () => {
  const now = 1_700_000_000_000
  const events = []
  for (let index = 0; index < 10; index += 1) {
    events.push({
      receivedAt: now - (10 - index) * 1000,
      ts: now - (10 - index) * 1000,
      tag: index % 2 === 0 ? 'cart' : 'pay',
      msg: 'step ' + index,
      data: { index },
    })
  }
  const all = formatEvents(events, { limit: 3 }, now)
  assert.equal(all.matched, 10)
  assert.equal(all.total, 10)
  assert.match(all.text, /#8/)
  assert.match(all.text, /#10/)
  assert.doesNotMatch(all.text, /#7\]/)

  const cart = formatEvents(events, { tag: 'cart' }, now)
  assert.equal(cart.matched, 5)
  const grep = formatEvents(events, { grep: 'step 7' }, now)
  assert.equal(grep.matched, 1)
  assert.match(grep.text, /step 7/)
  const since = formatEvents(events, { sinceMs: 3500 }, now) // 只看最近 3.5s（index 7,8,9）
  assert.equal(since.matched, 3)

  const empty = formatEvents([], {}, now)
  assert.match(empty.text, /No events collected yet/)
})

test('findMarkerLines: line numbers and max hits', () => {
  const text = ['const a = 1', '// dsh-debug:dbg-1 probe', 'const b = 2', 'x() // dsh-debug:dbg-1'].join('\n')
  const hits = findMarkerLines(text, 'dsh-debug:dbg-1')
  assert.deepEqual(hits.map((hit) => hit.line), [2, 4])
  assert.equal(findMarkerLines(text, 'dsh-debug:dbg-1', 1).length, 1)
  assert.deepEqual(findMarkerLines('nothing here', 'dsh-debug:dbg-1'), [])
  assert.deepEqual(findMarkerLines(text, ''), [])
})

test('buildMission: carries endpoint, marker, paths and the 6-phase loop', () => {
  const mode = {
    id: 'dbg-abc123',
    bug: 'Export writes an empty file when the cart has 3 items.',
    endpoint: 'http://127.0.0.1:4242/ingest/tok',
    logFile: '/repo/.dsh-debug/dbg-abc123/events.ndjson',
    dir: '/repo/.dsh-debug/dbg-abc123',
    startedAt: 1_700_000_000_000,
  }
  const mission = buildMission(mode)
  assert.match(mission, /Debug Mode is now ACTIVE/)
  assert.match(mission, /http:\/\/127\.0\.0\.1:4242\/ingest\/tok/)
  assert.match(mission, /dsh-debug:dbg-abc123/)
  assert.match(mission, /events\.ndjson/)
  assert.match(mission, /Do NOT start by editing a fix/)
  assert.match(mission, /3\. Stop and ask the user to reproduce/)
  assert.match(mission, /debug_mode action="stop"/)
})

test('buildContextText: active-only, compact, includes live counts', () => {
  assert.equal(buildContextText(null), '')
  const mode = {
    id: 'dbg-abc123',
    bug: 'Empty export file',
    endpoint: 'http://127.0.0.1:4242/ingest/tok',
    logFile: '/repo/.dsh-debug/dbg-abc123/events.ndjson',
    startedAt: 1_700_000_000_000,
    events: [{ receivedAt: 1 }, { receivedAt: 2 }],
    lastEventAt: 1_700_000_030_000,
  }
  const text = buildContextText(mode, 1_700_000_060_000)
  assert.match(text, /Debug Mode active/)
  assert.match(text, /events collected: 2/)
  assert.match(text, /last event: 30s ago/)
  assert.match(text, /dsh-debug:dbg-abc123/)
})

test('buildStatusText: zh/en variants', () => {
  const mode = {
    id: 'dbg-abc123',
    bug: 'Empty export',
    status: 'active',
    startedAt: 1_700_000_000_000,
    events: [{ receivedAt: 1 }],
    lastEventAt: 0,
    endpoint: 'http://127.0.0.1:1/ingest/t',
    logFile: '/tmp/x.ndjson',
  }
  assert.match(buildStatusText(mode, 1_700_000_030_000, 'zh'), /Debug 模式进行中/)
  assert.match(buildStatusText(mode, 1_700_000_030_000, 'en'), /Debug Mode is ACTIVE/)
  assert.match(buildStatusText(undefined, 0, 'zh'), /没有处于 Debug 模式/)
  assert.match(buildStatusText(undefined, 0, 'en'), /not active/)
})

test('buildLeftoverText: clean vs hits', () => {
  assert.match(buildLeftoverText({ scanned: 10, matches: [] }, 'en'), /No leftover instrumentation/)
  const text = buildLeftoverText({
    scanned: 12,
    matches: [{ path: 'src/a.js', lines: [{ line: 3, text: '// dsh-debug:x' }] }],
    truncated: false,
  }, 'en')
  assert.match(text, /src\/a\.js/)
  assert.match(text, /L3: \/\/ dsh-debug:x/)
  assert.match(buildLeftoverText(undefined, 'zh'), /未执行扫描/)
})

test('buildInstrumentationReadme: snippets for JS/Python/shell and rules', () => {
  const mode = {
    id: 'dbg-abc123',
    bug: 'Empty export',
    startedAt: 1_700_000_000_000,
    endpoint: 'http://127.0.0.1:4242/ingest/tok',
    logFile: '/repo/.dsh-debug/dbg-abc123/events.ndjson',
  }
  const readme = buildInstrumentationReadme(mode)
  assert.match(readme, /## JS\/TS/)
  assert.match(readme, /## Python/)
  assert.match(readme, /## Shell/)
  assert.match(readme, /http:\/\/127\.0\.0\.1:4242\/ingest\/tok/)
  assert.match(readme, /dsh-debug:dbg-abc123/)
  assert.match(readme, /Hard rules/)
})
