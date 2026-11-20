/**
 * acp-guard — keep the harness's own context injections out of an ACP session.
 *
 * WHY: a session on the `acp` preset is a shell around another agent. The
 * harness still wakes its driver for injected context (`agent-instructions` and
 * the `skill-catalog` reminder arrive through the `agent/pre-step` waterfall),
 * and those injections ride the request as sourced USER messages — folded
 * directly behind the person's own message, with the runtime-context snapshot
 * appended after them. A bridge that forwarded "the last user message" would
 * hand the ACP agent the harness's context instead of the question. dsh-ntr's
 * bridge filters by `message.source.kind`, and this row is the second line of
 * defence: it removes the injections before they are even committed, so the
 * session's durable transcript shows the conversation and nothing else.
 *
 * STRIPPED SOURCES: `agent-instructions` and `skill-catalog` are the two
 * automatic reminders shipped presets add; every `plugin`-sourced message
 * (runtime-context snapshots, notices, relays, recalls) is harness context by
 * construction. `user` and `tool` sources are kept: the first is the person,
 * the second is loop-internal continuity this session still needs.
 *
 * NO-USER-INPUT STEPS ARE REJECTED (third duty) — with ONE exception: the
 * continuation steps of this row's OWN display cards. A batch that carries no
 * user-sourced message is the fuel of a host-side CONTINUATION step — the
 * agent loop re-runs whenever the settled assistant message contains
 * `tool-call` blocks, which is exactly what the ACP agent's segmented stream
 * produces (one card-bearing message per tool activity; see
 * docs/acp-convergence.md §1.7). The host "executes" the cards and proposes
 * the next step fed with those results, and the adapter answers that step by
 * resuming the SAME in-flight `session/prompt` from the transcript cursor —
 * never by sending a new one. Forwarding an arbitrary such batch would
 * re-send the person's last words to the ACP agent — the agent runs its OWN
 * loop and must hear a prompt once — so anything whose staged tool results
 * the bridge never saw is refused (`reject` ends the turn). But a batch whose
 * every staged call id sits in the shared registry (`toolResults`) is one of
 * OUR continuation steps and passes. Batches that DO carry user input keep
 * flowing (stripped as configured), and a source-less message counts as user
 * input — the same convention the bridge's forward picker uses, so a
 * hand-assembled batch is never eaten.
 *
 * DISPLAY CARDS EXECUTE AS REAL RESULTS (fourth duty): the card the Chat
 * plane draws IS the execution record, so the call must execute and record a
 * result. With no tool registered it would record `Error: unknown tool
 * "Bash"` (a red pile of errors). The `tools/execute` waterfall is the seam:
 * for a name nothing resolves, this row temporarily registers a SCOPED virtual
 * tool through exec.agent.ctx (the picker guard itself is global). The
 * definition is removed after execution, so ACP display titles never enter
 * subsequent model requests. Its body answers with the call's real output — the bridge
 * records every `tool_call` / `tool_call_update` content into the shared
 * registry (`toolResults`, keyed by call id). Under the SEGMENTED turn shape
 * the loop executes a card the moment its segment settles, which is often
 * BEFORE the agent reports the tool's output, so the body first parks on the
 * registry's `waitForToolOutput` (released by the record itself, by the
 * turn's settlement, or by a bounded timeout). A name that resolves to a REAL
 * tool passes untouched; a missing `tools` service degrades to the old
 * error-result behavior.
 *
 * Config:
 *   strippedSources?: string[]  — source kinds to strip (default below; `[]`
 *                                 disables the filter, e.g. to debug what the
 *                                 harness is injecting).
 *
 * ROUTE REWRITE (second duty): the host driver resolves each turn's route as
 * "pending selection → last request header → deployment default", and a plugin
 * cannot append a selection. A session that has never run an ACP turn therefore
 * resolves to the deployment default (a provider this conversation cannot use),
 * and one that has replays its previous `acp/<agent>` header even after the
 * user switched agents in the composer. The driver exposes exactly one seam for
 * this: the `agent/request` waterfall. This row registers a listener that
 * rewrites the resolved config to the plugin's conversation→agent binding
 * (`dsh-ntr` records it on bind, on model switch, and when a session
 * materializes; the plugin's default agent answers conversations nobody bound).
 *
 * The listener is registered with `{ prepend: true }`: waterfall listeners run
 * outermost-first, and the harness's own `installModelSelection` rewrite (which
 * re-applies `selectionFor(agent).current` — the deployment default for a
 * session with no selection history) is registered BEFORE this row mounts, so
 * only the outermost slot lets the binding win. The rewrite drops the resolved
 * `reasoningEffort`: it belongs to whatever route the seed named, while the
 * agent's thought level is the plugin's own per-session axis
 * (`session/chat-effort-set`), and a foreign effort would fail the adapter's
 * effort validation.
 *
 * The binding lives on `globalThis` under `BINDING_KEY` — the guard and the
 * plugin are separate module instances of the same package, so a module import
 * would not share state. Read defensively: a registry that is absent or shaped
 * unexpectedly degrades to "no rewrite", which is exactly the pre-guard
 * behavior. `BINDING_KEY` is a hand-copy discipline with `ACP_ROUTE_BINDING_KEY`
 * in src/bridge.ts (tests/register.spec.ts asserts the two see one registry).
 *
 * Deliberately dependency-free: this file is loaded by the harness's Loader as
 * the preset declaration's `dsh-ntr/acp-guard` row (see acp.patch.yml), and it
 * needs nothing but the `ctx` it is handed and node builtins. Keeping it that
 * way means a preset row can never fail for a reason the plugin's own dependency
 * graph would have to explain. A filter bug must never eat context, so every
 * step into this listener is guarded and degrades to "keep everything".
 */

