/**
 * dsh-editor-context — Client 半行为单测（node:vm 沙盒里的假 window/document/Monaco）。
 *
 * 覆盖无法在纯函数层验证的浏览器逻辑：页签标题提取、活动页签判定、页签点击与
 * MutationObserver 触发的重报、非文本页签 active:null、跨文件切换清选区、空快照。
 *
 * 运行：cd ~/dsh-plugins/dsh-editor-context && node --test tests/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { inferActiveSource, looksLikeFileTitle, parseResourceAddress } from '../lib/sources.js'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const EPOCH = 1_700_000_000_000

/** 可控时钟：client 里的 setTimeout/setInterval 都由它推进。 */
function makeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { fn, at: now + (Number(ms) || 0), interval: 0 })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn, ms) {
      const id = nextId++
      const step = Math.max(1, Number(ms) || 1)
      timers.set(id, { fn, at: now + step, interval: step })
      return id
    },
    clearInterval(id) { timers.delete(id) },
    advance(ms) {
      now += ms
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at <= now && (due === null || timer.at < due.at)) { due = timer; dueId = id }
        }
        if (due === null) return
        if (due.interval > 0) due.at += due.interval
        else timers.delete(dueId)
        due.fn()
      }
    },
    pendingCount: () => timers.size,
  }
}

/** 等一轮微任务（假 fetch 是 async 的，POST 会在微任务里完成）。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

function makeModel(path, language) {
  return {
    uri: { scheme: 'edrv', path: encodeURI(String(path).replace(/^\/+/, '')) },
    getLanguageId: () => language || 'plaintext',
  }
}

/** 假 Monaco 编辑器：记录监听器，测试里可以手动触发。 */
function makeEditor(model, options = {}) {
  const editor = {
    currentModel: model,
    listeners: { focus: [], selection: [], model: [] },
    visible: options.visible !== false,
    selection: options.selection || { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1 },
    position: options.position || { lineNumber: 1 },
    getModel() { return editor.currentModel },
    getDomNode() { return editor.visible ? { offsetParent: {} } : { offsetParent: null } },
    getSelection() { return editor.selection },
    getPosition() { return editor.position },
    onDidFocusEditorText(cb) { editor.listeners.focus.push(cb); return () => {} },
    onDidChangeCursorSelection(cb) { editor.listeners.selection.push(cb); return () => {} },
    onDidChangeModel(cb) { editor.listeners.model.push(cb); return () => {} },
    fire(kind) { for (const cb of editor.listeners[kind]) cb() },
  }
  return editor
}

/** 假页签（对齐 vscode-mode 的 EditorPane 结构）。 */
function makeTab({ label, path = '', active = false, focusedGroup = true }) {
  const groupEl = { classList: { contains: (name) => name === 'edrv-group-focused' && focusedGroup } }
  const tabObject = {
    nodeType: 1,
    classList: { contains: (name) => name === 'edrv-tab-active' && active },
    getAttribute(name) {
      if (name === 'data-edrv-tab-path') return path
      if (name === 'aria-selected') return String(active)
      return null
    },
    querySelector(selector) { return selector === '.edrv-group-tab-name' ? { textContent: label } : null },
    closest(selector) {
      if (selector === '.edrv-tab') return tabObject
      if (selector === '.edrv-group' || selector === '[data-edrv-view], .edrv-tabs') return groupEl
      return null
    },
  }
  return tabObject
}

/** 假页签的「原始 DOM」变体：标题在嵌套 span 里，后面跟 × 关闭按钮（复现原始 bug 的结构）。 */
function makeNestedTab({ label, path = '', active = true, focusedGroup = true }) {
  const textNode = (text) => ({ nodeType: 3, textContent: text, parentElement: null })
  const closeButton = { nodeType: 1, matches: (selector) => selector.includes('.edrv-tab-x'), textContent: '×', childNodes: [] }
  const titleSpan = { nodeType: 1, matches: () => false, textContent: label, childNodes: [textNode(label)] }
  const groupEl = { classList: { contains: (name) => name === 'edrv-group-focused' && focusedGroup } }
  const tabObject = {
    nodeType: 1,
    classList: { contains: (name) => name === 'edrv-tab-active' && active },
    getAttribute(name) {
      if (name === 'data-edrv-tab-path') return path
      if (name === 'aria-selected') return String(active)
      return null
    },
    // 没有 .edrv-group-tab-name，只有嵌套 span
    querySelector: () => null,
    closest(selector) {
      if (selector === '.edrv-tab') return tabObject
      if (selector === '.edrv-group' || selector === '[data-edrv-view], .edrv-tabs') return groupEl
      return null
    },
    matches: () => false,
    childNodes: [titleSpan, closeButton],
    querySelectorAll: () => [],
  }
  return tabObject
}

