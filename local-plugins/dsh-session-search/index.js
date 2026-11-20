/**
 * dsh-session-search — Host half.
 *
 * Content backend for the Cursor-style conversation search UI in `client.js`.
 *
 * Why this half exists: the shipped sidebar search asks the Host
 * `sessions.search` Remote, which runs FTS5 with the `unicode61` tokenizer.
 * That tokenizer treats a whole run of CJK characters as one token, so a
 * Chinese substring query ("浮点数") never matches a message that contains it
 * inside a longer run — which is why the shipped search looks title-only for
 * Chinese users. This half instead builds its own in-memory index of every
 * logical session's user/assistant message text through the public
 * `ctx.sessionQuery` service (exact reads work even when FTS is configured
 * `openAt: never`), then answers case-insensitive *literal substring* queries
 * over that text: CJK substrings match, English terms match inside words, and
 * multi-term queries require every term somewhere in the session.
 *
 * The index is derived state only: it lives in this fiber's memory, is built
 * lazily on the first request (a `GET /dsh-session-search/status` kicks it off
 * so the palette can show progress), and is dropped when the plugin unloads.
 * Persisted sessions are read once per process; live sessions are kept current
 * by appending every new user/assistant message from the `session/event`
 * feed, so the running conversation is searchable without re-reading logs on
 * each keystroke.
 */

/** Route that answers one literal-substring query. */
const ROUTE_SEARCH = '/dsh-session-search/search'
/** Route that reports index progress and can start the build. */
const ROUTE_STATUS = '/dsh-session-search/status'

/** Longest accepted query text (code units). */
const MAX_QUERY_CHARS = 200
/** Largest accepted result count. */
const MAX_LIMIT = 100
/** Largest request body this route accepts. */
const MAX_BODY_BYTES = 16 * 1024
/** Per-message text kept in the index; longer messages are truncated. */
const MAX_CHUNK_CHARS = 20000
/** Snippet budget around the first match. */
const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 180
/** Event types whose text is worth searching. */
const MESSAGE_TYPES = ['user/message', 'assistant/message']
/** Yield to the event loop every N indexed sessions so the Host stays responsive. */
const YIELD_EVERY = 6

/** Read a request body as UTF-8 text with a hard size cap. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Write one JSON response unless the peer already went away. */
function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** Normalize one message body: drop control noise and collapse whitespace. */
function normalizeText(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  let text = raw.replace(/\u0000/g, ' ')
  text = text.replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > MAX_CHUNK_CHARS) text = text.slice(0, MAX_CHUNK_CHARS)
  return text.length < 2 ? '' : text
}

/** Extract the searchable text of one user/assistant message event. */
function messageTextOf(event) {
  if (event === null || typeof event !== 'object') return ''
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return ''
  const data = event.data
  if (data === null || typeof data !== 'object') return ''
  const message = event.type === 'user/message' ? data.message ?? data : data.message
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  let text = ''
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    text += (text === '' ? '' : ' ') + block.text
  }
  return normalizeText(text)
}

/** Split caller text into lowercase terms; duplicates and blanks removed. */
function splitTerms(query) {
  const seen = new Set()
  const terms = []
  for (const piece of String(query ?? '').toLowerCase().split(/\s+/)) {
    const term = piece.trim()
    if (term === '' || seen.has(term)) continue
    seen.add(term)
    terms.push(term)
    if (terms.length >= 6) break
  }
  return terms
}

/** Build one snippet window around the first matched term. */
function snippetOf(text, lower, terms, fallbackIndex) {
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) at = typeof fallbackIndex === 'number' && fallbackIndex >= 0 ? fallbackIndex : 0
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(text.length, at + SNIPPET_AFTER)
  const body = text.slice(start, end).trim()
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '')
}

export const inject = ['webServer']

