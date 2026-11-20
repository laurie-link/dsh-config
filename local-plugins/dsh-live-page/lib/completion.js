/**
 * dsh-live-page — inline text completion for the in-page editor.
 *
 * The overlay asks the live server for a continuation while the caret sits at
 * the end of an edited block; this module turns that request into one short
 * non-session LLM call and returns the raw continuation text.
 *
 * Design notes:
 *  - Latency is everything: short prompt, few tokens, hard timeout, single
 *    in-flight call per live site (enforced by the caller), early stop.
 *  - Reasoning models are a real failure mode here (they spend the token budget
 *    on reasoning and return empty text). The route resolver therefore prefers
 *    a non-thinking configuration: `reasoningEffort: 'off'` when the model
 *    advertises it, and a retry with `off` when a first attempt returns only
 *    reasoning.
 *  - No session, no tools, no store: this never touches conversation state.
 */

/** Hard cap for one completion request (LLM round trip included). */
export const COMPLETE_TIMEOUT_MS = 7000
/** Route candidates one completion may burn through on provider-level failures. */
export const MAX_COMPLETE_ROUTE_TRIES = 3

/** Output budget: a completion is a short phrase, not a paragraph. */
export const COMPLETE_MAX_TOKENS = 96

/** Stop streaming once this many characters arrived. */
export const COMPLETE_EARLY_STOP_CHARS = 180

/** Longest accepted prefix/suffix/context (defensive, client already trims). */
export const MAX_PREFIX_CHARS = 1200
export const MAX_SUFFIX_CHARS = 400
export const MAX_CONTEXT_CHARS = 900

/** Returned continuation cap (overlay also caps). */
export const MAX_SUGGESTION_CHARS = 180

/** System prompt: continuation-only, same language, no markup. */
export const COMPLETE_SYSTEM = [
  'You are an inline autocomplete engine inside a web page text editor.',
  'Continue the user text from the cursor with the few words a writer would type next.',
  'Rules:',
  '- Output ONLY the continuation text, no quotes, no markdown, no explanation, no labels.',
  '- Same language and tone as the surrounding text.',
  '- At most one short sentence (about 3-20 words). Never restate the text before the cursor.',
  '- Match the page voice; keep product names and terminology exactly as they appear.',
  '- If no sensible continuation exists, output nothing.',
].join('\n')

/** Normalize one completion request; returns null for unusable input. */
export function normalizeRequest(input) {
  if (!input || typeof input !== 'object') return null
  const prefix = typeof input.prefix === 'string' ? input.prefix : ''
  if (prefix.trim().length < 3) return null
  return {
    file: typeof input.file === 'string' ? input.file.slice(0, 400) : '',
    title: typeof input.title === 'string' ? input.title.slice(0, 300) : '',
    tag: typeof input.tag === 'string' ? input.tag.slice(0, 20) : '',
    before: typeof input.before === 'string' ? input.before.slice(-MAX_CONTEXT_CHARS) : '',
    prefix: prefix.slice(-MAX_PREFIX_CHARS),
    suffix: typeof input.suffix === 'string' ? input.suffix.slice(0, MAX_SUFFIX_CHARS) : '',
  }
}

/** Build the single user message for one completion. */
export function buildCompletionPrompt(request) {
  const lines = []
  if (request.title) lines.push('Page title: ' + request.title)
  if (request.file) lines.push('Source file: ' + request.file)
  if (request.before.trim() !== '') {
    lines.push('', 'Text right before the edited block:', request.before.trim())
  }
  lines.push('', 'Text of the block being edited (the cursor is at the end of it):', request.prefix)
  if (request.suffix.trim() !== '') {
    lines.push('', 'Text after the cursor in the same block:', request.suffix)
  }
  lines.push('', 'Write only the continuation after the cursor.')
  return lines.join('\n')
}