/**
 * 极简假 DOM 节点：只实现 client 用到的选择器匹配（逗号分隔的 .class / [attr] /
 * [attr="value"]），用于构造官方右侧栏（dockkit）子树并在沙盒里驱动推断逻辑。
 */
function matchesSelector(node, selector) {
  const parts = String(selector || '').split(',')
  return parts.some((raw) => {
    const part = raw.trim()
    if (!part) return false
    let ok = true
    let match = null
    const classRe = /\.([A-Za-z0-9_-]+)/g
    while ((match = classRe.exec(part)) !== null) {
      if (!node.classList || !node.classList.contains(match[1])) ok = false
    }
    const attrRe = /\[([A-Za-z0-9_:-]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]/g
    while ((match = attrRe.exec(part)) !== null) {
      const name = match[1]
      const expected = match[2] !== undefined ? match[2] : match[3]
      if (typeof node.hasAttribute !== 'function' || !node.hasAttribute(name)) { ok = false; continue }
      if (expected !== undefined && node.getAttribute(name) !== expected) ok = false
    }
    return ok
  })
}

function fakeNode({ attrs = {}, classes = [], text = '', children = [], visible = true } = {}) {
  const node = {
    nodeType: 1,
    parentElement: null,
    children,
    classList: { contains: (name) => classes.includes(name) },
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
    get textContent() { return text || children.map((child) => child.textContent).join('') },
    offsetParent: visible ? {} : null,
    matches: (selector) => matchesSelector(node, selector),
    querySelector: (selector) => querySelectorAllIn(node, selector)[0] || null,
    querySelectorAll: (selector) => querySelectorAllIn(node, selector),
    closest(selector) {
      let current = node
      while (current) {
        if (matchesSelector(current, selector)) return current
        current = current.parentElement
      }
      return null
    },
  }
  for (const child of children) child.parentElement = node
  return node
}

function querySelectorAllIn(root, selector) {
  const found = []
  const visit = (node) => {
    for (const child of node.children || []) {
      if (!child || child.nodeType !== 1) continue
      if (matchesSelector(child, selector)) found.push(child)
      visit(child)
    }
  }
  visit(root)
  return found
}

/** 构造官方右侧栏子树：root > pane(section) > tablist + body(预览/表格属性)。 */
function makeSidebar({ sessionId = 'session-1', hidden = false, panes = [] } = {}) {
  const paneNodes = panes.map((pane, index) => {
    const id = pane.id || 'pane-' + index
    const chips = (pane.tabs || []).map((tab, tabIndex) => fakeNode({
      attrs: { role: 'tab', 'data-dockkit-tab': id + '-tab-' + tabIndex, 'aria-selected': String(!!tab.active) },
      children: [fakeNode({ attrs: { 'data-dockkit-tab-title': '' }, text: tab.label })],
    }))
    const strip = fakeNode({ attrs: { role: 'tablist', 'data-dockkit-strip': id }, children: chips })
    const bodyChildren = []
    if (pane.sheet) {
      bodyChildren.push(fakeNode({
        attrs: {
          'data-workbench-sheets-path': pane.sheet.path || '',
          'data-workbench-sheets-address': pane.sheet.address || '',
          'data-workbench-sheets-kind': pane.sheet.kind || '',
        },
      }))
    }
    if (pane.previewUrl) bodyChildren.push(fakeNode({ attrs: { 'data-textpreview-url': pane.previewUrl } }))
    const body = fakeNode({ children: bodyChildren })
    const attrs = { 'data-dockkit-pane': id }
    if (pane.active) attrs['data-dockkit-pane-active'] = ''
    return fakeNode({ attrs, children: [strip, body], visible: pane.visible !== false })
  })
  const attrs = { 'data-sidebar-right-session': sessionId }
  if (hidden) attrs.hidden = ''
  return fakeNode({ attrs, children: paneNodes })
}

/** 构造沙盒环境：假 window/document/Monaco/fetch，并加载 client.js 的 factory。 */
function createEnv(initial) {
  const clock = makeClock()
  const posts = []
  const docListeners = new Map()
  const windowListeners = new Map()
  const observers = []
  const cleanups = []
  let plugin = null

  const state = {
    sessionId: initial.sessionId === undefined ? 'session-1' : initial.sessionId,
    view: initial.view === undefined ? 'cursor' : initial.view,
    tabs: (initial.tabs || []).slice(),
    editors: (initial.editors || []).slice(),
    models: (initial.models || []).slice(),
    /** 模拟 document.activeElement（侧栏焦点/编辑器焦点切换）。 */
    activeElement: initial.activeElement || null,
  }
  let fetchImpl = initial.fetchImpl || (async (url, options) => {
    posts.push({ url: String(url), body: JSON.parse(options.body) })
    return { ok: true, status: 200 }
  })

  const editorRoot = { nodeType: 1, classList: { contains: () => false }, closest: () => ({}) }

  // 右侧栏会话根：没有显式给子树时，按 sessionId 造一个空会话根（保持旧用例语义）。
  if (initial.sidebar) state.extraRoots = [initial.sidebar]
  else if (state.sessionId) state.extraRoots = [fakeNode({ attrs: { 'data-sidebar-right-session': state.sessionId } })]
  else state.extraRoots = []

  const doc = {
    baseURI: 'http://127.0.0.1:57736/app/',
    visibilityState: 'visible',
    body: { nodeType: 1 },
    documentElement: { nodeType: 1 },
    get activeElement() { return state.activeElement || null },
    querySelector(selector) {
      if (selector === '[data-cursor-mode]') return state.view ? { getAttribute: () => state.view } : null
      return doc.querySelectorAll(selector)[0] || null
    },
    querySelectorAll(selector) {
      if (selector === '.edrv-tab') return state.tabs
      const found = []
      for (const root of state.extraRoots || []) {
        if (matchesSelector(root, selector)) found.push(root)
        for (const node of querySelectorAllIn(root, selector)) found.push(node)
      }
      return found
    },
    addEventListener(type, handler) { docListeners.set(type, handler) },
    removeEventListener(type) { docListeners.delete(type) },
  }

  const sandbox = {
    console,
    URL,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    document: doc,
    fetch: (url, options) => fetchImpl(String(url), options),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    addEventListener(type, handler) { windowListeners.set(type, handler) },
    removeEventListener(type) { windowListeners.delete(type) },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.observing = false; observers.push(this) }
      observe(target, options) { this.observing = true; this.target = target; this.options = options }
      disconnect() { this.observing = false }
    },
    __ModuleLoader__: { load(def) { plugin = def.factory } },
    monaco: {
      editor: {
        getEditors: () => state.editors,
        getModels: () => state.models,
        onDidCreateEditor: () => () => {},
      },
    },
  }
  sandbox.window = sandbox
  sandbox.Date = { now: () => EPOCH + clock.now() }

  const context = vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, context, { filename: 'client.js' })

  const ctx = {
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') cleanups.push(disposer)
    },
  }
  // client.js 导出的是 loader factory：factory(require) → { inject, apply }
  plugin(() => {}).apply(ctx)

  return {
    state,
    clock,
    posts,
    observers,
    docListeners,
    debug: sandbox.__editorContextDebug,
    editorRoot,
    /** 推进一步时钟并等异步 POST 落地。 */
    async flush(ms = 300) {
      clock.advance(ms)
      await tick()
      await tick()
    },
    fireDoc(type, target) {
      const handler = docListeners.get(type)
      if (handler) handler({ target })
    },
    fireMutation(records) {
      for (const observer of observers) if (observer.observing && observer.callback) observer.callback(records)
    },
    /** 替换官方右侧栏子树（模拟切页签/切会话）。 */
    setSidebar(root) { state.extraRoots = root ? [root] : [] },
    /** client 暴露的纯函数（与 lib/sources.js 做一致性校验）。 */
    helpers: sandbox.__editorContextDebug.helpers,
    setFetchImpl(fn) { fetchImpl = fn },
    lastPost() { return posts[posts.length - 1] || null },
    dispose() { for (const fn of cleanups) { try { fn() } catch (error) { /* ignore */ } } },
  }
}

