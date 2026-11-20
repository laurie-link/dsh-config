/**
 * dsh-editor-context — Client half (plain JS, no build step).
 *
 * 观察 dsh-vscode-mode 的 Monaco 编辑器与工作台页签，把「当前活动文件 / 打开的
 * 页签 / 选区」以去抖方式 POST 给本插件 Host 半；Host 再把它注入每个 Agent 的
 * 运行时上下文。这里不加载任何本地依赖，只使用浏览器 API 与 loader 提供的全局。
 *
 * 活动文件判定按优先级：
 *  ① edrv 活动页签且存在对应 Monaco 文本模型 → 文本文件（带语言/选区/光标）；
 *  ② 否则看官方右侧栏（side card）的活动 pane：
 *     - dsh-workbench-sheets 的表格页签（`data-workbench-sheets-*` 属性，可能暂不存在）；
 *     - 官方 documentpreview 的预览页签（`data-textpreview-url`，文本/PDF/Word/PPT 都有）
 *       → 上报 `active: { path, source: 'preview'|'sheet' }`；
 *  ③ 都没有 → `active:null`（非文本 edrv 页签仍会标在打开列表里）。
 *
 * 注意：lib/sources.js 有本文件纯函数部分的等价实现（浏览器插件不能 import 本地
 * 文件），tests/client.test.mjs 用沙盒对两者做一致性校验。
 */
