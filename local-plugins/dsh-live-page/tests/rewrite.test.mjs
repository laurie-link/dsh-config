import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INSTRUCTION_CHARS,
  MAX_REWRITE_BLOCKS,
  REWRITE_SYSTEM,
  buildRewritePrompt,
  cleanReplacementHtml,
  createRewriter,
  normalizeRewriteRequest,
  parseRewriteReply,
} from '../lib/rewrite.js'

function request(patch = {}) {
  return {
    instruction: 'Make it shorter and more direct.',
    title: 'Page A',
    file: 'a.html',
    before: 'Before text.',
    after: 'After text.',
    blocks: [{ text: 'Hello world from the page.', start: 6, end: 11, tag: 'p' }],
    ...patch,
  }
}

describe('normalizeRewriteRequest', () => {
  it('keeps a usable request and numbers the blocks', () => {
    const normalized = normalizeRewriteRequest(
      request({ blocks: [
        { text: 'First block text.', start: 0, end: 5, tag: 'H2' },
        { text: 'Second block text.', start: 7, end: 12, tag: 'p' },
      ] }),
    )
    assert.ok(normalized)
    assert.equal(normalized.blocks.length, 2)
    assert.deepEqual(normalized.blocks.map((block) => block.index), [0, 1])
    assert.equal(normalized.blocks[0].tag, 'h2')
    assert.equal(normalized.blocks[0].start, 0)
    assert.equal(normalized.blocks[0].end, 5)
    assert.equal(normalized.instruction, 'Make it shorter and more direct.')
  })

  it('rejects short instructions, empty blocks and bad ranges', () => {
    assert.equal(normalizeRewriteRequest(request({ instruction: 'x' })), null)
    assert.equal(normalizeRewriteRequest(request({ blocks: [] })), null)
    assert.equal(normalizeRewriteRequest(request({ blocks: [{ text: 'abc', start: 2, end: 2, tag: 'p' }] })), null)
    assert.equal(normalizeRewriteRequest(request({ blocks: [{ text: 'abc', start: -1, end: 2, tag: 'p' }] })), null)
    assert.equal(normalizeRewriteRequest(request({ blocks: [{ text: 'abc', start: 0, end: 9, tag: 'p' }] })), null)
    assert.equal(normalizeRewriteRequest(request({ blocks: [{ text: '  ', start: 0, end: 1, tag: 'p' }] })), null)
  })

  it('caps instruction, block count and total text', () => {
    assert.equal(normalizeRewriteRequest(request({ instruction: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1) })).instruction.length, MAX_INSTRUCTION_CHARS)
    const many = Array.from({ length: MAX_REWRITE_BLOCKS + 1 }, (_, i) => ({
      text: 'block text ' + i,
      start: 0,
      end: 3,
      tag: 'p',
    }))
    assert.equal(normalizeRewriteRequest(request({ blocks: many })), null)
    const huge = [{ text: 'x'.repeat(7000), start: 0, end: 2, tag: 'p' }]
    assert.equal(normalizeRewriteRequest(request({ blocks: huge })), null)
  })
})

describe('buildRewritePrompt', () => {
  it('includes the selected text, its surroundings and one marker per block', () => {
    const normalized = normalizeRewriteRequest(
      request({ blocks: [
        { text: 'First block text.', start: 0, end: 5, tag: 'h2' },
        { text: 'Second block text.', start: 7, end: 12, tag: 'p' },
      ] }),
    )
    const prompt = buildRewritePrompt(normalized)
    assert.match(prompt, /Selected text to rewrite:\nFirst/)
    assert.match(prompt, /Selected text to rewrite:\nblock/)
    assert.match(prompt, /<dsh-block index="0">/)
    assert.match(prompt, /<dsh-block index="1">/)
    assert.match(prompt, /Change requested by the user:/)
    assert.match(prompt, /Text before the selection in this block:/)
    assert.match(prompt, /Text after the selection in this block:/)
  })

  it('states the requested number of markers', () => {
    const one = normalizeRewriteRequest(request())
    assert.match(buildRewritePrompt(one), /Return exactly one marker/)
    const two = normalizeRewriteRequest(request({ blocks: [
      { text: 'First block text.', start: 0, end: 5, tag: 'p' },
      { text: 'Second block text.', start: 0, end: 6, tag: 'p' },
    ] }))
    assert.match(buildRewritePrompt(two), /Return exactly 2 markers/)
  })
})

