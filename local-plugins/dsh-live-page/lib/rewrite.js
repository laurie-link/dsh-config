/**
 * dsh-live-page — selection rewriting for the in-page editor.
 *
 * The overlay turns a (possibly cross-block) text selection plus a short user
 * instruction into one request. This module prompts the model to return a
 * replacement HTML fragment for every selected block, validates the reply and
 * returns structured blocks the overlay can preview before applying.
 *
 * Output is marker-delimited rather than JSON: HTML fragments contain quotes
 * that models routinely fail to escape, while `<dsh-block index="0">` survives
 * that. JSON is still accepted as a fallback.
 */

import { createRouteCache, isRouteFailure, llmOf, routeLabelOf, streamModelText } from './completion.js'

/** One rewrite request may cover this many blocks. */
export const MAX_REWRITE_BLOCKS = 12
/** Instruction length cap (characters). */
export const MAX_INSTRUCTION_CHARS = 2000
/** Full text cap for one block (characters). */
export const MAX_REWRITE_BLOCK_CHARS = 6000
/** Full text cap for all blocks in one request. */
export const MAX_REWRITE_TOTAL_CHARS = 24000
/** Replacement fragment cap for one block. */
export const MAX_REPLACEMENT_CHARS = 8000
/** Hard cap for one rewrite request (model included). */
export const REWRITE_TIMEOUT_MS = 22000
/** Output budget: several paragraphs with inline markup. */
export const REWRITE_MAX_TOKENS = 1600
/** How many routes one rewrite may try before giving up (auth/route failures only). */
export const MAX_ROUTE_ATTEMPTS = 3

/** System prompt: in-place replacement only, one marker per block. */
export const REWRITE_SYSTEM = [
  'You are a precise in-place editor for an existing web page.',
  'The user selected one or more text blocks and described how the selected text should change.',
  'Rewrite ONLY the selected text. Leave every unselected word exactly as it is.',
  'Rules:',
  '- Return a replacement HTML fragment for each requested block. Use inline tags only (a, strong, em, b, i, code, span, br, small, sup, sub, mark, u, s, del, ins).',
  '- Never add block-level wrappers (p, div, h1-h6, li, table...), scripts, styles, images or iframes.',
  '- Keep the language and voice of the selected text unless the instruction explicitly asks for another language.',
  '- Preserve useful inline links from the selected text. Do not invent URLs.',
  '- No markdown, no code fences, no explanations, no surrounding quotes.',
  '- Output EXACTLY one marker per requested block, and nothing else:',
  '  <dsh-block index="0">replacement HTML</dsh-block>',
  '- Every requested index must appear exactly once, in ascending order.',
].join('\n')

const BLOCK_MARKER = /<dsh-block\b[^>]*\b(?:index|i)\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/dsh-block\s*>/gi

