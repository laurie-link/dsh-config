/**
 * dsh-live-page — client half tests.
 *
 * Dependency-free `node:test` suite. The plugin is loaded into a `node:vm`
 * sandbox with a fake `window` / `document` / `__ModuleLoader__` / React so the
 * pure helpers and the registration + quote-decision paths run without a real
 * DOM. No network, no timers fired by the test runner (the plugin's timers are
 * fake and fired deliberately).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

// Selectors mirrored from client.js (the plugin keeps them as private constants).
const SEL = {
  sidebarSession: '[data-sidebar-right-session]',
  cursorMode: '[data-cursor-mode]',
  editorActiveTab: '.edrv-tab-active[data-edrv-tab-path]',
  editorSelectedTab: '[role="tab"][aria-selected="true"][data-edrv-tab-path]',
  activePane: '[data-dockkit-pane-active], [data-dockkit-float-active]',
  pane: '[data-dockkit-pane], [data-dockkit-float]',
  webview: 'webview[data-sidebar-browser-frame="webview"]',
  dockTab: '[role="tab"][data-dockkit-tab]',
}

const ZH_TOOLTIP = '\u9875\u9762\u7f16\u8f91\uff1a\u5728 IDE \u6d4f\u89c8\u5668\u4e2d\u6253\u5f00\u5f53\u524d HTML'
const ZH_AGENT_VIEW = '\u5207\u6362\u5230 IDE \u89c6\u56fe\u540e\u4f7f\u7528'
const ZH_NO_SESSION = '\u65e0\u6cd5\u786e\u5b9a\u5f53\u524d\u4f1a\u8bdd\uff0c\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u5bf9\u8bdd'
const ZH_NO_BROWSER = 'IDE \u6d4f\u89c8\u5668\u4e0d\u53ef\u7528\uff0c\u8bf7\u5148\u5728\u8bbe\u7f6e\u4e2d\u542f\u7528 Browser \u9762\u677f'

const OPEN_RESPONSE = {
  ok: true,
  url: 'http://127.0.0.1:4321/pages/a.html?__live=tok123',
  file: 'pages/a.html',
  title: 'a.html',
  port: 4321,
  nonce: 'n-open',
}

// ----------------------------------------------------------- fake DOM/window --

function makeElement(tag, attributes) {
  const attrs = Object.assign({}, attributes || {})
  const element = {
    tagName: String(tag || 'div').toUpperCase(),
    textContent: '',
    value: '',
    parentNode: null,
    children: [],
    offsetParent: {},
    isConnected: true,
    setAttribute(name, value) {
      attrs[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name)
    },
    removeAttribute(name) {
      delete attrs[name]
    },
    appendChild(child) {
      element.children.push(child)
      child.parentNode = element
      return child
    },
    removeChild(child) {
      const index = element.children.indexOf(child)
      if (index !== -1) element.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    addEventListener() {},
    removeEventListener() {},
  }
  element._attrs = attrs
  return element
}

function createDocument() {
  const queries = new Map()
  const listeners = new Map()
  const head = makeElement('head')
  const body = makeElement('body')
  const document = {
    baseURI: 'http://127.0.0.1:50508/',
    hidden: false,
    visibilityState: 'visible',
    head,
    body,
    documentElement: makeElement('html'),
    createElement(tag) {
      return makeElement(tag)
    },
    querySelector(selector) {
      const value = queries.get(selector)
      const result = typeof value === 'function' ? value() : value
      if (Array.isArray(result)) return result.length > 0 ? result[0] : null
      return result || null
    },
    querySelectorAll(selector) {
      const value = queries.get(selector)
      const result = typeof value === 'function' ? value() : value
      return result || []
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) || []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = (listeners.get(type) || []).filter((item) => item !== listener)
      listeners.set(type, list)
    },
    _queries: queries,
    _listeners: listeners,
    setQuery(selector, value) {
      queries.set(selector, value)
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event)
    },
  }
  return document
}

function createWindow() {
  let nextId = 0
  const listeners = new Map()
  const timeouts = new Map()
  const intervals = new Map()
  const window = {
    __ModuleLoader__: {
      load(config) {
        window.__loaded = config
      },
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) || []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = (listeners.get(type) || []).filter((item) => item !== listener)
      listeners.set(type, list)
    },
    setTimeout(fn, ms) {
      nextId += 1
      timeouts.set(nextId, { id: nextId, fn: fn, ms: ms, cleared: false })
      return nextId
    },
    clearTimeout(id) {
      const entry = timeouts.get(id)
      if (entry) entry.cleared = true
    },
    setInterval(fn, ms) {
      nextId += 1
      intervals.set(nextId, { id: nextId, fn: fn, ms: ms, cleared: false })
      return nextId
    },
    clearInterval(id) {
      const entry = intervals.get(id)
      if (entry) entry.cleared = true
    },
    _listeners: listeners,
    _timeouts: timeouts,
    _intervals: intervals,
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event)
    },
  }
  return window
}

// ------------------------------------------------------------------- fakes --

function createReact() {
  const react = {
    _effects: [],
    _cleanups: [],
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type: type, props: props || {}, children: children }
    },
    useEffect(setup) {
      react._effects.push(setup)
      const cleanup = setup()
      if (typeof cleanup === 'function') react._cleanups.push(cleanup)
    },
    useRef(initial) {
      return { current: initial }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    Fragment: 'Fragment',
  }
  return react
}

function createSlotsService() {
  const injections = []
  const registrations = []
  return {
    _injections: injections,
    _registrations: registrations,
    inject(name, register) {
      injections.push(name)
      const dispose = typeof register === 'function' ? register() : undefined
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(spec, component) {
      registrations.push({ spec: spec, component: component })
      return () => {}
    },
  }
}

function createCtx(services) {
  const effects = []
  const injections = []
  const ctx = {
    _effects: effects,
    _injections: injections,
    get(name) {
      return services[name]
    },
    effect(setup, label) {
      const dispose = typeof setup === 'function' ? setup() : undefined
      const record = { label: label || '', dispose: typeof dispose === 'function' ? dispose : () => {} }
      effects.push(record)
      return record.dispose
    },
    inject(deps, callback) {
      injections.push(deps)
      const scope = {
        get(name) {
          return services[name]
        },
        effect(setup) {
          const dispose = typeof setup === 'function' ? setup() : undefined
          return typeof dispose === 'function' ? dispose : () => {}
        },
      }
      // Cordis exposes every service as a ctx property as well as via ctx.get().
      for (const name of Object.keys(services)) scope[name] = services[name]
      callback(scope)
      return () => {}
    },
    logger: { warn() {} },
  }
  // Cordis exposes every service as a ctx property as well as via ctx.get().
  for (const name of Object.keys(services)) {
    if (ctx[name] === undefined) ctx[name] = services[name]
  }
  return ctx
}

function routeFetch(table) {
  return async function fetchImpl(url, init) {
    const text = String(url)
    for (const key of Object.keys(table)) {
      if (text.indexOf(key) !== -1) {
        const value = typeof table[key] === 'function' ? table[key](text, init) : table[key]
        return { ok: true, status: 200, json: async () => value }
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'no fake route for ' + text }),
    }
  }
}

// -------------------------------------------------------------------- boot --

function boot(options) {
  const opts = options || {}
  const react = createReact()
  const window = createWindow()
  const document = opts.document || createDocument()
  const slots = opts.slots || createSlotsService()
  const services = Object.assign({ slots: slots }, opts.services || {})
  const calls = []
  const fetchImpl = opts.fetch || routeFetch({})
  const sandbox = {
    window: window,
    document: document,
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init || null })
      return fetchImpl(String(url), init || {})
    },
    URL: URL,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    console: { log() {}, warn() {}, error() {} },
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(SOURCE, context, { filename: CLIENT_PATH })
  assert.ok(window.__loaded, 'client.js must call window.__ModuleLoader__.load')
  const config = window.__loaded
  const api = config.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  const ctx = createCtx(services)
  api.apply(ctx)
  return {
    api: api,
    config: config,
    ctx: ctx,
    window: window,
    document: document,
    react: react,
    calls: calls,
    services: services,
    slots: slots,
  }
}

// --------------------------------------------------------------- utilities --

function sessionElement(sessionId) {
  return makeElement('div', { 'data-sidebar-right-session': sessionId })
}

function openPayloads(calls, routeKey) {
  return calls
    .filter((call) => call.url.indexOf(routeKey) !== -1)
    .map((call) => ({ url: call.url, body: call.init && call.init.body ? JSON.parse(call.init.body) : null }))
}

function findRegisteredComponent(booted) {
  const registrations = booted.slots._registrations
  assert.ok(registrations.length > 0, 'expected at least one slot registration')
  return registrations[0]
}

function createInputActions() {
  const calls = []
  return {
    calls: calls,
    insertQuote(text) {
      calls.push({ method: 'insertQuote', text: text })
      return true
    },
    insertText(text, span) {
      calls.push({ method: 'insertText', text: text, span: span })
      return true
    },
    setDraft() {},
  }
}

function createFacade(options) {
  const opts = options || {}
  const notices = []
  const facade = {
    notices: notices,
    state: {
      getSnapshot() {
        return { draft: opts.draft || '', draftRev: 3, occurrences: [] }
      },
    },
    caretSpan() {
      return { start: (opts.draft || '').length, end: (opts.draft || '').length }
    },
    insertQuote(text) {
      if (opts.rejectQuotes) return false
      notices.push({ level: 'insertQuote', text: text })
      return true
    },
    insertText(text, span) {
      if (opts.rejectText) return false
      notices.push({ level: 'insertText', text: text, span: span })
      return true
    },
    notify(level, text) {
      notices.push({ level: level, text: text })
    },
  }
  return facade
}

function conversationServices(facade) {
  return {
    conversation: {
      input: {
        for() {
          return facade
        },
      },
    },
    sessions: {
      binding() {
        return { ctx: { fake: 'scope' } }
      },
      scope() {
        return { fake: 'scope' }
      },
    },
  }
}

/** Sandbox-realm objects have foreign prototypes; compare their JSON form. */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