/** 一份典型的「打开着 sample.py + README.md，sample.py 活动」环境。 */
function textEnv() {
  const python = makeModel('_dsh-preview-test/sample.py', 'python')
  const readme = makeModel('README.md', 'markdown')
  const pythonEditor = makeEditor(python, {
    selection: { startLineNumber: 3, endLineNumber: 7, startColumn: 1, endColumn: 1 },
    position: { lineNumber: 3 },
  })
  return createEnv({
    tabs: [
      makeTab({ label: 'sample.py', path: '_dsh-preview-test/sample.py', active: true }),
      makeTab({ label: 'README.md', path: 'README.md', active: false }),
    ],
    editors: [pythonEditor],
    models: [python, readme],
  })
}

test('client：初始上报包含活动文件、语言、多行选区、页签列表与视图', async () => {
  const env = textEnv()
  await env.flush()
  assert.equal(env.posts.length, 1)
  const post = env.lastPost()
  assert.match(post.url, /\/app\/editor-context\/report$/)
  assert.equal(post.body.sessionId, 'session-1')
  assert.equal(post.body.view, 'cursor')
  assert.equal(post.body.active.path, '_dsh-preview-test/sample.py')
  assert.equal(post.body.active.language, 'python')
  assert.deepEqual(post.body.active.selection, { startLine: 3, endLine: 7 })
  // 页签标题从 span 里取到完整文件名（不是空），并按页签顺序排列
  assert.deepEqual(post.body.open.map((item) => item.label), ['sample.py', 'README.md'])
  assert.equal(post.body.open[0].active, true)
  assert.equal(post.body.open[1].active, undefined)
  assert.equal(env.debug.reports, 1)
  env.dispose()
})