window.__ModuleLoader__.load({
  id: 'dsh-editor-context',
  factory(require) {
    const FILE_SCHEME = 'edrv'
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
    const REPORT_URL = 'editor-context/report'
    const DEBOUNCE_MS = 300
    const SESSION_POLL_MS = 1500
    const MONACO_POLL_MS = 400
    const MONACO_WAIT_MS = 60 * 1000
    /** 状态没变也定期重发一次，避免 Host 端 30 分钟 TTL 把仍然有效的快照判过期。 */
    const REPOST_UNCHANGED_MS = 5 * 60 * 1000
    /** 上报失败后的退避重试间隔。 */
    const FAIL_RETRY_MS = 15 * 1000
    const TAB_SELECTOR = '.edrv-tab'
    const TAB_CLOSE_SELECTOR = '.edrv-tab-x, .edrv-tab-close, [data-edrv-close]'
    /** 官方右侧栏（dockkit）DOM 标记。 */
    const SIDEBAR_SESSION_SELECTOR = '[data-sidebar-right-session]'
    const SIDEBAR_TAB_SELECTOR = '[role="tab"][data-dockkit-tab]'
    const SIDEBAR_ACTIVE_PANE_SELECTOR = '[data-dockkit-pane-active], [data-dockkit-float-active]'
    const SIDEBAR_PANE_SELECTOR = '[data-dockkit-pane], [data-dockkit-float]'
    const SHEET_PATH_SELECTOR = '[data-workbench-sheets-path]'
    const PREVIEW_URL_SELECTOR = '[data-textpreview-url]'

    const debug = (window.__editorContextDebug = { startedAt: Date.now(), reports: 0, errors: [], lastReport: null })

    /** 相对文档基址的应用内 URL（兼容 dsh-app:// 与 http 两种 origin）。 */
    function appUrlOf(path) {
      try {
        const root = new URL('.', document.baseURI)
        return new URL(String(path).replace(/^\/+/, ''), root).href
      } catch (error) {
        return path
      }
    }

    /** 当前会话 id（优先可见的右侧栏会话；没有会话时为 null）。 */
    function currentSessionId() {
      try {
        const nodes = document.querySelectorAll(SIDEBAR_SESSION_SELECTOR)
        let first = null
        for (const node of nodes) {
          if (!node || typeof node.getAttribute !== 'function') continue
          const raw = node.getAttribute('data-sidebar-right-session') || ''
          if (!raw) continue
          if (first === null) first = raw
          const hidden = typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')
          if (!hidden) return raw
        }
        return first
      } catch (error) {
        return null
      }
    }

    /** 当前布局视图（dsh-cursor-layout 在 frame 上标注 cursor / agent）。 */
    function currentView() {
      try {
        const frame = document.querySelector('[data-cursor-mode]')
        const mode = frame ? frame.getAttribute('data-cursor-mode') : ''
        return mode === 'agent' ? 'agent' : mode === 'cursor' ? 'cursor' : undefined
      } catch (error) {
        return undefined
      }
    }

    /** 从 Monaco model uri 取磁盘路径（edrv scheme 的 path 是 encodeURIComponent 过的工作区相对路径）。 */
    function modelPathOf(model) {
      try {
        const uri = model && model.uri
        if (!uri || uri.scheme !== FILE_SCHEME) return null
        const raw = String(uri.path || '').replace(/^\//, '')
        if (!raw) return null
        try { return decodeURIComponent(raw) } catch (error) { return raw }
      } catch (error) {
        return null
      }
    }

    function basenameOf(path) {
      const value = String(path || '')
      return value.split(/[\\/]/).pop() || value
    }

    /**
     * 路径比较：容忍工作区外绝对路径的形态差异——页签里是 `/Users/x/a.ts`，
     * 而 edrv URI 约定会剥掉前导 `/` 变成 `Users/x/a.ts`。
     */
    function samePath(a, b) {
      if (!a || !b) return false
      if (a === b) return true
      return String(a).replace(/^\/+/, '') === String(b).replace(/^\/+/, '')
    }

    /** 在路径列表里找同一文件的第一个形态（找不到返回 null）。 */
    function findSamePath(paths, target) {
      for (const path of paths) if (samePath(path, target)) return path
      return null
    }

    /** 页签文本归一：去掉尾部关闭按钮的 ×/✕/✖/✗/⨯，收敛空白。 */
    function cleanTabLabel(text) {
      return String(text || '')
        .replace(/[\u00d7\u2715\u2716\u2717\u2a2f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    /** 元素是否可见（隐藏会话/折叠面板用 display:none，offsetParent 为 null）。 */
    function isVisibleNode(node) {
      try {
        return !!node && node.offsetParent !== null
      } catch (error) {
        return false
      }
    }

    /**
     * 解析官方 `dsh-resource://file/…` 地址（与 @deepseek-ai/dsh-util-workspace-path 同语法）。
     * session 域 → { sessionId, path }；absolute 域 → { path }。
     */
    function parseResourceAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return null
      try {
        const end = address.search(/[?#]/)
        const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
        const [scope, ...rest] = body.split('/')
        if (scope === 'session') {
          const [id, ...segments] = rest
          if (id === undefined || id === '' || segments.length === 0) return null
          const sessionId = decodeURIComponent(id)
          const path = segments.map((segment) => decodeURIComponent(segment)).join('/')
          if (!sessionId || !path) return null
          return { scope, sessionId, path }
        }
        if (scope === 'absolute') {
          const unc = rest[0] === '' && rest.length > 1
          const segments = (unc ? rest.slice(1) : rest).map((segment) => decodeURIComponent(segment))
          if (segments.length === 0 || segments[0] === '') return null
          if (unc) return { scope, path: '//' + segments.join('/') }
          if (/^[A-Za-z]:$/.test(segments[0])) return { scope, path: segments.join('/') }
          return { scope, path: '/' + segments.join('/') }
        }
        return null
      } catch (error) {
        return null
      }
    }

    /**
     * 从官方侧栏活动 pane 的属性推断活动文件（纯函数；输入是已取出的属性字符串）。
     * 表格页签优先，其次官方预览；推断不出返回 null。
     */
    function inferActiveSource(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
      const read = (name) => (typeof input[name] === 'string' ? input[name].trim() : '')
      const sheetPath = read('sheetPath')
      const sheetAddress = read('sheetAddress')
      const parsedSheet = sheetAddress ? parseResourceAddress(sheetAddress) : null
      const sheetResolved = sheetPath || (parsedSheet !== null ? parsedSheet.path : '')
      if (sheetResolved) {
        const result = { path: sheetResolved, source: 'sheet' }
        if (parsedSheet !== null && parsedSheet.sessionId) result.sessionId = parsedSheet.sessionId
        return result
      }
      const previewUrl = read('previewUrl')
      if (previewUrl) {
        const parsed = parseResourceAddress(previewUrl)
        if (parsed !== null && parsed.path) {
          const result = { path: parsed.path, source: 'preview' }
          if (parsed.sessionId) result.sessionId = parsed.sessionId
          return result
        }
      }
      return null
    }

    /** 页签标题是否「像一个文件名」（排除终端/浏览器/计划/轨迹等本地化名词页签）。 */
    function looksLikeFileTitle(title) {
      if (typeof title !== 'string') return false
      const text = title.trim()
      if (!text || text.length > 200) return false
      if (/[\\/\n\r]/.test(text)) return false
      const dot = text.lastIndexOf('.')
      if (dot <= 0) return false
      const stem = text.slice(0, dot)
      const ext = text.slice(dot + 1)
      if (!/^[A-Za-z0-9]{1,10}$/.test(ext)) return false
      if (/^[0-9]+$/.test(ext)) return false
      return /\S/.test(stem)
    }

    /** 焦点是否在官方右侧栏里（用户刚点过侧栏页签/预览正文）。 */
function sidebarHasFocus() {
  try {
    const active = document.activeElement
    return !!(active && typeof active.closest === 'function' && active.closest('[data-sidebar-right-session]'))
  } catch (error) {
    return false
  }
}

/** 可见的官方右侧栏会话根（优先当前会话；全部隐藏时返回 null）。 */
    function visibleSidebarRoot() {
      try {
        const sessionId = currentSessionId()
        const nodes = document.querySelectorAll(SIDEBAR_SESSION_SELECTOR)
        let first = null
        for (const node of nodes) {
          if (!node || typeof node.getAttribute !== 'function') continue
          if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) continue
          if (first === null) first = node
          if (sessionId !== null && node.getAttribute('data-sidebar-right-session') === sessionId) return node
        }
        return first
      } catch (error) {
        return null
      }
    }

    /** 官方侧栏当前活动的 pane（有 active 标记取最后一个可见的，否则兜底最后一个可见 pane）。 */
    function activeSidePane(root) {
      if (root === null || typeof root.querySelectorAll !== 'function') return null
      const candidates = []
      try {
        for (const node of root.querySelectorAll(SIDEBAR_ACTIVE_PANE_SELECTOR)) {
          if (isVisibleNode(node)) candidates.push(node)
        }
      } catch (error) { /* ignore */ }
      if (candidates.length === 0) {
        try {
          for (const node of root.querySelectorAll(SIDEBAR_PANE_SELECTOR)) {
            if (isVisibleNode(node)) candidates.push(node)
          }
        } catch (error) { /* ignore */ }
      }
      return candidates.length > 0 ? candidates[candidates.length - 1] : null
    }

    /** 从官方侧栏活动 pane 推断活动文件（表格页签 → 官方预览 → null）。 */
    function inferSidePaneActive() {
      const root = visibleSidebarRoot()
      if (root === null) return null
      const pane = activeSidePane(root)
      if (pane === null || typeof pane.querySelector !== 'function') return null
      let sheetPath = ''
      let sheetAddress = ''
      try {
        const sheet = pane.querySelector(SHEET_PATH_SELECTOR)
        if (sheet) {
          sheetPath = String(sheet.getAttribute('data-workbench-sheets-path') || '')
          sheetAddress = String(sheet.getAttribute('data-workbench-sheets-address') || '')
        }
      } catch (error) { /* 属性可能暂不存在 */ }
      let previewUrl = ''
      try {
        const preview = pane.querySelector(PREVIEW_URL_SELECTOR)
        if (preview) previewUrl = String(preview.getAttribute('data-textpreview-url') || '')
      } catch (error) { /* ignore */ }
      return inferActiveSource({ sheetPath, sheetAddress, previewUrl })
    }

    /** 官方右侧栏打开的文件页签（标题像文件名，或由调用方按推断补 path）。 */
    function sidebarFileTabs() {
      const tabs = []
      try {
        const root = visibleSidebarRoot()
        if (root === null || typeof root.querySelectorAll !== 'function') return tabs
        for (const chip of root.querySelectorAll(SIDEBAR_TAB_SELECTOR)) {
          if (!chip || typeof chip.getAttribute !== 'function') continue
          const titleEl = typeof chip.querySelector === 'function' ? chip.querySelector('[data-dockkit-tab-title]') : null
          const label = cleanTabLabel(titleEl ? titleEl.textContent : chip.textContent)
          if (!label) continue
          const active = chip.getAttribute('aria-selected') === 'true'
          // 不把「终端/浏览器/计划/轨迹」等非文件页签收进打开列表
          if (!looksLikeFileTitle(label)) continue
          tabs.push({ label, active })
        }
      } catch (error) { /* DOM 结构变化时忽略 */ }
      return tabs
    }

    // 测试与诊断用：暴露纯函数（client 不能 import lib，靠沙盒测试与 lib/sources.js 对齐）。
    debug.helpers = {
      parseResourceAddress,
      inferActiveSource,
      looksLikeFileTitle,
      sidebarFileTabs,
      inferSidePaneActive,
    }

    /** 页签标题：优先 span.edrv-group-tab-name（vscode-mode 的实际结构），否则遍历文本兜底。 */
    function labelOfTab(tab) {
      try {
        const name = tab.querySelector ? tab.querySelector('.edrv-group-tab-name') : null
        if (name && name.textContent && name.textContent.trim()) return cleanTabLabel(name.textContent)
      } catch (error) { /* 结构变化时走文本兜底 */ }
      try {
        let text = ''
        const walk = (node) => {
          if (!node) return
          if (node.nodeType === Node.TEXT_NODE) { text += node.textContent || ''; return }
          if (node.nodeType !== Node.ELEMENT_NODE) return
          // 跳过固定钉、未保存星号与关闭按钮，它们不是文件名
          if (node.matches && node.matches(TAB_CLOSE_SELECTOR + ', .edrv-tab-pin, .edrv-tab-star')) return
          for (const child of node.childNodes) walk(child)
        }
        walk(tab)
        return cleanTabLabel(text)
      } catch (error) {
        return ''
      }
    }

    /**
     * 工作台里已打开的 edrv 页签（DOM 是「打开的文件」的事实来源；非文本页签没有 Monaco model）。
     * 分屏时每个 group 各有一个 aria-selected 页签，用 groupFocused 标出聚焦分屏里的那个。
     */
    function domTabs() {
      const tabs = []
      try {
        for (const tab of document.querySelectorAll(TAB_SELECTOR)) {
          if (!tab || typeof tab.getAttribute !== 'function') continue
          const label = labelOfTab(tab)
          const tabPath = String(tab.getAttribute('data-edrv-tab-path') || '').trim()
          if (!label && !tabPath) continue
          const active = (tab.classList && tab.classList.contains('edrv-tab-active')) || tab.getAttribute('aria-selected') === 'true'
          let groupFocused = false
          try {
            const group = tab.closest ? tab.closest('.edrv-group') : null
            groupFocused = !!(group && group.classList && group.classList.contains('edrv-group-focused'))
          } catch (error) { /* ignore */ }
          tabs.push({ label: label || basenameOf(tabPath), path: tabPath, active, groupFocused })
        }
      } catch (error) {
        /* 忽略 DOM 结构变化 */
      }
      return tabs
    }

    /** 变更是否发生在编辑器或官方右侧栏区域内（避免聊天流式输出把上报打成高频）。 */
    function isContextSurface(node) {
      try {
        const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement
        if (!el || typeof el.closest !== 'function') return false
        return el.closest('[data-edrv-view], .edrv-tabs, [data-sidebar-right-session], [data-dockkit-pane], [data-dockkit-strip]') !== null
      } catch (error) {
        return false
      }
    }

    function apply(ctx) {
      let disposed = false
      let monaco = null
      let monacoTimer = 0
      let monacoDeadline = Date.now() + MONACO_WAIT_MS
      let reportTimer = 0
      let lastSerialized = ''
      let lastPostAt = 0
      /** 上报失败后的退避时间点（避免服务不可用时每 1.5s 重试刷屏）。 */
      let retryNotBefore = 0
      let activeEditor = null
      let editorDisposers = []
      let lastSessionId = currentSessionId()
      let lastView = currentView()
      /** editor → 上次上报时它的 model 路径（检测页签切换导致的 model 更换）。 */
      const editorModelPaths = new WeakMap()
      /**
       * 曾经出现在 Monaco 里的路径 → 最近一次有 model 的时间。只用于页签切换瞬间的抖动保护
       * （model 创建前的一两个报告）；过期后不再冒充活动文本，让位给官方侧栏推断。
       */
      const knownTextPaths = new Map()
      const KNOWN_TEXT_FRESH_MS = 8 * 1000

      /** 文本模型路径列表（Monaco 打开过的文件）。 */
      function openPaths() {
        const paths = []
        if (monaco !== null) {
          try {
            for (const model of monaco.editor.getModels()) {
              const path = modelPathOf(model)
              if (path && !paths.includes(path)) paths.push(path)
            }
          } catch (error) { /* ignore */ }
        }
        return paths
      }

      function editorModelPath(editor) {
        try { return editor && editor.getModel ? modelPathOf(editor.getModel()) : null } catch (error) { return null }
      }

      function isVisibleEditor(editor) {
        try {
          const node = editor.getDomNode && editor.getDomNode()
          return !!(node && node.offsetParent !== null)
        } catch (error) {
          return false
        }
      }

      function modelByPath(path) {
        if (monaco === null || !path) return null
        try {
          for (const model of monaco.editor.getModels()) {
            if (samePath(modelPathOf(model), path)) return model
          }
        } catch (error) { /* ignore */ }
        return null
      }

      /** 当前活动文本编辑器（仅在没有页签信息时兜底：优先最后获得焦点的，其次任一可见编辑器）。 */
      function pickActiveEditor() {
        if (monaco === null) return null
        try {
          const editors = typeof monaco.editor.getEditors === 'function' ? monaco.editor.getEditors() : []
          if (activeEditor && editors.includes(activeEditor)) return activeEditor
          for (const editor of editors) {
            if (isVisibleEditor(editor)) return editor
          }
        } catch (error) { /* ignore */ }
        return null
      }

      /** 打开列表里是否已有同一文件（按 path 或 label 去重）。 */
      function openHas(open, path, label) {
        for (const item of open) {
          if (path && item.path && samePath(item.path, path)) return true
          if (label && (item.label === label || (item.path && basenameOf(item.path) === label))) return true
        }
        return false
      }

      /** 组装一次上报负载（没有任何可报告事实时返回 null）。 */
      function buildReport() {
        const sessionId = currentSessionId()
        let editors = []
        try {
          if (monaco !== null && typeof monaco.editor.getEditors === 'function') editors = monaco.editor.getEditors()
        } catch (error) { /* ignore */ }
        const tabs = domTabs()
        const modelPaths = openPaths()
        const builtAt = Date.now()
        for (const path of modelPaths) knownTextPaths.set(path, builtAt)
        // 长时间运行别无限累积：只保留最近一批，避免内存缓慢增长
        if (knownTextPaths.size > 400) {
          knownTextPaths.clear()
          for (const path of modelPaths) knownTextPaths.set(path, builtAt)
        }
        // 分屏时优先取聚焦分屏的活动页签，否则退回第一个活动页签。
        const activeTab = tabs.find((tab) => tab.active && tab.groupFocused) || tabs.find((tab) => tab.active) || null
        // 官方右侧栏：推断活动文件 + 判断用户是不是正在看侧栏（焦点在侧栏或 edrv 编辑器不可见）。
        const inferred = inferSidePaneActive()
        const sidebarFocused = sidebarHasFocus()
        const anyEditorVisible = editors.some(isVisibleEditor)
        const preferSide = inferred !== null && (sidebarFocused || !anyEditorVisible)

        // ① 活动文件以 edrv 活动页签为准（除非用户正在看官方侧栏）：只要它对应得到文本模型
        //    （或刚开过），就是活动文本文件；PDF / 计划页签这类对应不到文本模型的 → 交给 ③。
        let activePath = null
        let selectionEditor = null
        if (!preferSide) {
          if (activeTab !== null) {
            const tabPath = activeTab.path
            if (tabPath) {
              const candidates = editors.filter((editor) => samePath(editorModelPath(editor), tabPath))
              /** 是否「刚开过」的文本文件（8 秒新鲜度，覆盖页签切换后 model 创建前的一两个报告）。 */
              let recentlyKnown = false
              for (const [knownPath, knownAt] of knownTextPaths) {
                if (samePath(knownPath, tabPath) && builtAt - knownAt < KNOWN_TEXT_FRESH_MS) { recentlyKnown = true; break }
              }
              const textKnown = findSamePath(modelPaths, tabPath) !== null || recentlyKnown
              if (textKnown || candidates.length > 0) {
                // 页签路径是 UI 的规范形态（工作区外可能是绝对路径），优先用它
                activePath = tabPath
                selectionEditor = candidates.find(isVisibleEditor) || candidates[0] || null
              }
            }
          } else {
            // ② 没有页签信息（DOM 结构变化/旧版 vscode-mode）时退回焦点编辑器，保持旧行为。
            const fallback = pickActiveEditor()
            if (fallback !== null) {
              const path = editorModelPath(fallback)
              if (path) { activePath = path; selectionEditor = fallback }
            }
          }
        }

        // ③ edrv 没有活动文本文件（或用户正在看官方侧栏）时，用官方侧栏活动 pane 的推断
        //    （CSV/XLSX 表格、PDF/Word/PPT 预览）。
        const sideActive = inferred !== null && (preferSide || activePath === null)

        let activePayload = null
        if (activePath !== null) {
          activePayload = { path: activePath }
          const model = modelByPath(activePath)
          if (model !== null) {
            try {
              const language = model.getLanguageId()
              if (language) activePayload.language = language
            } catch (error) { /* ignore */ }
          }
          // 选区/光标只采信「model 与活动文件一致」的编辑器：切换到别的页签后，
          // 旧编辑器的选区不能被算到新路径头上；model 刚换（A→B）的这一轮也先清空，
          // 等 onDidChangeCursorSelection 的下一轮再补。
          const currentModelPath = selectionEditor === null ? null : editorModelPath(selectionEditor)
          if (selectionEditor !== null && samePath(currentModelPath, activePath)) {
            const previousPath = editorModelPaths.get(selectionEditor)
            editorModelPaths.set(selectionEditor, currentModelPath)
            const switched = previousPath !== undefined && !samePath(previousPath, currentModelPath)
            if (!switched) {
              try {
                const selection = selectionEditor.getSelection()
                const position = selectionEditor.getPosition()
                if (selection) {
                  const startLine = Math.min(selection.startLineNumber, selection.endLineNumber)
                  const endLine = Math.max(selection.startLineNumber, selection.endLineNumber)
                  const hasRange = startLine !== endLine || selection.startColumn !== selection.endColumn
                  if (hasRange) activePayload.selection = { startLine, endLine }
                }
                if (position && position.lineNumber) activePayload.cursorLine = position.lineNumber
              } catch (error) { /* ignore */ }
            }
          }
        } else if (sideActive) {
          activePayload = { path: inferred.path, source: inferred.source }
        }

        // 打开页签：先按 edrv 页签顺序（含非文本页签），再补「有 model 但暂时没页签」的文本文件，
        // 最后补官方右侧栏打开的文件页签（标题像文件名的，或本次推断出的活动文件）。
        const open = []
        const seen = new Set()
        for (const tab of tabs) {
          const key = tab.path ? 'p:' + tab.path : 'l:' + tab.label
          if (seen.has(key)) {
            // 同一个文件在两个分屏都有页签时，保住「活动页签」标记
            if (tab === activeTab) {
              const existing = open.find((item) => (tab.path ? item.path === tab.path : item.label === tab.label))
              if (existing) existing.active = true
            }
            continue
          }
          seen.add(key)
          const entry = { label: tab.label || basenameOf(tab.path), path: tab.path }
          // 只把「本次选中的活动页签」标成 active（分屏时其他 group 也有各自的活动页签）；
          // 若活动文件其实来自官方侧栏（inferred），edrv 的页签不算当前活动页签。
          if (tab === activeTab && !sideActive) entry.active = true
          open.push(entry)
        }
        for (const path of modelPaths) {
          if (open.some((item) => samePath(item.path, path))) continue
          open.push({ label: basenameOf(path), path })
        }
        for (const sideTab of sidebarFileTabs()) {
          if (openHas(open, '', sideTab.label)) continue
          open.push({ label: sideTab.label, path: '' })
        }
        // 标记本次活动文件：edrv 文本文件，或从官方侧栏推断出的表格/预览文件。
        if (activePath !== null) {
          const hit = open.find((item) => samePath(item.path, activePath))
          if (hit) hit.active = true
        }
        if (sideActive) {
          const label = basenameOf(inferred.path)
          const hit = open.find((item) => samePath(item.path, inferred.path) || item.label === label)
          if (hit) hit.active = true
          else open.push({ label, path: inferred.path, active: true })
        }
        if (open.length > 60) open.length = 60

        const hasContent = activePayload !== null || open.length > 0
        // 从未上报过且没有任何事实：等编辑器出现再报；若之前上报过内容、现在全空了，
        // 要发一次空快照，让 Host 清掉陈旧的活动文件。
        if (!hasContent && lastSerialized === '') return null

        const report = { sessionId, at: Date.now() }
        const view = currentView()
        if (view !== undefined) report.view = view
        report.active = activePayload
        report.open = open
        return report
      }

      async function sendReport() {
        if (disposed) return
        const report = buildReport()
        if (report === null) return
        const serialized = JSON.stringify(report, (key, value) => (key === 'at' ? undefined : value))
        const unchanged = serialized === lastSerialized
        // 状态没变但距上次成功上报已超过 REPOST_UNCHANGED_MS 时，重发一次刷新 Host 端时间戳（TTL）。
        const stale = lastPostAt > 0 && Date.now() - lastPostAt > REPOST_UNCHANGED_MS
        // 上次失败（lastPostAt=0）时按退避窗口重试，避免服务不可用时每 1.5s 刷屏
        const retryDue = lastPostAt === 0 && Date.now() >= retryNotBefore
        if (unchanged && !stale && !retryDue) return
        lastSerialized = serialized
        debug.lastReport = report
        debug.lastSentAt = Date.now()
        try {
          const response = await fetch(appUrlOf(REPORT_URL), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(report),
          })
          if (response.ok) {
            debug.reports += 1
            lastPostAt = Date.now()
          } else {
            debug.errors.push('HTTP ' + response.status)
            lastPostAt = 0
            retryNotBefore = Date.now() + FAIL_RETRY_MS
          }
        } catch (error) {
          debug.errors.push(String((error && error.message) || error))
          lastPostAt = 0
          retryNotBefore = Date.now() + FAIL_RETRY_MS
        }
      }

      function scheduleReport() {
        if (disposed) return
        window.clearTimeout(reportTimer)
        reportTimer = window.setTimeout(() => { void sendReport() }, DEBOUNCE_MS)
      }

      function attachEditor(editor) {
        try {
          editorDisposers.push(editor.onDidFocusEditorText(() => { activeEditor = editor; scheduleReport() }))
          editorDisposers.push(editor.onDidChangeCursorSelection(() => { activeEditor = editor; scheduleReport() }))
          // 同一编辑器换 model（页签切换常见）→ 立即重算。不要在这里清 editorModelPaths：
          // buildReport 靠「上一次的 model 路径 ≠ 当前路径」判断刚切换，从而跳过这一轮的旧选区。
          editorDisposers.push(editor.onDidChangeModel(() => {
            activeEditor = editor
            scheduleReport()
          }))
        } catch (error) { /* 单个编辑器挂载失败不影响其他 */ }
      }

      function attachEditors() {
        if (monaco === null || typeof monaco.editor.onDidCreateEditor !== 'function') return
        try {
          editorDisposers.push(monaco.editor.onDidCreateEditor((editor) => { attachEditor(editor); scheduleReport() }))
        } catch (error) {
          debug.errors.push('onDidCreateEditor: ' + String((error && error.message) || error))
        }
        // 已存在的编辑器补挂监听（onDidCreateEditor 之后创建的会走上面的回调）。
        try {
          const editors = typeof monaco.editor.getEditors === 'function' ? monaco.editor.getEditors() : []
          for (const editor of editors) attachEditor(editor)
        } catch (error) { /* ignore */ }
      }

      function watchMonaco() {
        if (disposed) return
        if (window.monaco && window.monaco.editor) {
          monaco = window.monaco
          debug.monacoFoundAt = Date.now()
          attachEditors()
          scheduleReport()
          return
        }
        if (Date.now() > monacoDeadline) { debug.errors.push('Monaco 未出现'); return }
        monacoTimer = window.setTimeout(watchMonaco, MONACO_POLL_MS)
      }

      // 页签点击/切换（即使编辑器没有重新 focus）也要更新活动文件：
      // 监听编辑器与官方右侧栏区域内的页签增删、class/aria-selected 与活动 pane 变化，去抖 300ms 后重算。
      let tabObserver = null
      try {
        const observeTarget = document.body || document.documentElement
        if (observeTarget) {
          tabObserver = new MutationObserver((records) => {
            for (const record of records) {
              if (isContextSurface(record.target)) { scheduleReport(); return }
              if (record.type !== 'childList') continue
              for (const node of record.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue
                const matches = node.matches && node.matches(TAB_SELECTOR + ', .edrv-tabs, [data-dockkit-tab], [data-dockkit-pane]')
                const nested = node.querySelector && node.querySelector(TAB_SELECTOR + ', ' + SIDEBAR_TAB_SELECTOR + ', [data-textpreview-url], [data-workbench-sheets-path]')
                if (matches || nested) {
                  scheduleReport()
                  return
                }
              }
            }
          })
          tabObserver.observe(observeTarget, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'aria-selected', 'data-edrv-tab-path', 'data-dockkit-pane-active', 'data-dockkit-float-active'],
          })
        }
      } catch (error) {
        debug.errors.push('tabs observer: ' + String((error && error.message) || error))
      }

      const onTabPointer = (event) => {
        try {
          const target = event.target
          const el = target && target.nodeType === Node.ELEMENT_NODE ? target : target && target.parentElement
          if (!el || typeof el.closest !== 'function') return
          if (el.closest(TAB_SELECTOR)) { scheduleReport(); return }
          if (el.closest(SIDEBAR_TAB_SELECTOR)) { scheduleReport(); return }
          // 点官方侧栏正文会切换活动 pane / 页签，也重算一次
          if (el.closest('[data-dockkit-pane], [data-dockkit-float]')) scheduleReport()
        } catch (error) { /* ignore */ }
      }
      document.addEventListener('pointerdown', onTabPointer, true)
      document.addEventListener('click', onTabPointer, true)

      // 会话 / 视图切换与焦点变化都可能改变上下文：轻量轮询 + 事件共同触发。
      const sessionTimer = window.setInterval(() => {
        if (disposed) return
        const sessionId = currentSessionId()
        const view = currentView()
        if (sessionId !== lastSessionId || view !== lastView) {
          lastSessionId = sessionId
          lastView = view
          scheduleReport()
          return
        }
        // 长时间无编辑时定期重发，保证 Host 端快照不会因为 TTL 过期而消失。
        if (Date.now() - lastPostAt > REPOST_UNCHANGED_MS) scheduleReport()
      }, SESSION_POLL_MS)

      const onFocusIn = () => { scheduleReport() }
      const onVisibility = () => { if (document.visibilityState === 'visible') scheduleReport() }
      window.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('visibilitychange', onVisibility)

      watchMonaco()

      const cleanup = () => {
        disposed = true
        window.clearTimeout(reportTimer)
        window.clearTimeout(monacoTimer)
        window.clearInterval(sessionTimer)
        if (tabObserver !== null) { try { tabObserver.disconnect() } catch (error) { /* ignore */ } }
        document.removeEventListener('pointerdown', onTabPointer, true)
        document.removeEventListener('click', onTabPointer, true)
        window.removeEventListener('focusin', onFocusIn, true)
        document.removeEventListener('visibilitychange', onVisibility)
        for (const dispose of editorDisposers) { try { dispose() } catch (error) { /* ignore */ } }
        editorDisposers = []
      }
      ctx.effect(() => cleanup, 'editor-context: browser observers')
    }

    return { inject: [], apply }
  },
})