async function flush(rounds) {
  const count = rounds || 5
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function intervalOf(window, ms) {
  for (const entry of window._intervals.values()) {
    if (entry.ms === ms && !entry.cleared) return entry
  }
  return null
}

function firePendingTimeouts(window, ms) {
  let fired = 0
  for (const entry of window._timeouts.values()) {
    if (entry.cleared || entry.ms !== ms) continue
    entry.cleared = true
    entry.fn()
    fired += 1
  }
  return fired
}

// ------------------------------------------------------------- module/apply --

test('registers the module with __ModuleLoader__ and exposes inject/apply', () => {
  const booted = boot()
  assert.equal(booted.config.id, 'dsh-live-page')
  assert.equal(typeof booted.config.factory, 'function')
  assert.deepEqual(plain(booted.api.inject), ['slots'])
  assert.equal(typeof booted.api.apply, 'function')
})

test('apply sets the ready flag, the debug surface and the helper table', () => {
  const booted = boot()
  assert.equal(booted.window.__dshLivePageReady, true)
  const debug = booted.window.__dshLivePageDebug
  assert.equal(typeof debug.probes, 'number')
  assert.deepEqual(plain(debug.errors), [])
  assert.equal(debug.quotes, 0)
  assert.ok(debug.helpers && typeof debug.helpers === 'object')
  for (const name of [
    'isHtmlPath',
    'pickActiveHtmlPath',
    'normalizePage',
    'selectionDecision',
    'liveOriginAllowed',
    'nonceAllowed',
    'isAgentView',
    'truncateQuoteText',
    'formatQuoteSource',
    'formatQuoteContent',
    'formatQuoteMarkdown',
  ]) {
    assert.equal(typeof debug.helpers[name], 'function', 'missing helper ' + name)
  }
})

// ------------------------------------------------------------------ helpers --

test('helpers: HTML suffix and active editor path parsing', () => {
  const helpers = boot().window.__dshLivePageDebug.helpers
  assert.equal(helpers.isHtmlPath('pages/a.html'), true)
  assert.equal(helpers.isHtmlPath('dir\\b.HTM'), true)
  assert.equal(helpers.isHtmlPath('x.xhtml'), true)
  assert.equal(helpers.isHtmlPath('y.shtml'), true)
  assert.equal(helpers.isHtmlPath('a.html?__live=tok'), true)
  assert.equal(helpers.isHtmlPath('a.txt'), false)
  assert.equal(helpers.isHtmlPath('a.htmlx'), false)
  assert.equal(helpers.isHtmlPath(''), false)

  assert.equal(helpers.pickActiveHtmlPath({ activePath: 'src/a.ts', selectedPath: 'pages/b.html' }), 'pages/b.html')
  assert.equal(helpers.pickActiveHtmlPath({ activePath: '/w/pages/a.html', selectedPath: '' }), '/w/pages/a.html')
  assert.equal(helpers.pickActiveHtmlPath({ activePath: 'src/a.ts', selectedPath: 'src/b.ts' }), '')
  assert.equal(helpers.pickActiveHtmlPath(null), '')
})

test('helpers: page normalization drops the live token and normalizes the title', () => {
  const helpers = boot().window.__dshLivePageDebug.helpers
  const page = helpers.normalizePage({
    url: 'http://127.0.0.1:4321/a.html?__live=tok',
    title: '  Foo \n Bar  ',
  })
  assert.deepEqual(plain(page), {
    url: 'http://127.0.0.1:4321/a.html',
    title: 'Foo Bar',
    kind: 'browser',
  })
  assert.equal(helpers.normalizePage({ url: 'file:///tmp/a.html' }), null)
  assert.equal(helpers.normalizePage({ url: 'not a url' }), null)
  assert.equal(helpers.normalizePage({ url: '' }), null)
  assert.equal(helpers.normalizePage(null), null)
  assert.equal(helpers.normalizePage({ url: 'https://example.com/x' }).title, 'example.com')
})

test('helpers: selection decision enforces min length, editing and dedupe', () => {
  const helpers = boot().window.__dshLivePageDebug.helpers
  assert.deepEqual(plain(helpers.selectionDecision({ text: 'ab', editing: false, lastQuoted: '' })), {
    accept: true,
    reason: 'quote',
    text: 'ab',
  })
  assert.equal(helpers.selectionDecision({ text: 'ab', editing: true }).reason, 'editing')
  assert.equal(helpers.selectionDecision({ text: 'a', editing: false }).reason, 'short')
  assert.equal(helpers.selectionDecision({ text: 'same', editing: false, lastQuoted: 'same' }).reason, 'duplicate')
  assert.equal(helpers.selectionDecision({ text: 'Same', editing: false, lastQuoted: 'same' }).accept, true)
  assert.equal(helpers.selectionDecision(null).reason, 'invalid')

  assert.deepEqual(plain(helpers.normalizeSelectionReading({ text: ' x\r\ny  ', editing: false })), {
    text: 'x\ny',
    editing: false,
  })
  assert.deepEqual(plain(helpers.normalizeSelectionReading(null)), { text: '', editing: true })
})

test('helpers: live origin and nonce gates', () => {
  const helpers = boot().window.__dshLivePageDebug.helpers
  assert.equal(helpers.normalizeOrigin('http://127.0.0.1:4321/path'), 'http://127.0.0.1:4321')
  assert.equal(helpers.normalizeOrigin('file:///tmp/a.html'), '')
  assert.equal(helpers.normalizeOrigin(''), '')
  assert.equal(helpers.liveOriginAllowed('http://127.0.0.1:4321/', ['http://127.0.0.1:4321']), true)
  assert.equal(helpers.liveOriginAllowed('http://127.0.0.1:9999', ['http://127.0.0.1:4321']), false)
  assert.equal(helpers.liveOriginAllowed('', ['http://127.0.0.1:4321']), false)
  assert.equal(helpers.liveOriginAllowed('http://127.0.0.1:4321', null), false)
  assert.equal(helpers.nonceAllowed('anything', new Set()), true)
  assert.equal(helpers.nonceAllowed('n1', new Set(['n1'])), true)
  assert.equal(helpers.nonceAllowed('n2', new Set(['n1'])), false)
  assert.equal(helpers.nonceAllowed('', new Set(['n1'])), false)
})

test('helpers: agent view marker', () => {
  const helpers = boot().window.__dshLivePageDebug.helpers
  assert.equal(helpers.isAgentView('agent'), true)
  assert.equal(helpers.isAgentView('cursor'), false)
  assert.equal(helpers.isAgentView(''), false)
  assert.equal(helpers.isAgentView(undefined), false)
})

test('helpers: quote truncation and CONTRACT source formatting', () => {
  const helpers = boot().window.__dshLivePageDebug.helpers
  assert.equal(helpers.truncateQuoteText('  hi  '), 'hi')
  assert.equal(helpers.truncateQuoteText('abcdef', 3), 'abc')
  assert.equal(helpers.truncateQuoteText('x'.repeat(9000)).length, 8000)

  assert.equal(
    helpers.formatQuoteSource({ title: 'Foo Page', file: 'a/foo.html' }),
    '\u2014 from Foo Page (a/foo.html)',
  )
  assert.equal(helpers.formatQuoteSource({ title: 'a/foo.html', file: 'a/foo.html' }), '\u2014 from a/foo.html')
  assert.equal(helpers.formatQuoteSource({ file: 'a/b.html' }), '\u2014 from a/b.html')
  assert.equal(
    helpers.formatQuoteSource({ title: 'T', url: 'http://127.0.0.1:4321/x.html?__live=tok' }),
    '\u2014 from T (http://127.0.0.1:4321/x.html)',
  )
  assert.equal(helpers.formatQuoteContent('line1\nline2', '\u2014 from T'), 'line1\nline2\n\n\u2014 from T')
  assert.equal(helpers.formatQuoteMarkdown('a\n\nb'), '> a\n>\n> b')
})

// ------------------------------------------------------------------ locale --

test('locale: registers the dsh-live-page namespace and localizes the button', () => {
  const registrations = []
  const locale = {
    register(namespace, dictionaries) {
      registrations.push({ namespace: namespace, dictionaries: dictionaries })
      return () => {}
    },
    bind() {
      return (key) => {
        const entry = registrations.length > 0 ? registrations[registrations.length - 1] : null
        const en = entry && entry.dictionaries ? entry.dictionaries.en : null
        return en && typeof en[key] === 'string' ? en[key] : key
      }
    },
  }
  const booted = boot({ services: { locale: locale } })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].namespace, 'dsh-live-page')
  assert.ok(registrations[0].dictionaries.zh)
  assert.ok(registrations[0].dictionaries.en)
  assert.equal(registrations[0].dictionaries.zh['button.tooltip'], ZH_TOOLTIP)

  mountComposerCapture(booted, { sessionId: 'sess-1' })
})