test('client：点击非活动页签后（编辑器未重新 focus）活动文件跟着页签切换', async () => {
  const env = textEnv()
  await env.flush()
  const readmeEditor = makeEditor(makeModel('README.md', 'markdown'), {
    selection: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1 },
    position: { lineNumber: 4 },
  })
  env.state.editors = [readmeEditor]
  env.state.tabs = [
    makeTab({ label: 'sample.py', path: '_dsh-preview-test/sample.py', active: false }),
    makeTab({ label: 'README.md', path: 'README.md', active: true }),
  ]
  // 模拟页签点击（click 委托监听）
  env.fireDoc('click', env.state.tabs[1])
  await env.flush()
  const post = env.lastPost()
  assert.equal(post.body.active.path, 'README.md')
  assert.equal(post.body.active.cursorLine, 4)
  // 旧文件的多行选区不能被带到 README 上
  assert.equal(post.body.active.selection, undefined)
  env.dispose()
})

test('client：MutationObserver 捕获页签 class/aria-selected 变化后重报', async () => {
  const env = textEnv()
  await env.flush()
  const before = env.posts.length
  env.state.tabs = [
    makeTab({ label: 'sample.py', path: '_dsh-preview-test/sample.py', active: false }),
    makeTab({ label: 'README.md', path: 'README.md', active: true }),
  ]
  env.state.editors = [makeEditor(makeModel('README.md', 'markdown'))]
  env.fireMutation([{ type: 'attributes', target: env.editorRoot }])
  await env.flush()
  assert.ok(env.posts.length > before)
  assert.equal(env.lastPost().body.active.path, 'README.md')
  env.dispose()
})

test('client：切到非文本页签（PDF）时报 active:null，但仍列打开页签并标出活动页签', async () => {
  const env = textEnv()
  await env.flush()
  const pdfTab = makeTab({ label: 'sample.pdf', path: '_dsh-preview-test/sample.pdf', active: true })
  env.state.tabs = [
    makeTab({ label: 'sample.py', path: '_dsh-preview-test/sample.py', active: false }),
    pdfTab,
  ]
  env.state.editors = []
  env.fireDoc('click', pdfTab)
  await env.flush()
  const body = env.lastPost().body
  assert.equal(body.active, null)
  const pdfEntry = body.open.find((item) => item.path === '_dsh-preview-test/sample.pdf')
  assert.ok(pdfEntry && pdfEntry.active === true)
  assert.ok(body.open.some((item) => item.label === 'sample.py'))
  env.dispose()
})

