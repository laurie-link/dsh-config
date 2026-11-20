/**
 * dsh-ui-control — the Host half.
 *
 * The agent can already put content somewhere, but only into a conversation
 * whose sidebar happens to be on screen: every open queued while the user
 * looked elsewhere, and nothing could change the projection itself. This plugin
 * closes that gap: three tools, one small control channel to the Harness
 * window, and an outcome instead of a queue entry.
 *
 * Transport: the window polls `GET ui-control/poll` (the desktop shell serves
 * the page over a custom protocol, where streaming responses are unreliable)
 * and answers `GET ui-control/ack`. Every attached window says which
 * conversation it shows; a command goes to the window showing the calling
 * conversation, and when none does it goes to all of them with `focus` set, so
 * one switches over instead of dropping the command.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const POLL_PATH = '/ui-control/poll'
const ACK_PATH = '/ui-control/ack'
const ACK_TIMEOUT_MS = 8000
const CLIENT_STALE_MS = 45000
const MAX_QUEUE = 8
const MAX_DETAIL = 2200

/**
 * `@deepseek-ai/dsh-tools` is not resolvable from a linked local bundle (Node
 * resolves bare specifiers from this package's real path, outside the profile).
 * `defineTool` is an identity helper for type inference, so keeping the plain
 * definition is equivalent at runtime.
 */
const defineTool = (definition) => definition

/** Compact text renderer for a structured tool value. */
function textRender(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }]
}

/** The Session a tool call belongs to. */
function sessionIdOf(exec) {
  const agent = exec === undefined || exec === null ? undefined : exec.agent
  const session = agent === undefined || agent === null ? undefined : agent.session
  const id = session === undefined || session === null ? undefined : session.id
  if (typeof id !== 'string' || id === '') throw new Error('dsh-ui-control: this tool needs a calling session')
  return id
}

/** One line describing what happened; shared by the three tools. */
function summarize(value) {
  if (value.applied === true) return `${value.action} — done${value.detail === '' ? '' : `: ${value.detail}`}`
  if (value.delivered === false) return `${value.action} — not done: ${value.detail}`
  return `${value.action} — delivered but not confirmed: ${value.detail}`
}

/** Read one query parameter from a request URL. */
function queryOf(req, fallback) {
  return new URL(req.url === undefined ? fallback : req.url, 'http://dsh.internal').searchParams
}

/** Answer one poll or acknowledgement with JSON. */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}


/**
 * Maintenance self-test: with a `.selftest` marker beside this file, the plugin
 * drives its own channel once a window is attached and appends the round trip
 * to `.selftest.log`, then retires the marker. It exists so the channel can be
 * checked without the model tool roster (which a Session fixes at its start).
 */
const SELF_TEST_MARKER = new URL('./.selftest', import.meta.url)
const SELF_TEST_LOG = new URL('./.selftest.log', import.meta.url)

export const inject = ['webServer', 'tools', 'timer']