/** Remove wrappers/quotes and keep one line of plain text. */
export function cleanCompletion(raw, prefix = '') {
  let text = String(raw == null ? '' : raw)
  if (text === '') return ''
  // Drop code fences / leading labels the model may add anyway.
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/g, '')
  text = text.replace(/^\s*(?:continuation|completion|suggestion)\s*[::]\s*/i, '')
  // One line only: a completion must not introduce new paragraphs.
  const newline = text.search(/[\r\n]/)
  if (newline !== -1) text = text.slice(0, newline)
  text = text.replace(/^["'“”‘’「」]+/, '').replace(/["'“”‘’「」]+$/, '')
  text = text.replace(/\s+$/g, '')
  // Models sometimes echo the tail of the prefix; drop the duplicated part.
  const trimmedPrefix = String(prefix || '').replace(/\s+$/g, '')
  if (trimmedPrefix) {
    const limit = Math.min(trimmedPrefix.length, text.length)
    for (let size = limit; size >= 8; size -= 1) {
      const chunk = trimmedPrefix.slice(-size)
      if (!text.startsWith(chunk)) continue
      const tail = text.slice(size)
      text = tail.trim() === '' ? '' : tail
      break
    }
  }
  if (text.length > MAX_SUGGESTION_CHARS) text = text.slice(0, MAX_SUGGESTION_CHARS)
  // A continuation never starts a new line/paragraph.
  return text.replace(/^\s+/, '')
}

/** Probe the llm service without hard-depending on it. */
export function llmOf(ctx) {
  try {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
    return llm && typeof llm.stream === 'function' ? llm : null
  } catch {
    return null
  }
}

/** Does this model advertise a non-thinking effort id? */
function thinkingOffEffort(info) {
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts)) return ''
  for (const effort of efforts) {
    const id = String(effort?.id ?? '')
    if (id === 'off' || id === 'none' || id === 'disabled') return id
  }
  return ''
}

/** Providers tried before the chat default when looking for a fast, non-thinking route. */
const FAST_PROVIDER_ORDER = ['deepseek-account', 'deepseek-official', 'opencode-go', 'acp']

/** Provider/model ids that are known to answer prose quickly. */
function preferredModelOf(provider, models) {
  if (!Array.isArray(models) || models.length === 0) return ''
  if (provider === 'deepseek-account' || provider === 'deepseek-official') {
    const flash = models.find((model) => model && model.id === 'deepseek-flash')
    if (flash) return flash.id
  }
  if (provider === 'opencode-go') {
    const flash = models.find((model) => model && /flash/i.test(String(model.id)))
    if (flash) return flash.id
  }
  if (provider === 'acp') {
    const composer = models.find((model) => model && /composer/i.test(String(model.id)))
    if (composer) return composer.id
  }
  return models[0].id
}

/** Chat default selection ({provider, model, reasoningEffort}) when the service exists. */
function chatSelection(ctx) {
  try {
    const selection = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : undefined
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return {
        provider: selection.provider,
        model: selection.model,
        effort: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : '',
      }
    }
  } catch {
    // ignore
  }
  return null
}

/** Failure notes that mean the route itself is unusable, not the answer. */
const ROUTE_FAILURE_RE = /ACCOUNT_TOKEN_INVALID|invalid dsh token|unauthor|forbidden|not authenticated|\b401\b|\b403\b|provider.*(?:not found|unavailable|invalid)|no such provider|model.*not found|MODEL_NOT_FOUND/i

/** True when a failure should move to the next provider instead of giving up. */
export function isRouteFailure(note) {
  return ROUTE_FAILURE_RE.test(String(note || ''))
}

/** First usable model id for one provider (fast/preferred model when known). */
async function firstModelOf(llm, providerId) {
  let models = []
  try {
    models = await Promise.resolve(llm.listModels(providerId))
  } catch {
    models = []
  }
  return preferredModelOf(providerId, models) || (models[0] && models[0].id) || ''
}

/**
 * Ordered list of usable routes.
 *
 * Prose completion wants a fast, non-thinking model, so the order is:
 *   1. env override (DSH_LIVE_PAGE_AI_PROVIDER / _MODEL / _EFFORT);
 *   2. the chat default when it advertises a non-thinking effort;
 *   3. the first fast provider/model that advertises one;
 *   4. the chat default as-is;
 *   5. every remaining provider's first model, in catalog order.
 *
 * Duplicates (same provider + model) are dropped, so a route that
 * turns out to be unusable (expired credential, retired model) can simply move
 * on to the next entry.
 */