/** Cordis plugin name used by loader diagnostics. */
import { appendFileSync, readFileSync, statSync } from 'node:fs'

export const name = 'acp-guard'

/** Source kinds stripped from every proposed step unless configured otherwise. */
const DEFAULT_STRIPPED_SOURCES = ['agent-instructions', 'skill-catalog', 'plugin']

/** The shared binding registry's key — hand-copy of `ACP_ROUTE_BINDING_KEY` (src/bridge.ts). */
const BINDING_KEY = Symbol.for('dsh-ntr.acp-binding')

/** Read and validate the `strippedSources` list. */
function strippedSourcesOf(config) {
  const value = config?.strippedSources
  if (value === undefined) return new Set(DEFAULT_STRIPPED_SOURCES)
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${name}: strippedSources must be an array of source-kind strings`)
  }
  return new Set(value)
}

/**
 * The adapter model one conversation's next turn runs on, as the plugin
 * recorded it. `undefined` → no rewrite (the harness default plays out).
 */
function boundModelFor(dshSessionId) {
  try {
    const registry = globalThis[BINDING_KEY]
    if (registry === undefined || typeof dshSessionId !== 'string' || dshSessionId === '') return undefined
    const bound = registry.conversations?.get?.(dshSessionId)
    if (typeof bound === 'string' && bound !== '') return bound
    const fallback = registry.defaultModel
    return typeof fallback === 'string' && fallback !== '' ? fallback : undefined
  } catch {
    return undefined
  }
}

/**
 * The ACP tool call's real output, as the bridge folded it. `undefined` when
 * the call carried no content (the card then shows a plain note).
 */
function toolOutputFor(callId) {
  try {
    if (typeof callId !== 'string' || callId === '') return undefined
    const registry = globalThis[BINDING_KEY]
    const text = registry?.toolResults?.get?.(callId)
    return typeof text === 'string' && text !== '' ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the bridge saw this call id in the ACP update stream — the marker
 * that a staged tool result belongs to this row's own continuation steps (and
 * not to some foreign continuation this gate must refuse).
 */
/** Whether this session has an ACP binding recorded by the host (dropdown mode). */
function isBoundSession(sessionId) {
  try {
    const registry = globalThis[BINDING_KEY]
    return typeof sessionId === 'string' && sessionId !== ''
      && registry?.conversations?.has?.(sessionId) === true
  } catch {
    return false
  }
}

/** The bound adapter model for one conversation, without the default-agent fallback. */
function boundConversationModel(sessionId) {
  try {
    const registry = globalThis[BINDING_KEY]
    const bound = registry?.conversations?.get?.(sessionId)
    return typeof bound === 'string' && bound !== '' ? bound : undefined
  } catch {
    return undefined
  }
}

function registryHasToolCall(callId) {
  try {
    if (typeof callId !== 'string' || callId === '') return false
    const registry = globalThis[BINDING_KEY]
    return registry?.toolResults?.has?.(callId) === true
  } catch {
    return false
  }
}

/** Whether the bridge recorded an ACP image for this call id. */
function hasToolImage(callId) {
  try {
    if (typeof callId !== 'string' || callId === '') return false
    const registry = globalThis[BINDING_KEY]
    const records = registry?.toolImages?.get?.(callId)
    return Array.isArray(records) && records.length > 0
  } catch {
    return false
  }
}

/** The render blocks for a saved image value: the read_image shape DSH draws. */
function imageBlocks(value) {
  const blocks = []
  if (value !== null && typeof value === 'object' && typeof value.path === 'string' && value.image !== null && typeof value.image === 'object') {
    blocks.push({ type: 'text', text: `<path>${value.path}</path>\n<type>image</type>\n<content>\n${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes\n</content>` })
    blocks.push({ type: 'image', attachment: value.image })
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

/**
 * 2026-11-05：把已经保存成 DSH 附件的图片引用登记到共享 registry。
 *
 * 背景：ACP 生成图默认落在 read_image 工具卡里，而工具卡在聊天里默认折叠——
 * 用户不点开就看不到图（「codex 画了图但 DSH 里不显示」）。bridge 侧会在
 * 段结束时消费这份登记，把图片作为 assistant 消息的 image block 内联发出去。
 * 只在内存里记录、失败即忽略，绝不影响卡片本身的执行。
 */
function rememberImageRefs(callId, refs) {
  try {
    if (typeof callId !== 'string' || callId === '' || !Array.isArray(refs) || refs.length === 0) return
    const registry = globalThis[BINDING_KEY]
    if (registry === undefined || registry === null) return
    if (!(registry.toolImageRefs instanceof Map)) registry.toolImageRefs = new Map()
    const kept = refs.filter(ref => ref !== null && typeof ref === 'object' && typeof ref.attachmentId === 'string' && ref.attachmentId !== '')
    if (kept.length === 0) return
    registry.toolImageRefs.set(callId, kept)
    // Bounded: the map is a display side channel, not a durable log.
    while (registry.toolImageRefs.size > 200) {
      const oldest = registry.toolImageRefs.keys().next().value
      if (oldest === undefined) break
      registry.toolImageRefs.delete(oldest)
    }
  } catch { /* 显示增强失败不影响执行 */ }
}

/**
 * The display definition for an ACP-generated image. It shadows the real
 * `read_image` tool for THIS call: the ACP route usually declares no image
 * input, so the real tool would refuse; the card still renders through DSH's
 * own read_image row (variant `read`, keyed tool view) once this body answers
 * with the durable attachment and presentation metadata.
 */
function readImageShadowDefinition(ctx) {
  return {
    name: 'read_image',
    description: 'dsh-ntr: display an image the ACP agent generated (already executed in its own process).',
    parameters: { file_path: { type: 'string', required: true, description: 'Path of the generated image.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { path: { type: 'string' }, image: { type: 'object' } },
      },
      render: (_arguments, value) => imageBlocks(value),
      presentationMeta: (_arguments, value) => ({ path: value?.path }),
    },
    presentCall(args) {
      const path = typeof args?.file_path === 'string' ? args.file_path : ''
      return { card: 'generic', title: `Read image ${path}`, kind: 'read', locations: path === '' ? [] : [{ path }] }
    },
    execute: async (_arguments, exec) => {
      const callId = typeof exec?.callId === 'string' ? exec.callId : ''
      const registry = globalThis[BINDING_KEY]
      const records = registry?.toolImages?.get?.(callId)
      const recordPath = Array.isArray(records) && records.length > 0 && typeof records[0].uri === 'string' ? records[0].uri : ''
      const argPath = typeof _arguments?.file_path === 'string' ? _arguments.file_path : ''
      const path = recordPath !== '' ? recordPath : argPath
      const refs = await savedToolImages(ctx, exec, callId)
      if (refs.length > 0) {
        rememberImageRefs(callId, refs)
        return { path, image: refs[0] }
      }
      // 没有 ACP 图片记录时，直接读卡片参数指向的本地文件（2026-11-05 兜底）
      if (path !== '') {
        const local = await localImageRef(ctx, exec, path)
        if (local !== undefined) {
          rememberImageRefs(callId, [local])
          logImageExec({ kind: 'image-card', callId, name: exec?.name, saved: 1, via: 'local-file', path })
          return { path, image: local }
        }
        logImageExec({ kind: 'image-card', callId, name: exec?.name, saved: 0, via: 'path-only', path })
        return { path }
      }
      throw new Error('dsh-ntr: the generated image is no longer available')
    },
  }
}

/** A tool body's return value: the shared `output.schema` below validates this shape. */
function virtualToolValue(callId) {
  return { text: toolOutputFor(callId) ?? 'This tool call ran inside the ACP agent process; its output lives in the ACP transcript view.' }
}

/** The marker set for definitions this row registered (never shadow a real tool). */
function makeVirtualDefs() {
  return new WeakSet()
}

/** The host attachment service, when this composition mounts one. */
function attachmentsOf(ctx, exec) {
  for (const candidate of [exec?.agent?.ctx, ctx]) {
    if (candidate === null || candidate === undefined) continue
    try {
      const service = typeof candidate.get === 'function' ? candidate.get('attachments') : undefined
      if (service !== undefined && typeof service.saveImages === 'function') return service
    } catch {
      // keep looking; the other context may own the service
    }
  }
  return undefined
}

/** A short display name for one ACP image, preferring its own saved path. */
function imageName(uri) {
  if (typeof uri !== 'string' || uri === '') return undefined
  const parts = uri.split(/[\\/]/)
  const tail = parts[parts.length - 1]
  return tail === '' ? undefined : tail
}

/**
 * Turn the bridge's recorded ACP images into durable DSH attachments, so the
 * display card can render the picture itself instead of a 16K base64 blob.
 * Returns [] (never throws) when no attachment service or no image is present.
 */
/**
 * 2026-11-05 诊断：ACP 会话里的图片卡片执行路径写入固定日志，重启后可直接定位。
 * 只记录关键字段，异常不影响执行。
 */
function logImageExec(payload) {
  try {
    appendFileSync(String(process.env.HOME ?? '.') + '/.dsh/logs/dsh-ntr-guard-debug.log', JSON.stringify({ at: Date.now(), ...payload }) + '\n')
  } catch { /* 仅诊断 */ }
}

/** 图片扩展名 → MIME（本地文件兜底渲染用）。 */
function imageMimeByPath(filePath) {
  const ext = String(filePath).split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'avif') return 'image/avif'
  if (ext === 'png') return 'image/png'
  return undefined
}

/**
 * 2026-11-05 修复说明（顺序是根因，不是细节）：
 * 本步的 toolSet 在 `agent/pre-step` 之前就已 `tools.resolve()` 完毕
 * （dsh-agent-loop/lib/index.js preStep 先 resolve 再跑 waterfall）。若在 resolve
 * 之后再往 agent 作用域注册同名 shadow，dsh-tools resolve() 的 view 过滤器
 * （`current.registrations.get(name) === view.registrations.get(name)`）会让本步
 * toolSet 里**原本已准入的真工具**也解析不到（身份变了）——于是「pre-register ok」
 * 反而把 read_image 卡从本步准入里抹掉，dispatch 阶段变成 UNKNOWN_TOOL。
 * 因此这里不预注册任何东西；显示版定义只在 `tools/execute` 里给本次执行的
 * exec.toolSet 打 view 补丁（见下方 image 分支），随 exec 一起丢弃，无残留。
 */

/**
 * 直接从磁盘读图片文件并保存成 DSH 附件（没有 ACP 图片记录时的兜底）。
 * ACP agent 只把路径交给 harness（如 codex 的 `View Image <path>` / read_image 参数），
 * 记录的图片可能缺失；这里自给自足地读盘渲染，保证卡片能出图。
 */
async function localImageRef(ctx, exec, filePath) {
  try {
    const mimeType = imageMimeByPath(filePath)
    if (mimeType === undefined) return undefined
    const info = statSync(filePath)
    if (!info.isFile() || info.size <= 0 || info.size > 16 * 1024 * 1024) return undefined
    const attachments = attachmentsOf(ctx, exec)
    if (attachments === undefined) return undefined
    const refs = await attachments.saveImages([{
      data: readFileSync(filePath),
      mediaType: mimeType,
      name: String(filePath).split(/[\\/]/).pop() || 'image',
    }])
    return Array.isArray(refs) && refs.length > 0 ? refs[0] : undefined
  } catch (error) {
    logImageExec({ kind: 'local-image-error', filePath, error: String(error?.message ?? error) })
    return undefined
  }
}

async function savedToolImages(ctx, exec, callId) {
  const registry = globalThis[BINDING_KEY]
  const records = registry?.toolImages?.get?.(callId)
  const debug = (payload) => {
    try {
      if (process.env.DSH_NTR_TOOL_DEBUG) appendFileSync(process.env.DSH_NTR_TOOL_DEBUG, JSON.stringify({ at: Date.now(), kind: 'guard-image', ...payload }) + '\n')
    } catch { /* diagnostic only */ }
  }
  if (!Array.isArray(records) || records.length === 0) {
    debug({ callId, records: 0 })
    return []
  }
  const attachments = attachmentsOf(ctx, exec)
  debug({ callId, records: records.length, hasAttachments: attachments !== undefined, hasAgentCtx: exec?.agent?.ctx !== undefined, hasCtxGet: typeof ctx?.get === 'function' })
  if (attachments === undefined) return []
  try {
    const refs = await attachments.saveImages(records.map((record) => ({
      data: Buffer.from(record.data, 'base64'),
      mediaType: record.mimeType,
      ...(imageName(record.uri) === undefined ? {} : { name: imageName(record.uri) }),
    })))
    debug({ callId, saved: Array.isArray(refs) ? refs.length : -1 })
    return Array.isArray(refs) ? refs : []
  } catch (error) {
    debug({ callId, error: String(error?.message ?? error) })
    return []
  }
}

/**
 * One scoped virtual tool per ACP tool name. Returns the registry definition.
 *
 * The body first answers from the shared registry when the output has already
 * landed, and otherwise parks on `registry.waitForToolOutput` — under the
 * segmented turn shape the loop executes a card while the ACP agent may still
 * be running the tool, and the wait is released by the record itself, by the
 * turn's settlement, or by the bounded timeout (in that order).
 */
function virtualToolDefinition(toolName, ctx) {
  return {
    name: toolName,
    description: 'dsh-ntr: display card of a tool the ACP agent already executed in its own process.',
    parameters: { type: 'object', properties: {} },
    output: {
      // `images` carries durable attachment references (ImageAttachmentRef[]);
      // `render` is what the chat card stores and draws.
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          images: { type: 'array', items: { type: 'object' } },
        },
        additionalProperties: true,
      },
      render: (_arguments, value) => {
        const blocks = []
        if (typeof value?.text === 'string' && value.text !== '') blocks.push({ type: 'text', text: value.text })
        for (const attachment of Array.isArray(value?.images) ? value.images : []) {
          blocks.push({ type: 'image', attachment })
        }
        return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
      },
    },
    execute: async (_arguments, exec) => {
      const callId = typeof exec?.callId === 'string' ? exec.callId : ''
      const registry = globalThis[BINDING_KEY]
      let text = toolOutputFor(callId)
      if (text === undefined && typeof registry?.waitForToolOutput === 'function') {
        try {
          const landed = await registry.waitForToolOutput(callId, TOOL_OUTPUT_WAIT_MS)
          if (typeof landed === 'string' && landed !== '') text = landed
        } catch {
          // A waiter failure degrades to the transcript pointer, never to an error.
        }
      }
      const images = await savedToolImages(ctx, exec, callId)
      if (images.length > 0) return { text: text ?? '', images }
      return virtualToolValue(callId)
    },
  }
}

/**
 * How long a virtual tool parks on `waitForToolOutput` before answering with
 * the transcript pointer. Generous on purpose: the ACP agent runs the tool on
 * its own clock, and the turn's settlement releases the wait long before this
 * fires in every healthy case — this bound only caps a wedged agent.
 */
const TOOL_OUTPUT_WAIT_MS = 30 * 60 * 1000

/**
 * Register the step gate, the display-card executor, and the route rewrite for
 * this preset's agent scope.
 * @param ctx - the preset-scoped context the row is mounted under.
 * @param config - optional `strippedSources` override.
 */
export function apply(ctx, config) {
  // 挂载标记（2026-11-05）：写入日志目录，便于重启后确认这一行 guard 实际生效。
  try {
    appendFileSync(String(process.env.HOME ?? '.') + '/.dsh/logs/dsh-ntr-guard.marker',
      JSON.stringify({ at: Date.now(), plugin: name, pickerOnly: config?.pickerOnly === true, pid: process.pid }) + '\n')
  } catch { /* 仅诊断 */ }
  const stripped = strippedSourcesOf(config)
  // PICKER FORK: when mounted as a global row for the dropdown surface, every
  // duty below is limited to sessions the host actually bound to an ACP agent,
  // so ordinary harness sessions are never touched by this gate.
  const pickerOnly = config?.pickerOnly === true
  const virtualDefs = makeVirtualDefs()
  ctx.on('agent/pre-step', async (_payload, next) => {
    // 2026-11-05 修复：不再在 pre-step 里预注册 read_image 显示工具（见函数区注释）。
    // 本行 listener 只负责摘除注入与拒绝空输入步骤；卡片解析交给 tools/execute 的补丁。
    // Downstream failures propagate untouched; only this gate's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (pickerOnly && !isBoundSession(_payload?.agent?.id)) return decision
    try {
      if (!Array.isArray(decision.messages)) return decision
      let kept = decision.messages
      if (stripped.size > 0) {
        const filtered = kept.filter(message => {
          const kind = message?.source?.kind
          return typeof kind !== 'string' || !stripped.has(kind)
        })
        if (filtered.length !== kept.length) kept = filtered
      }
      // The ONE legal no-user step: a continuation of the in-flight ACP turn.
      //
      // 2026-11-05 修复（回复被截断的根因之一）：原判据要求 batch 里**每一条**
      // 消息都是 bridge 已登记的 tool 卡，否则整批 reject。宿主在 continuation
      // step 里夹带 time-context / reminder / action-cards 这类普通消息，或某张
      // 卡的 record 还没落进 brain 的 bounded registry，都会让这一步被拒 → turn
      // 以 `blocked` 结束，而 ACP agent 仍在产出——后续正文只进 ACP transcript，
      // 再也进不了聊天平面（用户看到的「回复结束但内容不全」）。
      //
      // 新判据与适配器自己的 continuation 规则同构（impl.js isAcpToolContinuation）：
      // batch 中存在 tool 消息，且最后一条 tool 之后没有 user/无 source 消息 → 放行。
      // registry 登记不再是否决条件。仍拒绝的是「既没有任何 tool 消息、也没有 user
      // 输入」的纯注入上下文（转发它会重发用户上一句）。空 batch 保持原 enter。
      let lastTool = -1
      for (let i = 0; i < kept.length; i += 1) {
        if (kept[i]?.source?.kind === 'tool') lastTool = i
      }
      const userAfterTool = lastTool >= 0 && kept.slice(lastTool + 1).some(message => {
        const kind = message?.source?.kind
        return kind === undefined || kind === 'user'
      })
      if (lastTool >= 0 && !userAfterTool) return kept === decision.messages ? decision : { ...decision, messages: kept }
      const hasUserInput = kept.some(message => {
        const kind = message?.source?.kind
        return kind === undefined || kind === 'user'
      })
      if (kept.length > 0 && !hasUserInput) return { kind: 'reject' }
      return kept === decision.messages ? decision : { ...decision, messages: kept }
    } catch {
      // A gate bug must never eat context: degrade to keeping every message.
      return decision
    }
  })

  // The display-card executor: answer the loop's execution of an ACP tool card
  // with the call's real output (fourth duty — see the module header).
  ctx.on('tools/execute', async (exec, next) => {
    let dispose
    try {
      if (exec === null || typeof exec !== 'object') return next()
      if (pickerOnly && !isBoundSession(exec.agent?.id)) return next()
      if (typeof exec.name !== 'string' || exec.name === '' || exec.name === 'run_code') return next()
      if (!registryHasToolCall(exec.callId)) return next()
      if (hasToolImage(exec.callId) || exec.name === 'read_image') {
        // The card was re-pointed at `read_image` by the bridge; answer it with
        // the recorded bytes instead of the route-gated real tool.
        //
        // 2026-11-05 修复：本步 toolSet 早在 pre-step 之前 resolve 完毕，所以「临时
        // register 同名定义」在这里永远进不了本步准入；更糟的是 resolve 后的注册会
        // 让本步 view 的身份校验失败，把原本已准入的真 read_image 也变成 unknown tool。
        // 正确做法：不改注册表，只给这一次执行的 exec.toolSet 打 view 补丁，让 dispatch
        // 阶段的解析拿到显示版定义（render 出 image content block）。补丁随 exec 丢弃，
        // 不影响后续步骤、其它会话。
        const definition = readImageShadowDefinition(ctx)
        const stepToolSet = exec.toolSet
        const hasStepToolSet = stepToolSet !== undefined && typeof stepToolSet.view === 'function'
        if (hasStepToolSet) {
          const baseView = stepToolSet.view.bind(stepToolSet)
          const target = exec.agent
          const cardName = typeof exec.name === 'string' && exec.name !== '' ? exec.name : definition.name
          exec.toolSet = {
            ...stepToolSet,
            view(scope) {
              const visible = baseView(scope)
              if (scope !== target || visible === null || typeof visible !== 'object' || typeof visible.set !== 'function') return visible
              const copy = new Map(visible)
              copy.set(cardName, definition)
              return copy
            },
          }
        }
        logImageExec({
          kind: 'execute-image', callId: exec.callId, name: exec.name,
          hasImageRecord: hasToolImage(exec.callId),
          toolSetPatch: hasStepToolSet,
          agentCtx: exec.agent?.ctx !== undefined,
        })
        if (hasStepToolSet) return next()
        // 没有 step toolSet 的调用路径：解析走当前 view，临时注册仍然有效（兜底）。
        const imageCtx = exec.agent?.ctx ?? ctx
        const imageTools = typeof imageCtx?.get === 'function' ? imageCtx.get('tools') : undefined
        if (imageTools !== undefined && typeof imageTools.register === 'function') {
          dispose = imageTools.register(definition)
          virtualDefs.add(definition)
          try {
            return await next()
          } finally {
            dispose?.()
            dispose = undefined
          }
        }
        return next()
      }
      // The global picker listener must never publish ACP titles into the
      // host registry. Titles may contain spaces, paths or colons, which the
      // DeepSeek tool-name contract rejects for every ordinary conversation.
      const agentCtx = exec.agent?.ctx
      const tools = typeof agentCtx?.get === 'function' ? agentCtx.get('tools') : undefined
      if (tools === undefined || typeof tools.get !== 'function' || typeof tools.register !== 'function') return next()
      // The scope-aware lookup mirrors `resolveExecution`: scoped tools shadow
      // globals, and the global view would not see this session's own layer.
      const existing = tools.get(exec.name, exec.agent)
      if (existing !== undefined && !virtualDefs.has(existing)) return next()
      if (existing === undefined) {
        const definition = virtualToolDefinition(exec.name, ctx)
        dispose = tools.register(definition)
        virtualDefs.add(definition)
      }
    } catch {
      // Registration is an upgrade, not a dependency: the old error-result
      // behavior (and the pre-step gate) still bounds the damage.
      return next()
    }
    try {
      return await next()
    } finally {
      // The registry has already canonicalized the body result when next()
      // settles. No later request should advertise this display-only tool,
      // including when the user switches the same conversation to DeepSeek.
      dispose?.()
    }
  })

  // The route rewrite: outermost on purpose — see the module header for why
  // `prepend` is load-bearing (the harness's own selection rewrite registers
  // first, and outermost runs last, so its value is what the driver sees).
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      const sessionId = payload?.agent?.session?.id === undefined
        ? undefined
        : String(payload.agent.session.id)
      // A model-picker choice for an ordinary provider wins over an old ACP
      // binding. Otherwise switching back to DeepSeek silently calls ACP.
      if (pickerOnly) {
        const conversations = globalThis[BINDING_KEY]?.conversations
        if (resolved?.provider === 'acp' && typeof resolved.model === 'string') {
          conversations?.set?.(sessionId, resolved.model)
        } else {
          conversations?.delete?.(sessionId)
        }
        return resolved
      }
      const model = pickerOnly ? boundConversationModel(sessionId) : boundModelFor(sessionId)
      if (model === undefined) return resolved
      if (resolved === undefined || typeof resolved !== 'object') return resolved
      const { reasoningEffort: _inherited, ...rest } = resolved
      return { ...rest, provider: 'acp', model }
    } catch {
      // A rewrite bug must never break a turn: keep the resolved route.
      return resolved
    }
  }, { prepend: true })
}