const UNSAFE_HTML = /<(?:script|style|iframe|object|embed|link|meta|base|img|picture|video|audio|canvas|svg|math|form|input|button|textarea|select)\b/i
const UNSAFE_ATTR = /\son[a-z]+\s*=|(?:href|src)\s*=\s*["']?\s*javascript:/i
const BLOCK_LEVEL = /<(?:p|div|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|section|article|figure|figcaption|blockquote|pre|main|header|footer)\b/i

function clampString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function cleanTag(value) {
  const tag = String(value || 'p').toLowerCase().replace(/[^a-z0-9]/g, '')
  return tag || 'p'
}

/** Normalize one rewrite request; returns null for unusable input. */
export function normalizeRewriteRequest(input) {
  if (!input || typeof input !== 'object') return null
  const instruction = clampString(input.instruction, MAX_INSTRUCTION_CHARS).trim()
  if (instruction.length < 2) return null

  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : []
  if (rawBlocks.length < 1 || rawBlocks.length > MAX_REWRITE_BLOCKS) return null

  const blocks = []
  let total = 0
  for (const raw of rawBlocks) {
    if (!raw || typeof raw !== 'object') return null
    const text = typeof raw.text === 'string' ? raw.text : ''
    if (text.trim() === '') return null
    if (text.length > MAX_REWRITE_BLOCK_CHARS) return null
    total += text.length
    if (total > MAX_REWRITE_TOTAL_CHARS) return null

    const start = Number(raw.start)
    const end = Number(raw.end)
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null
    if (start < 0 || end > text.length || start >= end) return null

    blocks.push({
      index: blocks.length,
      tag: cleanTag(raw.tag),
      text,
      start,
      end,
    })
  }

  return {
    file: clampString(input.file, 400),
    title: clampString(input.title, 300),
    before: clampString(input.before, 900),
    after: clampString(input.after, 900),
    instruction,
    blocks,
  }
}

/** Build the single user message for one selection rewrite. */
export function buildRewritePrompt(request) {
  const lines = []
  if (request.title) lines.push('Page title: ' + request.title)
  if (request.file) lines.push('Source file: ' + request.file)
  if (request.before.trim() !== '') {
    lines.push('', 'Text immediately before the selection:', request.before.trim())
  }
  if (request.after.trim() !== '') {
    lines.push('', 'Text immediately after the selection:', request.after.trim())
  }

  lines.push('', 'Change requested by the user:', request.instruction)
  lines.push('', 'Selected blocks (replace only the selected character range in each block):')

  for (const block of request.blocks) {
    const selected = block.text.slice(block.start, block.end)
    lines.push(
      '',
      `Block ${block.index} (${block.tag}), selected characters ${block.start}-${block.end}:`,
      'Full block text:',
      block.text,
      'Selected text to rewrite:',
      selected,
      'Text before the selection in this block:',
      block.text.slice(0, block.start),
      'Text after the selection in this block:',
      block.text.slice(block.end),
    )
  }

  lines.push(
    '',
    'Return exactly ' + (request.blocks.length === 1 ? 'one marker' : request.blocks.length + ' markers') +
      ' in this format, with no other text:',
  )
  for (const block of request.blocks) {
    lines.push(`<dsh-block index="${block.index}">replacement HTML</dsh-block>`)
  }
  return lines.join('\n')
}

/** Strip wrappers/labels models add around a fragment. */
function cleanFragmentText(raw) {
  let html = String(raw == null ? '' : raw).trim()
  if (html === '') return ''
  html = html.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  html = html.replace(/^\s*(?:replacement(?:\s+html)?|rewritten(?:\s+text)?|html)\s*[::]\s*/i, '')
  html = html.replace(/[⟦⟧]/g, '')
  return html.trim()
}

/** Remove a single outer block wrapper the model may have added. */
export function unwrapBlockTag(html, tag) {
  if (!html || !tag) return html
  const safeTag = cleanTag(tag)
  if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'figcaption', 'dt', 'dd', 'td', 'th'].includes(safeTag) === false) {
    return html
  }
  const pattern = new RegExp(`^<${safeTag}\\b[^>]*>([\\s\\S]*)<\\/${safeTag}>$`, 'i')
  const match = pattern.exec(html)
  return match ? match[1].trim() : html
}

/** Validate and normalize one replacement fragment. */
export function cleanReplacementHtml(raw, tag = 'p') {
  let html = cleanFragmentText(raw)
  html = unwrapBlockTag(html, tag)
  // Models sometimes put the label inside the wrapper they added.
  html = html.replace(/^\s*(?:replacement(?:\s+html)?|rewritten(?:\s+text)?|html)\s*[::]\s*/i, '')
  html = html.replace(/<\/?dsh-block\b[^>]*>/gi, '').trim()
  if (html === '') return { ok: true, html: '' }
  if (html.length > MAX_REPLACEMENT_CHARS) return { ok: false, note: '模型返回的替换内容过长' }
  if (UNSAFE_HTML.test(html)) return { ok: false, note: '模型返回了不允许的标签' }
  if (UNSAFE_ATTR.test(html)) return { ok: false, note: '模型返回了不允许的属性' }
  if (BLOCK_LEVEL.test(html)) return { ok: false, note: '模型返回了块级标签，无法原位替换' }
  if (/<\/?(?:html|body)\b/i.test(html)) return { ok: false, note: '模型返回了页面容器标记' }
  return { ok: true, html }
}

function collectFromJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  const start = text.indexOf('{')
  const arrayStart = text.indexOf('[')
  const from = start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart)
  if (from === -1) return null
  const close = text.endsWith(']') ? ']' : '}'
  const to = text.lastIndexOf(close)
  if (to <= from) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(from, to + 1))
  } catch {
    return null
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.blocks) ? parsed.blocks : null
  if (!list) return null
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') return null
    const index = Number(entry.index ?? entry.i)
    const html = typeof entry.html === 'string' ? entry.html : typeof entry.text === 'string' ? entry.text : null
    if (!Number.isInteger(index) || html === null) return null
    out.push({ index, html })
  }
  return out
}

/**
 * Parse a model reply into one replacement per requested block.
 * @param {string} raw model output
 * @param {Array<{index:number,tag:string}>} requested
 * @returns {{ok:true, blocks:Array<{index:number,html:string}>}|{ok:false,note:string}}
 */