test('locale: falls back to the Chinese dictionary without a locale service', () => {
  const booted = boot()
  mountComposerCapture(booted, { sessionId: 'sess-1' })
})

// -------------------------------------------------------- composer + open flow --

function bootOpenFlow(options) {
  const opts = options || {}
  const document = opts.document || createDocument()
  if (!opts.document) {
    document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
    document.setQuery(SEL.cursorMode, null)
    document.setQuery(SEL.editorActiveTab, makeElement('div', { 'data-edrv-tab-path': 'pages/a.html' }))
    document.setQuery(SEL.editorSelectedTab, null)
  }
  const openCalls = []
  const services = Object.assign(
    {
      sidebarRight: {
        openTab(kind, options) {
          openCalls.push({ kind: kind, options: options })
        },
      },
      sidebarRightTabs: {
        get(kind) {
          return kind === 'browser' ? { id: 'browser' } : undefined
        },
      },
    },
    opts.services || {},
  )
  const booted = boot({
    document: document,
    services: services,
    fetch: opts.fetch || routeFetch({ '/live-page/open': OPEN_RESPONSE }),
  })
  return { booted: booted, document: document, openCalls: openCalls }
}

/** Mount the invisible composer occupant: it must render nothing but capture props. */
function mountComposerCapture(booted, props) {
  const registration = findRegisteredComponent(booted)
  const tree = registration.component(props || {})
  assert.equal(tree, null, 'the composer occupant must not render any UI')
  return registration
}

