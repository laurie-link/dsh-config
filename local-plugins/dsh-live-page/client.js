/**
 * dsh-live-page — Client half (plain JS, no build step).
 *
 * 浏览器半的职责（契约见 CONTRACT.md）：
 *  1. 在 composer 工具行（`conversation.input.left`）放一个紧凑按钮：把当前活动的
 *     HTML 交给 Host 的 `/live-page/open` 解析成 live 地址，再在官方右侧栏打开一个
 *     Browser tab；没有活动 HTML 时打开工作区页面列表。
 *  2. 注册快捷键 `dshLivePage.openCurrentHtml`（Desktop/Web 都是 primary+shift+KeyE），
 *     并监听 fork 派发的 `dsh-live:open` 事件，走同一条打开流程。
 *  3. 轮询官方右侧栏里的 Electron `<webview data-sidebar-browser-frame="webview">`：
 *     上报当前页面（`/live-page/report`），并读取页面内选区，把选中文本作为引用插进
 *     当前会话的 composer（优先 `inputActions.insertQuote`，其次输入门面，最后
 *     Markdown `> ` 纯文本兜底）。
 *  4. 接收 live 页面 overlay 的 `postMessage`（`dsh-live-selection`），校验
 *     `event.origin`（`GET /live-page/servers` 的 origin 集合，未知时重拉一次）
 *     以及已知 nonce 后，走同一条引用插入流程。
 *
 * 本文件只可 require loader 提供的平台模块（react），不 import 任何本地文件；
 * 纯函数部分暴露在 `window.__dshLivePageDebug.helpers` 供 node:vm 测试复用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-page',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ---------------------------------------------------------------- 常量 --

    /** Locale namespace / plugin id. */
    const NS = 'dsh-live-page'
    const PLUGIN_ID = 'dsh-live-page'
    /** Composer slot and its cell key. */
    const SLOT_INPUT_LEFT = 'conversation.input.left'
    /** Shortcut command id owned by this plugin. */
    const SHORTCUT_ID = 'dshLivePage.openCurrentHtml'
    /** Window event dispatched by the local dsh-vscode-mode fork. */
    const EVENT_OPEN = 'dsh-live:open'
    /** Host (same-origin) routes. */
    const ROUTE_OPEN = '/live-page/open'
    const ROUTE_REPORT = '/live-page/report'
    const ROUTE_SERVERS = '/live-page/servers'

    /** v1 constants from CONTRACT §6 (kept in sync with the Host half). */
    const MIN_SELECTION_CHARS = 2
    const MAX_QUOTE_CHARS = 8000
    const SELECTION_POLL_MS = 400
    const SELECTION_DEBOUNCE_MS = 450
    const PAGE_POLL_MS = 700
    const PAGE_REPORT_REFRESH_MS = 5 * 60 * 1000
    const QUOTE_SOURCE = true
    const HTML_EXTENSIONS = ['html', 'htm', 'xhtml', 'shtml']

    /** Local-only guards. */
    const OPEN_GUARD_MS = 800
    const MAX_ERRORS = 60
    const TOAST_MS = 4200
    const ORIGIN_REFETCH_MS = 1500
    const COMPOSER_ORDER = 30

    /** DOM selectors shared with dsh-editor-context / official sidebar packages. */
    const SIDEBAR_SESSION_SELECTOR = '[data-sidebar-right-session]'
    const SIDEBAR_SESSION_ATTR = 'data-sidebar-right-session'
    const SIDEBAR_ACTIVE_PANE_SELECTOR = '[data-dockkit-pane-active], [data-dockkit-float-active]'
    const SIDEBAR_PANE_SELECTOR = '[data-dockkit-pane], [data-dockkit-float]'
    const BROWSER_WEBVIEW_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]'
    const DOCKKIT_TAB_SELECTOR = '[role="tab"][data-dockkit-tab]'
    const DOCKKIT_TAB_TITLE_SELECTOR = '[data-dockkit-tab-title]'
    const EDITOR_ACTIVE_TAB_SELECTOR = '.edrv-tab-active[data-edrv-tab-path]'
    const EDITOR_SELECTED_TAB_SELECTOR = '[role="tab"][aria-selected="true"][data-edrv-tab-path]'
    const ED_RV_TAB_PATH_ATTR = 'data-edrv-tab-path'
    const CURSOR_MODE_SELECTOR = '[data-cursor-mode]'
    const CURSOR_MODE_ATTR = 'data-cursor-mode'

    /** Marker attributes for our own DOM. */
    const STYLE_ATTR = 'data-dsh-live-page'
    const TOAST_ATTR = 'data-dsh-live-page-toast'

    /** Geometry-free visibility helpers use `hidden`; we avoid layout reads where possible. */
    const TAB_LABEL_GLYPHS = /[\u00d7\u2715\u2716\u2717\u2a2f]/g

    /** Selection probe evaluated inside the guest page (plain ES5, JSON-safe). */
    const SELECTION_SCRIPT = [
      '(function () {',
      '  try {',
      '    var active = document.activeElement;',
      '    var tag = active && active.tagName ? String(active.tagName).toUpperCase() : "";',
      '    var editing = !!(active && (active.isContentEditable === true || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"));',
      '    var selection = window.getSelection ? window.getSelection() : null;',
      '    var text = selection && selection.isCollapsed !== true ? String(selection.toString()) : "";',
      '    return { text: text, editing: editing };',
      '  } catch (error) {',
      '    return { text: "", editing: true };',
      '  }',
      '})()',
    ].join('\n')

    // ------------------------------------------------------ pure functions --
    // 这些函数不碰 DOM / 网络，既被运行时调用，也被 tests/client.test.mjs 通过
    // window.__dshLivePageDebug.helpers 直接测试。

    /** Normalize backslashes to forward slashes. */
    function normalizeSlashes(value) {
      return String(value === null || value === undefined ? '' : value).replace(/\\/g, '/')
    }

    /** Lower-case suffix without the dot; '' when there is none. */
    function suffixOf(value) {
      const base = normalizeSlashes(value)
      const clean = base.split('?')[0].split('#')[0]
      const name = clean.slice(clean.lastIndexOf('/') + 1)
      const dot = name.lastIndexOf('.')
      return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    }

    /** True for a browser-renderable page path (.html/.htm/.xhtml/.shtml). */
    function isHtmlPath(value) {
      const suffix = suffixOf(value)
      return suffix !== '' && HTML_EXTENSIONS.indexOf(suffix) !== -1
    }

    /** Basename for labels. */
    function basenameOf(value) {
      const text = normalizeSlashes(value)
      return text.slice(text.lastIndexOf('/') + 1) || text
    }

    /** Remove control characters and collapse whitespace; capped like the Host side. */
    function cleanTitle(value) {
      const text = typeof value === 'string' ? value : ''
      return text
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300)
    }

    /** Tab label text without the trailing close glyph. */
    function cleanTabLabel(value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(TAB_LABEL_GLYPHS, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    /**
     * Display form of a page URL: drops the one-time `__live` token so it never
     * reaches the prompt context or the quote source line. Other query params
     * (e.g. ?lang=zh) survive because they identify the actual page.
     */
    function displayUrl(value) {
      const raw = typeof value === 'string' ? value.trim() : ''
      if (raw === '') return ''
      try {
        const url = new URL(raw)
        if (url.searchParams.has('__live')) url.searchParams.delete('__live')
        return url.href
      } catch (error) {
        return raw
      }
    }

    /** Origin form ('http://127.0.0.1:54321') or '' for anything unusable. */
    function normalizeOrigin(value) {
      if (typeof value !== 'string') return ''
      const text = value.trim()
      if (text === '' || text.length > 512) return ''
      try {
        const url = new URL(text)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
        return url.origin
      } catch (error) {
        return ''
      }
    }

    /** True when `origin` is in the live-server origin cache. */
    function liveOriginAllowed(origin, origins) {
      const normalized = normalizeOrigin(origin)
      if (normalized === '' || !Array.isArray(origins)) return false
      for (const candidate of origins) {
        if (normalizeOrigin(candidate) === normalized) return true
      }
      return false
    }

    /**
     * Nonce gate: an empty known set means the Host does not expose nonces, so
     * the origin check is authoritative; once nonces are known they must match.
     */
    function nonceAllowed(nonce, knownNonces) {
      if (!knownNonces || typeof knownNonces.has !== 'function') return true
      if (knownNonces.size === 0) return true
      if (typeof nonce !== 'string' || nonce === '') return false
      return knownNonces.has(nonce)
    }

    /** Normalize selection text: CRLF → LF, strip control characters, trim ends. */
    function normalizeSelectionText(value) {
      if (typeof value !== 'string') return ''
      return value
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .trim()
    }

    /** Normalize one guest-page selection probe (`executeJavaScript` result). */
    function normalizeSelectionReading(raw) {
      if (!raw || typeof raw !== 'object') return { text: '', editing: true }
      const editing = raw.editing === true
      const text = normalizeSelectionText(raw.text)
      return editing ? { text: '', editing: true } : { text: text, editing: false }
    }

    /**
     * Decide whether a probed selection should become a quote right now.
     * @returns {{accept:boolean, reason:'invalid'|'editing'|'short'|'duplicate'|'quote', text:string}}
     */
    function selectionDecision(input) {
      if (!input || typeof input !== 'object') return { accept: false, reason: 'invalid', text: '' }
      const text = normalizeSelectionText(input.text)
      if (input.editing === true) return { accept: false, reason: 'editing', text: '' }
      if (text.length < MIN_SELECTION_CHARS) return { accept: false, reason: 'short', text: text }
      const lastQuoted = typeof input.lastQuoted === 'string' ? input.lastQuoted : ''
      if (lastQuoted !== '' && lastQuoted === text) return { accept: false, reason: 'duplicate', text: text }
      return { accept: true, reason: 'quote', text: text }
    }

    /** Page snapshot normalization for `/live-page/report` and quote sources. */
    function normalizePage(input) {
      if (!input || typeof input !== 'object') return null
      const rawInput = typeof input.url === 'string' ? input.url.trim() : ''
      if (rawInput === '' || rawInput.length > 2048) return null
      const raw = displayUrl(rawInput)
      if (raw === '' || raw.length > 2048) return null
      let parsed
      try {
        parsed = new URL(raw)
      } catch (error) {
        return null
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      const title = cleanTitle(input.title) || parsed.hostname
      return { url: parsed.href, title: title, kind: 'browser' }
    }

    /** Pick the active HTML path from tab-path attributes (active tab first). */
    function pickActiveHtmlPath(input) {
      if (!input || typeof input !== 'object') return ''
      const keys = ['activePath', 'selectedPath']
      for (const key of keys) {
        const value = typeof input[key] === 'string' ? input[key].trim() : ''
        if (value !== '' && isHtmlPath(value)) return value
      }
      return ''
    }

    /** Truncate quote body text to MAX_QUOTE_CHARS (source line is appended later). */
    function truncateQuoteText(value, max) {
      const text = normalizeSelectionText(value)
      const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_QUOTE_CHARS
      return text.length > limit ? text.slice(0, limit) : text
    }

    /** CONTRACT QUOTE_SOURCE tail: `— from <title> (<file 或 url>)`. */
    function formatQuoteSource(input) {
      if (!QUOTE_SOURCE) return ''
      const source = input && typeof input === 'object' ? input : {}
      const title = cleanTitle(source.title)
      let where = ''
      if (typeof source.file === 'string' && source.file.trim() !== '') {
        where = normalizeSlashes(source.file).replace(/^\/+/, '').trim()
      }
      if (where === '') where = displayUrl(source.url)
      if (where.length > 500) where = where.slice(0, 500)
      if (where === '') return title === '' ? '' : '\u2014 from ' + title
      if (title === '') return '\u2014 from ' + where
      // Avoid `foo.html (a/foo.html)` noise when the title is just the file name.
      if (title === where || where.slice(-(title.length + 1)) === '/' + title) return '\u2014 from ' + where
      return '\u2014 from ' + title + ' (' + where + ')'
    }

    /** Quote text handed to `insertQuote` (body + source line). */
    function formatQuoteContent(text, source) {
      const body = normalizeSelectionText(text)
      const tail = typeof source === 'string' ? source.trim() : ''
      if (body === '') return tail
      return tail === '' ? body : body + '\n\n' + tail
    }

    /** Markdown blockquote fallback: one `> ` prefix per line. */
    function formatQuoteMarkdown(content) {
      const lines = String(content === null || content === undefined ? '' : content)
        .replace(/\r\n?/g, '\n')
        .split('\n')
      return lines.map((line) => (line === '' ? '>' : '> ' + line)).join('\n')
    }

    /** `[data-cursor-mode="agent"]` means the IDE view is not the active layout. */
    function isAgentView(mode) {
      return typeof mode === 'string' && mode.trim() === 'agent'
    }

    /** Debug helper surface (node:vm tests import these directly). */
    const HELPERS = Object.freeze({
      suffixOf,
      isHtmlPath,
      basenameOf,
      cleanTitle,
      cleanTabLabel,
      displayUrl,
      normalizeOrigin,
      liveOriginAllowed,
      nonceAllowed,
      normalizeSelectionText,
      normalizeSelectionReading,
      selectionDecision,
      normalizePage,
      pickActiveHtmlPath,
      truncateQuoteText,
      formatQuoteSource,
      formatQuoteContent,
      formatQuoteMarkdown,
      isAgentView,
    })

    // ------------------------------------------------------------- locales --

    const ZH = {
      'button.label': '\u9875\u9762\u7f16\u8f91',
      'button.tooltip': '\u9875\u9762\u7f16\u8f91\uff1a\u5728 IDE \u6d4f\u89c8\u5668\u4e2d\u6253\u5f00\u5f53\u524d HTML',
      'shortcut.label': '\u5728 IDE \u6d4f\u89c8\u5668\u4e2d\u6253\u5f00\u5f53\u524d HTML',
      'notify.agentView': '\u5207\u6362\u5230 IDE \u89c6\u56fe\u540e\u4f7f\u7528',
      'notify.noSession': '\u65e0\u6cd5\u786e\u5b9a\u5f53\u524d\u4f1a\u8bdd\uff0c\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u5bf9\u8bdd',
      'notify.noBrowser': 'IDE \u6d4f\u89c8\u5668\u4e0d\u53ef\u7528\uff0c\u8bf7\u5148\u5728\u8bbe\u7f6e\u4e2d\u542f\u7528 Browser \u9762\u677f',
      'notify.openFailed': '\u6253\u5f00\u9875\u9762\u5931\u8d25',
      'notify.quoteFailed': '\u63d2\u5165\u9875\u9762\u9009\u533a\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5',
    }
    const EN = {
      'button.label': 'Page edit',
      'button.tooltip': 'Page edit: open the current HTML in the IDE browser',
      'shortcut.label': 'Open the current HTML in the IDE browser',
      'notify.agentView': 'Switch to the IDE view to use this',
      'notify.noSession': 'No conversation session is available; open a conversation first',
      'notify.noBrowser': 'The IDE browser is unavailable; enable the Browser panel in Settings first',
      'notify.openFailed': 'Failed to open the live page',
      'notify.quoteFailed': 'Failed to insert the page selection; try again',
    }
    const DICTIONARIES = { zh: ZH, en: EN }

    // ------------------------------------------------------------ utilities --

    /** Turn any thrown value into a short message. */
    function errorMessage(error) {
      if (error === null || error === undefined) return 'unknown error'
      if (typeof error === 'string') return error
      try {
        if (typeof error.message === 'string' && error.message !== '') return error.message
      } catch (ignore) {
        /* fall through */
      }
      return String(error)
    }

    /** Safe `ctx.get(name)` for optional services. */
    function serviceOf(ctx, name) {
      try {
        return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
      } catch (error) {
        return undefined
      }
    }

    /** Read one attribute as a trimmed string. */
    function attributeOf(node, name) {
      try {
        if (!node || typeof node.getAttribute !== 'function') return ''
        const value = node.getAttribute(name)
        return typeof value === 'string' ? value.trim() : ''
      } catch (error) {
        return ''
      }
    }

    /** Element visibility: hidden subtree members report no layout box. */
    function isVisibleElement(node) {
      try {
        if (!node) return false
        if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return false
        if (node.offsetParent !== null && node.offsetParent !== undefined) return true
        const rects = typeof node.getClientRects === 'function' ? node.getClientRects() : null
        return !!(rects && rects.length > 0)
      } catch (error) {
        return false
      }
    }

    /** `isConnected` without requiring it (older DOM/fakes do not expose it). */
    function isConnectedElement(node) {
      try {
        if (!node) return false
        return typeof node.isConnected === 'boolean' ? node.isConnected : true
      } catch (error) {
        return false
      }
    }

    /** Guarded string-returning method call (webview.getURL/getTitle). */
    function safeStringCall(target, method) {
      try {
        if (!target || typeof target[method] !== 'function') return ''
        const value = target[method]()
        return typeof value === 'string' ? value : ''
      } catch (error) {
        return ''
      }
    }

    /** Iterate a live NodeList/list defensively. */
    function eachNode(list, visit) {
      try {
        if (!list || typeof list.length !== 'number') return
        for (let index = 0; index < list.length; index += 1) visit(list[index])
      } catch (error) {
        /* DOM can change under us */
      }
    }

    // ---------------------------------------------------------------- apply --

    function apply(ctx) {
      // ---- debug + readiness (the fork shows its button only when ready) ----
      const debug = (window.__dshLivePageDebug = {
        at: Date.now(),
        probes: 0,
        errors: [],
        lastPage: null,
        lastReport: null,
        lastQuote: null,
        quotes: 0,
        lastOpen: null,
        liveOrigins: [],
        droppedMessages: 0,
        helpers: HELPERS,
      })
      window.__dshLivePageReady = true

      let disposed = false
      let boundTranslate = null
      let styleElement = null
      let pageTimer = 0
      let selectionTimer = 0
      let selectionDebounceTimer = 0
      let selectionBusy = false
      let lastWebview = null
      let lastSelectionProbeText = ''
      let lastQuotedText = ''
      let lastQuoteAt = 0
      let lastPage = null
      let openGuardKey = ''
      let openGuardAt = 0
      let originsFetch = null
      let originsFetchedAt = 0
      let liveOrigins = []
      let knownNonces = new Set()
      let lastComposerSessionId = ''

      /** Captured composer props (sessionId → inputActions), cleaned on unmount. */
      const capturedActions = new Map()
      /** Pending timeouts, cleared with the plugin. */
      const timers = new Set()
      /** Toast elements currently on screen. */
      const toastElements = new Set()
      /** sessionId → last reported page key. */
      const reportedPages = new Map()
      /** sessionId → last successful report time. */
      const reportTimes = new Map()
      /** sessionIds with an in-flight report. */
      const reportBusy = new Set()

      function pushError(message) {
        try {
          const text = String(message)
          debug.errors.push(text)
          if (debug.errors.length > MAX_ERRORS) debug.errors.splice(0, debug.errors.length - MAX_ERRORS)
        } catch (error) {
          /* diagnosis must never break behavior */
        }
      }

      // ---- localization ----

      /** Translate a key; falls back to the Chinese dictionary when the service is absent. */
      function t(key) {
        if (boundTranslate) {
          try {
            const value = boundTranslate(key)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch (error) {
            /* fall back below */
          }
        }
        const table = DICTIONARIES.zh || {}
        if (typeof table[key] === 'string' && table[key] !== '') return table[key]
        return typeof key === 'string' ? key : NS
      }

      function canUseLocale(locale) {
        return !!locale && typeof locale.register === 'function' && typeof locale.bind === 'function'
      }

      function attachLocale(scope) {
        if (disposed) return
        const locale = serviceOf(scope, 'locale')
        if (!canUseLocale(locale)) return
        try {
          boundTranslate = locale.bind(NS)
        } catch (error) {
          pushError('locale.bind: ' + errorMessage(error))
          return
        }
        try {
          const effect = typeof scope.effect === 'function' ? scope.effect : ctx.effect
          if (typeof effect === 'function') {
            effect(() => locale.register(NS, DICTIONARIES), 'dsh-live-page: locale dictionaries')
          }
        } catch (error) {
          pushError('locale.register: ' + errorMessage(error))
        }
      }

      attachLocale(ctx)
      if (!boundTranslate && typeof ctx.inject === 'function') {
        // The locale package may mount after this plugin; bind it lazily.
        try {
          ctx.inject(['locale'], (scope) => attachLocale(scope))
        } catch (error) {
          pushError('inject locale: ' + errorMessage(error))
        }
      }

      // ---- styles ----

      const STYLE_TEXT = [
        '[data-dsh-live-page-toast]{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);',
        'z-index:2147483000;max-width:min(460px,80vw);padding:8px 14px;border-radius:8px;',
        'background:var(--dsw-alias-bg-layer-2,#2b2b2b);color:var(--dsw-alias-label-primary,#fff);',
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));',
        'box-shadow:0 8px 24px rgba(0,0,0,.28);font:var(--dsw-font-xxs-12,12px/1.5 system-ui);',
        'pointer-events:none;white-space:pre-wrap;word-break:break-word}',
      ].join('')

      function installStyles() {
        try {
          const parent = (document && (document.head || document.documentElement)) || null
          if (!parent || typeof parent.appendChild !== 'function') return null
          const element = document.createElement('style')
          if (!element) return null
          if (typeof element.setAttribute === 'function') element.setAttribute(STYLE_ATTR, '1')
          element.textContent = STYLE_TEXT
          parent.appendChild(element)
          return element
        } catch (error) {
          pushError('styles: ' + errorMessage(error))
          return null
        }
      }

      function removeElement(element) {
        try {
          if (!element) return
          const parent = element.parentNode
          if (parent && typeof parent.removeChild === 'function') parent.removeChild(element)
          else if (typeof element.remove === 'function') element.remove()
        } catch (error) {
          /* removal is best-effort */
        }
      }

      styleElement = installStyles()

      // ---- timers / toast ----

      function later(callback, delayMs) {
        if (disposed) return 0
        let id = 0
        try {
          id = window.setTimeout(() => {
            timers.delete(id)
            if (disposed) return
            try {
              callback()
            } catch (error) {
              pushError('timer: ' + errorMessage(error))
            }
          }, delayMs)
          if (id) timers.add(id)
        } catch (error) {
          pushError('setTimeout: ' + errorMessage(error))
        }
        return id
      }

      function clearLater(id) {
        if (!id) return
        timers.delete(id)
        try {
          window.clearTimeout(id)
        } catch (error) {
          /* ignore */
        }
      }

      function showToast(message) {
        const text = String(message === null || message === undefined ? '' : message).trim()
        if (text === '' || disposed) return
        try {
          const body = document && document.body
          if (!body || typeof body.appendChild !== 'function') return
          const element = document.createElement('div')
          if (!element) return
          if (typeof element.setAttribute === 'function') {
            element.setAttribute(TOAST_ATTR, '1')
            element.setAttribute('role', 'status')
          }
          element.textContent = text
          body.appendChild(element)
          toastElements.add(element)
          later(() => {
            removeElement(element)
            toastElements.delete(element)
          }, TOAST_MS)
        } catch (error) {
          pushError('toast: ' + errorMessage(error))
        }
      }

      // ---- same-origin host requests ----

      /** Relative route → same-origin absolute URL (works under a mount subpath). */
      function appUrlOf(path) {
        try {
          const base = document && typeof document.baseURI === 'string' && document.baseURI !== ''
            ? document.baseURI
            : (typeof location !== 'undefined' && location && typeof location.href === 'string' ? location.href : '')
          const root = new URL('.', base || 'http://127.0.0.1/')
          return new URL(String(path).replace(/^\/+/, ''), root).href
        } catch (error) {
          return String(path)
        }
      }

      async function requestJson(url, options) {
        let response
        try {
          response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}))
        } catch (cause) {
          const error = new Error('\u65e0\u6cd5\u8fde\u63a5\u672c\u5730\u670d\u52a1\uff1a' + errorMessage(cause))
          error.code = 'network'
          throw error
        }
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        if (response && response.ok === true && payload && payload.ok === true) return payload
        const message = payload && typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : '\u8bf7\u6c42\u5931\u8d25\uff08HTTP ' + (response && response.status ? response.status : 0) + '\uff09'
        const error = new Error(message)
        error.status = response && typeof response.status === 'number' ? response.status : 0
        if (payload && typeof payload.code === 'string') error.code = payload.code
        throw error
      }

      function postJson(route, payload) {
        return requestJson(appUrlOf(route), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }

      // ---- DOM readers ----

      /** Current visible right-sidebar session id; '' when none. */
      function currentSessionId() {
        try {
          const nodes = document.querySelectorAll(SIDEBAR_SESSION_SELECTOR)
          let first = ''
          let found = ''
          eachNode(nodes, (node) => {
            if (found !== '' || !node || typeof node.getAttribute !== 'function') return
            const raw = String(node.getAttribute(SIDEBAR_SESSION_ATTR) || '').trim()
            if (raw === '') return
            if (first === '') first = raw
            const hidden = typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')
            const ariaHidden = typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true'
            if (!hidden && !ariaHidden) found = raw
          })
          return found !== '' ? found : first
        } catch (error) {
          return ''
        }
      }

      /** Layout mode marker set by dsh-cursor-layout on the app frame. */
      function readCursorMode() {
        try {
          const frame = document.querySelector(CURSOR_MODE_SELECTOR)
          return attributeOf(frame, CURSOR_MODE_ATTR)
        } catch (error) {
          return ''
        }
      }

      function isAgentViewNow() {
        return isAgentView(readCursorMode())
      }

      /** Visible right-sidebar session root (prefers the current session). */
      function visibleSidebarRoot() {
        try {
          const sessionId = currentSessionId()
          const nodes = document.querySelectorAll(SIDEBAR_SESSION_SELECTOR)
          let first = null
          let match = null
          eachNode(nodes, (node) => {
            if (!node || typeof node.getAttribute !== 'function') return
            if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return
            if (first === null) first = node
            if (match === null && sessionId !== '' && node.getAttribute(SIDEBAR_SESSION_ATTR) === sessionId) match = node
          })
          return match !== null ? match : first
        } catch (error) {
          return null
        }
      }

      /** Active pane within the right sidebar: active marker first, then any visible pane. */
      function activeSidePane(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return null
        const active = []
        try {
          eachNode(root.querySelectorAll(SIDEBAR_ACTIVE_PANE_SELECTOR), (node) => {
            if (isVisibleElement(node)) active.push(node)
          })
        } catch (error) {
          /* ignore */
        }
        if (active.length > 0) return active[active.length - 1]
        const fallback = []
        try {
          eachNode(root.querySelectorAll(SIDEBAR_PANE_SELECTOR), (node) => {
            if (isVisibleElement(node)) fallback.push(node)
          })
        } catch (error) {
          /* ignore */
        }
        return fallback.length > 0 ? fallback[fallback.length - 1] : null
      }

      /** Active HTML editor tab path, if the active IDE tab is an HTML file. */
      function activeEditorHtmlPath() {
        const paths = { activePath: '', selectedPath: '' }
        try {
          paths.activePath = attributeOf(document.querySelector(EDITOR_ACTIVE_TAB_SELECTOR), ED_RV_TAB_PATH_ATTR)
        } catch (error) {
          /* ignore */
        }
        try {
          paths.selectedPath = attributeOf(document.querySelector(EDITOR_SELECTED_TAB_SELECTOR), ED_RV_TAB_PATH_ATTR)
        } catch (error) {
          /* ignore */
        }
        return pickActiveHtmlPath(paths)
      }

      /** Visible browser webview inside the active pane (falls back to document-wide). */
      function findVisibleBrowserWebview(pane, root) {
        const scopes = []
        if (pane) scopes.push(pane)
        if (root && root !== pane) scopes.push(root)
        scopes.push(document)
        for (const scope of scopes) {
          if (!scope || typeof scope.querySelectorAll !== 'function') continue
          let nodes = null
          try {
            nodes = scope.querySelectorAll(BROWSER_WEBVIEW_SELECTOR)
          } catch (error) {
            continue
          }
          let hit = null
          eachNode(nodes, (node) => {
            if (hit === null && isVisibleElement(node)) hit = node
          })
          if (hit !== null) return hit
        }
        return null
      }

      /** The webview the probe should read this tick (cached when still valid). */
      function currentBrowserWebview() {
        if (lastWebview && isConnectedElement(lastWebview) && isVisibleElement(lastWebview)) return lastWebview
        const root = visibleSidebarRoot()
        const pane = activeSidePane(root)
        const found = findVisibleBrowserWebview(pane, root)
        lastWebview = found
        return found
      }

      /** Address-bar value as a page-URL fallback (webview getURL unavailable). */
      function addressInputValue(scope) {
        const scopes = scope ? [scope, document] : [document]
        for (const target of scopes) {
          if (!target || typeof target.querySelectorAll !== 'function') continue
          let inputs = null
          try {
            inputs = target.querySelectorAll('input')
          } catch (error) {
            continue
          }
          let hit = ''
          eachNode(inputs, (input) => {
            if (hit !== '' || !input) return
            const value = typeof input.value === 'string' ? input.value.trim() : ''
            if (!/^https?:\/\//i.test(value)) return
            if (!isVisibleElement(input)) return
            hit = value
          })
          if (hit !== '') return hit
        }
        return ''
      }

      /** Active sidebar tab title as a page-title fallback. */
      function tabTitleOf(scope) {
        if (!scope || typeof scope.querySelectorAll !== 'function') return ''
        let active = null
        try {
          eachNode(scope.querySelectorAll(DOCKKIT_TAB_SELECTOR), (tab) => {
            if (active !== null || !tab || typeof tab.getAttribute !== 'function') return
            if (tab.getAttribute('aria-selected') === 'true') active = tab
          })
        } catch (error) {
          return ''
        }
        if (!active) return ''
        let text = ''
        try {
          const titleElement = typeof active.querySelector === 'function' ? active.querySelector(DOCKKIT_TAB_TITLE_SELECTOR) : null
          text = titleElement && typeof titleElement.textContent === 'string'
            ? titleElement.textContent
            : (typeof active.textContent === 'string' ? active.textContent : '')
        } catch (error) {
          text = ''
        }
        return cleanTitle(cleanTabLabel(text))
      }

      /**
       * Read a normalized page snapshot from the active browser tab.
       * Desktop reads the webview; the Web GUI (iframe browser) falls back to
       * the address bar + active tab title, so page awareness still works even
       * though cross-origin selection cannot be read there.
       */
      function readPageFromWebview(webview, scope) {
        let url = webview ? safeStringCall(webview, 'getURL') : ''
        let title = webview ? safeStringCall(webview, 'getTitle') : ''
        if (url === '') url = addressInputValue(scope)
        if (title === '') title = tabTitleOf(scope)
        if (url === '') return null
        return normalizePage({ url: url, title: title })
      }

      // ---- service access ----

      /** sidebarRight (+ browser tab type) or null when the surface is unusable. */
      function sidebarServices() {
        const sidebarRight = serviceOf(ctx, 'sidebarRight')
        if (!sidebarRight || typeof sidebarRight.openTab !== 'function') return null
        const tabs = serviceOf(ctx, 'sidebarRightTabs')
        if (tabs && typeof tabs.get === 'function') {
          let browser = undefined
          try {
            browser = tabs.get('browser')
          } catch (error) {
            browser = undefined
          }
          if (!browser) return null
        }
        return { sidebarRight: sidebarRight }
      }

      /** Per-session input facade from `ctx.conversation`. */
      function inputFacade(sessionId) {
        if (!sessionId) return null
        try {
          const conversation = serviceOf(ctx, 'conversation')
          if (!conversation || !conversation.input || typeof conversation.input.for !== 'function') return null
          const sessions = serviceOf(ctx, 'sessions')
          let scope = null
          if (sessions && typeof sessions.binding === 'function') {
            try {
              const binding = sessions.binding(sessionId)
              if (binding && binding.ctx) scope = binding.ctx
            } catch (error) {
              scope = null
            }
          }
          if (!scope && sessions && typeof sessions.scope === 'function') {
            try {
              scope = sessions.scope(sessionId)
            } catch (error) {
              scope = null
            }
          }
          if (!scope) return null
          const facade = conversation.input.for(scope)
          return facade && typeof facade === 'object' ? facade : null
        } catch (error) {
          pushError('input facade: ' + errorMessage(error))
          return null
        }
      }

      /** Warn through the composer when possible; DOM toast otherwise. */
      function notify(level, message) {
        const text = String(message === null || message === undefined ? '' : message).trim()
        if (text === '') return
        const sessionId = currentSessionId() || lastComposerSessionId
        const facade = inputFacade(sessionId)
        if (facade && typeof facade.notify === 'function') {
          try {
            facade.notify(level === 'error' ? 'error' : 'warn', text)
            return
          } catch (error) {
            pushError('notify: ' + errorMessage(error))
          }
        }
        showToast(text)
      }

      // ---- open flow ----

      /** Open one live URL in a new official Browser tab. */
      function openBrowserTab(url) {
        if (typeof url !== 'string' || url === '') return false
        const services = sidebarServices()
        if (!services) {
          notify('warn', t('notify.noBrowser'))
          return false
        }
        try {
          services.sidebarRight.openTab('browser', { params: { url: url } })
          return true
        } catch (error) {
          pushError('openTab: ' + errorMessage(error))
          notify('warn', t('notify.noBrowser'))
          return false
        }
      }

      /** Kick off one async task without letting a rejection escape. */
      function guardPromise(promise) {
        try {
          if (promise && typeof promise.catch === 'function') {
            promise.catch((error) => pushError('async: ' + errorMessage(error)))
          }
        } catch (error) {
          pushError('async: ' + errorMessage(error))
        }
      }

      function onLiveOpen(event) {
        try {
          if (disposed) return
          const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : null
          const path = detail && typeof detail.path === 'string' ? detail.path : ''
          void openCurrentHtml(path === '' ? undefined : { path: path })
        } catch (error) {
          pushError('event: ' + errorMessage(error))
        }
      }

      // ---- quote insertion ----

      function recordQuote(channel, quoteContent, sessionId) {
        lastQuoteAt = Date.now()
        debug.quotes += 1
        debug.lastQuote = {
          channel: channel,
          sessionId: sessionId || '',
          text: quoteContent,
          at: lastQuoteAt,
        }
      }

      /**
       * Insert a quote into the current session composer.
       * Order: captured inputActions.insertQuote → captured insertText → input
       * facade insertQuote → facade insertText with a Markdown `> ` blockquote.
       */
      function insertQuoteIntoComposer(content, sessionId) {
        const body = normalizeSelectionText(content)
        if (body === '') return false
        const markdown = formatQuoteMarkdown(content)

        // 1. composer slot props captured by the mounted button.
        const captured = sessionId ? capturedActions.get(sessionId) : null
        if (captured && typeof captured.insertQuote === 'function') {
          try {
            if (captured.insertQuote(content) === true) {
              recordQuote('inputActions', content, sessionId)
              return true
            }
          } catch (error) {
            pushError('inputActions.insertQuote: ' + errorMessage(error))
          }
        }
        // 1b. same captured props, plain-text channel (no session facade needed).
        if (captured && typeof captured.insertText === 'function' && typeof captured.captureInsertion === 'function') {
          try {
            const insertion = captured.captureInsertion()
            if (insertion && typeof insertion.end === 'number' && isFinite(insertion.end)
              && typeof insertion.draftRev === 'number' && isFinite(insertion.draftRev)) {
              const span = { start: insertion.end, end: insertion.end, draftRev: insertion.draftRev }
              if (captured.insertText(markdown, span) === true) {
                recordQuote('inputActions.insertText', content, sessionId)
                return true
              }
            }
          } catch (error) {
            pushError('inputActions.insertText: ' + errorMessage(error))
          }
        }

        // 2. the per-session input facade (works when the button is not mounted).
        const facade = inputFacade(sessionId)
        if (facade) {
          if (typeof facade.insertQuote === 'function') {
            try {
              if (facade.insertQuote(content) === true) {
                recordQuote('insertQuote', content, sessionId)
                return true
              }
            } catch (error) {
              pushError('insertQuote: ' + errorMessage(error))
            }
          }

          // 3. plain Markdown blockquote through insertText.
          try {
            const snapshot = facade.state && typeof facade.state.getSnapshot === 'function'
              ? facade.state.getSnapshot()
              : null
            const draftRev = snapshot && typeof snapshot.draftRev === 'number' ? snapshot.draftRev : 0
            let at = snapshot && typeof snapshot.draft === 'string' ? snapshot.draft.length : 0
            if (typeof facade.caretSpan === 'function') {
              const caret = facade.caretSpan()
              if (caret && typeof caret.end === 'number' && isFinite(caret.end)) at = caret.end
            }
            if (typeof facade.insertText === 'function' && facade.insertText(markdown, { start: at, end: at, draftRev: draftRev }) === true) {
              recordQuote('insertText', content, sessionId)
              return true
            }
          } catch (error) {
            pushError('insertText: ' + errorMessage(error))
          }

          if (typeof facade.notify === 'function') {
            try {
              facade.notify('warn', t('notify.quoteFailed'))
            } catch (error) {
              pushError('quote notify: ' + errorMessage(error))
            }
          }
          return false
        }

        showToast(t('notify.quoteFailed'))
        return false
      }

      /**
       * Quote one selection (webview poll or overlay postMessage).
       * @param {{text?:string,title?:string,file?:string,url?:string,sessionId?:string}} selection
       */
      function quoteSelection(selection) {
        try {
          if (disposed || !selection || typeof selection !== 'object') return false
          const full = normalizeSelectionText(selection.text)
          if (full.length < MIN_SELECTION_CHARS) return false
          const truncated = truncateQuoteText(full, MAX_QUOTE_CHARS)
          const source = formatQuoteSource({ title: selection.title, file: selection.file, url: selection.url })
          const content = formatQuoteContent(truncated, source)
          const sessionId = typeof selection.sessionId === 'string' && selection.sessionId !== ''
            ? selection.sessionId
            : (currentSessionId() || lastComposerSessionId)
          const inserted = insertQuoteIntoComposer(content, sessionId)
          // Dedupe on the selected text itself (the source line is per-page metadata).
          if (inserted) lastQuotedText = truncated
          return inserted
        } catch (error) {
          pushError('quote: ' + errorMessage(error))
          return false
        }
      }

      // ---- browser page probe ----

      function isDocumentHidden() {
        try {
          if (!document) return false
          if (document.hidden === true) return true
          return document.visibilityState === 'hidden'
        } catch (error) {
          return false
        }
      }

      /** Report one page snapshot; null clears a previously reported page. */
      function reportPage(sessionId, page) {
        if (disposed || !sessionId) return Promise.resolve()
        const key = page ? page.url + '\u0000' + page.title : ''
        const previous = reportedPages.get(sessionId)
        if (page === null && previous === undefined) return Promise.resolve()
        const lastAt = reportTimes.get(sessionId) || 0
        if (page !== null && previous === key && Date.now() - lastAt < PAGE_REPORT_REFRESH_MS) return Promise.resolve()
        if (reportBusy.has(sessionId)) return Promise.resolve()
        reportBusy.add(sessionId)
        const payload = {
          sessionId: sessionId,
          page: page ? { url: page.url, title: page.title, kind: 'browser' } : null,
        }
        return postJson(ROUTE_REPORT, payload)
          .then(() => {
            if (page) reportedPages.set(sessionId, key)
            else reportedPages.delete(sessionId)
            reportTimes.set(sessionId, Date.now())
            debug.lastReport = { sessionId: sessionId, page: payload.page, at: Date.now() }
          })
          .catch((error) => {
            pushError('report: ' + errorMessage(error))
          })
          .then(() => {
            reportBusy.delete(sessionId)
          })
      }

      async function probePage() {
        if (disposed || isDocumentHidden()) return
        debug.probes += 1
        try {
          const sessionId = currentSessionId() || lastComposerSessionId
          if (!sessionId) {
            lastPage = null
            debug.lastPage = null
            return
          }
          const root = visibleSidebarRoot()
          const pane = activeSidePane(root)
          const webview = findVisibleBrowserWebview(pane, root)
          lastWebview = webview
          const page = readPageFromWebview(webview, pane || root)
          lastPage = page
          debug.lastPage = page
          await reportPage(sessionId, page)
        } catch (error) {
          pushError('probe: ' + errorMessage(error))
        }
      }

      // ---- selection polling (desktop webview) ----

      function clearSelectionDebounce() {
        if (selectionDebounceTimer) {
          clearLater(selectionDebounceTimer)
          selectionDebounceTimer = 0
        }
      }

      function handleSelectionProbe(raw) {
        if (disposed) return
        const reading = normalizeSelectionReading(raw)
        if (reading.editing) {
          clearSelectionDebounce()
          lastSelectionProbeText = ''
          lastQuotedText = ''
          debug.lastSelection = { text: '', editing: true, at: Date.now() }
          return
        }
        const text = reading.text
        if (text === lastSelectionProbeText) return
        lastSelectionProbeText = text
        debug.lastSelection = { text: text, editing: false, at: Date.now() }
        clearSelectionDebounce()
        if (text === '') {
          // Selection collapsed: a later re-selection of the same text may quote again.
          lastQuotedText = ''
          return
        }
        const decision = selectionDecision({ text: text, editing: false, lastQuoted: lastQuotedText })
        if (!decision.accept) return
        selectionDebounceTimer = later(() => {
          selectionDebounceTimer = 0
          if (disposed) return
          const latest = selectionDecision({
            text: lastSelectionProbeText,
            editing: false,
            lastQuoted: lastQuotedText,
          })
          if (!latest.accept) return
          const page = lastPage
          quoteSelection({
            text: latest.text,
            title: page ? page.title : '',
            url: page ? page.url : '',
            sessionId: currentSessionId() || lastComposerSessionId,
          })
        }, SELECTION_DEBOUNCE_MS)
      }

      async function pollSelection() {
        if (disposed || isDocumentHidden() || selectionBusy) return
        try {
          if (typeof document === 'undefined' || !document) return
        } catch (error) {
          return
        }
        try {
          const webview = currentBrowserWebview()
          if (!webview || typeof webview.executeJavaScript !== 'function') {
            if (lastSelectionProbeText !== '') {
              clearSelectionDebounce()
              lastSelectionProbeText = ''
              lastQuotedText = ''
            }
            return
          }
          selectionBusy = true
          let raw = null
          try {
            raw = await webview.executeJavaScript(SELECTION_SCRIPT, true)
          } catch (error) {
            pushError('executeJavaScript: ' + errorMessage(error))
            return
          } finally {
            selectionBusy = false
          }
          handleSelectionProbe(raw)
        } catch (error) {
          selectionBusy = false
          pushError('selection: ' + errorMessage(error))
        }
      }

      // ---- overlay postMessage (web iframe path) ----

      function refreshLiveOrigins() {
        if (originsFetch) return originsFetch
        const task = (async () => {
          try {
            const response = await requestJson(appUrlOf(ROUTE_SERVERS), { method: 'GET' })
            const servers = response && Array.isArray(response.servers) ? response.servers : []
            const origins = []
            const nonces = new Set()
            for (const server of servers) {
              if (!server || typeof server !== 'object') continue
              const origin = normalizeOrigin(server.origin)
              if (origin !== '' && origins.indexOf(origin) === -1) origins.push(origin)
              if (typeof server.nonce === 'string' && server.nonce !== '') nonces.add(server.nonce)
            }
            liveOrigins = origins
            knownNonces = nonces
            originsFetchedAt = Date.now()
            debug.liveOrigins = origins.slice()
          } catch (error) {
            pushError('servers: ' + errorMessage(error))
          } finally {
            originsFetch = null
          }
        })()
        originsFetch = task
        return task
      }

      /** Remember a live-server nonce handed back by /live-page/open or /live-page/servers. */
      function rememberNonce(payload) {
        try {
          const nonce = payload && typeof payload.nonce === 'string' ? payload.nonce.trim() : ''
          if (nonce === '') return
          if (!knownNonces || typeof knownNonces.add !== 'function') knownNonces = new Set()
          knownNonces.add(nonce)
          debug.knownNonces = knownNonces.size
        } catch (error) {
          /* nonce bookkeeping is best-effort */
        }
      }

      async function ensureLiveOrigin(origin) {
        if (disposed) return false
        if (liveOriginAllowed(origin, liveOrigins)) return true
        if (Date.now() - originsFetchedAt < ORIGIN_REFETCH_MS) return false
        await refreshLiveOrigins()
        return liveOriginAllowed(origin, liveOrigins)
      }

      async function handleOverlaySelection(origin, data) {
        try {
          if (disposed) return
          const text = normalizeSelectionText(data.text)
          if (text.length < MIN_SELECTION_CHARS) return
          const allowed = await ensureLiveOrigin(origin)
          if (!allowed) {
            debug.droppedMessages += 1
            return
          }
          if (!nonceAllowed(data.nonce, knownNonces)) {
            debug.droppedMessages += 1
            pushError('selection dropped: nonce mismatch')
            return
          }
          if (text === lastQuotedText && Date.now() - lastQuoteAt < 2000) return
          quoteSelection({
            text: text,
            title: typeof data.title === 'string' ? data.title : '',
            file: typeof data.file === 'string' ? data.file : '',
            url: typeof data.url === 'string' ? data.url : '',
            sessionId: currentSessionId() || lastComposerSessionId,
          })
        } catch (error) {
          pushError('overlay selection: ' + errorMessage(error))
        }
      }

      function onWindowMessage(event) {
        try {
          if (disposed || !event) return
          const data = event.data
          if (!data || typeof data !== 'object' || data.type !== 'dsh-live-selection') return
          const origin = typeof event.origin === 'string' ? event.origin : ''
          guardPromise(handleOverlaySelection(origin, data))
        } catch (error) {
          pushError('message: ' + errorMessage(error))
        }
      }

      function onVisibilityChange() {
        if (disposed) return
        if (isDocumentHidden()) return
        guardPromise(probePage())
        guardPromise(pollSelection())
      }

      // ---- composer session capture ----

      /**
       * Invisible composer-slot occupant.
       *
       * The open entry point lives in the editor path bar (「页面编辑」) and the
       * Ctrl/Cmd+Shift+E shortcut; the composer tool row deliberately shows no
       * extra button. This occupant exists only to receive the slot's standard
       * props, so the plugin learns the live session id and keeps the official
       * `inputActions` (insertQuote) for selected-text quotes. It renders null.
       */
      function ComposerCapture(props) {
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
        const inputActions = props && props.inputActions ? props.inputActions : null

        React.useEffect(() => {
          if (disposed) return undefined
          if (sessionId === '') return undefined
          lastComposerSessionId = sessionId
          if (inputActions) capturedActions.set(sessionId, inputActions)
          return () => {
            if (inputActions && capturedActions.get(sessionId) === inputActions) capturedActions.delete(sessionId)
          }
        }, [sessionId, inputActions])

        return null
      }

      /**
       * Open the live editor for the current page.
       * @param {{path?: string}} [options] explicit path (fork event detail).
       */
      function openCurrentHtml(options) {
        try {
          if (disposed) return
          if (isAgentViewNow()) {
            notify('warn', t('notify.agentView'))
            return
          }
          const sessionId = currentSessionId() || lastComposerSessionId
          if (!sessionId) {
            notify('warn', t('notify.noSession'))
            return
          }
          if (!sidebarServices()) {
            notify('warn', t('notify.noBrowser'))
            return
          }

          const requested = options && typeof options.path === 'string' ? options.path.trim() : ''
          let targetPath = requested !== '' && isHtmlPath(requested) ? requested : ''
          if (targetPath === '') targetPath = activeEditorHtmlPath()

          const guardKey = sessionId + '|' + targetPath
          const now = Date.now()
          if (guardKey === openGuardKey && now - openGuardAt < OPEN_GUARD_MS) return
          openGuardKey = guardKey
          openGuardAt = now

          const payload = targetPath === '' ? { sessionId: sessionId } : { sessionId: sessionId, path: targetPath }
          void (async () => {
            try {
              let response = null
              try {
                response = await postJson(ROUTE_OPEN, payload)
              } catch (error) {
                if (targetPath === '') throw error
                // The active HTML may sit outside this session's workspace; fall
                // back to the workspace listing instead of failing the click.
                pushError('open path: ' + errorMessage(error))
                targetPath = ''
                openGuardKey = sessionId + '|'
                openGuardAt = Date.now()
                response = await postJson(ROUTE_OPEN, { sessionId: sessionId })
              }
              rememberNonce(response)
              if (disposed) return
              const url = response && typeof response.url === 'string' ? response.url : ''
              if (url === '') throw new Error('missing url')
              if (openBrowserTab(url)) {
                debug.lastOpen = {
                  sessionId: sessionId,
                  path: targetPath === '' ? null : targetPath,
                  url: displayUrl(url),
                  at: Date.now(),
                }
              }
            } catch (error) {
              pushError('open: ' + errorMessage(error))
              notify('warn', t('notify.openFailed') + '\uff1a' + errorMessage(error))
            }
          })()
        } catch (error) {
          pushError('open: ' + errorMessage(error))
        }
      }
      // ---- registration + lifecycle ----

      /** Register the invisible composer occupant (session + inputActions capture). */
      function registerComposer() {
        if (typeof ctx.effect !== 'function' || !ctx.slots
          || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          pushError('slots unavailable')
          return
        }
        try {
          ctx.effect(
            () => ctx.slots.inject(SLOT_INPUT_LEFT, () => ctx.slots.register({
              name: SLOT_INPUT_LEFT,
              id: PLUGIN_ID,
              order: COMPOSER_ORDER,
              label: () => t('button.label'),
            }, ComposerCapture)),
            'dsh-live-page: composer session capture',
          )
        } catch (error) {
          pushError('composer slot: ' + errorMessage(error))
        }
      }

      /** primary+shift+KeyE on every explicit Desktop/Web profile (CONTRACT/task). */
      function shortcutBinding() {
        return { code: 'KeyE', modifiers: ['primary', 'shift'] }
      }

      function shortcutDefaults() {
        return {
          'desktop:macos': shortcutBinding(),
          'desktop:windows': shortcutBinding(),
          'desktop:linux': shortcutBinding(),
          'web:macos': shortcutBinding(),
          'web:windows': shortcutBinding(),
          'web:linux': shortcutBinding(),
        }
      }

      /** Register the open command through the optional shortcuts service. */
      function registerShortcut() {
        if (typeof ctx.inject !== 'function') return
        try {
          ctx.inject(['shortcuts'], (scope) => {
            const shortcuts = serviceOf(scope, 'shortcuts')
            if (!shortcuts || typeof shortcuts.register !== 'function') return
            const effect = typeof scope.effect === 'function' ? scope.effect : ctx.effect
            if (typeof effect !== 'function') return
            try {
              effect(() => shortcuts.register({
                id: SHORTCUT_ID,
                label: () => t('shortcut.label'),
                aliases: ['live page', 'page edit', 'html editor', 'page editor'],
                defaults: shortcutDefaults(),
                regions: ['page', 'editable', 'terminal'],
                modals: [],
                resolve: () => ({
                  status: 'handled',
                  run: () => { openCurrentHtml() },
                }),
              }), 'dsh-live-page: shortcut')
            } catch (error) {
              pushError('shortcut: ' + errorMessage(error))
            }
          })
        } catch (error) {
          pushError('inject shortcuts: ' + errorMessage(error))
        }
      }

      function attachListeners() {
        try {
          window.addEventListener(EVENT_OPEN, onLiveOpen)
        } catch (error) {
          pushError('listen event: ' + errorMessage(error))
        }
        try {
          window.addEventListener('message', onWindowMessage)
        } catch (error) {
          pushError('listen message: ' + errorMessage(error))
        }
        try {
          if (document && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibilityChange)
          }
        } catch (error) {
          pushError('listen visibility: ' + errorMessage(error))
        }
      }

      function startLoops() {
        try {
          pageTimer = window.setInterval(() => { guardPromise(probePage()) }, PAGE_POLL_MS)
        } catch (error) {
          pushError('page timer: ' + errorMessage(error))
        }
        try {
          selectionTimer = window.setInterval(() => { guardPromise(pollSelection()) }, SELECTION_POLL_MS)
        } catch (error) {
          pushError('selection timer: ' + errorMessage(error))
        }
      }

      /** Remove every browser resource this plugin instance owns. */
      function dispose() {
        if (disposed) return
        disposed = true
        try {
          if (pageTimer) window.clearInterval(pageTimer)
        } catch (error) {
          /* ignore */
        }
        pageTimer = 0
        try {
          if (selectionTimer) window.clearInterval(selectionTimer)
        } catch (error) {
          /* ignore */
        }
        selectionTimer = 0
        clearSelectionDebounce()
        for (const id of timers) {
          try {
            window.clearTimeout(id)
          } catch (error) {
            /* ignore */
          }
        }
        timers.clear()
        for (const element of toastElements) removeElement(element)
        toastElements.clear()
        try {
          window.removeEventListener(EVENT_OPEN, onLiveOpen)
        } catch (error) {
          /* ignore */
        }
        try {
          window.removeEventListener('message', onWindowMessage)
        } catch (error) {
          /* ignore */
        }
        try {
          if (document && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibilityChange)
          }
        } catch (error) {
          /* ignore */
        }
        capturedActions.clear()
        removeElement(styleElement)
        styleElement = null
        try {
          if (window.__dshLivePageReady === true) window.__dshLivePageReady = false
        } catch (error) {
          /* ignore */
        }
      }

      registerComposer()
      registerShortcut()
      attachListeners()
      startLoops()
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => dispose(), 'dsh-live-page: lifecycle')
        } else {
          pushError('ctx.effect unavailable; browser resources are not cleaned up')
        }
      } catch (error) {
        pushError('effect: ' + errorMessage(error))
      }
    }

    return { inject: ['slots'], apply }
  },
})