test('client：页签切换导致 model 更换时先清掉旧选区，下一轮光标事件再补', async () => {
  const env = textEnv()
  await env.flush()
  const editor = env.state.editors[0]
  // 同一编辑器换 model（page A→B），选区还是旧文件的行号
  editor.currentModel = makeModel('README.md', 'markdown')
  editor.selection = { startLineNumber: 3, endLineNumber: 7, startColumn: 1, endColumn: 1 }
  editor.position = { lineNumber: 3 }
  editor.visible = true
  env.state.tabs = [
    makeTab({ label: 'sample.py', path: '_dsh-preview-test/sample.py', active: false }),
    makeTab({ label: 'README.md', path: 'README.md', active: true }),
  ]
  editor.fire('model')
  await env.flush()
  let body = env.lastPost().body
  assert.equal(body.active.path, 'README.md')
  assert.equal(body.active.selection, undefined, 'model 刚换的一轮不能带旧选区')
  assert.equal(body.active.cursorLine, undefined)

  // 光标事件到来后正常上报（selection 归一成 1:1，不上报选区，只报光标行）
  editor.selection = { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1 }
  editor.position = { lineNumber: 1 }
  editor.fire('selection')
  await env.flush()
  body = env.lastPost().body
  assert.equal(body.active.path, 'README.md')
  assert.equal(body.active.selection, undefined)
  assert.equal(body.active.cursorLine, 1)
  env.dispose()
})

test('client：编辑器全空时上报一次空快照清掉陈旧状态，之后同内容不再重复发', async () => {
  const env = textEnv()
  await env.flush()
  assert.equal(env.posts.length, 1)
  env.state.tabs = []
  env.state.editors = []
  env.state.models = []
  env.fireDoc('pointerdown', env.editorRoot)
  await env.flush()
  assert.equal(env.lastPost().body.active, null)
  assert.deepEqual(env.lastPost().body.open, [])
  const afterEmpty = env.posts.length
  await env.flush(1000)
  assert.equal(env.posts.length, afterEmpty, '相同内容的空快照不重复 POST')
  env.dispose()
})

test('client：没有会话/视图标注时仍能上报（sessionId:null）', async () => {
  const env = createEnv({
    sessionId: null,
    view: null,
    tabs: [makeTab({ label: 'a.ts', path: 'a.ts', active: true })],
    editors: [makeEditor(makeModel('a.ts', 'typescript'))],
    models: [makeModel('a.ts', 'typescript')],
  })
  await env.flush()
  const body = env.lastPost().body
  assert.equal(body.sessionId, null)
  assert.equal(body.view, undefined)
  assert.equal(body.active.path, 'a.ts')
  env.dispose()
})

test('client：分屏时优先聚焦分屏里的活动页签', async () => {
  const env = createEnv({
    tabs: [
      makeTab({ label: 'left.ts', path: 'left.ts', active: true, focusedGroup: false }),
      makeTab({ label: 'right.ts', path: 'right.ts', active: true, focusedGroup: true }),
    ],
    editors: [makeEditor(makeModel('right.ts', 'typescript'))],
    models: [makeModel('left.ts', 'typescript'), makeModel('right.ts', 'typescript')],
  })
  await env.flush()
  const body = env.lastPost().body
  assert.equal(body.active.path, 'right.ts')
  assert.equal(body.open.filter((item) => item.active).length, 1)
  env.dispose()
})

test('client：工作区外文件（页签绝对路径 / edrv URI 剥前导斜杠）仍识别为活动文本文件', async () => {
  const env = createEnv({
    tabs: [makeTab({ label: 'outside.ts', path: '/Users/x/outside.ts', active: true })],
    // edrv URI 约定：绝对路径剥掉前导 /，model 路径是 Users/x/outside.ts
    editors: [makeEditor(makeModel('/Users/x/outside.ts', 'typescript'))],
    models: [makeModel('/Users/x/outside.ts', 'typescript')],
  })
  await env.flush()
  const body = env.lastPost().body
  assert.equal(body.active.path, '/Users/x/outside.ts')
  // 同一文件不要因为路径形态差异在列表里出现两次
  assert.equal(body.open.filter((item) => item.label === 'outside.ts').length, 1)
  assert.equal(body.open.find((item) => item.path === '/Users/x/outside.ts').active, true)
  env.dispose()
})