export function parseRewriteReply(raw, requested) {
  const blocks = Array.isArray(requested) ? requested : []
  if (blocks.length === 0) return { ok: false, note: '没有需要改写的内容' }

  const found = new Map()
  const markerRe = new RegExp(BLOCK_MARKER.source, BLOCK_MARKER.flags)
  let match
  while ((match = markerRe.exec(String(raw || ''))) !== null) {
    const index = Number(match[1])
    if (found.has(index)) return { ok: false, note: '模型重复返回了第 ' + (index + 1) + ' 段' }
    found.set(index, match[2])
  }

  if (found.size === 0) {
    const fromJson = collectFromJson(raw)
    if (fromJson) {
      for (const entry of fromJson) {
        if (found.has(entry.index)) return { ok: false, note: '模型重复返回了第 ' + (entry.index + 1) + ' 段' }
        found.set(entry.index, entry.html)
      }
    } else if (blocks.length === 1) {
      // A single block is unambiguous: accept the reply as the fragment.
      found.set(blocks[0].index, cleanFragmentText(raw))
    } else {
      return { ok: false, note: '模型没有按分段格式返回改写结果' }
    }
  }

  const out = []
  for (const block of blocks) {
    const index = Number(block.index)
    if (!found.has(index)) return { ok: false, note: '模型漏掉了第 ' + (index + 1) + ' 段' }
    const cleaned = cleanReplacementHtml(found.get(index), block.tag)
    if (!cleaned.ok) return { ok: false, note: cleaned.note }
    out.push({ index, html: cleaned.html })
  }
  for (const index of found.keys()) {
    if (!blocks.some((block) => Number(block.index) === index)) {
      return { ok: false, note: '模型返回了不存在的段号' }
    }
  }
  return { ok: true, blocks: out }
}

/**
 * Create the per-plugin rewriter.
 * @param {object} ctx host context
 * @returns {(request: object) => Promise<{blocks:Array<{index:number,html:string}>, note?:string, route?:string, ms:number}>}
 */
export function createRewriter(ctx) {
  const routes = createRouteCache(ctx)

  return async function rewrite(input) {
    const started = Date.now()
    const request = normalizeRewriteRequest(input)
    if (!request) return { blocks: [], note: '请求不完整', ms: 0 }

    const llm = llmOf(ctx)
    if (!llm) return { blocks: [], note: 'llm 服务不可用', ms: Date.now() - started }
    let route = await routes.ensure()
    if (!route) return { blocks: [], note: '没有可用模型', ms: Date.now() - started }

    const prompt = buildRewritePrompt(request)
    const deadline = started + REWRITE_TIMEOUT_MS
    let routeLabel = routeLabelOf(route)
    let note = ''

    // A provider whose credential expired or whose model was retired fails
    // within a second; move on to the next candidate instead of losing the
    // whole request. Content, timeout and parse problems never switch models.
    for (let attempt = 1; attempt <= MAX_ROUTE_ATTEMPTS; attempt += 1) {
      routeLabel = routeLabelOf(route)
      const remaining = deadline - Date.now()
      if (remaining < 1500) {
        note = note || '改写超时'
        break
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), remaining)
      let failure = ''
      try {
        const result = await streamModelText(llm, {
          provider: route.provider,
          model: route.model,
          effort: route.effort,
          prompt,
          system: REWRITE_SYSTEM,
          temperature: 0.35,
          maxTokens: REWRITE_MAX_TOKENS,
          signal: controller.signal,
        })
        if (result.text.trim()) {
          const parsed = parseRewriteReply(result.text, request.blocks)
          if (!parsed.ok) return { blocks: [], note: parsed.note, route: routeLabel, ms: Date.now() - started }
          return { blocks: parsed.blocks, route: routeLabel, ms: Date.now() - started }
        }
        failure = result.note || ''
        note = result.note
          ? '改写失败：' + result.note
          : result.reasoning > 0
            ? '模型只返回了思考，未产出改写结果'
            : '模型没有返回改写结果'
      } catch (error) {
        failure = String(error?.message || error)
        note = '改写失败：' + failure
      } finally {
        clearTimeout(timer)
      }
      if (!isRouteFailure(failure)) break
      const next = await routes.advance()
      if (!next) break
      route = next
    }

    return { blocks: [], note: note || '模型没有返回改写结果', route: routeLabel, ms: Date.now() - started }
  }
}


/** Diagnostics snapshot for the host debug route. */
export function lastRewriteOf(ctx) {
  return ctx?.__dshLivePageLastRewrite ?? null
}