describe('cleanReplacementHtml', () => {
  it('unwraps the original block tag and keeps inline markup', () => {
    const result = cleanReplacementHtml('<p>New <strong>text</strong> here.</p>', 'p')
    assert.equal(result.ok, true)
    assert.equal(result.html, 'New <strong>text</strong> here.')
  })

  it('removes fences, labels and marker leftovers', () => {
    const result = cleanReplacementHtml('```html\n<p>Replacement: <em>fresh</em></p>\n```', 'p')
    assert.equal(result.ok, true)
    assert.equal(result.html, '<em>fresh</em>')
  })

  it('accepts an empty replacement', () => {
    assert.deepEqual(cleanReplacementHtml('   ', 'p'), { ok: true, html: '' })
  })

  it('rejects unsafe or block-level fragments', () => {
    assert.equal(cleanReplacementHtml('<script>alert(1)</script>', 'p').ok, false)
    assert.equal(cleanReplacementHtml('<div>block</div>', 'p').ok, false)
    assert.equal(cleanReplacementHtml('<img src="x.png">', 'p').ok, false)
    assert.equal(cleanReplacementHtml('<a href="javascript:alert(1)">x</a>', 'p').ok, false)
    assert.equal(cleanReplacementHtml('<span onclick="x()">x</span>', 'p').ok, false)
  })
})

describe('parseRewriteReply', () => {
  const blocks = [
    { index: 0, tag: 'p' },
    { index: 1, tag: 'h2' },
  ]

  it('parses one marker per block in any order', () => {
    const result = parseRewriteReply(
      'noise before\n<dsh-block index="1">New heading</dsh-block>\n<dsh-block index="0">New <em>body</em></dsh-block>\ntrailing',
      blocks,
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.blocks, [
      { index: 0, html: 'New <em>body</em>' },
      { index: 1, html: 'New heading' },
    ])
  })

  it('rejects missing and duplicate blocks', () => {
    assert.equal(parseRewriteReply('<dsh-block index="0">Only one</dsh-block>', blocks).ok, false)
    assert.equal(
      parseRewriteReply('<dsh-block index="0">A</dsh-block><dsh-block index="0">B</dsh-block><dsh-block index="1">C</dsh-block>', blocks).ok,
      false,
    )
  })

  it('falls back to JSON', () => {
    const result = parseRewriteReply('{"blocks":[{"index":0,"html":"A"},{"index":1,"html":"B"}]}', blocks)
    assert.equal(result.ok, true)
    assert.equal(result.blocks[0].html, 'A')
  })

  it('accepts a plain fragment for a single block', () => {
    const result = parseRewriteReply('Just a replacement.', [{ index: 0, tag: 'p' }])
    assert.equal(result.ok, true)
    assert.equal(result.blocks[0].html, 'Just a replacement.')
  })

  it('exposes the marker protocol in the system prompt', () => {
    assert.match(REWRITE_SYSTEM, /<dsh-block index="0">/)
    assert.match(REWRITE_SYSTEM, /Rewrite ONLY the selected text/)
  })
})

/** llm stub: first provider rejects the credential, the second answers. */
function fallbackLlm(calls, { secondReply }) {
  return {
    listProviders: () => [{ id: 'deepseek-account' }, { id: 'deepseek-official' }],
    listModels: (id) => [{ id: id === 'deepseek-account' ? 'deepseek-flash' : 'deepseek-flash' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream: (options) => {
      calls.push(options.provider)
      if (options.provider === 'deepseek-account') {
        return (async function* rejected() {
          throw new Error('ACCOUNT_TOKEN_INVALID: Authentication Fails (invalid dsh token)')
        })()
      }
      return (async function* answered() {
        yield { type: 'text-delta', text: secondReply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function ctxWith(llm) {
  return {
    get(name) {
      if (name === 'llm') return llm
      return undefined
    },
  }
}

describe('createRewriter route fallback', () => {
  const first = 'Hello world from the page.'
  const second = 'Second paragraph here.'
  const input = {
    instruction: '更简洁',
    blocks: [
      { tag: 'p', text: first, start: 0, end: first.length },
      { tag: 'p', text: second, start: 0, end: second.length },
    ],
  }
  const reply = '<dsh-block index="0">Hello world.</dsh-block>\n<dsh-block index="1">Second one.</dsh-block>'

  it('moves to the next provider when the credential is rejected', async () => {
    const calls = []
    const rewrite = createRewriter(ctxWith(fallbackLlm(calls, { secondReply: reply })))
    const result = await rewrite(input)
    assert.equal(result.note, undefined)
    assert.deepEqual(result.blocks.map((block) => block.html), ['Hello world.', 'Second one.'])
    assert.deepEqual(calls, ['deepseek-account', 'deepseek-official'])
    assert.match(result.route, /^deepseek-official\//)
  })

  it('keeps the same provider when the answer is merely empty', async () => {
    const calls = []
    const llm = {
      listProviders: () => [{ id: 'deepseek-account' }, { id: 'deepseek-official' }],
      listModels: () => [{ id: 'deepseek-flash' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
      stream: (options) => {
        calls.push(options.provider)
        return (async function* empty() {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const rewrite = createRewriter(ctxWith(llm))
    const result = await rewrite(input)
    assert.equal(result.blocks.length, 0)
    assert.ok(result.note)
    assert.deepEqual(calls, ['deepseek-account'])
  })
})