test('client：上报失败后按退避重试，成功后恢复', async () => {
  const env = textEnv()
  env.setFetchImpl(async () => ({ ok: false, status: 404 }))
  await env.flush()
  assert.equal(env.posts.length, 0)
  assert.ok(env.debug.errors.some((item) => item.includes('404')))
  // 退避窗口内不反复重试
  await env.flush(1000)
  assert.equal(env.posts.length, 0)
  // 窗口过后恢复上报
  env.setFetchImpl(async (url, options) => {
    env.posts.push({ url: String(url), body: JSON.parse(options.body) })
    return { ok: true, status: 200 }
  })
  await env.flush(20000)
  await env.flush(300) // 让退避后的重试去抖到期
  assert.equal(env.posts.length, 1)
  assert.equal(env.lastPost().body.active.path, '_dsh-preview-test/sample.py')
  env.dispose()
})

test('client：标题在嵌套 span 里时也能取到完整文件名，并去掉尾部 × 关闭按钮', async () => {
  const env = createEnv({
    tabs: [makeNestedTab({ label: 'nested-title.ts', path: 'nested-title.ts', active: true })],
    editors: [makeEditor(makeModel('nested-title.ts', 'typescript'))],
    models: [makeModel('nested-title.ts', 'typescript')],
  })
  await env.flush()
  const body = env.lastPost().body
  assert.equal(body.active.path, 'nested-title.ts')
  assert.deepEqual(body.open.map((item) => item.label), ['nested-title.ts'])
  env.dispose()
})

// ---------- 官方右侧栏（side card）页签推断 ----------

test('client：官方侧栏活动表格页签（XLSX）推断为 active.source=sheet', async () => {
  const sidebar = makeSidebar({
    panes: [{
      id: 'p1',
      active: true,
      sheet: {
        path: '_dsh-preview-test/sample.xlsx',
        address: 'dsh-resource://file/session/session-1/_dsh-preview-test/sample.xlsx',
        kind: 'xlsx',
      },
      tabs: [
        { label: 'sample.xlsx', active: true },
        { label: 'sample.csv', active: false },
        { label: '终端', active: false },
      ],
    }],
  })
  // 对应 Lead 实测的现状：edrv 里只剩一个非文本页签（无 model）
  const env = createEnv({
    tabs: [makeTab({ label: 'cordis.patch.yml', path: 'cordis.patch.yml', active: true })],
    editors: [],
    models: [],
    sidebar,
  })
  await env.flush()
  const body = env.lastPost().body
  assert.equal(body.sessionId, 'session-1')
  assert.deepEqual(body.active, { path: '_dsh-preview-test/sample.xlsx', source: 'sheet' })
  const labels = body.open.map((item) => item.label)
  assert.ok(labels.includes('sample.xlsx'), '打开列表要含表格页签')
  assert.ok(labels.includes('sample.csv'))
  assert.ok(labels.includes('cordis.patch.yml'))
  assert.ok(!labels.includes('终端'), '非文件页签不能收进打开列表')
  assert.equal(body.open.find((item) => item.label === 'sample.xlsx').path, '')
  env.dispose()
})

test('client：官方侧栏活动 PDF 预览页签推断为 active.source=preview', async () => {
  const sidebar = makeSidebar({
    panes: [{
      id: 'p1',
      active: true,
      previewUrl: 'dsh-resource://file/session/session-1/_dsh-preview-test/sample.pdf',
      tabs: [
        { label: 'sample.pdf', active: true },
        { label: 'sample.docx', active: false },
        { label: '轨迹', active: false },
      ],
    }],
  })
  const env = createEnv({ tabs: [], editors: [], models: [], sidebar })
  await env.flush()
  const body = env.lastPost().body
  assert.deepEqual(body.active, { path: '_dsh-preview-test/sample.pdf', source: 'preview' })
  const labels = body.open.map((item) => item.label)
  assert.deepEqual(labels, ['sample.pdf', 'sample.docx'])
  assert.equal(body.open[0].active, true)
  env.dispose()
})