/** Trigger the open flow through the remaining entry point (fork button / shortcut). */
function triggerOpen(booted, detail) {
  booted.window.dispatch('dsh-live:open', { detail: detail || {} })
}

test('composer slot: invisible occupant renders nothing and the editor entry opens the page', async () => {
  const flow = bootOpenFlow()
  const registration = findRegisteredComponent(flow.booted)
  assert.equal(registration.spec.name, 'conversation.input.left')
  assert.equal(registration.spec.id, 'dsh-live-page')
  assert.equal(registration.spec.order, 30)
  assert.equal(flow.booted.slots._injections[0], 'conversation.input.left')

  mountComposerCapture(flow.booted, { sessionId: 'sess-1', inputActions: createInputActions() })
  triggerOpen(flow.booted, { path: 'pages/a.html' })
  await flush()

  const opens = openPayloads(flow.booted.calls, '/live-page/open')
  assert.equal(opens.length, 1)
  assert.deepEqual(opens[0].body, { sessionId: 'sess-1', path: 'pages/a.html' })
  assert.deepEqual(plain(flow.openCalls), [
    { kind: 'browser', options: { params: { url: OPEN_RESPONSE.url } } },
  ])
  assert.equal(flow.booted.window.__dshLivePageDebug.lastOpen.path, 'pages/a.html')
  assert.equal(
    flow.booted.window.__dshLivePageDebug.lastOpen.url,
    'http://127.0.0.1:4321/pages/a.html',
    'the one-time __live token must not leak into debug/quote state',
  )
})

