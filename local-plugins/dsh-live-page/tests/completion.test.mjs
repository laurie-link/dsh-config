import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPLETE_SYSTEM,
  MAX_SUGGESTION_CHARS,
  buildCompletionPrompt,
  cleanCompletion,
  createCompleter,
  createRouteCache,
  isRouteFailure,
  normalizeRequest,
  resolveModelCandidates,
} from '../lib/completion.js'

describe('normalizeRequest', () => {
  it('keeps a usable request and trims fields', () => {
    const request = normalizeRequest({
      file: 'a/b.html',
      title: 'T',
      tag: 'p',
      before: 'previous paragraph',
      prefix: 'Hello wor',
      suffix: '',
    })
    assert.deepEqual(request, {
      file: 'a/b.html',
      title: 'T',
      tag: 'p',
      before: 'previous paragraph',
      prefix: 'Hello wor',
      suffix: '',
    })
  })

  it('rejects empty/short/malformed input', () => {
    assert.equal(normalizeRequest(null), null)
    assert.equal(normalizeRequest({ prefix: '' }), null)
    assert.equal(normalizeRequest({ prefix: ' a ' }), null)
    assert.equal(normalizeRequest({ prefix: 'ab' }), null)
  })

  it('caps long fields', () => {
    const request = normalizeRequest({ prefix: 'x'.repeat(5000), before: 'y'.repeat(5000), suffix: 'z'.repeat(5000) })
    assert.ok(request.prefix.length <= 1200)
    assert.ok(request.before.length <= 900)
    assert.ok(request.suffix.length <= 400)
  })
})

describe('buildCompletionPrompt', () => {
  it('includes title, context and the cursor position', () => {
    const prompt = buildCompletionPrompt({
      title: 'Pokémon GO nests',
      file: 'pokemon-go/nest.html',
      before: 'Some previous text.',
      prefix: 'A nest is an area where one species',
      suffix: '',
    })
    assert.match(prompt, /Page title: Pokémon GO nests/)
    assert.match(prompt, /Source file: pokemon-go\/nest.html/)
    assert.match(prompt, /Text right before the edited block:/)
    assert.match(prompt, /A nest is an area where one species/)
    assert.match(prompt, /Write only the continuation after the cursor/)
    assert.equal(prompt.includes('Text after the cursor'), false)
  })

  it('mentions suffix text when it exists', () => {
    const prompt = buildCompletionPrompt({ title: '', file: '', before: '', prefix: 'Hello ', suffix: 'world' })
    assert.match(prompt, /Text after the cursor in the same block:\nworld/)
  })
})

describe('cleanCompletion', () => {
  it('keeps a short single-line continuation', () => {
    assert.equal(cleanCompletion('appears more often than elsewhere.'), 'appears more often than elsewhere.')
    assert.equal(cleanCompletion('  appears more often.'), 'appears more often.')
  })

  it('drops quotes, fences, labels and extra lines', () => {
    assert.equal(cleanCompletion('"appears more often."'), 'appears more often.')
    assert.equal(cleanCompletion('```text\nappears more often.\n```'), 'appears more often.')
    assert.equal(cleanCompletion('Continuation: appears more often.'), 'appears more often.')
    assert.equal(cleanCompletion('appears more often.\nSecond line.'), 'appears more often.')
    assert.equal(cleanCompletion('“appears more often.”'), 'appears more often.')
  })

  it('removes an echoed prefix tail and caps the length', () => {
    assert.equal(cleanCompletion('where one species appears', 'A nest is an area where one species'), 'appears')
    assert.equal(cleanCompletion('x'.repeat(500)).length, MAX_SUGGESTION_CHARS)
    assert.equal(cleanCompletion(''), '')
    assert.equal(cleanCompletion(null), '')
  })
})

describe('system prompt', () => {
  it('asks for a bare continuation', () => {
    assert.match(COMPLETE_SYSTEM, /Output ONLY the continuation text/)
    assert.match(COMPLETE_SYSTEM, /Same language/)
  })
})

/** Minimal llm service stub: provider list, model list, model info, stream. */
function fakeLlm({ providers = [], models = {}, info = {}, stream }) {
  return {
    listProviders: () => providers.map((id) => ({ id })),
    listModels: (id) => models[id] || [],
    resolveModelInfo: async (provider, model) => info[provider + '/' + model] ?? null,
    stream: stream || (() => replyChunks('')),
  }
}