export async function resolveModelCandidates(llm, ctx, probe) {
  const overrideProvider = process.env.DSH_LIVE_PAGE_AI_PROVIDER || ''
  const overrideModel = process.env.DSH_LIVE_PAGE_AI_MODEL || ''
  const overrideEffort = process.env.DSH_LIVE_PAGE_AI_EFFORT || ''
  const out = []
  const seen = new Set()

  function push(candidate) {
    if (!candidate || !candidate.provider || !candidate.model) return
    // Same provider+model at a different effort is still the same credential;
    // a second attempt with it would fail the same way.
    const key = candidate.provider + '/' + candidate.model
    if (seen.has(key)) return
    seen.add(key)
    out.push(candidate)
  }

  if (overrideProvider && overrideModel) {
    push({ provider: overrideProvider, model: overrideModel, effort: overrideEffort, offSupported: overrideEffort, source: 'env' })
    return out
  }

  const selection = chatSelection(ctx)
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() || [] : []
  const byId = new Map(providers.map((provider) => [provider.id, provider]))

  async function probeRoute(provider, model, source) {
    const info = await probe(provider, model)
    const effort = thinkingOffEffort(info)
    return { provider, model, effort, offSupported: effort, source }
  }

  if (selection) {
    const probed = await probeRoute(selection.provider, selection.model, 'agent-default')
    if (probed.effort) push(probed)
  }
  for (const providerId of FAST_PROVIDER_ORDER) {
    if (!byId.has(providerId)) continue
    const modelId = await firstModelOf(llm, providerId)
    if (!modelId) continue
    const probed = await probeRoute(providerId, modelId, 'fast')
    if (probed.effort) push(probed)
  }
  if (selection) {
    push({ provider: selection.provider, model: selection.model, effort: selection.effort, offSupported: '', source: 'agent-default' })
  }
  for (const provider of providers) {
    const modelId = await firstModelOf(llm, provider.id)
    if (!modelId) continue
    push({ provider: provider.id, model: modelId, effort: '', offSupported: '', source: 'catalog' })
  }
  return out
}

/** Resolve the single best completion route (first usable candidate). */
export async function resolveModelRoute(llm, ctx, probe) {
  const candidates = await resolveModelCandidates(llm, ctx, probe)
  return candidates[0] || null
}

/**
 * Cache one route decision for the lifetime of the host process.
 * Used by both inline completion and selection rewriting; both want the same
 * fast route, but only one probe should happen per process.
 * `advance()` drops the current route after a provider-level failure so the
 * caller can retry the next candidate instead of failing the whole request.
 */
export function createRouteCache(ctx) {
  /** Resolved candidate list, ordered. */
  let candidates = null
  /** Index of the route currently in use. */
  let index = 0
  /** Cached route decision: { provider, model, effort, offSupported, source }. */
  let route = null
  /** Model-info cache: resolveModelInfo is async and may hit the provider. */
  const infoCache = new Map()

  async function modelInfo(provider, model) {
    const key = provider + '/' + model
    if (infoCache.has(key)) return infoCache.get(key)
    let info = null
    try {
      info = typeof llmOf(ctx)?.resolveModelInfo === 'function' ? await llmOf(ctx).resolveModelInfo(provider, model) : null
    } catch {
      info = null
    }
    infoCache.set(key, info)
    return info
  }

  function toRoute(candidate) {
    return {
      provider: candidate.provider,
      model: candidate.model,
      effort: candidate.effort || '',
      offSupported: candidate.offSupported || candidate.effort || '',
      source: candidate.source || '',
    }
  }

  async function load() {
    if (candidates) return candidates
    const llm = llmOf(ctx)
    if (!llm) {
      candidates = []
      return candidates
    }
    try {
      candidates = (await resolveModelCandidates(llm, ctx, modelInfo)) || []
    } catch {
      candidates = []
    }
    return candidates
  }

  async function ensure() {
    if (route) return route
    const list = await load()
    if (list.length === 0) return null
    if (index >= list.length || index < 0) index = 0
    route = toRoute(list[index])
    return route
  }

  /** Mark the current route unusable and move to the next candidate. */
  async function advance() {
    const list = await load()
    if (list.length === 0) return null
    if (!route) return ensure()
    index += 1
    if (index >= list.length) {
      route = null
      return null
    }
    route = toRoute(list[index])
    return route
  }

  return {
    ensure,
    advance,
    get current() {
      return route
    },
    get candidates() {
      return candidates || []
    },
  }
}

/**
 * Stream one model call and collect text/reasoning.
 * Shared by completion (tiny, fast) and rewrite (larger, slower).
 */