test('open flow: opens the workspace listing when no active HTML is open', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  document.setQuery(SEL.cursorMode, null)
  document.setQuery(SEL.editorActiveTab, makeElement('div', { 'data-edrv-tab-path': 'src/a.ts' }))
  document.setQuery(SEL.editorSelectedTab, null)
  const flow = bootOpenFlow({
    document: document,
    fetch: routeFetch({
      '/live-page/open': {
        ok: true,
        url: 'http://127.0.0.1:4321/?__live=tok',
        file: null,
        title: 'live index',
        port: 4321,
      },
    }),
  })
  mountComposerCapture(flow.booted, { sessionId: 'sess-1', inputActions: createInputActions() })
  triggerOpen(flow.booted, {})
  await flush()
  const opens = openPayloads(flow.booted.calls, '/live-page/open')
  assert.equal(opens.length, 1)
  assert.deepEqual(opens[0].body, { sessionId: 'sess-1' })
  assert.equal(flow.openCalls.length, 1)
})

test('open flow: agent view blocks the open with a warn notice', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  document.setQuery(SEL.cursorMode, makeElement('div', { 'data-cursor-mode': 'agent' }))
  const facade = createFacade()
  const flow = bootOpenFlow({
    document: document,
    services: conversationServices(facade),
  })
  mountComposerCapture(flow.booted, { sessionId: 'sess-1', inputActions: createInputActions() })
  triggerOpen(flow.booted, { path: 'pages/a.html' })
  await flush()
  assert.equal(flow.booted.calls.length, 0, 'no host request may be made in the agent view')
  assert.equal(flow.openCalls.length, 0)
  assert.deepEqual(facade.notices, [{ level: 'warn', text: ZH_AGENT_VIEW }])
})

test('open flow: no session shows a DOM toast and does not open anything', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [])
  const flow = bootOpenFlow({ document: document })
  mountComposerCapture(flow.booted, {})
  triggerOpen(flow.booted, { path: 'pages/a.html' })
  await flush()
  assert.equal(flow.booted.calls.length, 0)
  assert.equal(flow.openCalls.length, 0)
  const toasts = document.body.children.filter((node) => node.hasAttribute('data-dsh-live-page-toast'))
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].textContent, ZH_NO_SESSION)
})

test('open flow: missing Browser service warns instead of opening', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  const facade = createFacade()
  const booted = boot({
    document: document,
    services: conversationServices(facade),
    fetch: routeFetch({ '/live-page/open': OPEN_RESPONSE }),
  })
  mountComposerCapture(booted, { sessionId: 'sess-1', inputActions: createInputActions() })
  triggerOpen(booted, { path: 'pages/a.html' })
  await flush()
  assert.deepEqual(facade.notices, [{ level: 'warn', text: ZH_NO_BROWSER }])
  assert.equal(booted.calls.length, 0)
})

// ----------------------------------------------------------------- shortcut --