/** ctx stub backed by a fake llm and an optional chat default. */
function fakeCtx(llm, selection = null) {
  return {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return selection ? { currentSelection: () => selection } : undefined
      return undefined
    },
  }
}

const OFF = { reasoning: { efforts: [{ id: 'high' }, { id: 'off' }] } }

function routeCatalog() {
  return {
    providers: ['deepseek-account', 'deepseek-official', 'opencode-go'],
    models: {
      'deepseek-account': [{ id: 'deepseek-flash' }],
      'deepseek-official': [{ id: 'deepseek-flash' }],
      'opencode-go': [{ id: 'deepseek-v4.1-flash' }],
    },
    info: {
      'deepseek-account/deepseek-flash': OFF,
      'deepseek-official/deepseek-flash': OFF,
    },
  }
}

/** Async generator yielding a fixed assistant reply. */
async function* replyChunks(text) {
  yield { type: 'text-delta', text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

describe('resolveModelCandidates', () => {
  it('orders fast non-thinking providers, then the chat default, with dedupe', async () => {
    const catalog = routeCatalog()
    const llm = fakeLlm(catalog)
    const ctx = fakeCtx(llm, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
    const probe = (provider, model) => Promise.resolve(catalog.info[provider + '/' + model] ?? null)
    const routes = await resolveModelCandidates(llm, ctx, probe)
    assert.deepEqual(
      routes.map((route) => route.provider + '/' + route.model),
      ['deepseek-account/deepseek-flash', 'deepseek-official/deepseek-flash', 'opencode-go/deepseek-v4.1-flash'],
    )
    assert.equal(routes[0].effort, 'off')
    assert.equal(routes[2].effort, 'max')
  })

  it('starts with the chat default when it advertises a non-thinking effort', async () => {
    const catalog = routeCatalog()
    const llm = fakeLlm(catalog)
    const ctx = fakeCtx(llm, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'off' })
    const probe = (provider, model) =>
      Promise.resolve(provider === 'opencode-go' ? OFF : (catalog.info[provider + '/' + model] ?? null))
    const routes = await resolveModelCandidates(llm, ctx, probe)
    assert.equal(routes[0].provider, 'opencode-go')
    assert.equal(routes[0].source, 'agent-default')
  })
})

describe('isRouteFailure', () => {
  it('treats credential and routing errors as provider-level failures', () => {
    assert.equal(isRouteFailure('ACCOUNT_TOKEN_INVALID: Authentication Fails (invalid dsh token)'), true)
    assert.equal(isRouteFailure('401 Unauthorized'), true)
    assert.equal(isRouteFailure('MODEL_NOT_FOUND'), true)
  })

  it('keeps content and timeout failures on the same route', () => {
    assert.equal(isRouteFailure(''), false)
    assert.equal(isRouteFailure('timeout'), false)
    assert.equal(isRouteFailure('模型没有返回改写结果'), false)
  })
})

describe('createRouteCache', () => {
  it('advances through candidates and stops when exhausted', async () => {
    const catalog = routeCatalog()
    const llm = fakeLlm(catalog)
    const ctx = fakeCtx(llm, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
    const cache = createRouteCache(ctx)
    assert.equal((await cache.ensure()).provider, 'deepseek-account')
    assert.equal((await cache.advance()).provider, 'deepseek-official')
    assert.equal((await cache.advance()).provider, 'opencode-go')
    assert.equal(await cache.advance(), null)
  })
})

describe('createCompleter route fallback', () => {
  it('retries the next provider when the credential is rejected', async () => {
    const catalog = routeCatalog()
    const calls = []
    const llm = fakeLlm({
      ...catalog,
      stream: (options) => {
        calls.push(options.provider)
        if (options.provider === 'deepseek-account') {
          return (async function* fail() {
            throw new Error('ACCOUNT_TOKEN_INVALID: Authentication Fails (invalid dsh token)')
          })()
        }
        return replyChunks(' appears more often.')
      },
    })
    const complete = createCompleter(fakeCtx(llm, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }))
    const result = await complete({ prefix: 'A nest is an area where one species', tag: 'p' })
    assert.equal(result.text, 'appears more often.')
    assert.equal(result.note, undefined)
    assert.equal(calls[0], 'deepseek-account')
    assert.equal(calls[1], 'deepseek-official')
    assert.match(result.route, /^deepseek-official\//)
  })
})