export function apply(ctx) {
  const state = {
    phase: 'idle',
    error: null,
    indexed: 0,
    total: 0,
    docs: 0,
    buildStartedAt: 0,
    buildFinishedAt: 0,
    skipped: 0,
    /** sessionId -> { id, chunks, blob } */
    index: new Map(),
  }
  let buildPromise = null
  let disposed = false

  /** Session query service when this deployment mounts one. */
  function queryService() {
    return ctx.get('sessionQuery')
  }

  /** Index one logical session; cheap for live sessions, one read for persisted ones. */
  async function indexSession(service, sessionId, known) {
    if (disposed) return
    const docs = await service.filterEvents(sessionId, [{ kind: 'type', values: MESSAGE_TYPES }])
    const chunks = []
    const seen = new Set()
    let lastSeq = -1
    let lastTime = 0
    let blob = ''
    for (const doc of docs) {
      const text = normalizeText(doc.text)
      if (text === '') continue
      if (seen.has(text)) continue
      seen.add(text)
      const seq = Number(doc.seq) || 0
      const time = Number(doc.time) || 0
      if (seq > lastSeq) lastSeq = seq
      if (time > lastTime) lastTime = time
      const lower = text.toLowerCase()
      chunks.push({ text, lower, seq, time })
      blob += lower + '\n'
    }
    if (chunks.length === 0) {
      state.index.delete(sessionId)
      return
    }
    state.index.set(sessionId, {
      id: sessionId,
      chunks,
      blob,
      live: known === true,
      lastSeq,
      lastTime,
      updatedAt: lastTime,
    })
  }

  /** Build the whole index once; concurrent callers share one promise. */
  function ensureIndex() {
    if (state.phase === 'ready' || state.phase === 'unavailable') return Promise.resolve()
    if (buildPromise !== null) return buildPromise
    buildPromise = (async () => {
      const service = queryService()
      if (service === undefined || typeof service.listSessions !== 'function') {
        state.phase = 'unavailable'
        state.error = 'this deployment does not mount ctx.sessionQuery'
        return
      }
      state.phase = 'building'
      state.buildStartedAt = Date.now()
      try {
        const records = await service.listSessions()
        state.total = records.length
        let handled = 0
        for (const record of records) {
          if (disposed) return
          const header = record === null || typeof record !== 'object' ? undefined : record.header
          if (header === undefined || typeof header.id !== 'string') continue
          if (header.origin === 'subagent') continue
          try {
            await indexSession(service, header.id, record.live === true)
          } catch (error) {
            state.skipped += 1
            if (state.error === null) state.error = `skip ${header.id}: ${String(error && error.message ? error.message : error)}`
          }
          handled += 1
          state.indexed = handled
          if (handled % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve))
        }
        if (disposed) return
        state.phase = 'ready'
        state.buildFinishedAt = Date.now()
      } catch (error) {
        state.phase = 'error'
        state.error = String(error && error.message ? error.message : error)
        state.buildFinishedAt = Date.now()
      }
    })().finally(() => {
      buildPromise = null
    })
    return buildPromise
  }

  /** Append one live message to the in-memory index without re-reading the log. */
  function appendLiveEvent(session, event) {
    const sessionId = session !== null && typeof session === 'object' && session.id !== undefined ? String(session.id) : ''
    if (sessionId === '') return
    if (session !== null && typeof session === 'object') {
      const header = session.header
      if (header !== undefined && header !== null && header.origin === 'subagent') return
    }
    const text = messageTextOf(event)
    if (text === '') return
    let entry = state.index.get(sessionId)
    if (entry === undefined) {
      entry = { id: sessionId, chunks: [], blob: '', live: true, lastSeq: -1, lastTime: 0, updatedAt: 0 }
      state.index.set(sessionId, entry)
    }
    const seq = Number(event.seq) || 0
    const time = Number(event.time) || 0
    const lower = text.toLowerCase()
    entry.chunks.push({ text, lower, seq, time })
    entry.blob += lower + '\n'
    entry.live = true
    if (seq > entry.lastSeq) entry.lastSeq = seq
    if (time > entry.lastTime) entry.lastTime = time
    entry.updatedAt = time
  }

  /** Literal substring search over the prepared index. */
  function searchIndex(query, limit) {
    const terms = splitTerms(query)
    if (terms.length === 0) return []
    const hits = []
    for (const entry of state.index.values()) {
      let present = true
      for (const term of terms) {
        if (!entry.blob.includes(term)) {
          present = false
          break
        }
      }
      if (!present) continue
      let best = null
      for (const chunk of entry.chunks) {
        let matched = 0
        let earliest = -1
        for (const term of terms) {
          const at = chunk.lower.indexOf(term)
          if (at < 0) continue
          matched += 1
          if (earliest < 0 || at < earliest) earliest = at
        }
        if (matched === 0) continue
        const score = matched * 1000 + (terms.length === matched ? 500 : 0) - (earliest < 0 ? 0 : earliest / 1e6)
        if (best === null || score > best.score) best = { score, matched, chunk, earliest }
        if (matched === terms.length) break
      }
      if (best === null) continue
      hits.push({
        sessionId: entry.id,
        snippet: snippetOf(best.chunk.text, best.chunk.lower, terms, best.earliest),
        matchedTerms: best.matched,
        termCount: terms.length,
        time: best.chunk.time,
        seq: best.chunk.seq,
      })
    }
    hits.sort((a, b) => {
      if (a.matchedTerms !== b.matchedTerms) return b.matchedTerms - a.matchedTerms
      if (a.time !== b.time) return b.time - a.time
      return a.sessionId < b.sessionId ? 1 : -1
    })
    return hits.slice(0, limit)
  }

  /** One status snapshot for the palette's progress line. */
  function statusSnapshot() {
    return {
      phase: state.phase,
      error: state.error,
      indexed: state.indexed,
      total: state.total,
      docs: state.docs,
      indexedSessions: state.index.size,
      skipped: state.skipped,
      buildMs: state.buildFinishedAt > 0 ? state.buildFinishedAt - state.buildStartedAt : 0,
    }
  }

  const statusHandler = async (_req, res) => {
    try {
      void ensureIndex()
      sendJson(res, 200, statusSnapshot())
    } catch (error) {
      sendJson(res, 500, { phase: 'error', error: String(error && error.message ? error.message : error) })
    }
  }

  const searchHandler = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req, MAX_BODY_BYTES))
      } catch (error) {
        sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
        return
      }
      const query = typeof payload.query === 'string' ? payload.query.slice(0, MAX_QUERY_CHARS) : ''
      const limit = Math.max(1, Math.min(MAX_LIMIT, Number(payload.limit) || 40))
      const startedAt = Date.now()
      await ensureIndex()
      const indexReadyAt = Date.now()
      if (disposed) {
        sendJson(res, 503, { error: 'plugin unloaded' })
        return
      }
      const items = state.phase === 'ready' ? searchIndex(query, limit) : []
      const searchDoneAt = Date.now()
      state.docs = 0
      for (const entry of state.index.values()) state.docs += entry.chunks.length
      sendJson(res, 200, {
        query,
        items,
        tookMs: searchDoneAt - startedAt,
        buildMs: indexReadyAt - startedAt,
        searchMs: searchDoneAt - indexReadyAt,
        ...statusSnapshot(),
      })
    } catch (error) {
      sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_SEARCH, handler: searchHandler }),
    'session-search: search route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_STATUS, handler: statusHandler }),
    'session-search: status route',
  )
  // Live feed: every committed user/assistant message is appended to the
  // in-memory index, so the running conversation needs no log re-read.
  ctx.effect(
    () => ctx.on('session/event', (session, event) => {
      try {
        appendLiveEvent(session, event)
      } catch {
        /* the feed must never disturb the agent loop */
      }
    }),
    'session-search: live event feed',
  )
  // A Session created after the build (new conversation, fork) is indexed once
  // when it appears; live appends keep it current afterwards.
  ctx.effect(
    () => ctx.on('session/created', (session) => {
      try {
        if (disposed || state.phase !== 'ready') return
        const header = session === null || typeof session !== 'object' ? undefined : session.header
        if (header === undefined || header === null || typeof header.id !== 'string') return
        if (header.origin === 'subagent') return
        if (state.index.has(header.id)) return
        const service = queryService()
        if (service === undefined) return
        indexSession(service, header.id, true).catch(() => { state.skipped += 1 })
      } catch {
        /* indexing a new session is best effort */
      }
    }),
    'session-search: new session index',
  )
  ctx.effect(() => () => {
    disposed = true
    state.index.clear()
    state.phase = 'unavailable'
  }, 'session-search: dispose')
}