test('shortcut: registers dshLivePage.openCurrentHtml with primary+shift+KeyE', async () => {
  const specs = []
  const services = {
    shortcuts: {
      register(spec) {
        specs.push(spec)
        return () => {}
      },
    },
  }
  const flow = bootOpenFlow({ services: services })
  assert.deepEqual(
    plain(flow.booted.ctx._injections.find((deps) => deps.indexOf('shortcuts') !== -1)),
    ['shortcuts'],
  )
  assert.equal(specs.length, 1)
  const spec = specs[0]
  assert.equal(spec.id, 'dshLivePage.openCurrentHtml')
  assert.equal(typeof spec.label(), 'string')
  assert.ok(spec.label().length > 0)
  for (const profile of ['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows', 'web:linux']) {
    assert.deepEqual(plain(spec.defaults[profile]), { code: 'KeyE', modifiers: ['primary', 'shift'] }, profile)
  }

  const resolution = spec.resolve({ target: null })
  assert.equal(resolution.status, 'handled')
  resolution.run()
  await flush()
  const opens = openPayloads(flow.booted.calls, '/live-page/open')
  assert.equal(opens.length, 1)
  assert.deepEqual(opens[0].body, { sessionId: 'sess-1', path: 'pages/a.html' })
})

// ---------------------------------------------------------------- fork event --

test('window event dsh-live:open opens the path from the fork detail', async () => {
  const flow = bootOpenFlow()
  flow.booted.window.dispatch('dsh-live:open', {
    detail: { path: '/w/pages/a.html' },
  })
  await flush()
  const opens = openPayloads(flow.booted.calls, '/live-page/open')
  assert.equal(opens.length, 1)
  assert.deepEqual(opens[0].body, { sessionId: 'sess-1', path: '/w/pages/a.html' })
  assert.equal(flow.openCalls.length, 1)
})

// --------------------------------------------------------- overlay messages --

function bootOverlay(serverList, options) {
  const opts = options || {}
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  document.setQuery(SEL.cursorMode, null)
  const inputActions = createInputActions()
  const booted = boot({
    document: document,
    services: opts.services || {},
    fetch: routeFetch({
      '/live-page/servers': { ok: true, servers: serverList },
    }),
  })
  const registration = findRegisteredComponent(booted)
  registration.component({ sessionId: 'sess-1', inputActions: inputActions })
  return { booted: booted, document: document, inputActions: inputActions }
}

test('overlay message: validated origin+nonce inserts a quote with the source line', async () => {
  const overlay = bootOverlay([
    { port: 4321, origin: 'http://127.0.0.1:4321', root: '/w', nonce: 'n1' },
  ])
  overlay.booted.window.dispatch('message', {
    origin: 'http://127.0.0.1:4321',
    data: {
      type: 'dsh-live-selection',
      nonce: 'n1',
      text: 'Hello world',
      title: 'Foo Page',
      file: 'a/foo.html',
      url: 'http://127.0.0.1:4321/a/foo.html',
    },
  })
  await flush(8)

  assert.equal(overlay.inputActions.calls.length, 1)
  assert.equal(overlay.inputActions.calls[0].method, 'insertQuote')
  assert.equal(
    overlay.inputActions.calls[0].text,
    'Hello world\n\n\u2014 from Foo Page (a/foo.html)',
  )
  const debug = overlay.booted.window.__dshLivePageDebug
  assert.equal(debug.quotes, 1)
  assert.equal(debug.lastQuote.channel, 'inputActions')
  assert.equal(debug.lastQuote.text, overlay.inputActions.calls[0].text)
  assert.deepEqual(plain(debug.liveOrigins), ['http://127.0.0.1:4321'])
})

test('overlay message: an origin outside /live-page/servers is dropped', async () => {
  const overlay = bootOverlay([
    { port: 4321, origin: 'http://127.0.0.1:4321', root: '/w', nonce: 'n1' },
  ])
  overlay.booted.window.dispatch('message', {
    origin: 'http://127.0.0.1:9999',
    data: {
      type: 'dsh-live-selection',
      nonce: 'n1',
      text: 'Hello world',
      title: 'Foo Page',
      file: 'a/foo.html',
      url: 'http://127.0.0.1:9999/a/foo.html',
    },
  })
  await flush(8)
  assert.equal(overlay.inputActions.calls.length, 0)
  assert.equal(overlay.booted.window.__dshLivePageDebug.droppedMessages, 1)
})

test('overlay message: a nonce mismatch is dropped when nonces are known', async () => {
  const overlay = bootOverlay([
    { port: 4321, origin: 'http://127.0.0.1:4321', root: '/w', nonce: 'n1' },
  ])
  overlay.booted.window.dispatch('message', {
    origin: 'http://127.0.0.1:4321',
    data: {
      type: 'dsh-live-selection',
      nonce: 'wrong',
      text: 'Hello world',
      title: 'Foo Page',
      file: 'a/foo.html',
      url: 'http://127.0.0.1:4321/a/foo.html',
    },
  })
  await flush(8)
  assert.equal(overlay.inputActions.calls.length, 0)
  assert.equal(overlay.booted.window.__dshLivePageDebug.droppedMessages, 1)
})