test('client：切到 Word 预览页签后 active 跟随变化（点击页签触发）', async () => {
  const env = createEnv({
    tabs: [],
    editors: [],
    models: [],
    sidebar: makeSidebar({
      panes: [{
        id: 'p1',
        active: true,
        previewUrl: 'dsh-resource://file/session/session-1/_dsh-preview-test/sample.pdf',
        tabs: [{ label: 'sample.pdf', active: true }, { label: 'sample.docx', active: false }],
      }],
    }),
  })
  await env.flush()
  assert.equal(env.lastPost().body.active.path, '_dsh-preview-test/sample.pdf')

  const next = makeSidebar({
    panes: [{
      id: 'p1',
      active: true,
      previewUrl: 'dsh-resource://file/session/session-1/_dsh-preview-test/sample.docx',
      tabs: [{ label: 'sample.pdf', active: false }, { label: 'sample.docx', active: true }],
    }],
  })
  env.setSidebar(next)
  env.fireDoc('click', next.querySelectorAll('[role="tab"]')[1])
  await env.flush()
  assert.deepEqual(env.lastPost().body.active, { path: '_dsh-preview-test/sample.docx', source: 'preview' })
  env.dispose()
})

test('client：右侧栏隐藏（非当前会话）时不做推断，保持 active:null', async () => {
  const sidebar = makeSidebar({
    hidden: true,
    panes: [{ id: 'p1', active: true, previewUrl: 'dsh-resource://file/session/session-1/_dsh-preview-test/sample.pdf' }],
  })
  const env = createEnv({
    tabs: [makeTab({ label: 'cordis.patch.yml', path: 'cordis.patch.yml', active: true })],
    editors: [],
    models: [],
    sidebar,
  })
  await env.flush()
  const body = env.lastPost().body
  assert.equal(body.active, null)
  assert.ok(!body.open.some((item) => item.label === 'sample.pdf'))
  env.dispose()
})

test('client：absolute 域预览地址解析成绝对路径', async () => {
  const sidebar = makeSidebar({
    panes: [{
      id: 'p1',
      active: true,
      previewUrl: 'dsh-resource://file/absolute/Users/x/outside.pdf',
    }],
  })
  const env = createEnv({ tabs: [], editors: [], models: [], sidebar })
  await env.flush()
  assert.deepEqual(env.lastPost().body.active, { path: '/Users/x/outside.pdf', source: 'preview' })
  env.dispose()
})

test('client：侧栏页签与 edrv 打开列表按 label 去重', async () => {
  const env = createEnv({
    tabs: [makeTab({ label: 'cordis.patch.yml', path: 'cordis.patch.yml', active: true })],
    editors: [],
    models: [],
    sidebar: makeSidebar({
      panes: [{
        id: 'p1',
        active: true,
        previewUrl: 'dsh-resource://file/session/session-1/cordis.patch.yml',
        tabs: [{ label: 'cordis.patch.yml', active: true }],
      }],
    }),
  })
  await env.flush()
  const body = env.lastPost().body
  assert.equal(body.open.filter((item) => item.label === 'cordis.patch.yml').length, 1)
  // 同一文件在侧栏里是活动页签 → 列表标记 active
  assert.equal(body.open.find((item) => item.label === 'cordis.patch.yml').active, true)
  env.dispose()
})

test('client：纯函数与 lib/sources.js 实现保持一致（防两份实现漂移）', () => {
  const env = createEnv({ sessionId: null })
  const h = env.helpers
  assert.equal(typeof h.parseResourceAddress, 'function')

  const addresses = [
    'dsh-resource://file/session/s1/a/b%20c.ts',
    'dsh-resource://file/session/s%201/x.csv?x=1#frag',
    'dsh-resource://file/absolute/Users/x/a.pdf',
    'dsh-resource://file/absolute//server/share/doc.docx',
    'dsh-resource://file/absolute/C:/work/a.xlsx',
    'dsh-resource://file/other/nope',
    'dsh-resource://file/',
    'not-an-address',
    '',
    42,
  ]
  for (const address of addresses) {
    assert.equal(JSON.stringify(h.parseResourceAddress(address)), JSON.stringify(parseResourceAddress(address)), 'address: ' + address)
  }

  const inputs = [
    { sheetPath: 'a/b.xlsx', sheetAddress: 'dsh-resource://file/session/s1/a/b.xlsx' },
    { sheetAddress: 'dsh-resource://file/session/s1/a/b.csv' },
    { previewUrl: 'dsh-resource://file/session/s1/sample.pdf' },
    { previewUrl: 'dsh-resource://file/absolute/Users/x/outside.pdf' },
    { previewUrl: 'bad' },
    {},
  ]
  for (const input of inputs) {
    assert.equal(JSON.stringify(h.inferActiveSource(input)), JSON.stringify(inferActiveSource(input)), 'input: ' + JSON.stringify(input))
  }

  const titles = ['sample.xlsx', 'a b.pdf', 'Makefile', '终端', 'v1.2', '轨迹', 'dir/sample.pdf', '', 'a.']
  for (const title of titles) {
    assert.equal(h.looksLikeFileTitle(title), looksLikeFileTitle(title), 'title: ' + title)
  }
  env.dispose()
})