export function apply(ctx) {
  const connection = ctx.get('connection')
  const fence = (req) => (connection === undefined ? true : connection.requestRejection(req) === undefined)

  /** clientId -> { sessionId, queue, lastSeen }. */
  const windows = new Map()
  /** command id -> settle one dispatch. */
  const waiting = new Map()

  const entryFor = (clientId) => {
    let entry = windows.get(clientId)
    if (entry === undefined) {
      entry = { sessionId: '', queue: [], lastSeen: Date.now() }
      windows.set(clientId, entry)
    }
    entry.lastSeen = Date.now()
    return entry
  }

  const prune = () => {
    const cutoff = Date.now() - CLIENT_STALE_MS
    for (const [id, entry] of windows) if (entry.lastSeen < cutoff) windows.delete(id)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: POLL_PATH,
    handler: (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      const query = queryOf(req, POLL_PATH)
      const clientId = query.get('client') ?? ''
      if (clientId === '') {
        writeJson(res, 400, { error: 'client is required' })
        return
      }
      prune()
      const entry = entryFor(clientId)
      const session = query.get('session')
      if (session !== null) entry.sessionId = session
      const commands = entry.queue
      entry.queue = []
      writeJson(res, 200, { commands })
    },
  }), 'dsh-ui-control: command poll')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACK_PATH,
    handler: (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      const query = queryOf(req, ACK_PATH)
      const id = query.get('id') ?? ''
      const settle = waiting.get(id)
      if (settle !== undefined) {
        waiting.delete(id)
        settle({
          delivered: true,
          applied: query.get('ok') === '1',
          detail: (query.get('detail') ?? '').slice(0, MAX_DETAIL),
        })
      }
      writeJson(res, 200, { ok: true })
    },
  }), 'dsh-ui-control: acknowledgement')

  /** Where a command should go: the window showing `sessionId`, else all of them. */
  function targetsFor(sessionId) {
    const exact = []
    for (const entry of windows.values()) if (entry.sessionId === sessionId) exact.push(entry)
    if (exact.length > 0) return { targets: exact, focused: false }
    const all = [...windows.values()]
    return { targets: all, focused: all.length > 0 }
  }

  /** Push one command and wait for the first window to answer it. */
  function dispatch(sessionId, action, params, signal) {
    prune()
    const { targets, focused } = targetsFor(sessionId)
    if (targets.length === 0) {
      return Promise.resolve({
        delivered: false,
        applied: false,
        detail: 'no Harness window is attached yet — keep the window open and try again',
      })
    }
    const id = randomUUID()
    const command = {
      id,
      sessionId,
      action,
      params: focused === true ? { ...params, focus: true } : params,
    }
    for (const entry of targets) {
      entry.queue.push(command)
      if (entry.queue.length > MAX_QUEUE) entry.queue.splice(0, entry.queue.length - MAX_QUEUE)
    }
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer)
        waiting.delete(id)
        resolve(value)
      }
      const timer = setTimeout(() => {
        finish({ delivered: true, applied: false, detail: 'the window did not answer in time' })
      }, ACK_TIMEOUT_MS)
      waiting.set(id, finish)
      if (signal !== undefined && signal !== null) {
        signal.addEventListener('abort', () => {
          finish({ delivered: true, applied: false, detail: 'cancelled' })
        }, { once: true })
      }
    })
  }

  /** Shared result shape for all three tools. */
  const output = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'delivered', 'applied', 'detail'],
      properties: {
        action: { type: 'string', description: 'The operation that was asked for.' },
        delivered: { type: 'boolean', description: 'Whether a Harness window received the command.' },
        applied: { type: 'boolean', description: 'Whether the interface confirmed it did the operation.' },
        detail: { type: 'string', description: 'What the interface reported, or why nothing happened.' },
      },
    },
    render: textRender(summarize),
  }

  ctx.tools.register(defineTool({
    name: 'ui_view',
    description: 'Switch the Harness main area between the IDE projection (workbench in the middle, conversation on the right) and the Agent view (conversation centred, workbench hidden). Use the IDE view when the person should look at a file, a page or a terminal; the Agent view when they should read the conversation. The choice is remembered per conversation, and the result says whether the window really switched.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['view'],
      properties: {
        view: { type: 'string', enum: ['cursor', 'agent'], description: 'Which projection to show: "cursor" (IDE) or "agent".' },
      },
    },
    output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const view = args.view === 'agent' ? 'agent' : args.view === 'cursor' ? 'cursor' : ''
      if (view === '') throw new Error('view must be "cursor" or "agent"')
      const result = await dispatch(sessionIdOf(exec), 'view', { view }, exec.signal)
      return { action: `switch to the ${view === 'cursor' ? 'IDE' : 'Agent'} view`, ...result }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ui_sidebar',
    description: 'Show, hide or toggle the right sidebar of the Harness window — the column that holds the browser, the file editor, the terminal and the review tabs. Showing it is what makes an opened page visible in the IDE projection.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['open', 'close', 'toggle'], description: 'What to do with the right sidebar: "open", "close" or "toggle".' },
      },
    },
    output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const action = args.action === 'open' || args.action === 'close' || args.action === 'toggle' ? args.action : ''
      if (action === '') throw new Error('action must be "open", "close" or "toggle"')
      const result = await dispatch(sessionIdOf(exec), 'sidebar', { action }, exec.signal)
      return { action: `${action} the right sidebar`, ...result }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ui_tab',
    description: 'Work with the workbench tabs (the IDE view column) and with the sidebar tab kinds. action="list" returns the tab kinds this window can open; "open" activates one (browser, files, editor, git, diff, terminal, session-review, …); "show" lists the tabs that are currently open with their ids and active mark; "switch" activates one of those open tabs by id, 1-based index, or part of its title; "close" closes one of them (the active tab when no target is given). Every action switches to the IDE projection and expands the sidebar first, so the result is visible.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', description: 'list | open | show | switch | close' },
        kind: { type: 'string', description: 'For action=open: the tab kind to activate, exactly as action=list reports it.' },
        tab: { type: 'string', description: 'For action=switch or action=close: an open tab id, its 1-based index from action=show, part of its title, or "active".' },
        url: { type: 'string', description: 'For action=open with kind=browser: the page to show in that tab.' },
        focus: { type: 'boolean', description: 'Switch the Harness window to this conversation first (default true).' },
      },
    },
    output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const action = typeof args.action === 'string' ? args.action.trim() : ''
      if (action === '') throw new Error('action is required: list | open | show | switch | close')
      if (action === 'list' || action === 'show') {
        const result = await dispatch(sessionIdOf(exec), 'tab', { action }, exec.signal)
        const what = action === 'list' ? 'list the sidebar tab kinds' : 'list the open workbench tabs'
        return { action: what, ...result }
      }
      if (action === 'switch' || action === 'close') {
        const tab = typeof args.tab === 'string' ? args.tab.trim() : ''
        const params = { action, tab, focus: args.focus !== false }
        const result = await dispatch(sessionIdOf(exec), 'tab', params, exec.signal)
        const target = tab === '' ? 'the active tab' : `"${tab}"`
        return { action: `${action} ${target}`, ...result }
      }
      const kind = typeof args.kind === 'string' ? args.kind.trim() : ''
      if (kind === '') throw new Error('kind is required for action=open')
      const params = { action: 'open', kind, focus: args.focus !== false }
      if (typeof args.url === 'string' && args.url.trim() !== '') params.url = args.url.trim()
      const result = await dispatch(sessionIdOf(exec), 'tab', params, exec.signal)
      return { action: `open the "${kind}" sidebar tab`, ...result }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ui_session',
    description: 'Move the Harness window between conversations: "open" brings a given session id on screen (so a later ui_open, ui_view or ui_tab lands there), and "list" returns the conversations this window can see as id » title pairs. Use it when the work belongs to a conversation other than the one on screen, or when the person asks to be taken somewhere.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'open'], description: 'What to do: list the conversations this window knows, or open one.' },
        session: { type: 'string', description: 'For action=open: the session id to bring on screen.' },
      },
    },
    output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      if (args.action === 'list') {
        const result = await dispatch(sessionIdOf(exec), 'session', { action: 'list' }, exec.signal)
        return { action: 'list the conversations this window knows', ...result }
      }
      const session = typeof args.session === 'string' ? args.session.trim() : ''
      if (session === '') throw new Error('session is required for action=open')
      const result = await dispatch(sessionIdOf(exec), 'session', { action: 'open', session }, exec.signal)
      return { action: `show conversation ${session}`, ...result }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ui_open',
    description: 'Open an http(s) URL in the right sidebar browser, or a local file in the right sidebar editor, and make sure the person can see it: the plugin switches to the IDE projection, expands the sidebar, opens the tab, and reports whether the window confirmed it. Unlike a queued open this reaches the Harness window even while another conversation is on screen — it switches to this one first unless focus is false.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'An http:// or https:// URL for the sidebar browser, such as a local editor at http://127.0.0.1:4720/….' },
        path: { type: 'string', description: 'A local file path (absolute, or relative to the session working directory) for the sidebar editor; use instead of url.' },
        title: { type: 'string', description: 'Optional tab title; defaults to the page title or the file name.' },
        focus: { type: 'boolean', description: 'Switch the Harness window to this conversation before opening (default true). Pass false to open only when this conversation is already on screen.' },
        view: { type: 'string', enum: ['cursor', 'agent', 'current'], description: 'Projection to use: "cursor" (default), "agent", or "current" to leave it unchanged.' },
      },
    },
    output,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      const path = typeof args.path === 'string' ? args.path.trim() : ''
      if (url === '' && path === '') throw new Error('give either url or path')
      if (url !== '' && path !== '') throw new Error('give only one of url or path')
      if (url !== '' && !/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
      const view = args.view === 'agent' ? 'agent' : args.view === 'current' ? 'current' : 'cursor'
      const params = {
        focus: args.focus !== false,
        view,
        title: typeof args.title === 'string' ? args.title : '',
      }
      if (url !== '') params.url = url
      else params.path = path
      const result = await dispatch(sessionIdOf(exec), 'open', params, exec.signal)
      return { action: `open ${url === '' ? path : url} in the sidebar`, ...result }
    },
  }))

  // Self-test watcher: dropping the marker file triggers one run, so the
  // channel can be exercised without reloading the plugin (which would need a
  // full DSH restart for a linked package).
  let selfTestRunning = false
  ctx.effect(() => ctx.interval(() => {
    if (selfTestRunning || !existsSync(SELF_TEST_MARKER)) return
    selfTestRunning = true
    void (async () => {
      const lines = []
      const log = (line) => {
        lines.push(`${new Date().toISOString()} ${line}`)
        try {
          writeFileSync(SELF_TEST_LOG, `${lines.join('\n')}\n`)
        } catch {
          /* the log is diagnostics only */
        }
      }
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      try {
        log('self-test: start')
        const deadline = Date.now() + 30000
        while (windows.size === 0 && Date.now() < deadline) await wait(300)
        log(`self-test: attached windows = ${windows.size}`)
        if (windows.size === 0) {
          log('self-test: FAIL no Harness window polls the control channel (refresh the window so the client half loads)')
          return
        }
        const first = [...windows.values()][0]
        const sessionId = first.sessionId
        log(`self-test: first window shows session "${sessionId}"`)
        const marker = readFileSync(SELF_TEST_MARKER, 'utf8')
        const sessionMatch = /(?:^|\n)session=(\S+)/.exec(marker)
        const targetSession = sessionMatch === null ? sessionId : sessionMatch[1]
        const wantFocus = /(?:^|\n)focus=1/.test(marker)
        const steps = [
          ['describe', 'describe', {}],
          ['tabs probe', 'tabsprobe', {}],
          ['tab list', 'tab', { action: 'list' }],
          ['session list', 'session', { action: 'list' }],
        ]
        for (const [label, action, params] of steps) {
          const result = await dispatch(targetSession, action, params, undefined)
          log(`self-test: ${label} -> ${JSON.stringify(result)}`)
        }
        const kindMatch = /(?:^|\n)opentab=(\S+)/.exec(marker)
        if (kindMatch !== null) {
          const opened = await dispatch(targetSession, 'tab', { action: 'open', kind: kindMatch[1], focus: wantFocus }, undefined)
          log(`self-test: tab open "${kindMatch[1]}" -> ${JSON.stringify(opened)}`)
        }
        const switchMatch = /(?:^|\n)switchtab=(\S+)/.exec(marker)
        if (switchMatch !== null) {
          const switched = await dispatch(targetSession, 'tab', { action: 'switch', tab: switchMatch[1] }, undefined)
          log(`self-test: tab switch "${switchMatch[1]}" -> ${JSON.stringify(switched)}`)
        }
        const closeMatch = /(?:^|\n)closetab=(\S+)/.exec(marker)
        if (closeMatch !== null) {
          const closed = await dispatch(targetSession, 'tab', { action: 'close', tab: closeMatch[1] }, undefined)
          log(`self-test: tab close "${closeMatch[1]}" -> ${JSON.stringify(closed)}`)
        }
        const openMatch = /(?:^|\n)open=(\S+)/.exec(marker)
        if (openMatch !== null) {
          const opened = await dispatch(targetSession, 'open', {
            url: openMatch[1],
            view: 'cursor',
            title: 'self-test',
            focus: wantFocus,
          }, undefined)
          log(`self-test: open ${openMatch[1]} -> ${JSON.stringify(opened)}`)
        }
        log('self-test: done')
      } finally {
        try {
          renameSync(SELF_TEST_MARKER, new URL('./.selftest.done', import.meta.url))
        } catch {
          /* another run may have retired it already */
        }
        selfTestRunning = false
      }
    })()
  }, 1500), 'dsh-ui-control: self test watcher')
}