test('overlay message: unrelated message types are ignored without a server request', async () => {
  const overlay = bootOverlay([])
  overlay.booted.window.dispatch('message', {
    origin: 'http://127.0.0.1:4321',
    data: { type: 'something-else', text: 'Hello world' },
  })
  await flush()
  assert.equal(overlay.booted.calls.length, 0)
  assert.equal(overlay.inputActions.calls.length, 0)
})

// -------------------------------------------------------------- page probe --

function browserWebview(page) {
  const webview = makeElement('webview')
  webview.offsetParent = {}
  webview.isConnected = true
  webview.getURL = () => page.url
  webview.getTitle = () => page.title
  webview.executeJavaScript = page.executeJavaScript || (async () => ({ text: '', editing: false }))
  return webview
}

test('browser probe: reports the visible webview page and reuses the unchanged snapshot', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  document.setQuery(SEL.cursorMode, null)
  document.setQuery(SEL.webview, [
    browserWebview({ url: 'http://127.0.0.1:4321/pages/a.html?__live=tok', title: 'Foo Page' }),
  ])
  const booted = boot({
    document: document,
    fetch: routeFetch({ '/live-page/report': { ok: true } }),
  })

  const pageTimer = intervalOf(booted.window, 700)
  assert.ok(pageTimer, 'page probe interval must be registered')
  pageTimer.fn()
  await flush(6)

  const reports = openPayloads(booted.calls, '/live-page/report')
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0].body, {
    sessionId: 'sess-1',
    page: {
      url: 'http://127.0.0.1:4321/pages/a.html',
      title: 'Foo Page',
      kind: 'browser',
    },
  })
  const debug = booted.window.__dshLivePageDebug
  assert.equal(debug.probes, 1)
  assert.equal(debug.lastPage.title, 'Foo Page')
  assert.equal(debug.lastReport.sessionId, 'sess-1')

  // Unchanged page within the 5 minute refresh window: no second report.
  pageTimer.fn()
  await flush(6)
  assert.equal(openPayloads(booted.calls, '/live-page/report').length, 1)
})

test('browser probe: reports null to clear a page whose webview disappeared', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  document.setQuery(SEL.cursorMode, null)
  document.setQuery(SEL.webview, [
    browserWebview({ url: 'http://127.0.0.1:4321/pages/a.html', title: 'Foo Page' }),
  ])
  const booted = boot({
    document: document,
    fetch: routeFetch({ '/live-page/report': { ok: true } }),
  })
  const pageTimer = intervalOf(booted.window, 700)
  pageTimer.fn()
  await flush(6)
  assert.equal(openPayloads(booted.calls, '/live-page/report').length, 1)

  document.setQuery(SEL.webview, [])
  pageTimer.fn()
  await flush(6)
  const reports = openPayloads(booted.calls, '/live-page/report')
  assert.equal(reports.length, 2)
  assert.deepEqual(reports[1].body, { sessionId: 'sess-1', page: null })
})

test('quote insertion: falls back to the captured inputActions.insertText channel', async () => {
  const overlay = bootOverlay([
    { port: 4321, origin: 'http://127.0.0.1:4321', root: '/w', nonce: 'n1' },
  ])
  // Replace the recorded actions with ones that reject quotes and accept text.
  const actions = {
    calls: [],
    insertQuote(input) {
      actions.calls.push({ method: 'insertQuote', text: input })
      return false
    },
    captureInsertion() {
      return { start: 4, end: 4, draftRev: 7 }
    },
    insertText(input, span) {
      actions.calls.push({ method: 'insertText', text: input, span: span })
      return true
    },
    setDraft() {},
  }
  findRegisteredComponent(overlay.booted).component({ sessionId: 'sess-1', inputActions: actions })

  overlay.booted.window.dispatch('message', {
    origin: 'http://127.0.0.1:4321',
    data: {
      type: 'dsh-live-selection',
      nonce: 'n1',
      text: 'Hello world',
      title: 'Foo Page',
      file: 'a/foo.html',
      url: 'http://127.0.0.1:4321/a/foo.html',
    },
  })
  await flush(8)

  assert.equal(actions.calls.length, 2)
  assert.equal(actions.calls[0].method, 'insertQuote')
  assert.equal(actions.calls[1].method, 'insertText')
  assert.equal(
    actions.calls[1].text,
    '> Hello world\n>\n> \u2014 from Foo Page (a/foo.html)',
  )
  assert.deepEqual(plain(actions.calls[1].span), { start: 4, end: 4, draftRev: 7 })
  assert.equal(overlay.booted.window.__dshLivePageDebug.lastQuote.channel, 'inputActions.insertText')
})