export async function streamModelText(llm, options) {
  if (!llm) return { text: '', reasoning: 0, note: 'llm 服务不可用' }
  const {
    provider,
    model,
    effort = '',
    prompt,
    system,
    temperature = 0.3,
    maxTokens = 256,
    earlyStopChars = 0,
    signal,
  } = options || {}
  let text = ''
  let reasoning = 0
  let failure = ''
  const stream = llm.stream({
    provider,
    model,
    ...(effort ? { reasoningEffort: effort } : {}),
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      },
    ],
    system,
    temperature,
    maxTokens,
    signal,
  })
  for await (const chunk of stream) {
    const type = chunk?.type
    if (type === 'text-delta') {
      text += String(chunk.text ?? '')
      if (earlyStopChars > 0 && text.length >= earlyStopChars) break
    } else if (type === 'reasoning-delta') {
      reasoning += String(chunk.text ?? '').length
    } else if (type === 'finish') {
      const kind = chunk?.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        const failureInfo = chunk?.reason?.failure
        failure = String(failureInfo?.code || kind) + ': ' + String(failureInfo?.message || '模型调用失败')
      }
      break
    } else if (type === 'error') {
      failure = String(chunk?.error?.code || '') + ': ' + String(chunk?.error?.message || '模型调用失败')
      break
    }
  }
  return { text, reasoning, note: failure }
}

/**
 * Create the per-plugin completer.
 * @param {object} ctx host context
 * @returns {(request: object) => Promise<{text:string, note?:string, route?:string, ms:number}>}
 */
export function createCompleter(ctx) {
  const routes = createRouteCache(ctx)
  /** Diagnostics of the last request (served by the host's debug route). */
  let last = null

  function streamOnce({ provider, model, effort, prompt, signal }) {
    return streamModelText(llmOf(ctx), {
      provider,
      model,
      effort,
      prompt,
      system: COMPLETE_SYSTEM,
      temperature: 0.3,
      maxTokens: COMPLETE_MAX_TOKENS,
      earlyStopChars: COMPLETE_EARLY_STOP_CHARS,
      signal,
    })
  }

  return async function complete(input) {
    const started = Date.now()
    const request = normalizeRequest(input)
    if (!request) return { text: '', note: '请求不完整', ms: 0 }
    const llm = llmOf(ctx)
    if (!llm) return { text: '', note: 'llm 服务不可用', ms: Date.now() - started }
    let resolved = await routes.ensure()
    if (!resolved) return { text: '', note: '没有可用模型', ms: Date.now() - started }

    const prompt = buildCompletionPrompt(request)
    const deadline = started + COMPLETE_TIMEOUT_MS
    let routeLabel = routeLabelOf(resolved)
    let note = ''
    let text = ''

    // Same fallback rule as rewriting: only a provider-level failure (expired
    // credential, retired model) moves to the next candidate; a slow or empty
    // answer from a healthy provider does not.
    for (let round = 1; round <= MAX_COMPLETE_ROUTE_TRIES; round += 1) {
      routeLabel = routeLabelOf(resolved)
      const remaining = deadline - Date.now()
      if (remaining < 1200) {
        note = note || '补全超时'
        break
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), remaining)
      let failure = ''
      try {
        let attempt = await streamOnce({
          provider: resolved.provider,
          model: resolved.model,
          effort: resolved.effort,
          prompt,
          signal: controller.signal,
        })
        // Reasoning-only output means the effort did not take: retry once with
        // the model's non-thinking effort id before giving up.
        if (!attempt.text.trim() && !attempt.note && attempt.reasoning > 0 && resolved.offSupported && resolved.effort !== resolved.offSupported) {
          resolved.effort = resolved.offSupported
          attempt = await streamOnce({
            provider: resolved.provider,
            model: resolved.model,
            effort: resolved.effort,
            prompt,
            signal: controller.signal,
          })
        }
        if (attempt.text.trim()) {
          text = cleanCompletion(attempt.text, request.prefix)
          note = ''
          break
        }
        failure = attempt.note || ''
        note = attempt.note
          ? '补全失败：' + attempt.note
          : attempt.reasoning > 0
            ? '模型只返回了思考，未产出补全'
            : ''
      } catch (error) {
        failure = String(error?.message || error)
        note = '补全失败：' + failure
      } finally {
        clearTimeout(timer)
      }
      if (!isRouteFailure(failure)) break
      const next = await routes.advance()
      if (!next) break
      resolved = next
    }

    const result = {
      text,
      ...(text === '' && note ? { note } : {}),
      route: routeLabel,
      ms: Date.now() - started,
    }
    last = { at: new Date().toISOString(), ...result, prefix: request.prefix.slice(-120) }
    return result
  }
}

/** Diagnostics snapshot for the host debug route (attached by createCompleter). */
export function lastCompletionOf(ctx) {
  return ctx?.__dshLivePageLastCompletion ?? null
}

/** Display label for one route, e.g. `opencode-go/deepseek-v4.1-flash[low]`. */
export function routeLabelOf(route) {
  if (!route) return ''
  return route.provider + '/' + route.model + (route.effort ? '[' + route.effort + ']' : '')
}