test('client：edrv 页签的 model 消失后，8 秒新鲜度窗口过后让位给官方侧栏推断', async () => {
  const env = textEnv()
  await env.flush()
  assert.equal(env.lastPost().body.active.path, '_dsh-preview-test/sample.py')

  // 模拟页签切换瞬间：活动页签是 sample.py，但它的 model 暂时没了；另一个编辑器仍可见，
  // 所以「编辑器可见 → edrv 优先」成立，只靠 8 秒新鲜度窗口兜住这一两个报告。
  const readmeEditor = makeEditor(makeModel('README.md', 'markdown'))
  env.state.editors = [env.state.editors[0], readmeEditor]
  env.state.editors[0].currentModel = null
  env.state.models = [makeModel('README.md', 'markdown')]
  env.state.tabs = [makeTab({ label: 'sample.py', path: '_dsh-preview-test/sample.py', active: true })]
  const sidebar = makeSidebar({
    panes: [{
      id: 'p1',
      active: true,
      sheet: {
        path: '_dsh-preview-test/sample.xlsx',
        address: 'dsh-resource://file/session/session-1/_dsh-preview-test/sample.xlsx',
      },
      tabs: [{ label: 'sample.xlsx', active: true }],
    }],
  })
  env.setSidebar(sidebar)
  const chip = sidebar.querySelectorAll('[role="tab"]')[0]

  // 8 秒窗口内还认为刚才的 edrv 文本文件是活动的（页签切换抖动保护）
  env.fireDoc('click', chip)
  await env.flush()
  assert.equal(env.lastPost().body.active.path, '_dsh-preview-test/sample.py')

  // 窗口过后不再冒充，让位给官方侧栏的表格页签
  await env.flush(9000)
  env.fireDoc('click', chip)
  await env.flush()
  assert.deepEqual(env.lastPost().body.active, { path: '_dsh-preview-test/sample.xlsx', source: 'sheet' })
  env.dispose()
})

test('client：焦点在官方侧栏时优先报表格页签；编辑器重新聚焦后回到文本文件', async () => {
  const sidebar = makeSidebar({
    panes: [{
      id: 'p1',
      active: true,
      sheet: {
        path: '_dsh-preview-test/sample.xlsx',
        address: 'dsh-resource://file/session/session-1/_dsh-preview-test/sample.xlsx',
      },
      tabs: [{ label: 'sample.xlsx', active: true }],
    }],
  })
  const env = textEnv()
  env.setSidebar(sidebar)
  const chip = sidebar.querySelectorAll('[role="tab"]')[0]

  // 用户点官方表格页签（焦点进侧栏）→ 即使 edrv 还有文本文件，也报侧栏表格
  env.state.activeElement = chip
  env.fireDoc('click', chip)
  await env.flush()
  assert.deepEqual(env.lastPost().body.active, { path: '_dsh-preview-test/sample.xlsx', source: 'sheet' })

  // 用户点回编辑器 → 回到 edrv 文本文件，措辞保持原样（无 source）
  env.state.activeElement = env.state.editors[0].getDomNode()
  env.state.editors[0].fire('focus')
  await env.flush()
  assert.equal(env.lastPost().body.active.path, '_dsh-preview-test/sample.py')
  assert.equal(env.lastPost().body.active.source, undefined)
  env.dispose()
})