test('quote insertion: falls back to the facade insertText Markdown blockquote', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  document.setQuery(SEL.cursorMode, null)
  const facade = createFacade({ rejectQuotes: true, rejectText: false })
  const booted = boot({
    document: document,
    services: conversationServices(facade),
    fetch: routeFetch({
      '/live-page/servers': {
        ok: true,
        servers: [{ port: 4321, origin: 'http://127.0.0.1:4321', root: '/w', nonce: 'n1' }],
      },
    }),
  })

  booted.window.dispatch('message', {
    origin: 'http://127.0.0.1:4321',
    data: {
      type: 'dsh-live-selection',
      nonce: 'n1',
      text: 'Hello world',
      title: 'Foo Page',
      file: 'a/foo.html',
      url: 'http://127.0.0.1:4321/a/foo.html',
    },
  })
  await flush(8)

  // Only the fallback channel recorded; the rejected insertQuote stayed silent.
  assert.equal(facade.notices.length, 1)
  assert.equal(facade.notices[0].level, 'insertText')
  assert.equal(
    facade.notices[0].text,
    '> Hello world\n>\n> \u2014 from Foo Page (a/foo.html)',
  )
  assert.deepEqual(plain(facade.notices[0].span), { start: 0, end: 0, draftRev: 3 })
  assert.equal(booted.window.__dshLivePageDebug.lastQuote.channel, 'insertText')
})

// --------------------------------------------------------- selection polling --

test('selection poll: debounces a webview selection and quotes it with the page source', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  document.setQuery(SEL.cursorMode, null)
  document.setQuery(SEL.webview, [
    browserWebview({
      url: 'http://127.0.0.1:4321/pages/a.html',
      title: 'Foo Page',
      executeJavaScript: async () => ({ text: 'Chosen words', editing: false }),
    }),
  ])
  const inputActions = createInputActions()
  const booted = boot({
    document: document,
    fetch: routeFetch({ '/live-page/report': { ok: true } }),
  })
  findRegisteredComponent(booted).component({ sessionId: 'sess-1', inputActions: inputActions })

  // Page probe first so the quote source has a page.
  intervalOf(booted.window, 700).fn()
  await flush(6)
  intervalOf(booted.window, 400).fn()
  await flush(6)

  assert.equal(inputActions.calls.length, 0, 'quote must wait for the debounce window')
  const fired = firePendingTimeouts(booted.window, 450)
  assert.equal(fired, 1)
  await flush(4)
  assert.equal(inputActions.calls.length, 1)
  assert.equal(
    inputActions.calls[0].text,
    'Chosen words\n\n\u2014 from Foo Page (http://127.0.0.1:4321/pages/a.html)',
  )
})

test('selection poll: skips editor-mode webviews and sub-2-character selections', async () => {
  const document = createDocument()
  document.setQuery(SEL.sidebarSession, [sessionElement('sess-1')])
  document.setQuery(SEL.cursorMode, null)
  let reading = { text: 'editing now', editing: true }
  document.setQuery(SEL.webview, [
    browserWebview({
      url: 'http://127.0.0.1:4321/pages/a.html',
      title: 'Foo Page',
      executeJavaScript: async () => reading,
    }),
  ])
  const inputActions = createInputActions()
  const booted = boot({
    document: document,
    fetch: routeFetch({ '/live-page/report': { ok: true } }),
  })
  findRegisteredComponent(booted).component({ sessionId: 'sess-1', inputActions: inputActions })

  intervalOf(booted.window, 400).fn()
  await flush(6)
  assert.equal(firePendingTimeouts(booted.window, 450), 0)

  reading = { text: 'a', editing: false }
  intervalOf(booted.window, 400).fn()
  await flush(6)
  assert.equal(firePendingTimeouts(booted.window, 450), 0)
  assert.equal(inputActions.calls.length, 0)
})

// ----------------------------------------------------------------- dispose --

test('dispose removes styles, timers and listeners and clears the ready flag', async () => {
  const flow = bootOpenFlow()
  const window = flow.booted.window
  const document = flow.document
  assert.equal(document.head.children.length, 1, 'style element must be injected')
  assert.ok(intervalOf(window, 700))
  assert.ok(intervalOf(window, 400))

  const lifecycle = flow.booted.ctx._effects.find((entry) => entry.label === 'dsh-live-page: lifecycle')
  assert.ok(lifecycle, 'lifecycle cleanup effect must be registered')
  lifecycle.dispose()

  assert.equal(window.__dshLivePageReady, false)
  assert.equal(document.head.children.length, 0)
  for (const interval of window._intervals.values()) assert.equal(interval.cleared, true)
  assert.equal((window._listeners.get('message') || []).length, 0)
  assert.equal((window._listeners.get('dsh-live:open') || []).length, 0)
  assert.equal((document._listeners.get('visibilitychange') || []).length, 0)

  const callsBefore = flow.booted.calls.length
  window.dispatch('message', {
    origin: 'http://127.0.0.1:4321',
    data: { type: 'dsh-live-selection', text: 'Hello world' },
  })
  await flush()
  assert.equal(flow.booted.calls.length, callsBefore, 'disposed clients must not react to messages')
})
