/**
 * dsh-cursor-layout — Client half.
 *
 * Rearranges the shipped three-column shell into a Cursor / VSCode-style
 * workbench without replacing any slot occupant:
 *
 *   ┌───────────────┬──────────────────────────────┬────────────────────┐
 *   │ DSH sessions  │ right-hand workbench column  │ AI conversation    │
 *   │ (left column) │ (editor + files + browser +  │ (chat + composer)  │
 *   │               │  terminal + diff review)     │                    │
 *   └───────────────┴──────────────────────────────┴────────────────────┘
 *
 * Why the projection is done here: the shipped AppFrame renders
 * [sidebar][center conversation][rightbar] in one CSS grid, and no slot lets a
 * plugin move a column. So this module re-projects the frame's own grid:
 * the rightbar column (where dsh-vscode-mode and better-sidebar mount the
 * editor / file tree / browser / terminal / diff tabs) becomes the wide middle
 * track, while the center conversation moves to a fixed-width right track.
 * Everything is declarative CSS driven by two custom properties read back from
 * the frame's own inline geometry, so the shipped resize handle, the Cmd/Ctrl+B
 * collapse, the rightbar open/close and the fullscreen mode all keep working.
 *
 * Only the grid projection changes: no slot is registered, replaced or removed,
 * so every shipped panel keeps owning its own content and interactions.
 *
 * Diagnostics: the measured frame geometry is posted to the loopback route
 * `/cursor-layout/report` served by the Host half, so a geometry regression is
 * observable with `curl` on the GUI port instead of a screenshot.
 *
 * @author DSH session 2026-11-03
 */
window.__ModuleLoader__.load({
  id: 'dsh-cursor-layout',
  factory(require) {
    const React = require('react')

    // ───────────────────────────────────────────────────────────────────────
    // 页面侧请求探针 + 并发闸门（2026-11-09，排查「开对话→端口暴涨」用）
    //
    // 背景：Electron 主进程把页面里每个 `dsh-app://` 请求逐个 fetch 给 Host，
    // 页面一旦发请求风暴（每秒数百），loopback 连接会堆到几千、耗尽 ephemeral
    // 端口，整机联网卡死。这里做两件事，定位完可整段删除：
    //   1. 统计每个路径的请求数 / 在途数 / 页面加载次数 / 页面错误；
    //      每秒写一次 localStorage（Host 卡死时也能落盘，leveldb 里能翻到），
    //      每 5 秒顺带 POST 到 /cursor-layout/report。
    //   2. 闸门：在途请求超过 200 时排队（最多排 1000），再超出直接快速失败，
    //      这样风暴只会堆在页面内存里，不会堆成几千条 TCP 连接。
    // ───────────────────────────────────────────────────────────────────────
    /** 探针 localStorage 键；Host 卡死时靠它留证据。 */
    const PROBE_LS_KEY = 'dsh.fetch-probe.v2'
    /** 同时在途的页面→Host 请求上限；正常使用远低于此值。 */
    const PROBE_MAX_INFLIGHT = 200
    /** 排队上限；再多的请求直接快速失败，避免风暴把页面内存吃光。 */
    const PROBE_MAX_WAITERS = 1000
    /** 排队超时（毫秒）；Host 假死时排队请求快速失败，页面不会永久挂住。 */
    const PROBE_QUEUE_TIMEOUT_MS = 20000
    /** 媒体 src 赋值速率上限（2 秒窗口）；超出即跳过，防止 <img>/<video> 风暴绕过 fetch 闸门。 */
    const PROBE_MEDIA_MAX = 600
    const PROBE_MEDIA_PATH_MAX = 40

    const probe = (() => {
      try {
        // HMR 重新加载本插件时先卸掉上一版包装，保证改动的闸门代码立即生效。
        const previousProbe = window.__dshFetchProbe
        if (previousProbe !== undefined && previousProbe !== null) {
          try {
            if (typeof previousProbe.restore === 'function') previousProbe.restore()
          } catch (error) { /* 还原失败就继续装新版 */ }
          try { delete window.__dshFetchProbe } catch (error) { window.__dshFetchProbe = undefined }
        }
        const state = {
          rev: Math.random().toString(36).slice(2, 8),
          t0: Date.now(),
          timeOrigin: window.performance !== undefined ? window.performance.timeOrigin : Date.now(),
          boot: 0,
          fetchTotal: 0,
          fetchStarted: 0,
          fetchRejected: 0,
          fetchFail: 0,
          inflight: 0,
          maxInflight: 0,
          xhr: 0,
          media: 0,
          mediaWindowAt: 0,
          mediaWindow: 0,
          mediaPathWindow: new Map(),
          mediaSkipped: 0,
          stormStacks: [],
          stormCapture: 0,
          recent: [],
          attempts: new Map(),
          started: new Map(),
          errors: [],
        }
        try {
          const previous = Number(window.sessionStorage.getItem('dsh.fetch-probe.boot') || '0')
          window.sessionStorage.setItem('dsh.fetch-probe.boot', String(previous + 1))
          state.boot = previous + 1
        } catch (error) { /* 隐私模式等场景没有 sessionStorage */ }

        /** 请求地址 → 归一化路径（去掉 dsh-app:// 前缀，查询串只留问号）。 */
        const pathOf = (input) => {
          try {
            const raw = typeof input === 'string' ? input : (input !== null && input !== undefined && typeof input.url === 'string' ? input.url : String(input))
            const url = new URL(raw, window.location.href)
            return url.pathname + (url.search === '' ? '' : '?')
          } catch (error) {
            return '?'
          }
        }
        const bump = (map, key) => { map.set(key, (map.get(key) || 0) + 1) }

        const waiters = []
        // 名额在 acquire 里同步扣掉（不能等微任务），否则同步循环里的 fetch 会全部放行。
        const acquire = () => {
          if (state.inflight < PROBE_MAX_INFLIGHT) {
            state.inflight += 1
            if (state.inflight > state.maxInflight) state.maxInflight = state.inflight
            return Promise.resolve(true)
          }
          if (waiters.length >= PROBE_MAX_WAITERS) return Promise.resolve(false)
          return new Promise((resolve) => {
            const waiter = { resolve: undefined, timer: 0 }
            waiter.resolve = (value) => {
              try { window.clearTimeout(waiter.timer) } catch (error) { /* ignore */ }
              resolve(value)
            }
            // 排队超时后快速失败，避免 Host 假死时页面永久挂住。
            waiter.timer = window.setTimeout(() => {
              const index = waiters.indexOf(waiter)
              if (index !== -1) waiters.splice(index, 1)
              resolve(false)
            }, PROBE_QUEUE_TIMEOUT_MS)
            waiters.push(waiter)
          })
        }
        const release = () => {
          const next = waiters.shift()
          if (next !== undefined) { next.resolve(true); return }
          state.inflight -= 1
        }

        const trueOriginalFetch = window.__dshOriginalFetch !== undefined ? window.__dshOriginalFetch : window.fetch
        try { window.__dshOriginalFetch = trueOriginalFetch } catch (error) { /* ignore */ }
        const originalFetch = trueOriginalFetch
        if (typeof originalFetch === 'function') {
          const dshProbedFetch = function dshProbedFetch(input, init) {
            let hint = ''
            try {
              if (init !== null && init !== undefined && typeof init.body === 'string' && init.body.length > 0 && init.body.length < 4096) {
                const match = /"method"\s*:\s*"([^"]+)"/.exec(init.body)
                if (match !== null) hint = '#' + match[1]
              }
            } catch (error) { /* 只做诊断 */ }
            const key = pathOf(input) + hint
            state.fetchTotal += 1
            state.recent.push(key)
            if (state.recent.length > 40) state.recent.shift()
            const attemptCount = (state.attempts.get(key) || 0) + 1
            bump(state.attempts, key)
            // 风暴采样：同一路径第 100/1000 次调用时抓调用栈，定位刷屏代码。
            if ((attemptCount === 100 || attemptCount === 1000) && state.stormCapture < 40) {
              try {
                const stack = String(new Error().stack || '').split('\n').slice(1, 9).join('\n').slice(0, 900)
                if (!state.stormStacks.some((entry) => entry.stack === stack)) {
                  state.stormStacks.push({ key, at: attemptCount, stack })
                  state.stormCapture += 1
                }
              } catch (error) { /* 只做诊断 */ }
            }
            return acquire().then((admitted) => {
              if (admitted !== true) {
                state.fetchRejected += 1
                throw new Error('dsh-fetch-guard: too many concurrent page→host requests')
              }
              state.fetchStarted += 1
              bump(state.started, key)
              let pending
              try {
                pending = originalFetch.call(window, input, init)
              } catch (error) {
                state.fetchFail += 1
                release()
                throw error
              }
              return pending.then((response) => {
                release()
                return response
              }, (error) => {
                state.fetchFail += 1
                release()
                throw error
              })
            })
          }
          window.fetch = dshProbedFetch
          state.originalFetch = originalFetch
          state.restore = () => {
            try { if (window.fetch === dshProbedFetch) window.fetch = originalFetch } catch (error) { /* ignore */ }
          }
        }

        try {
          if (XMLHttpRequest.prototype.open.__dshProbed !== true) {
            const originalOpen = XMLHttpRequest.prototype.open
            const probedOpen = function dshProbedOpen(method, url) {
              state.xhr += 1
              try { bump(state.attempts, 'xhr:' + pathOf(url)) } catch (error) { /* 统计失败不影响请求 */ }
              return originalOpen.apply(this, arguments)
            }
            probedOpen.__dshProbed = true
            XMLHttpRequest.prototype.open = probedOpen
          }
        } catch (error) { /* 统计失败不影响请求 */ }

        for (const pair of [[window.HTMLImageElement, 'img'], [window.HTMLVideoElement, 'video'], [window.HTMLAudioElement, 'audio']]) {
          const ctor = pair[0]
          const tag = pair[1]
          try {
            if (ctor === undefined) continue
            const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, 'src')
            if (descriptor === undefined || typeof descriptor.set !== 'function' || descriptor.set.__dshProbed === true) continue
            const originalSet = descriptor.set
            const probedSet = function dshProbedSrc(value) {
              state.media += 1
              let mediaKey = tag + ':?'
              try { mediaKey = tag + ':' + pathOf(String(value)) } catch (error) { /* 统计失败不影响加载 */ }
              try { bump(state.attempts, mediaKey) } catch (error) { /* 统计失败不影响加载 */ }
              const now = Date.now()
              if (now - state.mediaWindowAt > 2000) {
                state.mediaWindowAt = now
                state.mediaWindow = 0
                state.mediaPathWindow.clear()
              }
              state.mediaWindow += 1
              const perPath = (state.mediaPathWindow.get(mediaKey) || 0) + 1
              state.mediaPathWindow.set(mediaKey, perPath)
              if (state.mediaWindow > PROBE_MEDIA_MAX || perPath > PROBE_MEDIA_PATH_MAX) {
                state.mediaSkipped += 1
                return
              }
              return originalSet.call(this, value)
            }
            probedSet.__dshProbed = true
            Object.defineProperty(ctor.prototype, 'src', Object.assign({}, descriptor, { set: probedSet }))
          } catch (error) { /* 某些环境不允许改写原型 */ }
        }

        const onError = (event) => {
          try {
            const message = String((event !== null && event !== undefined && (event.message || event.reason || event.error)) || 'error').slice(0, 300)
            if (state.errors.length < 12) state.errors.push(message)
          } catch (error) { /* 统计失败 */ }
        }
        window.addEventListener('error', onError, true)
        window.addEventListener('unhandledrejection', onError, true)

        const topOf = (map) => Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)
        state.snapshot = () => ({
          at: new Date().toISOString(),
          rev: state.rev,
          boot: state.boot,
          timeOrigin: state.timeOrigin,
          uptimeMs: Date.now() - state.t0,
          href: window.location.href,
          readyState: document.readyState,
          visibility: document.visibilityState,
          fetchTotal: state.fetchTotal,
          fetchStarted: state.fetchStarted,
          fetchRejected: state.fetchRejected,
          fetchFail: state.fetchFail,
          inflight: state.inflight,
          maxInflight: state.maxInflight,
          xhr: state.xhr,
          media: state.media,
          mediaSkipped: state.mediaSkipped,
          stormStacks: state.stormStacks.slice(0, 12),
          recent: state.recent.slice(-40),
          repro: state.repro,
          topAttempts: topOf(state.attempts),
          topStarted: topOf(state.started),
          errors: state.errors.slice(-6),
        })
        state.persist = () => {
          try { window.localStorage.setItem(PROBE_LS_KEY, JSON.stringify(state.snapshot())) } catch (error) { /* 配额/隐私模式 */ }
        }
        window.__dshFetchProbe = state
        state.persist()
        return state
      } catch (error) {
        return undefined
      }
    })()

    /** `<style>` marker and id, so a reload never stacks duplicate sheets. */
    const STYLE_ID = 'dsh-cursor-layout/geometry'
    /** Geometry of the chat column: px bounds and share of the viewport. */
    const CHAT_MIN_PX = 320
    const CHAT_MAX_PX = 1200
    const CHAT_VIEWPORT_SHARE = 0.25
    const CHAT_WIDTH_KEY = 'dsh-cursor-layout/chat-width.v1'
    /** Attribute names this module owns on the frame / its columns. */
    const MODE_ATTR = 'data-cursor-mode'
    const CLOSED_ATTR = 'data-cursor-editor-closed'
    const COL_ATTR = 'data-cursor-col'
    /** Set once the workbench editor pane has been opened by this plugin. */
    const OPEN_FLAG = 'dsh-cursor-layout/opened.v1'
    /** vscode-mode's own saved-tab key prefix (its cold-start restore marker). */
    const VSCODE_TAB_KEY = 'edrv.editor-tab.v1.'
    /** vscode-mode's browser-side registry: present once its client half loaded. */
    const VSCODE_GLOBAL = '__edrvCommands__'
    /** Rightbar page kind vscode-mode registers for its Monaco editor tab. */
    const EDITOR_KIND = 'edrvEditor'
    /** Native "changed files" card shipped by the core ui-deliverables plugin. */
    const CHANGED_FILES_CARD = '[data-changed-files]'
    /** The card's review tab (ui-deliverables ReviewTab) in the right workbench. */
    const CHANGED_FILES_REVIEW = '[data-changes-review]'
    /** Native delivered-file card (present results / turn tail) container. */
    const PRESENTED_FILE_CARD = '[data-presented-file]'
    /** Delay before snapshotting the review tab the native click opened (ms). */
    const CHANGED_FILES_TAB_DELAY_MS = 400
    /** Delay before snapshotting the editor tab a delivered-file click opened (ms). */
    const EDITOR_OPEN_SNAPSHOT_MS = 500
    /** Agent-view media peek: the workbench column drops in on the right while the
     *  conversation stays in the middle. Attribute lives on the frame. */
    const MEDIA_PEEK_ATTR = 'data-cursor-media-peek'
    /** Media suffixes the peek claims (mirrors dsh-vscode-mode's MEDIA_EXT). */
    const MEDIA_EXT = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']
    /** Peek column width bounds; the actual width tracks the viewport. */
    const PEEK_MIN_PX = 380
    const PEEK_MAX_PX = 860
    const PEEK_VIEWPORT_SHARE = 0.46
    /** Grace before a peek whose panel never opened is retracted (IDE fallback). */
    const PEEK_OPEN_GRACE_MS = 4000
    /** Diagnostics endpoint served by the Host half (loopback, last report wins). */
    const REPORT_URLS = ['/cursor-layout/report']
    /** The two layout views this module projects. */
    const VIEW_CURSOR = 'cursor'
    const VIEW_AGENT = 'agent'
    /** Legacy single global view key: only read once, to seed the per-session map. */
    const VIEW_KEY = 'dsh-cursor-layout/view.v1'
    /** Per-session view map: `{ version, fallback, bySession: { sessionId: view } }`. */
    const VIEWS_KEY = 'dsh-cursor-layout/view.v2'
    /** Upper bound on remembered per-session choices (oldest writes are dropped). */
    const VIEW_MAP_LIMIT = 200

    /** App-local URL for a product endpoint (desktop dsh-app origin included). */
    function appUrlOf(path) {
      try {
        const root = new URL('.', document.baseURI)
        return new URL(String(path).replace(/^\/+/, ''), root).href
      } catch (error) {
        return path
      }
    }

    /** One JSON-RPC call into the dsh-vscode-mode extension route. */
    async function rpcCall(method, args) {
      const response = await fetch(appUrlOf('/edrv/rpc'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return await response.json()
    }

    /** Random operation id for a review decision (crypto when available). */
    function operationId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch (error) { /* fall through */ }
      return 'cursor-layout-' + Date.now() + '-' + Math.random().toString(16).slice(2)
    }

    /**
     * Own inline-completion provider wired to dsh-vscode-mode's host AI route.
     * Replaces the shipped provider (whose closure can go stale after module
     * reloads) so ghost text keeps working across HMR / plugin restarts.
     */
    function setupOwnInlineProvider(ctx) {
      const monaco = window.monaco
      if (!monaco || !monaco.languages || typeof monaco.languages.registerInlineCompletionsProvider !== 'function') {
        ownInline.lastError = 'monaco registerInlineCompletionsProvider unavailable'
        return () => {}
      }
      // Retire the shipped provider so two providers never race for the same text.
      try {
        const shipped = window.__edrvAiInlineDisposer__
        if (typeof shipped === 'function') shipped()
        delete window.__edrvAiInlineDisposer__
        ownInline.disposedShipped = true
      } catch (error) {
        ownInline.disposedShipped = false
      }

      const cache = new Map()
      let lastAt = 0
      const provider = {
        async provideInlineCompletions(model, position, context, token) {
          ownInline.calls += 1
          try {
            if (!ownInlineEnabled) return { items: [] }
            const uri = model && model.uri
            if (!uri || uri.scheme !== 'edrv') return { items: [] }
            const path = decodeURIComponent(String(uri.path || '').replace(/^\//, ''))
            const value = model.getValue()
            const offset = model.getOffsetAt(position)
            const prefix = value.slice(Math.max(0, offset - 3000), offset)
            if (prefix.trim().length === 0) return { items: [] }
            const suffix = value.slice(offset, offset + 800)
            const key = path + ':' + position.lineNumber + ':' + position.column + ':' + prefix.slice(-24)
            const hit = cache.get(key)
            if (hit !== undefined && Date.now() - hit.at < 30000) return { items: hit.items }
            // One debounced request per typing burst; Monaco cancels superseded ones.
            await new Promise((resolve) => window.setTimeout(resolve, 160))
            if (token && token.isCancellationRequested) return { items: [] }
            const startedAt = Date.now()
            const result = await rpcCall('edrv.ai.inline', { path, prefix, suffix })
            ownInline.lastMs = Date.now() - startedAt
            const text = result && result.ok === true && typeof result.text === 'string' ? result.text : ''
            ownInline.lastLen = text.length
            ownInline.lastNote = result && result.note ? String(result.note).slice(0, 200) : ''
            lastAt = Date.now()
            if (text === '') {
              cache.set(key, { items: [], at: Date.now() })
              return { items: [] }
            }
            if (token && token.isCancellationRequested) return { items: [] }
            const items = [{ insertText: text }]
            ownInline.lastText = text.slice(0, 120)
            cache.set(key, { items, at: Date.now() })
            return { items }
          } catch (error) {
            ownInline.errors += 1
            ownInline.lastError = String((error && error.message) || error).slice(0, 240)
            return { items: [] }
          }
        },
        freeInlineCompletions() {},
      }
      const dispose = monaco.languages.registerInlineCompletionsProvider('*', provider)
      ownInline.ready = true
      return () => {
        try { dispose.dispose() } catch (error) { /* ignore */ }
        ownInline.ready = false
      }
    }

    /**
     * Cursor-style "files changed in this conversation" bar above the composer.
     * Reads dsh-vscode-mode's official review records, mirrors them as one
     * compact row and drives Undo / Keep / Review against the same records the
     * editor's own review bar uses.
     */
    function createDiffBar(ctx) {
      const h = React.createElement

      /** 记录路径比较键：display 是工作区相对路径（官方与待审口径一致），退化时才用绝对路径。 */
      function recordPathKey(item) {
        const value = String((item && (item.display || item.currentPath || item.path)) || '')
        return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
      }

      /** 待审投影条目的 id 带 `pending:` 前缀（见 dsh-vscode-mode reviewRpc 的 PENDING_PREFIX）。 */
      function isPendingRecord(item) {
        return String((item && item.id) || '').startsWith('pending:')
      }

      function CursorDiffBar(props) {
        diffBarDebug.renders += 1
        diffBarDebug.props = Object.keys(props || {}).slice(0, 24)
        const sessionId = props && props.sessionId
        diffBarDebug.sessionId = sessionId || ''
        const [files, setFiles] = React.useState([])
        const [error, setError] = React.useState('')
        // 动作类错误（Keep/Undo 失败原因）与轮询错误分开：后台刷新成功不能把「刚才的失败」清掉，
        // 否则用户看到的是「点了没反应」——尤其 Undo 被沙箱/跨端拦下时。
        const [actionError, setActionError] = React.useState('')
        const [busy, setBusy] = React.useState('')
        const [open, setOpen] = React.useState(false)
        const alive = React.useRef(true)

        const accept = React.useCallback((result) => {
          if (!alive.current) return
          if (result && result.ok === true) {
            const page = result.page || {}
            const all = Array.isArray(page.items) ? page.items : []
            const target = String(sessionId || '')
            const scoped = all.filter((item) => {
              // `display` is workspace-relative for files inside the session workspace
              // and an absolute/`~`-prefixed path for everything outside it.
              const scope = String((item && item.display) || '')
              if (scope === '' || /^(?:\/|~|[A-Za-z]:[\\/])/.test(scope)) return false
              // dsh-vscode-mode's official review ledger is workspace-wide ("pending
              // across all source sessions"); mirror Cursor instead: keep only the
              // records produced by THIS conversation. Pending entries are already
              // session-scoped, so the same comparison keeps them too.
              const owner = String((item && item.sessionId) || '')
              // 待审投影条目的 sessionId 是「首个写入会话」，多会话折叠时可能不等于当前会话；
              // host 已按会话血缘过滤过，这里直接采信，别把本会话可见的条目误伤掉（否则
              // 差异栏条数会比编辑器自己的待处理数少）。
              if (isPendingRecord(item)) return target !== ''
              return target !== '' && owner === target
            })
            const items = scoped
            diffBarDebug.files = items.length
            diffBarDebug.allFiles = all.length
            diffBarDebug.workspaceFiles = all.length
            diffBarDebug.paths = items.map((item) => item.display || item.currentPath || item.path).slice(0, 12)
            diffBarDebug.error = ''
            diffBarDebug.at = Date.now()
            setFiles(items)
            setError('')
          } else {
            diffBarDebug.files = 0
            diffBarDebug.error = result && result.error ? String(result.error) : 'unknown'
            diffBarDebug.at = Date.now()
            setFiles([])
            setError(result && result.error ? String(result.error) : '')
          }
        }, [sessionId])

        const reload = React.useCallback(() => {
          if (!sessionId) return
          rpcCall('edrv.review.list', { sessionId })
            .then(accept)
            .catch((cause) => {
              diffBarDebug.files = -1
              diffBarDebug.error = String((cause && cause.message) || cause)
              diffBarDebug.at = Date.now()
              if (alive.current) { setFiles([]); setError(diffBarDebug.error) }
            })
        }, [sessionId, accept])

        React.useEffect(() => {
          alive.current = true
          diffBarDebug.effectRuns += 1
          if (!sessionId) return undefined
          reload()
          const timer = window.setInterval(reload, 4000)
          const onRefresh = () => reload()
          window.addEventListener('edrv:refresh', onRefresh)
          return () => {
            alive.current = false
            window.clearInterval(timer)
            window.removeEventListener('edrv:refresh', onRefresh)
          }
        }, [sessionId, reload])

        const openDiff = (item) => {
          const path = item && (item.currentPath || item.path)
            || (item && typeof item.display === 'string' ? item.display : '')
          if (!path) {
            diffBarDebug.lastError = 'record-without-path'
            return
          }
          // Binary / oversized review records carry no text hunks (the row reads
          // +0 −0): there is nothing to diff, so open the file itself — the
          // editor's image / video preview panel, or the official binary viewer
          // for delegated formats. Only text records enter the diff-focus flow.
          const media = isMediaPathLike(path)
          const focusDiff = item && item.kind !== undefined ? item.kind === 'text' : !media
          diffBarDebug.clicks += 1
          diffBarDebug.lastPath = String(path).slice(0, 260)
          diffBarDebug.lastView = layoutView
          diffBarDebug.lastFocusDiff = focusDiff
          diffBarDebug.lastError = ''
          diffBarDebug.lastAt = Date.now()
          // The Agent view projects the workbench column as display:none, so a bare
          // `edrv:open-editor` would open the file in a hidden pane — the click looks
          // dead. Project a visible target first, exactly like the chat file links
          // and the delivered-file cards: media onto the right-hand peek column,
          // text back into the IDE view (then open/focus the diff).
          if (layoutView === VIEW_AGENT) {
            if (media) {
              setMediaPeek(true)
            } else {
              const target = sessionId !== undefined && sessionId !== null ? sessionId : currentSessionId
              if (target !== undefined) setLayoutView(VIEW_CURSOR, target)
              try { sync() } catch (error) { /* the frame observers re-project */ }
            }
          }
          const available = vscodeModeLoaded()
          if (available) ensureEditorPanel()
          openInEditor(path, focusDiff)
          if (!available) {
            // No dsh-vscode-mode: fall back to the official opener so the click
            // still produces a visible result instead of silently doing nothing.
            try {
              const workspaces = ctx.get('workspaces')
              if (workspaces !== undefined && workspaces !== null && typeof workspaces.openPath === 'function') {
                void workspaces.openPath(path).catch(() => {})
              }
            } catch (error) { /* best effort */ }
          }
        }

        const decide = async (mode) => {
          if (!sessionId || files.length === 0) return
          setBusy(mode)
          setError('')
          setActionError('')
          try {
            if (mode === 'accepted') {
              await keepEveryPendingChange()
            } else {
              for (const item of files) {
                const result = await rpcCall('edrv.review.decide', {
                  sessionId,
                  id: item.id,
                  seq: item.seq,
                  revision: item.revision,
                  operationId: operationId(),
                  scope: 'file',
                  decision: 'rejected',
                })
                if (!result || result.ok !== true) throw new Error((result && result.error) || 'Undo 失败')
              }
            }
            window.dispatchEvent(new CustomEvent('edrv:refresh'))
            reload()
          } catch (cause) {
            if (alive.current) setActionError(String((cause && cause.message) || cause))
            // 失败后也刷新一次：让栏里剩下的是真正还在待审的条目，而不是本地点过就消失的幻影。
            reload()
          } finally {
            if (alive.current) setBusy('')
          }
        }

        /**
         * Keep 一遍「当前列表里的全部待审改动」。
         *
         * Cursor 的 Keep All 语义是「把所有待审改动一次结清」，但 dsh-vscode-mode 的差异台账有
         * 两套账（待审投影 + 官方轮次记录），同一文件可能各有一条；keepAll 只结传入的那套，
         * 另一套会在待审投影消失后重新浮出列表 —— 表现出来的就是「点了 Keep，下一轮文件又回来了」。
         * 所以这里按**路径**循环收口：Keep → 重新取列表 → 同路径还有残留就再 Keep 一次，
         * 最多 3 轮；仍有残留（跨端、版本冲突、文本超限等）就显式报错，绝不假装成功。
         *
         * @returns {Promise<void>}
         */
        const keepEveryPendingChange = async () => {
          const keepPaths = new Set(files.map(recordPathKey).filter((key) => key !== ''))
          let pending = files
          let leftover = []
          for (let round = 0; round < 3 && pending.length > 0; round += 1) {
            const items = pending.map((item) => ({ id: item.id, display: item.display, seq: item.seq, revision: item.revision }))
            const result = await rpcCall('edrv.review.keepAll', { sessionId, batchId: operationId(), items })
            if (!result || result.ok !== true) throw new Error((result && result.error) || 'Keep 失败')
            const info = result.result || {}
            if (info.error) throw new Error(String(info.error))
            const page = await rpcCall('edrv.review.list', { sessionId })
            const pageItems = page && page.ok === true && page.page && Array.isArray(page.page.items) ? page.page.items : []
            leftover = pageItems.filter((item) => keepPaths.has(recordPathKey(item)))
            pending = leftover
          }
          if (leftover.length > 0) {
            const names = leftover.map((item) => item.display || item.currentPath || item.path).slice(0, 3).join('、')
            throw new Error('Keep 未完成：仍有 ' + leftover.length + ' 处改动在待审（' + names + (leftover.length > 3 ? '…' : '') + '），请刷新后重试或逐条处理。')
          }
        }

        /**
         * Cursor 的 Review 打开的是「文件列表 + diff」的多文件审查面。DSH 里最接近的原生面是
         * 本栏自己的文件列表 + 编辑器里的官方审查条，所以 Review = 展开按路径聚合的文件列表
         * （每个文件一行，可逐个点开）+ 打开第一处差异；不再拉起编辑器的「差异总览」——
         * 那个面板是按官方轮次记录排的（一条记录一个卡片），几百条 pending 时反而更难审。
         * @returns {void}
         */
        const review = () => {
          if (files.length === 0) return
          setOpen(true)
          openDiff(files[0])
        }

        // 2026-11-13：rc.2 起普通会话也会渲染 conversation.hero.frame 包装层（见下方视图开关
        // 的同一处结论），用「hero 存在」判断空白会话会把这条栏永久挡掉 —— diffBar 从 rc.2 起
        // 恒为 null 就是这个原因。空白会话本来就没有待审文件，files.length 已覆盖，故只看这两项。
        if (!sessionId || files.length === 0) return null

        // Cursor 的改动栏是「文件」列表，不是「记录」列表：同一文件的多个轮次记录聚合为一行
        // （条数按文件算，+N/−M 取该文件全部待审记录的合计），避免 265 条记录把 19 个文件淹掉。
        const groupMap = new Map()
        for (const item of files) {
          const key = recordPathKey(item)
          const entry = groupMap.get(key)
          if (entry === undefined) groupMap.set(key, { key, first: item, items: [item] })
          else entry.items.push(item)
        }
        const groups = [...groupMap.values()]
        const added = files.reduce((sum, item) => sum + (Number(item.added) || 0), 0)
        const deleted = files.reduce((sum, item) => sum + (Number(item.deleted) || 0), 0)
        const header = h('div', { className: 'cursor-diffbar-head' },
          h('button', {
            type: 'button',
            className: 'cursor-diffbar-toggle',
            onClick: () => setOpen(!open),
            title: open ? '收起文件列表' : '展开文件列表',
          },
            h('span', { className: 'cursor-diffbar-chev' }, open ? '▾' : '▸'),
            h('span', null, groups.length + (groups.length > 1 ? ' Files' : ' File')),
            h('span', { className: 'cursor-diffbar-stat' },
              h('span', { className: 'cursor-diffbar-add' }, '+' + added),
              h('span', { className: 'cursor-diffbar-del' }, '−' + deleted))),
          h('span', { className: 'cursor-diffbar-spacer' }),
          h('button', { type: 'button', className: 'cursor-diffbar-btn', disabled: busy !== '', onClick: () => { void decide('rejected') }, title: '撤销全部：把文件恢复成本轮修改前' }, 'Undo'),
          h('button', { type: 'button', className: 'cursor-diffbar-btn', disabled: busy !== '', onClick: () => { void decide('accepted') }, title: '保留全部：标记已审，不改文件' }, 'Keep'),
          h('button', { type: 'button', className: 'cursor-diffbar-btn cursor-diffbar-primary', disabled: busy !== '', onClick: () => review(), title: '审阅：展开文件列表并打开第一处差异（在编辑器审查条里逐个文件 Keep / Undo）' }, 'Review'))
        const rows = open
          ? h('div', { className: 'cursor-diffbar-rows' }, groups.map((group) => {
            const groupAdded = group.items.reduce((sum, item) => sum + (Number(item.added) || 0), 0)
            const groupDeleted = group.items.reduce((sum, item) => sum + (Number(item.deleted) || 0), 0)
            const path = group.first.currentPath || group.first.path
            return h('button', {
              key: group.key,
              type: 'button',
              className: 'cursor-diffbar-row',
              title: path + (group.items.length > 1 ? '（' + group.items.length + ' 条待审记录）' : ''),
              onClick: () => openDiff(group.first),
            },
              h('span', { className: 'cursor-diffbar-name' }, group.first.display || path),
              group.items.length > 1 ? h('span', { className: 'cursor-diffbar-count' }, '×' + group.items.length) : null,
              h('span', { className: 'cursor-diffbar-add' }, '+' + groupAdded),
              h('span', { className: 'cursor-diffbar-del' }, '−' + groupDeleted))
          }))
          : null
        return h('div', { className: 'cursor-diffbar', 'data-cursor-diffbar': '1' },
          (actionError || error) ? h('div', { className: 'cursor-diffbar-error' }, actionError || error) : null,
          header,
          rows)
      }

      return CursorDiffBar
    }

    /**
     * Header pill that flips the projection between the Cursor workbench and the
     * native Agent view (centred conversation, workbench hidden). It sits in the
     * session header, so it is reachable in both views — including the Agent view
     * where the workbench (and its own controls) is hidden.
     */
    function createViewToggle(heroOnly) {
      const h = React.createElement

      function CursorViewToggle() {
        const [view, setView] = React.useState(layoutView)
        React.useEffect(() => {
          const onView = (event) => {
            const detail = event && event.detail ? event.detail : null
            setView(detail && detail.view === VIEW_AGENT ? VIEW_AGENT : VIEW_CURSOR)
          }
          setView(layoutView)
          window.addEventListener('cursor-layout:view', onView)
          return () => window.removeEventListener('cursor-layout:view', onView)
        }, [])
        // The blank new-conversation page has no session header, so the composer
        // row hosts a second, hero-only instance of the same switch.
        // 2026-11-11 local fix: newer DSH renders a `conversation.hero.frame`
        // wrapper on ordinary sessions too, so "a hero slot exists" stopped
        // meaning "blank page" and this fallback drew a SECOND 视图 pill next to
        // the session-header one. A session header carries the primary toggle,
        // so its presence means we are not on the blank page: hide the fallback.
        if (heroOnly === true) {
          if (document.querySelector('[data-slot^="conversation.hero"]') === null) return null
          if (document.querySelector('[data-slot="conversation.session.header.actions"]') !== null) return null
        }
        const agent = view === VIEW_AGENT
        const label = agent ? 'IDE 视图' : 'Agent 视图'
        const title = agent
          ? '切回 IDE 视图：中间工作台 + 右侧对话（⌘⌥M / Ctrl+Alt+M）'
          : '切到 Agent 视图：对话居中、隐藏中间代码区（⌘⌥M / Ctrl+Alt+M）'
        const glyph = agent
          ? h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.2 }),
            h('line', { x1: 6.2, y1: 2.5, x2: 6.2, y2: 13.5, stroke: 'currentColor', strokeWidth: 1.2 }),
            h('line', { x1: 10.2, y1: 2.5, x2: 10.2, y2: 13.5, stroke: 'currentColor', strokeWidth: 1.2 }))
          : h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.2 }),
            h('rect', { x: 4.6, y: 5, width: 6.8, height: 6, rx: 1.4, fill: 'currentColor', opacity: 0.35 }))
        return h('button', {
          type: 'button',
          className: 'cursor-layout-toggle',
          'data-cursor-layout-toggle': '1',
          'data-view': view,
          title,
          'aria-label': title,
          onClick: () => setLayoutView(agent ? VIEW_CURSOR : VIEW_AGENT),
        },
          glyph,
          h('span', { className: 'cursor-layout-toggle-label' }, label))
      }

      return CursorViewToggle
    }

    const CSS = `
/* ------------------------------------------------------------------ */
/* Cursor view: sidebar | workbench (middle) | conversation (right).   */
/* ------------------------------------------------------------------ */
[data-cursor-mode="cursor"] {
  grid-template-columns:
    var(--cursor-layout-sidebar, 280px)
    minmax(0, 1fr)
    var(--cursor-layout-chat, 420px) !important;
}
/* Pin every re-projected column to the frame's first row: the frame owns a
   second (bottom) row, and a grid-column-only override would let auto-placement
   push a column into that row, collapsing it to zero height. */
[data-cursor-mode="cursor"] > [data-cursor-col="sidebar"],
[data-cursor-mode="cursor"] > [data-cursor-col="workbench"],
[data-cursor-mode="cursor"] > [data-cursor-col="chat"] { grid-row: 1 !important; }
[data-cursor-mode="cursor"] > [data-cursor-col="sidebar"] { grid-column: 1 !important; }
[data-cursor-mode="cursor"] > [data-cursor-col="workbench"] { grid-column: 2 !important; }
[data-cursor-mode="cursor"] > [data-cursor-col="chat"] { grid-column: 3 !important; }
/* ------------------------------------------------------------------ */
/* Agent view: the shipped middle conversation column, workbench gone. */
/* Its tabs stay mounted, so flipping back to Cursor restores them.    */
/* ------------------------------------------------------------------ */
[data-cursor-mode="agent"] {
  grid-template-columns:
    var(--cursor-layout-sidebar, 280px)
    minmax(0, 1fr)
    0px !important;
}
[data-cursor-mode="agent"] > [data-cursor-col="sidebar"],
[data-cursor-mode="agent"] > [data-cursor-col="chat"] { grid-row: 1 !important; }
[data-cursor-mode="agent"] > [data-cursor-col="sidebar"] { grid-column: 1 !important; }
[data-cursor-mode="agent"] > [data-cursor-col="chat"] { grid-column: 2 !important; }
[data-cursor-mode="agent"] > [data-cursor-col="workbench"] { display: none !important; }
/* ------------------------------------------------------------------ */
/* Agent view + media peek: the workbench (VSCode editor) drops in as   */
/* the RIGHT column while the conversation keeps the middle track.      */
/* Used when a video/image link in the conversation is clicked.         */
/* ------------------------------------------------------------------ */
[data-cursor-mode="agent"][data-cursor-media-peek] {
  grid-template-columns:
    var(--cursor-layout-sidebar, 280px)
    minmax(0, 1fr)
    var(--cursor-layout-peek, 620px) !important;
}
[data-cursor-mode="agent"][data-cursor-media-peek] > [data-cursor-col="sidebar"],
[data-cursor-mode="agent"][data-cursor-media-peek] > [data-cursor-col="chat"],
[data-cursor-mode="agent"][data-cursor-media-peek] > [data-cursor-col="workbench"] { grid-row: 1 !important; }
[data-cursor-mode="agent"][data-cursor-media-peek] > [data-cursor-col="sidebar"] { grid-column: 1 !important; }
[data-cursor-mode="agent"][data-cursor-media-peek] > [data-cursor-col="chat"] { grid-column: 2 !important; }
[data-cursor-mode="agent"][data-cursor-media-peek] > [data-cursor-col="workbench"] {
  grid-column: 3 !important;
  display: block !important;
}
[data-cursor-mode="agent"][data-cursor-media-peek] > [data-cursor-col="chat"] {
  border-right: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
}
[data-cursor-mode="agent"][data-cursor-media-peek] [data-rightbar-col] [data-sidebar-right-panel] {
  width: 100% !important;
  max-width: 100% !important;
  --dsh-sidebar-width: 100% !important;
}
/* The rightbar is a track, its occupant draws a panel anchored to that track's
   right edge at the normal width; in the middle track it must fill. */
[data-cursor-mode="cursor"] [data-rightbar-col] [data-sidebar-right-panel] {
  width: 100% !important;
  max-width: 100% !important;
  --dsh-sidebar-width: 100% !important;
}
/* The shipped resize handle bound to the right column no longer sits on the
   chat boundary; the Cursor chat width is derived and the Agent view hides the
   workbench, so hide it in both views. The left sidebar handle stays usable and
   keeps driving the first track. */
[data-cursor-mode="cursor"] [data-side="rightbar"],
[data-cursor-mode="agent"] [data-side="rightbar"] {
  display: none !important;
}
/* Cursor-ish separation between the workbench and the conversation. */
[data-cursor-mode="cursor"] > [data-cursor-col="chat"] {
  border-left: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
}
/* One Cursor-style changed-files bar replaces vscode-mode's own diff dock in every
   view state. Unscoped on purpose: when the workbench pane is closed the frame
   falls back to the shipped layout (no data-cursor-mode), and the native dock
   used to leak above the composer there — including the blank new-conversation page. */
.edrv-diff-dock-shell,
[data-edrv-diff-dock-shell] {
  display: none !important;
}
/* 2026-11-13：用户选定只留这条 Cursor 风格改动栏。dsh-session-review 已于同日晚从 profile
   移除，这条规则留着是为了万一重装时它的中文条（.dsr-dock）不再和本栏打架；
   侧栏 Review 面板 .dsr-panel 不受影响。 */
.dsr-dock {
  display: none !important;
}
.cursor-diffbar {
  box-sizing: border-box;
  width: calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px));
  max-width: var(--dsh-composer-card-max-width, none);
  margin: 0 auto 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  line-height: 1.5;
  overflow: hidden;
}
.cursor-diffbar-head { display: flex; align-items: center; gap: 6px; padding: 5px 8px; }
.cursor-diffbar-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
}
.cursor-diffbar-toggle:hover { background: var(--dsw-alias-bg-layer-2); }
.cursor-diffbar-chev { width: 10px; color: var(--dsw-alias-label-secondary); font-size: 10px; }
.cursor-diffbar-stat { display: inline-flex; gap: 5px; margin-left: 2px; font-variant-numeric: tabular-nums; }
.cursor-diffbar-add { color: var(--dsw-alias-state-success-primary); font-variant-numeric: tabular-nums; }
.cursor-diffbar-del { color: var(--dsw-alias-state-error-primary); font-variant-numeric: tabular-nums; }
.cursor-diffbar-spacer { flex: 1; }
.cursor-diffbar-btn {
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 7px;
  cursor: pointer;
}
.cursor-diffbar-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.cursor-diffbar-btn:disabled { opacity: 0.5; cursor: default; }
.cursor-diffbar-primary { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.cursor-diffbar-rows { border-top: 1px solid var(--dsw-alias-border-l1); max-height: 128px; overflow: auto; }
.cursor-diffbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 11px;
  padding: 3px 10px;
  cursor: pointer;
  text-align: left;
}
.cursor-diffbar-row:hover { background: var(--dsw-alias-bg-layer-2); }
.cursor-diffbar-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cursor-diffbar-count { color: var(--dsw-alias-label-tertiary); font-size: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 0 5px; line-height: 15px; }
.cursor-diffbar-error { color: var(--dsw-alias-state-error-primary); padding: 4px 8px; font-size: 11px; }
/* Header pill flipping between the Cursor workbench and the Agent view. */
.cursor-layout-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.cursor-layout-toggle:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.cursor-layout-toggle[data-view="agent"] {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}
.cursor-layout-toggle svg { width: 13px; height: 13px; flex: none; }
/* Hide dsh-vscode-mode's diff-review badge (compare-select icon + pending-file
   count) in the session header entirely: the editor's own diff dock still
   offers Keep/Undo/Review, so the extra amber counter is only noise here. */
button:has(img[src*="compare-select"]) {
  display: none !important;
}
/* Drag handle between the workbench and the conversation column. */
.cursor-layout-chat-resizer {
  position: fixed;
  width: 9px;
  z-index: 35;
  cursor: col-resize;
  background: transparent;
  touch-action: none;
}
.cursor-layout-chat-resizer::after {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: transparent;
  transition: background 120ms ease;
}
.cursor-layout-chat-resizer:hover::after { background: var(--dsw-alias-state-business-primary, #4d6bfe); }
.cursor-layout-chat-resizer:active::after { background: var(--dsw-alias-state-business-primary, #4d6bfe); }

/* IDE view + collapsed conversation: the workbench keeps the full middle width
   and the conversation column is removed; the same official panel-collapse
   button (now re-purposed) brings it back. */
[data-cursor-mode="cursor"][data-cursor-chat-collapsed] {
  grid-template-columns:
    var(--cursor-layout-sidebar, 280px)
    minmax(0, 1fr)
    0px !important;
}
[data-cursor-mode="cursor"][data-cursor-chat-collapsed] > [data-cursor-col="chat"] {
  display: none !important;
}
/* Its divider no longer exists while the conversation is hidden. */
[data-cursor-mode="cursor"][data-cursor-chat-collapsed] > [data-cursor-col="chat"] { border-left: none !important; }

/* Windowed macOS chrome: when the session sidebar is collapsed the IDE view
   puts the workbench at x=0, while the workbench's own content starts 38px from
   the frame top — that strip is exactly where the traffic lights and the
   shell.leading controls live, so they overlap its top row. Push the workbench
   content down to the frame's own top clearance (48px on darwin) in that state. */
html:not([data-fullscreen]) [data-cursor-mode="cursor"][data-sidebar-collapsed] > [data-cursor-col="workbench"] {
  padding-top: max(0px, calc(var(--dsh-frame-top-clearance, 48px) - 38px)) !important;
}

/* 会话头部右上：隐藏「自动化任务」目录的时钟入口。
   ui-schedule 插件把带 data-schedule-reminder-entry 的时钟按钮注册进
   conversation.session.header.utilities，当这个会话有活跃自动化任务时就会
   出现在模型选择器和「…」菜单之间。侧栏「自动化任务」页与会话列表的时钟
   标记不受影响。要恢复：删掉这条规则。 */
[data-schedule-reminder-entry] { display: none !important; }

@media (max-width: 720px) {
  .cursor-layout-toggle-label { display: none; }
  .cursor-layout-toggle { padding: 0 6px; }
}
`

    /** Runtime errors captured for the diagnostics report. */
    const errors = []

    /** Last merged-diffbar state (diagnostics: proves whether the review RPC answered). */
    const diffBarDebug = {
      files: -1, error: '', at: 0, registered: false, registerError: '', renders: 0, effectRuns: 0,
      // 点击链诊断：点了哪条记录、当时哪个视图、按什么模式打开、失败原因。
      clicks: 0, lastPath: '', lastView: '', lastFocusDiff: null, lastError: '', lastAt: 0,
    }

    /** Header view-toggle registration state (diagnostics). */
    const viewToggleDebug = {
      registered: false, registerError: '', shortcutError: '', heroRegistered: false, heroRegisterError: '',
      sessionId: '', fileReveals: 0, mediaReveals: 0, mediaPeek: false,
      // 媒体预览列被自动收回的次数与原因（诊断「关掉页签后右侧留一条黑列」）
      peekCloses: 0, peekCloseReason: '', peekSawPanelOpen: false,
      // 空编辑区 → Agent 视图（每个会话）的判定计数：广播次数 / 自动切 Agent / 迟到恢复回退
      editorPresence: 0, emptyAgents: 0, emptyFilled: 0,
    }

    /** Native changed-files card click → IDE view reveal (diagnostics). */
    const changedFilesDebug = {
      clicks: 0, reveals: 0, skipped: 0, lastPath: '', lastLabel: '', lastAt: 0, reviewTab: null,
    }

    /** Native delivered-file card click → IDE editor tab (diagnostics). */
    const presentedOpenDebug = {
      clicks: 0, opened: 0, cards: 0, lastPath: '', lastView: '', lastAt: 0, editorTab: null,
    }

    /** IDE-view left rail reveal (diagnostics): dsh-vscode-mode's「文件管理」tree. */
    const explorerDebug = {
      attempts: 0, finds: 0, opened: 0, lastAt: 0, railOnly: null, active: null, error: '',
    }

    /** Latest dsh-vscode-mode AI inline status (diagnostics for ghost text). */
    const aiDebug = { registered: false, last: null, lastAt: 0, events: 0, config: null, configError: '' }

    /** Root client context captured for diagnostics probes (read-only). */
    let rootCtx = null

    /** Inline-completion shim / Monaco state (diagnostics for ghost text). */
    const inlineDebug = { monaco: false, registerApi: false, editors: 0, modelUri: '', inlineEnabled: null, shimHits: 0, triggerSent: 0, status: '' }

    /** Own inline-completion provider state (wired to the same host AI route). */
    const ownInline = {
      ready: false,
      enabled: false,
      calls: 0,
      errors: 0,
      lastMs: 0,
      lastLen: 0,
      lastNote: '',
      lastError: '',
      lastText: '',
      disposedShipped: false,
    }

    /** AI inline toggle, refreshed from the host config. */
    let ownInlineEnabled = false

    /** Official shortcut catalog rows for dsh-vscode-mode commands (Ctrl+U probe). */
    function probeShortcuts(ctx) {
      try {
        const service = ctx === null ? undefined : ctx.get('shortcuts')
        const catalog = service && service.catalog
        const rows = catalog && typeof catalog.getSnapshot === 'function' ? catalog.getSnapshot() : null
        if (!Array.isArray(rows)) return { available: false }
        return {
          available: true,
          total: rows.length,
          hasSidebarToggle: rows.some((row) => String((row && row.id) || '') === 'sidebar.left.toggle'),
          hasViewToggle: rows.some((row) => String((row && row.id) || '') === 'cursorLayout.toggleView'),
          edrv: rows
            .filter((row) => {
              const id = String((row && row.id) || '')
              return id.indexOf('edrv.') === 0 || id.indexOf('cursorLayout.') === 0
            })
            .map((row) => ({ id: row.id, binding: row.binding, keys: row.keys, issue: row.issue, conflicts: row.conflicts }))
            .slice(0, 90),
        }
      } catch (error) {
        return { error: String((error && error.message) || error) }
      }
    }

    /** Nearest shell frame: the element owning the rightbar column. */
    function findFrame() {
      const column = document.querySelector('[data-rightbar-col]')
      return column === null ? null : column.parentElement
    }

    /** Current sidebar track width in px, read from the frame's inline geometry. */
    function sidebarWidthOf(frame) {
      const template = frame.style.gridTemplateColumns || ''
      const first = /^\s*([0-9.]+)px/.exec(template)
      if (first !== null) return Math.round(Number(first[1]))
      return frame.hasAttribute('data-sidebar-collapsed') ? 0 : 280
    }

    /** The wide limit that still leaves room for the workbench column. */
    function chatWidthMax() {
      return Math.max(CHAT_MIN_PX, Math.min(CHAT_MAX_PX, window.innerWidth - 420))
    }

    /** Persisted dragged conversation width, if the user ever dragged it. */
    function storedChatWidth() {
      try {
        const raw = localStorage.getItem(CHAT_WIDTH_KEY)
        if (raw !== null) {
          const value = Number(raw)
          if (Number.isFinite(value) && value > 0) return value
        }
      } catch (error) { /* storage unavailable */ }
      return undefined
    }

    /** Chat column width: the dragged width, else a viewport share. */
    function chatWidth() {
      const stored = storedChatWidth()
      const raw = stored !== undefined
        ? stored
        : Math.round(window.innerWidth * CHAT_VIEWPORT_SHARE)
      return Math.min(chatWidthMax(), Math.max(CHAT_MIN_PX, Math.round(raw)))
    }

    // --region 每个会话独立的 IDE / Agent 视图
    //
    // The projection is a window-level grid, but the *choice* belongs to the
    // conversation on screen: session A can sit in the Agent view while session B
    // shows the IDE workbench. The map below is that choice store; `layoutView`
    // stays the effective value read by sync(), the resizer and the timers.

    /** Normalize a stored view value; anything but "agent" is the Cursor default. */
    function normalizeView(view) {
      return view === VIEW_AGENT ? VIEW_AGENT : VIEW_CURSOR
    }

    /**
     * Read the per-session view map. A profile upgraded from the single global
     * value seeds the fallback with it, so an upgrade keeps the behavior the user
     * already had until they flip a session.
     * @returns `{ fallback, bySession }` (in-memory maps, never null)
     */
    function readViewState() {
      const state = { fallback: VIEW_CURSOR, bySession: Object.create(null) }
      try {
        const raw = localStorage.getItem(VIEWS_KEY)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') {
            state.fallback = normalizeView(parsed.fallback)
            const map = parsed.bySession
            if (map !== null && typeof map === 'object') {
              for (const [sessionId, view] of Object.entries(map)) {
                if (typeof sessionId === 'string' && sessionId.length > 0) {
                  state.bySession[sessionId] = normalizeView(view)
                }
              }
            }
          }
          return state
        }
        state.fallback = normalizeView(localStorage.getItem(VIEW_KEY))
      } catch (error) { /* storage unavailable: in-memory defaults still apply */ }
      return state
    }

    const initialViewState = readViewState()
    /** View for the blank hero page and for sessions that never made a choice. */
    let fallbackView = initialViewState.fallback
    /** Explicit per-session choices: sessionId → 'cursor' | 'agent'. */
    const sessionViews = initialViewState.bySession
    /** Session on screen (undefined on the blank new-conversation page). */
    let currentSessionId
    /** Effective view of the session on screen; written by commitView(), read everywhere. */
    let layoutView = fallbackView

    /** Remembered view of one session (undefined session → the shared fallback). */
    function viewOfSession(sessionId) {
      if (typeof sessionId === 'string' && Object.prototype.hasOwnProperty.call(sessionViews, sessionId)) {
        return sessionViews[sessionId]
      }
      return fallbackView
    }

    /** Persist the per-session map, dropping the oldest choices past the cap. */
    function persistViewState() {
      const ids = Object.keys(sessionViews)
      for (let index = 0; index < ids.length - VIEW_MAP_LIMIT; index += 1) delete sessionViews[ids[index]]
      try {
        localStorage.setItem(VIEWS_KEY, JSON.stringify({
          version: 2,
          fallback: fallbackView,
          bySession: sessionViews,
        }))
      } catch (error) { /* storage unavailable: the in-memory state still applies */ }
    }

    /**
     * Project one view and tell every toggle. Persisting is the caller's job; this
     * is the single place that writes `layoutView`, uncollapses the conversation on
     * the way into the Agent view, re-runs sync() and reports the change.
     * @param view - the view to project
     * @param reason - diagnostics label forwarded to the report
     */
    function commitView(view, reason) {
      const next = normalizeView(view)
      const changed = next !== layoutView
      layoutView = next
      // The peek belongs to one view/session only; any view change drops it.
      if (mediaPeekActive) setMediaPeek(false)
      if (changed) {
        // The Agent view is the conversation itself: never hide it on the way in.
        if (next === VIEW_AGENT && chatCollapsed) {
          chatCollapsed = false
          try { localStorage.setItem(CHAT_COLLAPSED_KEY, '0') } catch (error) { /* ignore */ }
        }
        window.requestAnimationFrame(() => {
          try { sync() } catch (error) { /* the frame observers retry the projection */ }
          sendReport(reason || 'view-change')
        })
      }
      try {
        window.dispatchEvent(new CustomEvent('cursor-layout:view', {
          detail: { view: next, sessionId: currentSessionId },
        }))
      } catch (error) { /* ignore */ }
    }

    /**
     * Switch view and remember the choice for one session. The default target is
     * the session on screen; with no session (blank hero page) the choice becomes
     * the shared fallback that new sessions start from.
     * @param view - 'cursor' | 'agent'
     * @param sessionId - optional explicit target session
     */
    function setLayoutView(view, sessionId) {
      const next = normalizeView(view)
      const target = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : currentSessionId
      if (target === undefined) fallbackView = next
      else sessionViews[target] = next
      persistViewState()
      // 用户手选视图：清掉「空编辑区自动切」的标记（推断让位于明确选择）
      if (target === undefined || target === currentSessionId) emptyAgentSessionId = undefined
      // A choice stored for another session leaves the on-screen projection alone.
      if (target === undefined || target === currentSessionId) commitView(next, 'view-change')
    }

    /**
     * Follow the conversation on screen: switching sessions applies that
     * session's remembered view (fallback when it never made a choice). An empty
     * editor (no open files) has nothing to show in the IDE view, so the Agent
     * view is applied instead unless the user picked a view for that session.
     * @param sessionId - the Session now on screen, or undefined for the hero page
     * @param reason - diagnostics label
     */
    function applySessionView(sessionId, reason) {
      if (sessionId === currentSessionId) return
      currentSessionId = sessionId
      viewToggleDebug.sessionId = sessionId === undefined ? '' : sessionId
      // 上一个会话的「空编辑区自动切」标记不带过来
      emptyAgentSessionId = undefined
      const remembered = viewOfSession(sessionId)
      // 需求 1：切到空编辑区 → 直接给 Agent 视图（空工作台没有可看的内容；
      // 手选过 IDE 视图的会话也一样，否则「空文件」的旧会话切回来还是空编辑器；
      // 当次会话里手动切回 IDE 视图仍然有效，直到切走）。
      // 空白新对话页（undefined）不参与：那里没有「该会话的文件」，视图归药丸管。
      // 查询桥未就绪时先按记住的视图投影，等广播 / ensure 计时器兜底补判。
      if (typeof sessionId === 'string' && sessionId.length > 0
        && remembered === VIEW_CURSOR && editorPresenceBridge() !== null && !sessionHasEditorFiles(sessionId)) {
        switchToEmptyAgentView(sessionId, 'session-empty-editor')
      } else {
        commitView(remembered, reason || 'session-view')
      }
      sendReport(reason || 'session-view')
    }

    // --region 空编辑区 → Agent 视图
    //
    // 每个会话的 IDE / Agent 视图原先只按手选记录（view.v2）。空编辑区（该会话没打开
    // 任何文件）停在 IDE 视图只会看到「暂无打开的文件」，没有可看的内容，故：
    //   1. 切会话时：编辑区是空的 → 直接给 Agent 视图（需求 1；手选过 IDE 的会话也一并
    //      让位，当次会话里再手动切回 IDE 仍然有效，直到切走）；
    //   2. 当前会话关掉最后一个文件页签（页签数 >0 → 0）→ 自动切回 Agent 视图（需求 2）；
    //   3. 自动切过去之后编辑区又恢复出文件（迟到水合 / 存档恢复）→ 回到该会话记住的视图。
    // 「空/非空」的事实由 dsh-vscode-mode 广播（`edrv:editor-presence` 事件 +
    // `window.__edrvEditorPresence__.editorFileCount(sessionId)` 同步查询），本模块不嗅探
    // 编辑器 DOM / 存档格式。没有 dsh-vscode-mode（没有查询桥）时不参与判定，保持原行为。

    /** dsh-vscode-mode 的编辑区页签数广播（EditorView 挂载 / 增删页签 / 恢复完成后派发）。 */
    const PRESENCE_EVENT = 'edrv:editor-presence'
    /** dsh-vscode-mode 的浏览器全局查询桥（见 dsh-vscode-mode 的 client/editorPresence.ts）。 */
    const PRESENCE_GLOBAL = '__edrvEditorPresence__'
    /** 每个会话最近一次真实页签数（未挂载过编辑区的会话没有条目）。 */
    const liveEditorCounts = new Map()
    /** 当前因「空编辑区」自动切到 Agent 视图的会话（undefined = 当前 Agent 视图不是自动切的）。 */
    let emptyAgentSessionId

    /** 该会话是否手选过视图（有显式记录才尊重用户选择）。 */
    function hasChosenView(sessionId) {
      return typeof sessionId === 'string' && sessionId.length > 0
        && Object.prototype.hasOwnProperty.call(sessionViews, sessionId)
    }

    /** dsh-vscode-mode 的编辑区查询桥（未安装 / 未加载 → null）。 */
    function editorPresenceBridge() {
      const bridge = window[PRESENCE_GLOBAL]
      if (bridge === null || typeof bridge !== 'object') return null
      return typeof bridge.editorFileCount === 'function' ? bridge : null
    }

    /**
     * 会话是否有打开的文件。查询桥缺失 / 查询失败按「有文件」处理：
     * 自动切视图只在能确认编辑区为空时发生，绝不误伤。
     * @param sessionId - 会话 id
     * @returns 是否还有打开的文件
     */
    function sessionHasEditorFiles(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      if (liveEditorCounts.has(sessionId)) return liveEditorCounts.get(sessionId) > 0
      const bridge = editorPresenceBridge()
      if (bridge === null) return true
      try {
        const count = bridge.editorFileCount(sessionId)
        return typeof count === 'number' ? count > 0 : true
      } catch (error) {
        return true
      }
    }

    /**
     * 切到「空编辑区的 Agent 视图」。不写按会话的手选记录：这是布局事实的推断，
     * 不是用户的选择——写入会污染 view.v2（切走再切回时又以推断覆盖手选，互相打架）。
     * @param sessionId - 会话 id（空白新对话页为 undefined）
     * @param reason - 诊断原因
     * @returns 是否真的切了（已经是 Agent 视图返回 false）
     */
    function switchToEmptyAgentView(sessionId, reason) {
      if (layoutView === VIEW_AGENT) return false
      emptyAgentSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
      viewToggleDebug.emptyAgents += 1
      commitView(VIEW_AGENT, reason)
      return true
    }

    /**
     * 按编辑区事实重新判定当前会话的视图。三处调用：切会话（applySessionView）、
     * 编辑区广播（页签增删 / 恢复完成）、ensure 计时器（兜底：查询桥 / 编辑器后到）。
     * @param previousCount - 本次广播前该会话的页签数（undefined = 之前没广播过）
     * @param count - 本次广播的页签数（undefined = 轮询判定，没有新广播）
     * @param arrival - 是否是「刚到达一个会话」（切会话 / 首屏补判）：是则不受手选记录约束
     */
    function syncEmptyEditorView(previousCount, count, arrival) {
      const sessionId = currentSessionId
      // 空白新对话页（还没有会话）没有「该会话的编辑区」：视图由药丸直接控制 fallbackView，
      // 自动判定会把手动切到 IDE 视图的英雄页在一拍后抢回 Agent 视图。
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const explicit = hasChosenView(sessionId)
      const liveKnown = typeof sessionId === 'string' && liveEditorCounts.has(sessionId)
      // 事实来源都没就绪：等广播 / 等查询桥，不做判定
      if (!liveKnown && editorPresenceBridge() === null) return
      if (sessionHasEditorFiles(sessionId)) {
        // 迟到的恢复（水合 / 页签存档回填）带来文件：当前 Agent 视图不是用户手选、
        // 也不是媒体预览列时，还原成该会话记住的视图（空编辑区的推断作废）
        if (!mediaPeekActive && layoutView === VIEW_AGENT && viewOfSession(sessionId) === VIEW_CURSOR) {
          emptyAgentSessionId = undefined
          viewToggleDebug.emptyFilled += 1
          commitView(VIEW_CURSOR, 'editor-filled')
        }
        return
      }
      if (count === 0 && previousCount !== undefined && previousCount > 0) {
        // 用户刚关掉最后一个文件页签（需求 2）：手选过 IDE 视图也自动回 Agent
        if (mediaPeekActive) setMediaPeek(false)
        switchToEmptyAgentView(sessionId, 'editor-empty-closed')
        return
      }
      // 手选记录只保护「同一会话内的手动切换」；到达会话（切会话 / 首屏补判）时事实优先
      if (explicit && arrival !== true) return
      if (layoutView !== VIEW_CURSOR) return
      switchToEmptyAgentView(sessionId, count === 0 ? 'editor-empty' : 'editor-empty-poll')
    }

    /**
     * 编辑区页签数广播的订阅回调。
     * @param event - `edrv:editor-presence` CustomEvent（detail = { sessionId, tabCount }）
     */
    function onEditorPresence(event) {
      const detail = event && event.detail ? event.detail : null
      if (detail === null || typeof detail.sessionId !== 'string' || detail.sessionId.length === 0) return
      if (typeof detail.tabCount !== 'number' || !Number.isFinite(detail.tabCount)) return
      const sessionId = detail.sessionId
      const count = Math.max(0, Math.floor(detail.tabCount))
      const previous = liveEditorCounts.get(sessionId)
      liveEditorCounts.set(sessionId, count)
      viewToggleDebug.editorPresence += 1
      // 广播可能来自正在卸载 / 已切走的会话：只判定当前会话
      if (sessionId !== currentSessionId) return
      syncEmptyEditorView(previous, count)
    }

    /**
     * 订阅编辑区广播。
     * @returns 取消订阅函数
     */
    function bindEditorPresence() {
      window.addEventListener(PRESENCE_EVENT, onEditorPresence)
      return () => window.removeEventListener(PRESENCE_EVENT, onEditorPresence)
    }

    /**
     * 空编辑区判定的状态快照（诊断：桥是否就绪、当前会话实时 / 存档页签数、自动切计数）。
     * @returns 诊断载荷（直接进 /cursor-layout/report）
     */
    function emptyEditorDebugState() {
      const bridge = editorPresenceBridge()
      let savedTabs = null
      if (bridge !== null && typeof currentSessionId === 'string') {
        try {
          const count = bridge.editorFileCount(currentSessionId)
          savedTabs = typeof count === 'number' ? count : null
        } catch (error) {
          savedTabs = 'error'
        }
      }
      return {
        bridge: bridge !== null,
        bridgeVersion: bridge !== null && typeof bridge.version === 'string' ? bridge.version : '',
        autoAgent: emptyAgentSessionId === undefined ? '' : emptyAgentSessionId,
        liveSessions: liveEditorCounts.size,
        currentTabs: typeof currentSessionId === 'string' && liveEditorCounts.has(currentSessionId)
          ? liveEditorCounts.get(currentSessionId)
          : null,
        savedTabs,
      }
    }
    // --endregion

    /** Session-scope binding diagnostics (`uiSession.current` follow). */
    const sessionBinding = { active: false, source: '', error: '' }

    /**
     * Bind to `uiSession.current`, the authoritative "conversation on screen".
     * One subscription for the whole page: every Session switch re-applies that
     * Session's view. A DOM fallback covers a client build without the service
     * (see the ensure timer).
     * @param ctx - client root context
     */
    function bindSessionView(ctx) {
      try {
        ctx.inject(['uiSession'], (scope) => {
          scope.effect(() => {
            const source = scope.uiSession === undefined ? undefined : scope.uiSession.current
            if (source === undefined || typeof source.getSnapshot !== 'function') return undefined
            sessionBinding.active = true
            sessionBinding.source = 'uiSession'
            const read = () => {
              const binding = source.getSnapshot()
              const sessionId = binding !== null && typeof binding === 'object' && typeof binding.key === 'string'
                ? binding.key
                : undefined
              applySessionView(sessionId, 'session-binding')
            }
            read()
            return typeof source.subscribe === 'function' ? source.subscribe(read) : undefined
          }, 'cursor-layout: per-session view')
        })
      } catch (error) {
        sessionBinding.error = String((error && error.message) || error)
      }
    }

    /** Chat file links render as `<button class="_fileLink_…">` (CSS-module name). */
    const FILE_LINK_CLASS = /fileLink|file-link/i

    /**
     * Nearest chat file link for a click target. The markdown renderer buttons a
     * workspace path (`title` = path); explicit `dsh-resource://file/…` anchors
     * open the same way.
     * @param target - event target
     * @returns the link element, or null when the click is not a file link
     */
    function fileLinkElementOf(target) {
      if (!(target instanceof Element)) return null
      const element = target.closest('button, a, [role="button"]')
      if (element === null) return null
      const className = typeof element.className === 'string' ? element.className : ''
      if (FILE_LINK_CLASS.test(className)) return element
      if (element.tagName === 'A') {
        const href = element.getAttribute('href') || ''
        if (href.indexOf('dsh-resource://file/') === 0) return element
      }
      return null
    }

    /**
     * Resolve a click's file path. File chips carry the full path in `title`;
     * `dsh-resource://file/…` anchors encode it; the chip label is the fallback.
     * @param element - chat file link element
     * @returns candidate path (may be empty)
     */
    function fileLinkPathOf(element) {
      const title = element.getAttribute('title')
      if (title !== null && title.trim().length > 0) return title.trim()
      const href = element.tagName === 'A' ? (element.getAttribute('href') || '') : ''
      if (href.indexOf('dsh-resource://file/') === 0) {
        const rest = href.slice('dsh-resource://file/'.length)
        const parts = rest.split('/')
        const scope = parts.shift() || ''
        const decoded = parts.map((part) => {
          try { return decodeURIComponent(part) } catch (error) { return part }
        })
        if (scope === 'session') return decoded.slice(1).join('/')
        if (scope === 'absolute') return '/' + decoded.join('/')
        return decoded.join('/')
      }
      return String(element.textContent || '').trim()
    }

    /**
     * Whether a path carries a media suffix (video / browser-decodable image).
     * @param path - candidate file path
     * @returns true for media files
     */
    function isMediaPathLike(path) {
      const base = String(path || '').split(/[\\/]/).pop() || ''
      const dot = base.lastIndexOf('.')
      if (dot <= 0 || dot === base.length - 1) return false
      const ext = base.slice(dot + 1).toLowerCase().replace(/[?#].*$/, '')
      return MEDIA_EXT.indexOf(ext) >= 0
    }

    /* ------------------------------------------------------------------ */
    /* Agent-view media peek: a chat media link opens the VSCode editor    */
    /* tab (dsh-vscode-mode) docked on the RIGHT instead of switching to   */
    /* the IDE view (which puts the workbench in the middle).              */
    /* ------------------------------------------------------------------ */

    /** Whether the media peek column is currently projected. */
    let mediaPeekActive = false

    /** Interval that retracts a peek whose panel is gone (belt and braces). */
    let peekWatchdog = 0

    /** Last media path projected into the peek (the IDE fallback reopens it). */
    let peekMediaPath = ''

    /** Live peek width: a slice of the viewport, bounded. */
    function peekWidth() {
      return Math.round(Math.min(PEEK_MAX_PX, Math.max(PEEK_MIN_PX, window.innerWidth * PEEK_VIEWPORT_SHARE)))
    }

    /**
     * Observe the peek column while it is projected. The peek is only a
     * relocation of the shipped right panel, so a column whose panel is gone is
     * an empty black strip with no close control — it must never survive. This
     * interval is the last line of defence: `sync()` reacts to the frame
     * attribute, this one keeps looking for as long as the peek lives.
     */
    function startPeekWatchdog() {
      stopPeekWatchdog()
      const openedAt = Date.now()
      peekWatchdog = window.setInterval(() => {
        if (!mediaPeekActive) { stopPeekWatchdog(); return }
        if (layoutView !== VIEW_AGENT) return
        const frame = findFrame()
        if (frame === null) return
        if (!frame.hasAttribute('data-rightbar-collapsed')) {
          viewToggleDebug.peekSawPanelOpen = true
          return
        }
        if (viewToggleDebug.peekSawPanelOpen) {
          setMediaPeek(false, 'panel-collapsed')
          return
        }
        // Never opened at all (the editor panel refused to expand): a column of
        // nothing is worse than no preview, so fall back to the IDE view where
        // the media lands in the editor the user can see.
        if (Date.now() - openedAt > PEEK_OPEN_GRACE_MS) {
          const path = peekMediaPath
          setMediaPeek(false, 'panel-never-opened')
          setLayoutView(VIEW_CURSOR)
          if (path !== '') openMediaInEditor(path)
        }
      }, 400)
    }

    /** Stop the peek watchdog. */
    function stopPeekWatchdog() {
      if (peekWatchdog !== 0) {
        window.clearInterval(peekWatchdog)
        peekWatchdog = 0
      }
    }
    /** dsh-vscode-mode's workbench tab: the editor that owns the video/image panel. */
    function findEditorTabButton() {
      try {
        const tabs = Array.from(document.querySelectorAll('div[role="tablist"] button[role="tab"]'))
        for (const tab of tabs) {
          if (tab.textContent && tab.textContent.indexOf('文件编辑') >= 0) return tab
        }
      } catch (error) { /* DOM unavailable */ }
      return null
    }

    /**
     * Make sure the workbench shows dsh-vscode-mode's editor tab: expand the right
     * panel when collapsed and activate 「文件编辑」 when another panel tab is in front.
     * Needed because the editor body (and its edrv:open-editor listener) is lazily
     * mounted by the panel.
     */
    function ensureEditorPanel() {
      const frame = findFrame()
      const collapsed = frame !== null && frame.hasAttribute('data-rightbar-collapsed')
      let tab = findEditorTabButton()
      if ((collapsed || tab === null) && rootCtx !== null && typeof rootCtx.get === 'function') {
        const service = rootCtx.get('sidebarRight')
        if (service !== undefined && typeof service.openTab === 'function') {
          try { service.openTab(EDITOR_KIND, {}) } catch (error) { /* seat not bound yet */ }
        }
        tab = findEditorTabButton()
      }
      if (tab !== null) {
        try { tab.click() } catch (error) { /* the panel may have replaced it */ }
      }
    }

    /**
     * Open one media path in dsh-vscode-mode's editor (video / image preview panel).
     * The editor body mounts lazily, so the open request is retried until the view
     * appears (each dispatch re-selects the same tab when it lands twice).
     * @param path - workspace-relative or absolute media path
     */
    function openMediaInEditor(path) {
      // In the Agent view the media lives in the peek column; once that column is
      // retracted (the user closed the editor tab) the late retries would only
      // re-open it behind a hidden panel, so they stop together with the peek.
      const stopWithPeek = layoutView === VIEW_AGENT
      if (stopWithPeek) peekMediaPath = path
      // The editor body mounts lazily after the panel tab activates; retry the
      // (idempotent) open request across the mount window.
      for (const delay of [80, 250, 500, 900, 1500, 2400]) {
        window.setTimeout(() => {
          if (stopWithPeek && !mediaPeekActive) return
          try {
            window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail: { path } }))
          } catch (error) { /* ignore */ }
        }, delay)
      }
    }

    /**
     * Open one path in dsh-vscode-mode's workbench editor. The right-panel tab
     * mounts its body lazily, so the request is repeated across the mount window —
     * the same idiom as openMediaInEditor above. Re-dispatching the same path is
     * idempotent: the path is the tab key, so no duplicate tab is created.
     * @param path - workspace-relative or absolute file path
     * @param focusDiff - true opens the review/diff flow and jumps to the first
     *   hunk; false opens the file itself (image / video / binary preview)
     * @param line - 1-based line to land on; ignored when focusDiff is true
     *   (dsh-vscode-mode treats the two as mutually exclusive)
     */
    function openInEditor(path, focusDiff, line, endLine, retries) {
      const detail = focusDiff === true
        ? { path, focusDiff: true }
        : typeof line === 'number' && Number.isFinite(line) && line > 0
          ? {
              path,
              line: Math.floor(line),
              ...(typeof endLine === 'number' && Number.isFinite(endLine) && endLine >= line
                ? { endLine: Math.floor(endLine) }
                : {}),
            }
          : { path }
      // 1200ms 之后编辑器可能才刚挂上 Monaco（首次跳转只开到文件不落行的已知时序），
      // 补两拍再派发一次，让 pendingFocus 在后到的渲染里被消费。
      for (const delay of Array.isArray(retries) ? retries : [0, 150, 500, 1200, 2000, 3000]) {
        window.setTimeout(() => {
          try {
            window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail }))
          } catch (error) { /* a detaching page: the retry budget is best effort */ }
        }, delay)
      }
    }

    /**
     * dsh-vscode-mode's activity-rail button for its file panel (「文件管理」).
     * The rail is the 44px icon column on the editor's left side.
     * @returns the rail button, or null while the editor is not mounted
     */
    function findExplorerRailButton() {
      try {
        const sidebar = document.querySelector('.edrv-sidebar')
        if (sidebar === null) return null
        const buttons = Array.from(sidebar.querySelectorAll('button.edrv-rail-btn'))
        for (const button of buttons) {
          const title = String(button.getAttribute('title') || '')
          if (/(文件|explorer|files)/i.test(title) && !/面板区/.test(title)) return button
        }
        // Fallback: the file panel is the first rail entry.
        return buttons.length > 0 ? buttons[0] : null
      } catch (error) {
        return null
      }
    }

    /**
     * Show where the opened file lives: expand dsh-vscode-mode's left panel area and
     * activate the「文件管理」tree. The tree follows the active editor path by itself
     * (its reveal hook listens to `activePath`), so once that panel is mounted the
     * just-opened file is expanded and highlighted — the editor window gets the
     * VS Code「打开文件 → 左侧资源管理器定位」behavior.
     * @returns whether the rail button was found
     */
    function ensureExplorerPanel() {
      explorerDebug.attempts += 1
      try {
        const sidebar = document.querySelector('.edrv-sidebar')
        const button = findExplorerRailButton()
        if (sidebar === null || button === null) return false
        explorerDebug.finds += 1
        const railOnly = sidebar.classList.contains('edrv-sidebar-rail-only')
        const active = button.classList.contains('edrv-rail-on')
        explorerDebug.railOnly = railOnly
        explorerDebug.active = active
        if (!railOnly && active) return true
        button.click()
        explorerDebug.opened += 1
        explorerDebug.lastAt = Date.now()
        return true
      } catch (error) {
        explorerDebug.error = String((error && error.message) || error)
        return false
      }
    }

    /** Retry the explorer reveal across the editor body's lazy-mount window. */
    function scheduleExplorerReveal() {
      for (const delay of [140, 420, 900, 1600, 2600, 3800]) {
        window.setTimeout(() => {
          try { ensureExplorerPanel() } catch (error) { /* next tick retries */ }
        }, delay)
      }
    }

    /**
     * Project / clear the Agent-view media peek column.
     * @param on - true shows the workbench on the right, false clears it
     * @param reason - diagnostics: why the peek was cleared (ignored when opening)
     */
    function setMediaPeek(on, reason) {
      const next = on === true
      if (next !== mediaPeekActive) {
        mediaPeekActive = next
        viewToggleDebug.mediaPeek = next
        if (next) {
          // Opening: the panel may still be collapsed until ensureEditorPanel()
          // commits, so the "panel was open" witness starts false.
          viewToggleDebug.peekSawPanelOpen = false
        } else {
          viewToggleDebug.peekCloses += 1
          viewToggleDebug.peekCloseReason = typeof reason === 'string' && reason !== '' ? reason : 'explicit'
        }
        const frame = findFrame()
        if (frame !== null) {
          if (next) {
            frame.setAttribute(MEDIA_PEEK_ATTR, '')
            frame.style.setProperty('--cursor-layout-peek', `${peekWidth()}px`)
          } else {
            frame.removeAttribute(MEDIA_PEEK_ATTR)
            frame.style.removeProperty('--cursor-layout-peek')
          }
        }
      }
      if (next) {
        ensureEditorPanel()
        startPeekWatchdog()
      } else {
        stopPeekWatchdog()
      }
      window.requestAnimationFrame(() => {
        try { sync() } catch (error) { /* the frame observers retry */ }
      })
      sendReport(next ? 'media-peek-on' : 'media-peek-off')
    }

    /**
     * Chat file-link click (capture phase, before the chat routes the file):
     * - media link → always open in dsh-vscode-mode's editor panel (video/image
     *   preview). In the Agent view the editor docks on the RIGHT (media peek)
     *   and the event is consumed so the chat's own resource router — which
     *   lands in viewers that render binary media as「不支持预览」— never runs;
     * - other file link in the Agent view → reveal the IDE view as before.
     * @returns disposer removing the capture listener
     */
    function installFileLinkReveal() {
      const onFileLinkClick = (event) => {
        const element = fileLinkElementOf(event.target)
        if (element === null) return
        const path = fileLinkPathOf(element)
        const media = path !== '' && isMediaPathLike(path)
        if (media) {
          event.preventDefault()
          event.stopPropagation()
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
          viewToggleDebug.mediaReveals += 1
          if (layoutView === VIEW_AGENT) setMediaPeek(true)
          else ensureEditorPanel()
          openMediaInEditor(path)
          return
        }
        if (layoutView !== VIEW_AGENT) return
        const sessionId = currentSessionId
        if (sessionId === undefined) return
        viewToggleDebug.fileReveals += 1
        setLayoutView(VIEW_CURSOR, sessionId)
        // The editor window should also show where the file lives (left tree).
        scheduleExplorerReveal()
      }
      window.addEventListener('click', onFileLinkClick, true)
      return () => window.removeEventListener('click', onFileLinkClick, true)
    }

    /**
     * Tab-strip watcher for the media peek. The peek borrows the shipped right
     * panel, and that panel's tab strip can close the 「文件编辑」 tab the peek was
     * opened with: closing the LAST tab collapses the column (handled in
     * `sync()`), but closing it while other tabs stay open would leave the peek
     * showing a panel that no longer holds the media. Either way, the peek is
     * retracted so that X lands back in the plain Agent view.
     * @returns disposer removing the capture listener
     */
    function installPeekTabCloseWatcher() {
      const onTabStripClick = (event) => {
        if (!mediaPeekActive || layoutView !== VIEW_AGENT) return
        const target = event.target
        if (!(target instanceof Element) || target.closest('[role="tablist"]') === null) return
        // Only a strip that currently holds the editor tab can lose it.
        if (findEditorTabButton() === null) return
        for (const delay of [120, 420, 1000]) {
          window.setTimeout(() => {
            if (!mediaPeekActive || layoutView !== VIEW_AGENT) return
            if (findEditorTabButton() !== null) return
            setMediaPeek(false, 'editor-tab-closed')
          }, delay)
        }
      }
      window.addEventListener('click', onTabStripClick, true)
      return () => window.removeEventListener('click', onTabStripClick, true)
    }

    /**
     * Clickable trigger of the native changed-files card: its header (whole-card
     * review entry, single-file card) or one file row. The fold toggle carries
     * `aria-expanded` and only expands the list, so it does not switch views.
     * @param target - click target
     * @returns the card's header / row button, or null outside the card
     */
    function changedFilesTriggerOf(target) {
      if (!(target instanceof Element)) return null
      const card = target.closest(CHANGED_FILES_CARD)
      if (card === null) return null
      const trigger = target.closest('button')
      if (trigger === null || !card.contains(trigger)) return null
      if (trigger.hasAttribute('aria-expanded')) return null
      return trigger
    }

    /**
     * Path a changed-files trigger stands for. Rows describe the resolved
     * workspace path in a hidden `aria-describedby` node (the visible label is
     * shortened); the label is the fallback when that node is missing.
     * @param trigger - card header / row button
     * @returns absolute or workspace-relative path (may be '')
     */
    function changedFilesPathOf(trigger) {
      const describedBy = trigger.getAttribute('aria-describedby')
      if (describedBy !== null) {
        for (const id of describedBy.trim().split(/\s+/)) {
          if (id.length === 0) continue
          const node = document.getElementById(id)
          if (node === null) continue
          const text = String(node.textContent || '').trim()
          if (text.length > 0) return text
        }
      }
      return String(trigger.getAttribute('aria-label') || '').trim()
    }

    /**
     * Native「已编辑 N 个文件」card → IDE view. The card opens its per-file review
     * as a right-sidebar resource tab; in the Agent view that sidebar is the
     * hidden workbench column, so a click there used to look dead. Recognize the
     * click in the capture phase, project the IDE view first, then let the native
     * handler open the review tab where it is now visible.
     * @returns disposer removing the capture listener
     */
    function installChangedFilesReveal() {
      const onChangedFilesClick = (event) => {
        const trigger = changedFilesTriggerOf(event.target)
        if (trigger === null) return
        changedFilesDebug.clicks += 1
        changedFilesDebug.lastPath = changedFilesPathOf(trigger).slice(0, 260)
        changedFilesDebug.lastLabel = String(trigger.getAttribute('aria-label') || '').slice(0, 160)
        changedFilesDebug.lastAt = Date.now()
        // IDE view already projects the workbench: the native handler is enough.
        if (layoutView !== VIEW_AGENT) {
          changedFilesDebug.skipped += 1
          return
        }
        const sessionId = currentSessionId
        if (sessionId === undefined) {
          changedFilesDebug.skipped += 1
          return
        }
        changedFilesDebug.reveals += 1
        // Capture phase runs before React's onClick: switching here makes the
        // review tab the native click opens land in a visible workbench.
        setLayoutView(VIEW_CURSOR, sessionId)
        // Project the grid synchronously too: the native onClick runs right after
        // this handler, and the workbench must already be laid out when the review
        // resource tab mounts inside it.
        try { sync() } catch (error) { /* the frame observers retry */ }
        window.setTimeout(() => {
          const tab = document.querySelector(CHANGED_FILES_REVIEW)
          changedFilesDebug.reviewTab = tab === null ? null : { rect: rectOf(tab), display: getComputedStyle(tab).display }
        }, CHANGED_FILES_TAB_DELAY_MS)
      }
      window.addEventListener('click', onChangedFilesClick, true)
      return () => window.removeEventListener('click', onChangedFilesClick, true)
    }

    /**
     * Preview trigger of a native delivered-file card (`present` results and the
     * turn-tail file cards). The preview is the card's only direct-child button,
     * covering the whole card; the action buttons live inside `.actions` and keep
     * their own handlers (e.g. an explicit "open in sidebar" stays native).
     * @param target - click target
     * @returns the card's preview button, or null outside such a card
     */
    function presentedFileTriggerOf(target) {
      if (!(target instanceof Element)) return null
      const card = target.closest(PRESENTED_FILE_CARD)
      if (card === null) return null
      const button = target.closest('button')
      if (button === null) return null
      const preview = card.querySelector(':scope > button')
      return preview !== null && preview === button ? preview : null
    }

    /**
     * Path a delivered-file card opens. The card keeps the resolved absolute
     * path in the preview button's `title`; the visible label is only a basename.
     * @param trigger - card preview button
     * @returns resolved path (may be '')
     */
    function presentedFilePathOf(trigger) {
      const title = trigger.getAttribute('title')
      return title !== null ? title.trim() : ''
    }

    /**
     * Open one path in the IDE view's editor tab. Delivered-file cards are code,
     * images and videos alike, so the same route covers all of them: project the
     * IDE view, activate 「文件编辑」, hand the path to dsh-vscode-mode (its editor
     * owns the image / video / markdown panels) and expand the editor's left file
     * tree on the file's folder so its location is visible.
     * @param path - absolute or workspace-relative file path
     * @returns whether the editor route was available
     */
    function openPathInIdeView(path) {
      if (path === '') return false
      if (layoutView === VIEW_AGENT) {
        const sessionId = currentSessionId
        if (sessionId !== undefined) setLayoutView(VIEW_CURSOR, sessionId)
        try { sync() } catch (error) { /* the frame observers retry */ }
      }
      if (!vscodeModeLoaded()) return false
      ensureEditorPanel()
      // Retries cover the editor body's lazy mount after the tab activates.
      openMediaInEditor(path)
      // …and the left rail: the editor window should show where the file lives.
      scheduleExplorerReveal()
      // Diagnostics: proves the editor tab (and its body) is on screen afterwards.
      window.setTimeout(() => {
        const body = document.querySelector('.edrv-editor-area, .edrv-full-view')
        presentedOpenDebug.editorTab = body === null ? null : { rect: rectOf(body), display: getComputedStyle(body).display }
      }, EDITOR_OPEN_SNAPSHOT_MS)
      return true
    }

    /**
     * Native delivered-file card → IDE view's 「文件编辑」. The native click routes
     * through the chat's `openFile` (an official sidebar resource tab), which in
     * the Agent view lands in the hidden workbench column — the click looked dead.
     * Consume that click and open the file in dsh-vscode-mode's editor instead, so
     * a card click always ends up in the visible editor tab.
     * @returns disposer removing the capture listener
     */
    function installPresentedFileReveal() {
      const onPresentedFileClick = (event) => {
        const trigger = presentedFileTriggerOf(event.target)
        if (trigger === null) return
        const path = presentedFilePathOf(trigger)
        if (path === '') return
        presentedOpenDebug.clicks += 1
        presentedOpenDebug.lastPath = path.slice(0, 260)
        presentedOpenDebug.lastView = layoutView
        presentedOpenDebug.lastAt = Date.now()
        const editorRoute = vscodeModeLoaded()
        if (editorRoute) {
          // The editor opens the file itself: never let the chat's resource
          // router open a second (official sidebar) tab behind our back.
          event.preventDefault()
          event.stopPropagation()
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        }
        if (openPathInIdeView(path)) presentedOpenDebug.opened += 1
      }
      window.addEventListener('click', onPresentedFileClick, true)
      return () => window.removeEventListener('click', onPresentedFileClick, true)
    }

    // The right-hand conversation column can be collapsed from the OFFICIAL
    // right-panel collapse button (dsh-client-ui-sidebar-right's
    // `[data-sidebar-right-toggle]`) while in the IDE view: the right side of
    // the IDE view IS the conversation, so that button is re-purposed instead of
    // collapsing the workbench panel. State is persisted per browser.
    const CHAT_COLLAPSED_KEY = 'dsh-cursor-layout/chat-collapsed.v1'
    const CHAT_COLLAPSED_ATTR = 'data-cursor-chat-collapsed'

    function readChatCollapsed() {
      try { return localStorage.getItem(CHAT_COLLAPSED_KEY) === '1' } catch (error) { return false }
    }

    let chatCollapsed = readChatCollapsed()

    function setChatCollapsed(next) {
      const value = next === true
      if (value === chatCollapsed) return
      chatCollapsed = value
      try { localStorage.setItem(CHAT_COLLAPSED_KEY, value ? '1' : '0') } catch (error) { /* ignore */ }
      window.requestAnimationFrame(() => {
        try { sync() } catch (error) { /* frame observers retry */ }
      })
    }

    /** Whether vscode-mode's browser half has loaded (its tab kind exists then). */
    function vscodeModeLoaded() {
      return window[VSCODE_GLOBAL] !== undefined
    }

    /** Whether vscode-mode remembers an editor tab and will restore it itself. */
    function vscodeHasSavedTab() {
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          if (key !== null && key.startsWith(VSCODE_TAB_KEY)) return true
        }
      } catch (error) { /* storage unavailable: treat as no saved tab */ }
      return false
    }

    /** Small rounded rectangle description for the diagnostics payload. */
    function rectOf(element) {
      if (element === null || element === undefined) return null
      const box = element.getBoundingClientRect()
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.width),
        h: Math.round(box.height),
      }
    }

    /** Attribute snapshot for the diagnostics payload. */
    function attrsOf(element) {
      const out = {}
      for (const attribute of Array.from(element.attributes).slice(0, 14)) {
        out[attribute.name] = String(attribute.value).slice(0, 60)
      }
      return out
    }

    /** One element's identity plus layout facts for the diagnostics payload. */
    function describe(element) {
      if (element === null || element === undefined) return null
      const computed = getComputedStyle(element)
      return {
        tag: element.tagName.toLowerCase(),
        cls: String(element.className || '').slice(0, 90),
        attrs: attrsOf(element),
        rect: rectOf(element),
        display: computed.display,
        visibility: computed.visibility,
        transform: computed.transform,
        width: computed.width,
        inlineWidth: element.style.width,
      }
    }

    /**
     * State of the native changed-files card and of this module's reveal
     * (diagnostics): whether the card is on screen, what its buttons look like,
     * and where the review tab the last click opened actually landed.
     * @returns diagnostics payload (directly into /cursor-layout/report)
     */
    function changedFilesDebugState() {
      const cards = Array.from(document.querySelectorAll(CHANGED_FILES_CARD))
      const card = cards.length > 0 ? cards[cards.length - 1] : null
      return {
        cards: cards.length,
        card: describe(card),
        buttons: card === null ? [] : Array.from(card.querySelectorAll('button')).slice(0, 8).map((element) => ({
          label: String(element.getAttribute('aria-label') || '').slice(0, 100),
          describedBy: String(element.getAttribute('aria-describedby') || '').slice(0, 100),
          expanded: element.hasAttribute('aria-expanded'),
        })),
        reviewTabs: document.querySelectorAll(CHANGED_FILES_REVIEW).length,
        ...changedFilesDebug,
      }
    }

    /** Collect the frame geometry the projection depends on. */
    function buildReport() {
      const frame = findFrame()
      const base = {
        at: new Date().toISOString(),
        version: '0.5.16-peek-watchdog',
        view: layoutView,
        sessionId: currentSessionId === undefined ? '' : currentSessionId,
        fallbackView: fallbackView,
        sessionViewCount: Object.keys(sessionViews).length,
        sessionBinding: { ...sessionBinding },
        emptyEditor: emptyEditorDebugState(),
        href: location.href,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        probe: probe === undefined ? undefined : probe.snapshot(),
      }
      if (frame === null) return { ...base, frameFound: false }
      const workbench = frame.querySelector('[data-rightbar-col]')
      const chat = workbench === null ? null : workbench.previousElementSibling
      const sidebar = chat === null ? null : chat.previousElementSibling
      const panel = workbench === null ? null : workbench.querySelector('[data-sidebar-right-panel]')
      return {
        ...base,
        frameFound: true,
        mode: frame.getAttribute(MODE_ATTR) !== null,
        closed: frame.getAttribute(CLOSED_ATTR) !== null,
        frameAttrs: attrsOf(frame),
        inlineTemplate: frame.style.gridTemplateColumns,
        computedTemplate: getComputedStyle(frame).gridTemplateColumns,
        sidebarVar: frame.style.getPropertyValue('--cursor-layout-sidebar'),
        chatVar: frame.style.getPropertyValue('--cursor-layout-chat'),
        sidebar: describe(sidebar),
        chat: describe(chat),
        workbench: describe(workbench),
        panel: describe(panel),
        dockHosts: workbench === null
          ? []
          : Array.from(workbench.querySelectorAll('[data-dockkit-host]')).slice(0, 4).map(describe),
        tabs: workbench === null
          ? []
          : Array.from(workbench.querySelectorAll('[data-dockkit-tab], [data-sidebar-right-tab]'))
            .slice(0, 8)
            .map((element) => String(element.textContent || '').trim().slice(0, 40)),
        vscodeLoaded: vscodeModeLoaded(),
        savedTab: vscodeHasSavedTab(),
        aiDebug: { ...aiDebug },
        ownInline: { ...ownInline },
        inline: (() => {
          try {
            const monaco = window.monaco
            inlineDebug.monaco = monaco !== undefined
            inlineDebug.registerApi = !!(monaco && monaco.languages && typeof monaco.languages.registerInlineCompletionsProvider === 'function')
            const editors = monaco && monaco.editor && typeof monaco.editor.getEditors === 'function' ? monaco.editor.getEditors() : []
            inlineDebug.editors = Array.isArray(editors) ? editors.length : 0
            const editor = Array.isArray(editors) && editors.length > 0 ? editors[0] : null
            try { inlineDebug.modelUri = editor && editor.getModel ? String(editor.getModel()?.uri?.toString() || '') : '' } catch (error) { /* ignore */ }
            try {
              const option = editor && monaco.editor.EditorOption ? monaco.editor.EditorOption.inlineSuggest : null
              inlineDebug.inlineEnabled = option !== null && editor ? editor.getOption(option) : null
            } catch (error) { /* ignore */ }
            const active = document.activeElement
            inlineDebug.focusInEditor = active instanceof Element ? Boolean(active.closest('.monaco-editor')) : false
            const statusEl = Array.from(document.querySelectorAll('span, div')).find((element) => {
              const text = String(element.textContent || '').trim()
              return text.length > 0 && text.length < 40 && /^(AI|补全)/.test(text) && element.children.length === 0
            })
            inlineDebug.status = statusEl ? String(statusEl.textContent || '').trim() : ''
          } catch (error) {
            inlineDebug.error = String((error && error.message) || error)
          }
          return { ...inlineDebug }
        })(),
        shortcuts: probeShortcuts(rootCtx),
        diffBarDebug: { ...diffBarDebug },
        viewToggleDebug: { ...viewToggleDebug },
        changedFiles: changedFilesDebugState(),
        presentedOpen: (() => {
          const cards = Array.from(document.querySelectorAll(PRESENTED_FILE_CARD))
          presentedOpenDebug.cards = cards.length
          return { ...presentedOpenDebug }
        })(),
        explorer: (() => {
          const sidebar = document.querySelector('.edrv-sidebar')
          const buttons = sidebar === null ? [] : Array.from(sidebar.querySelectorAll('button.edrv-rail-btn'))
          return {
            ...explorerDebug,
            rail: sidebar === null ? null : {
              railOnly: sidebar.classList.contains('edrv-sidebar-rail-only'),
              titles: buttons.slice(0, 10).map((button) => String(button.getAttribute('title') || '').slice(0, 40)),
              active: buttons.filter((button) => button.classList.contains('edrv-rail-on'))
                .map((button) => String(button.getAttribute('title') || '').slice(0, 40)),
            },
          }
        })(),
        diffBar: Array.from(document.querySelectorAll('[data-cursor-diffbar]')).slice(0, 2).map((element) => ({
          rect: rectOf(element),
          text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        })),
        docks: Array.from(document.querySelectorAll('div, span, button'))
          .filter((element) => /^(本轮修改|差异\s*\d|Keep All|Undo All|Review 全部|撤销全部|保存全部)/.test(
            String(element.textContent || '').trim().slice(0, 24),
          ))
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            cls: String(element.className || '').slice(0, 80),
            rect: rectOf(element),
            text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
            parentCls: String((element.parentElement && element.parentElement.className) || '').slice(0, 80),
            grandCls: String((element.parentElement && element.parentElement.parentElement && element.parentElement.parentElement.className) || '').slice(0, 80),
            slot: (element.closest('[data-slot]') || {}).getAttribute?.('data-slot') || '',
          })),
        composer: describe(document.querySelector('[data-slot="conversation.composer"]')),
        composerCard: describe(document.querySelector('[data-composer-card]')),
        viewToggle: describe(document.querySelector('[data-cursor-layout-toggle]')),
        headerLeading: describe(document.querySelector('[data-slot="conversation.header.leading"]')),
        heroPresent: document.querySelector('[data-slot^="conversation.hero"]') !== null,
        nativeDock: Array.from(document.querySelectorAll('.edrv-diff-dock-shell, [data-edrv-diff-dock-shell]')).slice(0, 1).map((element) => ({
          display: getComputedStyle(element).display,
          rect: rectOf(element),
        })),
        viewToggleCount: document.querySelectorAll('[data-cursor-layout-toggle]').length,
        platform: document.documentElement.getAttribute('data-platform'),
        sidebarCollapsed: frame.hasAttribute('data-sidebar-collapsed'),
        rightbarCollapsed: frame.hasAttribute('data-rightbar-collapsed'),
        leadingSeat: describe(document.querySelector('[data-shell-leading]')),
        headerCorner: describe(document.querySelector('[data-conversation-header-corner]')),
        workbenchChildren: workbench === null
          ? []
          : Array.from(workbench.children).slice(0, 4).map(describe),
        innerColumns: sidebar === null ? {} : {
          sidebarClass: String(sidebar.className || '').slice(0, 120),
          chatClass: chat === null ? '' : String(chat.className || '').slice(0, 120),
          sidebarChildren: Array.from(sidebar.children).slice(0, 3).map(describe),
        },
        hitTests: [[30, 40], [120, 40], [30, 90], [120, 90], [240, 60]].map(([x, y]) => {
          const hit = document.elementFromPoint(x, y)
          const chain = []
          let node = hit
          for (let depth = 0; node !== null && depth < 5; depth += 1) {
            chain.push({
              tag: node.tagName ? node.tagName.toLowerCase() : '',
              cls: String(node.className || '').slice(0, 90),
              slot: node.getAttribute?.('data-slot') || '',
              rect: rectOf(node),
            })
            node = node.parentElement
          }
          return { x, y, chain }
        }),
        errors: errors.slice(-6),
      }
    }

    /** Send the latest report to the diagnostics endpoints. */
    function sendReport(reason) {
      let report
      try {
        report = buildReport()
      } catch (error) {
        if (errors.length < 20) errors.push('report: ' + String((error && error.message) || error))
        return
      }
      report.reason = reason
      const body = JSON.stringify(report)
      for (const url of REPORT_URLS) {
        try {
          void fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            cache: 'no-store',
            keepalive: true,
          }).catch(() => {})
        } catch (error) { /* diagnostics only */ }
      }
    }

    /** The drag handle between the workbench (middle) and the conversation (right). */
    let chatResizerEl = null
    let chatResizeDrag = null

    function ensureChatResizer() {
      if (chatResizerEl !== null) return chatResizerEl
      const element = document.createElement('div')
      element.className = 'cursor-layout-chat-resizer'
      element.setAttribute('data-cursor-chat-resizer', '')
      element.title = '拖动调整右侧对话宽度；双击恢复默认'
      element.style.display = 'none'
      element.addEventListener('pointerdown', (event) => {
        if (layoutView !== VIEW_CURSOR) return
        if (event.button !== undefined && event.button !== 0) return
        chatResizeDrag = { startX: event.clientX, startWidth: chatWidth() }
        element.setPointerCapture?.(event.pointerId)
        document.body.style.userSelect = 'none'
        event.preventDefault()
      })
      element.addEventListener('pointermove', (event) => {
        if (chatResizeDrag === null) return
        const next = chatResizeDrag.startWidth + (chatResizeDrag.startX - event.clientX)
        applyChatWidth(next)
        event.preventDefault()
      })
      const endDrag = (event) => {
        if (chatResizeDrag === null) return
        chatResizeDrag = null
        document.body.style.userSelect = ''
        try { element.releasePointerCapture?.(event.pointerId) } catch (error) { /* ignore */ }
        sendReport('chat-resize')
      }
      element.addEventListener('pointerup', endDrag)
      element.addEventListener('pointercancel', endDrag)
      element.addEventListener('dblclick', () => {
        try { localStorage.removeItem(CHAT_WIDTH_KEY) } catch (error) { /* ignore */ }
        sync()
        sendReport('chat-resize-reset')
      })
      document.body.appendChild(element)
      chatResizerEl = element
      return element
    }

    /** Persist one dragged width and re-project (live, without a full sync). */
    function applyChatWidth(raw) {
      const frame = findFrame()
      if (frame === null) return
      const width = Math.min(chatWidthMax(), Math.max(CHAT_MIN_PX, Math.round(raw)))
      try { localStorage.setItem(CHAT_WIDTH_KEY, String(width)) } catch (error) { /* ignore */ }
      frame.style.setProperty('--cursor-layout-chat', `${width}px`)
      positionChatResizer()
    }

    /** Place/show the drag handle at the live conversation boundary. */
    function positionChatResizer() {
      if (chatResizerEl === null) return
      const frame = findFrame()
      const shown = frame !== null
        && layoutView === VIEW_CURSOR
        && frame.getAttribute(MODE_ATTR) !== null
        && !frame.hasAttribute(CHAT_COLLAPSED_ATTR)
        && !frame.hasAttribute('data-rightbar-collapsed')
        && !frame.hasAttribute('data-rightbar-fullscreen')
      const workbench = frame === null ? null : frame.querySelector('[data-rightbar-col]')
      const chat = workbench === null ? null : workbench.previousElementSibling
      if (!shown || chat === null) {
        chatResizerEl.style.display = 'none'
        return
      }
      const chatBox = chat.getBoundingClientRect()
      const frameBox = frame.getBoundingClientRect()
      if (chatBox.width <= 0 || frameBox.width <= 0) {
        chatResizerEl.style.display = 'none'
        return
      }
      chatResizerEl.style.display = 'block'
      chatResizerEl.style.left = `${Math.round(chatBox.left - 4)}px`
      chatResizerEl.style.top = `${Math.round(frameBox.top)}px`
      chatResizerEl.style.height = `${Math.round(frameBox.height)}px`
    }

    /**
     * The right sidebar is closed: click its official expand control once, then
     * re-project when the panel has a track again.
     *
     * Why: the IDE view has nowhere to draw while `data-rightbar-collapsed` is on
     * the frame, so the projection below hands the frame back to the shipped
     * geometry. Doing that silently made the header pill look dead whenever the
     * user had the editor pane closed (reported 2026-11-07). Opening the panel is
     * what the same seat's own button does; the frame observer sees the attribute
     * drop and re-runs sync(), so no polling loop is needed.
     *
     * @returns whether an expand request was issued this time.
     */
    let rightbarOpenAskedAt = 0
    function openRightbarOnce() {
      const now = Date.now()
      if (now - rightbarOpenAskedAt < 1200) return false
      rightbarOpenAskedAt = now
      let expand = null
      for (const element of document.querySelectorAll('[data-sidebar-right-expand]')) {
        const style = getComputedStyle(element)
        if (style.display !== 'none' && style.visibility !== 'hidden') { expand = element; break }
      }
      if (expand === null || typeof expand.click !== 'function') return false
      try { expand.click() } catch (error) { return false }
      // The shipped panel opens with an animation; nudge the projection twice in
      // case the attribute transition settles without a further mutation.
      for (const delay of [120, 420]) window.setTimeout(() => { try { sync() } catch (error) { /* ignore */ } }, delay)
      return true
    }

    /**
     * Project the frame's grid into the Cursor arrangement.
     * Idempotent; safe to call on any layout change.
     */
    function sync() {
      const frame = findFrame()
      if (frame === null) return
      ensureChatResizer()
      const workbench = frame.querySelector('[data-rightbar-col]')
      if (workbench === null) return

      // Fullscreen workbench owns the whole frame; leave the shipped geometry alone.
      if (frame.hasAttribute('data-rightbar-fullscreen')) {
        frame.removeAttribute(MODE_ATTR)
        frame.removeAttribute(CLOSED_ATTR)
        frame.removeAttribute(CHAT_COLLAPSED_ATTR)
        frame.removeAttribute(MEDIA_PEEK_ATTR)
        positionChatResizer()
        return
      }

      const chatColumn = workbench.previousElementSibling
      const sidebarColumn = chatColumn === null ? null : chatColumn.previousElementSibling

      if (layoutView === VIEW_AGENT) {
        // Agent view: the shipped conversation column stays the middle track and
        // the workbench column is hidden by CSS (its tabs stay mounted, so the
        // Cursor view can bring them straight back).
        frame.setAttribute(MODE_ATTR, VIEW_AGENT)
        frame.removeAttribute(CLOSED_ATTR)
        frame.removeAttribute(CHAT_COLLAPSED_ATTR)
        // The peek is a projection of the shipped right panel, so it must die
        // with it: closing the last docked tab (e.g. the 「文件编辑」 tab the peek
        // itself opened) collapses that panel, and a peek left on a collapsed
        // panel is an empty black column with no control left to close it.
        // `peekSawPanelOpen` keeps the instant right after opening — the panel
        // is still collapsed until ensureEditorPanel() commits — from
        // cancelling the peek it just opened.
        if (mediaPeekActive) {
          if (frame.hasAttribute('data-rightbar-collapsed')) {
            if (viewToggleDebug.peekSawPanelOpen) setMediaPeek(false, 'panel-collapsed')
          } else {
            viewToggleDebug.peekSawPanelOpen = true
          }
        }
        if (mediaPeekActive) {
          frame.setAttribute(MEDIA_PEEK_ATTR, '')
          const peek = `${peekWidth()}px`
          if (frame.style.getPropertyValue('--cursor-layout-peek') !== peek) frame.style.setProperty('--cursor-layout-peek', peek)
        } else {
          frame.removeAttribute(MEDIA_PEEK_ATTR)
        }
        const sidebar = sidebarWidthOf(frame)
        if (frame.style.getPropertyValue('--cursor-layout-sidebar') !== `${sidebar}px`) {
          frame.style.setProperty('--cursor-layout-sidebar', `${sidebar}px`)
        }
        if (sidebarColumn !== null) sidebarColumn.setAttribute(COL_ATTR, 'sidebar')
        if (chatColumn !== null) chatColumn.setAttribute(COL_ATTR, 'chat')
        workbench.setAttribute(COL_ATTR, 'workbench')
        positionChatResizer()
        return
      }

      frame.setAttribute(MODE_ATTR, VIEW_CURSOR)
      frame.removeAttribute(MEDIA_PEEK_ATTR)
      if (chatCollapsed) frame.setAttribute(CHAT_COLLAPSED_ATTR, '')
      else frame.removeAttribute(CHAT_COLLAPSED_ATTR)

      const sidebar = sidebarWidthOf(frame)
      if (frame.style.getPropertyValue('--cursor-layout-sidebar') !== `${sidebar}px`) {
        frame.style.setProperty('--cursor-layout-sidebar', `${sidebar}px`)
      }
      const chat = chatWidth()
      if (frame.style.getPropertyValue('--cursor-layout-chat') !== `${chat}px`) {
        frame.style.setProperty('--cursor-layout-chat', `${chat}px`)
      }

      // No workbench pane: hand the frame back to the shipped geometry. Keeping a
      // zero-width projection here made the right sidebar measure a zero room and
      // permanently drop its own panel (it never came back after a plugin reload).
      // Ask the official expand control first so "IDE 视图" reopens the pane
      // instead of silently doing nothing (2026-11-07 report).
      if (frame.hasAttribute('data-rightbar-collapsed')) {
        openRightbarOnce()
        frame.removeAttribute(MODE_ATTR)
        frame.removeAttribute(CLOSED_ATTR)
        frame.removeAttribute(MEDIA_PEEK_ATTR)
        positionChatResizer()
        return
      }

      if (sidebarColumn !== null) sidebarColumn.setAttribute(COL_ATTR, 'sidebar')
      if (chatColumn !== null) chatColumn.setAttribute(COL_ATTR, 'chat')
      workbench.setAttribute(COL_ATTR, 'workbench')
      positionChatResizer()
    }

    /** Undo every frame attribute/style this module wrote. */
    function restore() {
      const frame = findFrame()
      if (frame !== null) {
        frame.removeAttribute(MODE_ATTR)
        frame.removeAttribute(CLOSED_ATTR)
        frame.removeAttribute(COL_ATTR)
        frame.removeAttribute(CHAT_COLLAPSED_ATTR)
        frame.removeAttribute(MEDIA_PEEK_ATTR)
        frame.style.removeProperty('--cursor-layout-sidebar')
        frame.style.removeProperty('--cursor-layout-chat')
        frame.style.removeProperty('--cursor-layout-peek')
        for (const column of frame.querySelectorAll(`[${COL_ATTR}]`)) column.removeAttribute(COL_ATTR)
      }
      if (chatResizerEl !== null) chatResizerEl.style.display = 'none'
      const style = document.getElementById(STYLE_ID)
      if (style !== null) style.remove()
    }

    const CURSOR_SKIN_CSS = `
/* ============================================================
   Cursor Skin — 全站令牌重映射（深色）
   数值来源：Cursor Dark 主题（cursor-dark-color-theme.json）
   ============================================================ */
body[data-ds-dark-theme] {
  /* --- 灰阶：DSH neutral-bluish 阶梯 → Cursor 中性灰 --- */
  --dsw-static-neutral-bluish-1000: #0a0a0a;
  --dsw-static-neutral-bluish-950: #141414;
  --dsw-static-neutral-bluish-900: #181818;
  --dsw-static-neutral-bluish-875: #1f1f1f;
  --dsw-static-neutral-bluish-850: #262626;
  --dsw-static-neutral-bluish-800: #2e2e2e;
  --dsw-static-neutral-bluish-750: #3d3d3d;
  --dsw-static-neutral-bluish-700: #565656;
  --dsw-static-neutral-bluish-600: #707070;
  --dsw-static-neutral-bluish-500: #8a8a8a;
  --dsw-static-neutral-bluish-400: #f0f0f099;
  --dsw-static-neutral-bluish-300: #f0f0f0bd;
  --dsw-static-neutral-bluish-250: #dedede;
  --dsw-static-neutral-bluish-200: #e4e4e4;
  --dsw-static-neutral-bluish-150: #eaeaea;
  --dsw-static-neutral-bluish-100: #efefef;
  --dsw-static-neutral-bluish-50: #f0f0f0;
  --dsw-static-neutral-bluish-00: #fafafa;
  --dsw-static-neutral-900: #141414;
  --dsw-static-neutral-850: #1f1f1f;
  --dsw-static-neutral-800: #2e2e2e;
  --dsw-static-neutral-700: #3d3d3d;
  --dsw-static-neutral-600: #565656;
  --dsw-static-neutral-550: #6e6e6e;
  --dsw-static-neutral-500: #8a8a8a;
  --dsw-static-neutral-400: #a6a6a6;

  /* --- 品牌蓝 → Cursor 的青蓝 #88c0d0 / 钢蓝 #81a1c1 --- */
  --dsw-static-deepseek-50: #eaf1f5;
  --dsw-static-deepseek-100: #d7e4ec;
  --dsw-static-deepseek-200: #c4d7e3;
  --dsw-static-deepseek-300: #a9cfdc;
  --dsw-static-deepseek-400: #88c0d0;
  --dsw-static-deepseek-450: #81a1c1;
  --dsw-static-deepseek-500: #6e92b0;
  --dsw-static-deepseek-600: #5c86a6;
  --dsw-static-deepseek-800: #33424e;
  --dsw-static-deepseek-900: #24303a;
  --dsw-static-blue-400: #88c0d0;
  --dsw-static-blue-450: #81a1c1;
  --dsw-static-blue-500: #81a1c1;
  --dsw-static-blue-600: #6e92b0;

  /* --- 状态色：Cursor 的 diff / git 配色 --- */
  --dsw-static-green-500: #3fa266;
  --dsw-static-green-400: #70b489;
  --dsw-static-green-500-a08: rgb(63 162 102 / 8%);
  --dsw-static-green-500-a12: rgb(63 162 102 / 12%);
  --dsw-static-green-900: #1e2b22;
  --dsw-static-amber-500: #f1b467;
  --dsw-static-amber-400: #f1b467;
  --dsw-static-amber-600: #d2943e;
  --dsw-static-amber-900: #33291a;
  --dsw-static-red-400: #e34671;
  --dsw-static-red-500: #fc6b83;
  --dsw-static-violet-400: #88c0d0;

  /* --- 表面 --- */
  --dsw-alias-bg-base: #141414;
  --dsw-alias-bg-layer-1: #181818;
  --dsw-alias-bg-layer-2: #1f1f1f;
  --dsw-alias-bg-layer-3: #262626;
  --dsw-alias-bg-module-platform: #181818;
  --dsw-alias-bg-overlay: #1f1f1f;
  --dsw-alias-bg-document-selection: #40404099;
  --dsw-alias-bg-mask-1: rgb(0 0 0 / 55%);

  /* --- 描边 / 交互 --- */
  --dsw-alias-border-l1: #f0f0f013;
  --dsw-alias-border-l2: #f0f0f024;
  --dsw-alias-border-l2-darkmode-thin: #f0f0f013;
  --dsw-alias-border-l3: #f0f0f02e;
  --dsw-alias-border-l4: #f0f0f038;
  --dsw-alias-border-selected: #88c0d0;
  --dsw-alias-interactive-bg-hover: #f0f0f011;
  --dsw-alias-interactive-bg-active: #f0f0f01e;
  --dsw-alias-interactive-bg-hover-solid: #2e2e2e;
  --dsw-alias-interactive-bg-hover-accent: #f0f0f02e;

  /* --- 文字 --- */
  --dsw-alias-label-primary: #f0f0f0;
  --dsw-alias-label-secondary: #f0f0f0bd;
  --dsw-alias-label-tertiary: #f0f0f099;
  --dsw-alias-label-caption: #f0f0f05c;
  --dsw-alias-label-dimmed: #f0f0f05c;
  --dsw-alias-label-primary-inverted: #191c22;
  --dsw-alias-label-primary-bluish: #f0f0f0;

  /* --- 品牌 / 按钮 --- */
  --dsw-alias-brand-primary: #81a1c1;
  --dsw-alias-brand-primary-invert: #191c22;
  --dsw-alias-brand-text: #f0f0f0;
  --dsw-alias-button-primary-fill: #81a1c1;
  --dsw-alias-button-primary-hover: #87a6c4;
  --dsw-alias-button-primary-dimmed: #3d3d3d;
  --dsw-alias-button-info-fill: #81a1c1;
  --dsw-alias-button-info-hover: #87a6c4;
  --dsw-alias-button-contrast-fill: #f0f0f0;
  --dsw-alias-button-elevated-fill: #262626;
  --dsw-alias-button-floating-fill: #1f1f1f;
  --dsw-alias-button-floating-hover: #262626;
  --dsw-alias-button-ghost-active-fill: #2e2e2e;
  --dsw-alias-button-ghost-active-hover: #3d3d3d;
  --dsw-alias-button-ghost-active-border: #f0f0f013;
  --dsw-alias-link: #88c0d0;

  /* --- 代码块 / 卡片 / 浮层 --- */
  --dsw-alias-markdown-code-block: #181818;
  --dsw-alias-markdown-code-block-banner: #262626;
  --dsw-alias-markdown-inline-code: #2e2e2e;
  --dsw-alias-markdown-code-segment-selected: #2e2e2e;
  --dsw-alias-markdown-code-segment-unselected: #181818;
  --dsw-alias-markdown-citation: #2e2e2e;
  --dsw-alias-hovercard-bg: #1f1f1f;
  --dsw-alias-hovercard-label-primary: #f0f0f0;
  --dsw-alias-hovercard-label-secondary: #f0f0f0bd;
  --dsw-alias-hovercard-label-tertiary: #f0f0f099;
  --dsw-alias-hovercard-state-done: #88c0d0;
  --dsw-alias-hovercard-state-error: #e34671;
  --dsw-alias-card-fill: #1f1f1f;
  --dsw-alias-card-fill-hover: #262626;
  --dsw-alias-card-tile-fill: #f0f0f00d;
  --dsw-alias-tooltip-bg: #262626;
  --dsw-alias-bg-skeleton: #1f1f1f;

  /* --- 状态 --- */
  --dsw-alias-state-done-primary: #88c0d0;
  --dsw-alias-state-error-primary: #e34671;
  --dsw-alias-state-error-secondary: #fc6b83;
  --dsw-alias-state-success-primary: #3fa266;
  --dsw-alias-state-success-secondary: #70b489;
  --dsw-alias-state-success-tertiary: #1e2b22;
  --dsw-alias-state-warn-primary: #f1b467;
  --dsw-alias-state-warn-secondary: #f1b467;
  --dsw-alias-state-warn-tertiary: #33291a;
  --dsw-alias-state-idle-primary: #707070;

  /* --- diff --- */
  --dsw-alias-file-diff-added-bg: rgb(63 162 102 / 20%);
  --dsw-alias-file-diff-added-gutter: rgb(63 162 102 / 28%);
  --dsw-alias-file-diff-added-marker: #3fa266;
  --dsw-alias-file-diff-deleted-bg: rgb(184 0 73 / 20%);
  --dsw-alias-file-diff-deleted-gutter: rgb(184 0 73 / 28%);
  --dsw-alias-file-diff-deleted-marker: #e34671;
  --dsw-alias-code-diff-added: rgb(63 162 102 / 12%);
  --dsw-alias-code-diff-deleted: rgb(184 0 73 / 12%);

  /* --- 侧栏 / 菜单（macOS）--- */
  --dsw-specific-sidebar-fill: #141414;
  --dsw-specific-sidebar-nav-item-active: #262626;
  --dsw-specific-sidebar-nav-item-active-accent: #2e2e2e;
  --dsw-specific-sidebar-tint: #141414;
  --dsw-specific-sidebar-wash-top: transparent;
  --dsw-specific-sidebar-wash-bottom: transparent;
  --dsw-specific-menu: rgba(20, 20, 20, 0.94);
  --dsw-specific-selector: #2e2e2e;
  --dsw-specific-tip: #262626;

  /* --- 对话里的代码高亮（Shiki）--- */
  --shiki-foreground: #f0f0f0;
  --shiki-background: #181818;
  --shiki-token-plain: #f0f0f0;
  --shiki-token-constant: #ebc88d;
  --shiki-token-string: #e394dc;
  --shiki-token-string-expression: #e394dc;
  --shiki-token-comment: #f0f0f099;
  --shiki-token-keyword: #82d2ce;
  --shiki-token-parameter: #87c3ff;
  --shiki-token-function: #efb080;
  --shiki-token-punctuation: #f0f0f0bd;
  --shiki-token-link: #87c3ff;
}

/* macOS 侧栏原本是毛玻璃：Cursor 的侧栏是实心 #141414，这里把 darwin
   专属的 tint / wash / glass 层（选择器权重更高）全部压掉。 */
html[data-platform='darwin'] body[data-ds-dark-theme] {
  --dsw-specific-menu: rgba(20, 20, 20, 0.94);
  --dsw-specific-sidebar-tint: #141414;
  --dsw-specific-sidebar-wash-top: transparent;
  --dsw-specific-sidebar-wash-top-clear: transparent;
  --dsw-specific-sidebar-wash-bottom: transparent;
  --dsw-specific-sidebar-wash-bottom-clear: transparent;
  --dsw-specific-sidebar-glass-fill: #f0f0f00d;
  --dsw-specific-sidebar-glass-hover: #f0f0f01e;
  --dsw-specific-sidebar-glass-collapsed-fill: #f0f0f00d;
  --dsw-specific-sidebar-glass-collapsed-hover: #f0f0f01e;
}

/* 对话里的代码块：Cursor 的 6px 圆角 + 细描边 + 13px 等宽 */
body[data-ds-dark-theme] .md-code-block {
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  overflow: hidden;
}
body[data-ds-dark-theme] .md-code-block [data-code-block-banner] {
  background: var(--dsw-alias-markdown-code-block-banner);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
body[data-ds-dark-theme] .md-code-block pre {
  font-size: 13px;
  line-height: 1.65;
}
body[data-ds-dark-theme] code:not(pre code) {
  border-radius: 4px;
  padding: 1px 5px;
}

/* ============================================================
   侧栏文件树 → VS Code / Cursor Explorer 的行感
   （better-sidebar 的资源管理器 + dsh-vscode-mode 的文件树）
   ============================================================ */
body[data-ds-dark-theme] [class*='explorerRow'] {
  height: 22px;
  border-radius: 0;
  font-size: 13px;
  gap: 4px;
}
body[data-ds-dark-theme] [class*='explorerRow']:hover {
  background: #f0f0f011;
}
body[data-ds-dark-theme] [class*='explorerRowSelected'] {
  background: #f0f0f01e;
  color: #f0f0f0;
}
/* Cursor 的选中行没有左侧竖条 */
body[data-ds-dark-theme] [class*='explorerRowSelected']::before {
  display: none;
}
body[data-ds-dark-theme] [class*='explorerRowRevealed'] {
  background: #f0f0f014;
}
/* 文件夹名在 VS Code 里不是粗体 */
body[data-ds-dark-theme] [class*='explorerDir'] {
  font-weight: 400;
  color: #f0f0f0bd;
}

/* dsh-vscode-mode 自带文件树 */
body[data-ds-dark-theme] [data-edrv-view] .edrv-tree {
  font-size: 13px;
  padding: 0 0 12px;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-tree-row {
  height: 22px;
  border-radius: 0;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-tree-virtual .edrv-tree-row {
  height: 22px;
  min-height: 22px;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-tree-row.edrv-tree-active {
  background: #f0f0f01e;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-tree-svn {
  background: transparent;
  border-radius: 0;
  font-size: 11px;
  font-weight: 400;
}

/* 活动栏 / 侧栏标题：VS Code 的 48px 图标列 + 22px 大写小标题 */
body[data-ds-dark-theme] [data-edrv-view] .edrv-sidebar {
  background: #141414;
  border-right: none;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-rail {
  width: 48px;
  padding: 0;
  gap: 0;
  background: #141414;
  border-right: none;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-rail-btn {
  width: 48px;
  height: 48px;
  border-radius: 0;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-rail-btn:hover {
  background: #f0f0f011;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-rail-btn.edrv-rail-on {
  background: transparent;
  color: #f0f0f0;
  box-shadow: inset 2px 0 0 #f0f0f0;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-rail-badge {
  top: auto;
  bottom: 7px;
  right: 9px;
  background: #81a1c1;
  color: #191c22;
  font-weight: 500;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-side-head {
  height: 22px;
  padding: 0 8px;
  border-bottom: none;
}
body[data-ds-dark-theme] [data-edrv-view] .edrv-side-title {
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #f0f0f0bd;
}
`

    function apply(ctx) {
      let disposed = false
      rootCtx = ctx

      ctx.effect(() => {
        if (document.getElementById(STYLE_ID) === null) {
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.dataset.plugin = 'dsh-cursor-layout'
          style.textContent = CSS + CURSOR_SKIN_CSS
          document.head.appendChild(style)
        }

        // Each Session keeps its own IDE / Agent view: follow the conversation on
        // screen and re-project when it changes.
        bindSessionView(ctx)
        // Chat file links open in the workbench; in the Agent view that pane is
        // hidden, so a click there switches back to the IDE view first.
        const disposeFileLinkReveal = installFileLinkReveal()
        // Native「已编辑 N 个文件」card: same treatment. Its click opens a review
        // resource tab in the right sidebar, which is the hidden workbench in the
        // Agent view; switch to the IDE view before the native handler runs.
        const disposeChangedFilesReveal = installChangedFilesReveal()
        // Native delivered-file cards (present results / turn tail): their click
        // opens an official sidebar resource tab. Route it into the IDE view's
        // editor tab instead, so code, images and videos all land in 「文件编辑」.
        const disposePresentedFileReveal = installPresentedFileReveal()
        // 空编辑区 → Agent 视图：订阅 dsh-vscode-mode 的页签数广播（见 --region 空编辑区）
        const disposeEditorPresence = bindEditorPresence()
        // 查询桥（dsh-vscode-mode 的浏览器半）可能比本插件晚就绪：首屏补两次判定，
        // 避免空编辑区在会话首屏多停一会儿空的 IDE 视图。
        const emptyEditorRetries = [400, 1000].map((delay) => window.setTimeout(() => {
          if (disposed) return
          try { syncEmptyEditorView(undefined, undefined, true) } catch (error) { /* 广播 / 下一拍会再判 */ }
        }, delay))

        // 媒体（视频/图片）由 dsh-vscode-mode 在编辑区打开（它带视频/图片预览面板）。
        // Agent 视图里编辑区是隐藏的：不切视图，而是把工作台列以「媒体预览」形态
        // 放到右边（chat 留在中间）。Cursor 视图下保持原行为（工作台本来就在中间）。
        const onMediaOpen = (event) => {
          if (layoutView !== VIEW_AGENT) return
          const detail = event && event.detail ? event.detail : null
          const path = detail && typeof detail.path === 'string' ? detail.path : ''
          if (path !== '' && !isMediaPathLike(path)) return
          viewToggleDebug.mediaReveals += 1
          setMediaPeek(true)
        }
        window.addEventListener('edrv:media-open', onMediaOpen)

        // 媒体预览的应急关闭键：Esc（编辑区/输入框内不抢键，避免干扰补全/弹层）。
        const onPeekEscape = (event) => {
          if (!mediaPeekActive || event.key !== 'Escape') return
          const target = event.target
          if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"], .monaco-editor') !== null) return
          event.preventDefault()
          setMediaPeek(false)
        }
        window.addEventListener('keydown', onPeekEscape, true)

        // 官方页签条上的 × 关掉「文件编辑」时，预览列跟着撤（见 installPeekTabCloseWatcher）。
        const disposePeekTabCloseWatcher = installPeekTabCloseWatcher()

        // A read-only face for other plugins / diagnostics: proves the Client
        // half is live even though it registers no slot, and exposes the
        // projection for a forced re-run.
        const disposeService = typeof ctx.reflect?.provide === 'function'
          ? ctx.reflect.provide('cursorLayout', {
            version: '0.5.16-peek-watchdog',
            sync,
            report: () => sendReport('manual'),
            get frame() { return findFrame() },
            get view() { return layoutView },
            get sessionId() { return currentSessionId },
            setView: (view, sessionId) => setLayoutView(view, sessionId),
            views: () => ({
              fallback: fallbackView,
              bySession: { ...sessionViews },
              sessionId: currentSessionId === undefined ? '' : currentSessionId,
            }),
          })
          : () => {}

        // 对外桥：其它插件（dsh-edit-diff 的改动卡片）要让「点一下文件」落到 IDE 视图的
        // 编辑区，但 ctx.reflect 只做只读检查、不能跨插件调用，所以留一个 window 全局。
        // reveal({ path, line, focusDiff, sessionId }) → 布尔；false 表示本机没有可用编辑区，
        // 调用方自己退回官方 openFile。
        const bridge = {
          version: '0.5.17-edit-diff-bridge',
          reveal: (request) => {
            if (disposed) return false
            const detail = request !== null && typeof request === 'object' ? request : {}
            const path = typeof detail.path === 'string' ? detail.path : ''
            if (path === '') return false
            if (!vscodeModeLoaded()) return false
            const line = typeof detail.line === 'number' && Number.isFinite(detail.line) && detail.line > 0
              ? Math.floor(detail.line)
              : null
            // dsh-vscode-mode 里「聚焦差异」和「跳到某一行」互斥：有行号就精确跳行，
            // 没有行号才交给差异流程自己去第一处改动。
            const focusDiff = detail.focusDiff === true && line === null
            const target = typeof detail.sessionId === 'string' && detail.sessionId.length > 0
              ? detail.sessionId
              : currentSessionId
            const onScreen = target === undefined || target === currentSessionId
            if (onScreen && layoutView !== VIEW_CURSOR) {
              try { setLayoutView(VIEW_CURSOR, target) } catch (error) { /* 下一拍 sync 补投影 */ }
              try { sync() } catch (error) { /* the frame observers re-project */ }
            }
            ensureEditorPanel()
            const endLine = typeof detail.endLine === 'number' && Number.isFinite(detail.endLine) ? Math.floor(detail.endLine) : undefined
            // 两段式：先走「差异聚焦」——编辑器若记着这次改动，会落到改动处并画行内红绿；
            // 再看有没有行号，晚一点补一次精确跳行 + 区间高亮（编辑器没记着改动时的兜底）。
            openInEditor(path, true, null, undefined, [0, 400])
            if (line !== null) {
              window.setTimeout(() => {
                if (disposed) return
                try { openInEditor(path, false, line, endLine) } catch (error) { /* 跳行失败不影响打开 */ }
              }, 2400)
              window.setTimeout(() => {
                if (disposed) return
                try { openInEditor(path, false, line, endLine) } catch (error) { /* 再补一拍 */ }
              }, 5200)
            }
            scheduleExplorerReveal()
            return true
          },
        }
        window.__dshCursorLayout = bridge

        const onAiStatus = (event) => {
          aiDebug.events += 1
          aiDebug.last = event && event.detail ? event.detail : null
          aiDebug.lastAt = Date.now()
          aiDebug.registered = window.__edrvAiInlineDisposer__ !== undefined
        }
        window.addEventListener('edrv:ai-status', onAiStatus)
        aiDebug.registered = window.__edrvAiInlineDisposer__ !== undefined
        let aiConfigAttempts = 0
        const probeAiConfig = () => {
          aiConfigAttempts += 1
          rpcCall('edrv.ai.configGet', {}).then((config) => {
            aiDebug.config = config
            aiDebug.configAt = Date.now()
            ownInlineEnabled = Boolean(config && config.ok === true && config.enabled === true)
          }).catch((error) => {
            aiDebug.configError = String((error && error.message) || error)
            if (aiConfigAttempts < 5) window.setTimeout(probeAiConfig, 2000)
          })
        }
        window.setTimeout(probeAiConfig, 1500)

        // Own ghost-text provider (retires the shipped one) + one-shot self test.
        // Registration only needs the Monaco module, not an open editor.
        let disposeOwnInline = null
        let inlineBootTries = 0
        const bootOwnInline = () => {
          if (disposed) return
          inlineBootTries += 1
          if (window.monaco !== undefined) {
            disposeOwnInline = setupOwnInlineProvider(ctx)
            if (ownInline.ready) return
          }
          if (inlineBootTries < 120) window.setTimeout(bootOwnInline, 500)
        }
        window.setTimeout(bootOwnInline, 500)
        const onAiConfigChanged = (event) => {
          const detail = event && event.detail ? event.detail : null
          if (detail && typeof detail.enabled === 'boolean') ownInlineEnabled = detail.enabled
        }
        window.addEventListener('edrv:ai-config', onAiConfigChanged)
        // Keep exactly one ghost-text provider: retire any shipped provider that
        // registers later than ours (module reload / plugin restart race).
        const shippedProviderWatchdog = window.setInterval(() => {
          try {
            const shipped = window.__edrvAiInlineDisposer__
            if (typeof shipped === 'function') {
              shipped()
              delete window.__edrvAiInlineDisposer__
              ownInline.disposedShipped = true
            }
          } catch (error) { /* ignore */ }
        }, 2500)

        // Cursor-like manual ghost-text trigger: Alt+\ (dsh-vscode-mode's own
        // "trigger AI completion" command ships without an official chord).
        const onKeyDown = (event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.key !== '\\' && event.code !== 'Backslash') return
          const target = event.target
          if (!(target instanceof Element) || target.closest('.monaco-editor') === null) return
          event.preventDefault()
          event.stopPropagation()
          inlineDebug.shimHits += 1
          try { window.dispatchEvent(new CustomEvent('edrv.command.triggerAi')); inlineDebug.triggerSent += 1 } catch (error) { inlineDebug.shimError = String((error && error.message) || error) }
        }
        window.addEventListener('keydown', onKeyDown, true)

        const onError = (event) => {
          if (errors.length < 20) errors.push(String(event.message || event.reason || 'error').slice(0, 300))
        }
        window.addEventListener('error', onError)
        window.addEventListener('unhandledrejection', onError)

        // Cursor-style changed-files bar above the composer.
        let disposeDiffBar = () => {}
        try {
          const Bar = createDiffBar(ctx)
          disposeDiffBar = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'cursor-diffbar',
            order: 16,
          }, Bar))
          diffBarDebug.registered = true
        } catch (error) {
          diffBarDebug.registerError = String((error && error.message) || error)
        }

        // Session-header pill that flips Cursor workbench ⟷ native Agent view.
        // It lives in the conversation header, so it stays reachable in the Agent
        // view even though the workbench (and every control inside it) is hidden.
        let disposeViewToggle = () => {}
        try {
          const Toggle = createViewToggle()
          disposeViewToggle = ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'cursor-layout-view-toggle',
            order: 12,
          }, Toggle))
          viewToggleDebug.registered = true
        } catch (error) {
          viewToggleDebug.registerError = String((error && error.message) || error)
        }

        // Blank new-conversation page: `conversation.input.left` is session-scoped,
        // so it never renders there. The leading seat is root-scoped and documented
        // as "available without a Session", so the switch lives there for the hero.
        let disposeHeroToggle = () => {}
        try {
          const HeroToggle = createViewToggle(true)
          disposeHeroToggle = ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
            name: 'conversation.header.leading',
          }, HeroToggle))
          viewToggleDebug.heroRegistered = true
        } catch (error) {
          viewToggleDebug.heroRegisterError = String((error && error.message) || error)
        }

        // Same flip from the keyboard: Cmd/Ctrl+Alt+M (browser: +Shift).
        // Cmd+A is reserved by the shortcut registry, hence KeyM.
        ctx.inject(['shortcuts'], (shortcutCtx) => {
          shortcutCtx.effect(() => {
            try {
              const disposeShortcut = shortcutCtx.shortcuts.register({
                id: 'cursorLayout.toggleView',
                label: () => '切换 IDE 视图 / Agent 视图',
                aliases: ['agent view', 'cursor layout', 'toggle layout', '布局'],
                defaults: {
                  'desktop:macos': { code: 'KeyM', modifiers: ['primary', 'alt'] },
                  'desktop:windows': { code: 'KeyM', modifiers: ['primary', 'alt'] },
                  'desktop:linux': { code: 'KeyM', modifiers: ['primary', 'alt'] },
                  'web:macos': { code: 'KeyM', modifiers: ['primary', 'alt', 'shift'] },
                  'web:windows': { code: 'KeyM', modifiers: ['primary', 'alt', 'shift'] },
                },
                regions: ['page', 'editable'],
                modals: [],
                resolve: () => ({
                  status: 'handled',
                  run: () => setLayoutView(layoutView === VIEW_AGENT ? VIEW_CURSOR : VIEW_AGENT),
                }),
              })
              viewToggleDebug.shortcutId = 'cursorLayout.toggleView'
              return disposeShortcut
            } catch (error) {
              viewToggleDebug.shortcutError = String((error && error.message) || error)
              return undefined
            }
          }, 'cursor-layout: toggle view shortcut')
        })

        let scheduled = 0
        let lastReportAt = 0
        const scheduleSync = (reason) => {
          if (scheduled !== 0) return
          scheduled = window.requestAnimationFrame(() => {
            scheduled = 0
            try {
              sync()
            } catch (error) {
              if (errors.length < 20) errors.push('sync: ' + String(error && error.message ? error.message : error))
            }
            const now = Date.now()
            if (now - lastReportAt > 1500) {
              lastReportAt = now
              sendReport(reason || 'sync')
            }
          })
        }

        // Frame replacement / remount detection (body only, cheap).
        let trackedFrame = null
        let frameObserver = null
        const trackFrame = () => {
          const frame = findFrame()
          if (frame === trackedFrame) return
          trackedFrame = frame
          if (frameObserver !== null) frameObserver.disconnect()
          frameObserver = null
          if (frame === null) return
          frameObserver = new MutationObserver(() => scheduleSync('frame-attr'))
          frameObserver.observe(frame, {
            attributes: true,
            attributeFilter: ['style', 'data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
          })
          scheduleSync('frame-tracked')
        }

        const bodyObserver = new MutationObserver(() => {
          if (trackedFrame === null || !trackedFrame.isConnected) trackFrame()
        })
        bodyObserver.observe(document.body, { childList: true, subtree: true })

        // The official right-panel collapse button becomes the IDE view's
        // conversation toggle: intercept it in the capture phase so the rightbar
        // panel (the workbench) never collapses behind the layout's back.
        const onPanelCollapseClick = (event) => {
          const node = event.target instanceof Element ? event.target.closest('[data-sidebar-right-toggle]') : null
          if (node === null) return
          if (layoutView === VIEW_AGENT) {
            // In the Agent view the right panel only exists for the media peek;
            // its collapse button closes the peek instead of collapsing the panel.
            if (!mediaPeekActive) return
            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            setMediaPeek(false)
            return
          }
          if (layoutView !== VIEW_CURSOR) return
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
          setChatCollapsed(!chatCollapsed)
        }
        window.addEventListener('click', onPanelCollapseClick, true)

        window.addEventListener('resize', () => scheduleSync('resize'))
        trackFrame()
        scheduleSync('apply')

        // One settled report per page load, so the loopback diagnostics route has a
        // fresh snapshot even when the layout stays idle afterwards.
        window.setTimeout(() => sendReport('ready'), 5000)

        // 诊断探针：每秒把请求统计写进 localStorage（Host 卡死也能落盘），
        // 每 5 秒再 POST 一份到 /cursor-layout/report。定位端口暴涨后删除。
        let probePersistTimer = 0
        let probeReportTimer = 0
        if (probe !== undefined) {
          probePersistTimer = window.setInterval(() => {
            try { probe.persist() } catch (error) { /* diagnostics only */ }
          }, 1000)
          probeReportTimer = window.setInterval(() => {
            try { sendReport('probe') } catch (error) { /* diagnostics only */ }
          }, 5000)
          window.setTimeout(() => {
            try { sendReport('probe-boot') } catch (error) { /* diagnostics only */ }
          }, 1200)
        }

        // 自测已通过：闸门把 800 并发请求压在 200 在途（maxInflight=200）。

        // 临时复现钩子（定位后删除）：自动点开「我现在要做一个这个…」这个会话，
        // 看是否单靠打开就会触发请求风暴。90 秒后尝试切回原会话。
        try {
          if (window.localStorage.getItem('dsh.fetch-probe.repro1') !== '1') {
            window.localStorage.setItem('dsh.fetch-probe.repro1', '1')
            window.setTimeout(() => {
              try {
                const title = '我现在要做一个这个'
                const rows = []
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
                let node
                while ((node = walker.nextNode()) !== null) {
                  const value = node.nodeValue
                  if (value === null || value.indexOf(title) < 0) continue
                  let element = node.parentElement
                  for (let depth = 0; element !== null && depth < 8; depth += 1, element = element.parentElement) {
                    if (element.tagName === 'BUTTON' || element.tagName === 'A' || element.getAttribute('role') === 'button' || window.getComputedStyle(element).cursor === 'pointer') {
                      rows.push(element)
                      break
                    }
                  }
                  if (rows.length > 0) break
                }
                const previousRow = document.querySelector('[data-session-active="true"], [aria-current="true"], [aria-selected="true"]')
                if (probe !== undefined) {
                  probe.repro = {
                    found: rows.length > 0,
                    previousFound: previousRow !== null,
                    tag: rows.length > 0 ? rows[0].tagName : '',
                    cls: rows.length > 0 ? String(rows[0].className).slice(0, 120) : '',
                    attrs: rows.length > 0 ? Array.from(rows[0].attributes).slice(0, 8).map((attribute) => attribute.name + '=' + String(attribute.value).slice(0, 40)) : [],
                  }
                }
                if (rows.length > 0) {
                  rows[0].click()
                  window.setTimeout(() => {
                    try { if (previousRow !== null && previousRow.isConnected) previousRow.click() } catch (error) { /* ignore */ }
                  }, 90000)
                }
              } catch (error) { /* ignore */ }
            }, 2500)
          }
        } catch (error) { /* ignore */ }


        // Editor-pane policy: "code first" means the workbench should be the
        // primary pane. vscode-mode restores its own editor tab when it
        // remembers one, but that restore can lose the race with the session
        // seat, so retry the open for a bounded window. A user who deliberately
        // closed the pane leaves no saved-tab marker and our one-shot flag set,
        // so nothing is reopened on the next load.
        // Self-healing: whenever the workbench pane is closed *and* vscode-mode
        // still remembers an editor tab (i.e. the user did not close it on
        // purpose — that clears vscode-mode's marker), reopen it. This also
        // repairs the pane after a vscode-mode reload/panic closes its tabs,
        // which previously left the Cursor layout collapsed for good.
        let autoOpenBudget = 40
        let lastOpenAttempt = 0
        const ensureTimer = window.setInterval(() => {
          if (disposed) return
          // A client build whose uiSession is unavailable: the right-hand panel
          // still names the Session it draws, so per-session state keeps working.
          if (!sessionBinding.active && currentSessionId === undefined) {
            const panel = document.querySelector('[data-sidebar-right-session]')
            const domSession = panel === null ? '' : String(panel.getAttribute('data-sidebar-right-session') || '')
            if (domSession.length > 0) {
              sessionBinding.source = 'dom'
              applySessionView(domSession, 'session-dom')
            }
          }
          // 兜底：查询桥 / 编辑区广播晚到，或编辑区面板没打开（没有广播）时，
          // 用「工作区 + 会话」存档判定空编辑区，保证切会话后空编辑区仍是 Agent 视图。
          try { syncEmptyEditorView(undefined, undefined) } catch (error) { /* 下一拍 / 广播会再判 */ }
          // In the Agent view the workbench is hidden on purpose; reopening its
          // tab would only fight the view.
          if (layoutView === VIEW_AGENT) return
          const frame = findFrame()
          if (frame === null) return
          if (!frame.hasAttribute('data-rightbar-collapsed')) return
          const remembered = vscodeHasSavedTab()
          if (!remembered && autoOpenBudget <= 0) return
          const now = Date.now()
          if (now - lastOpenAttempt < 3000) return
          lastOpenAttempt = now
          if (!remembered) autoOpenBudget -= 1
          if (!vscodeModeLoaded()) return
          const service = ctx.get('sidebarRight')
          if (service === undefined || typeof service.openTab !== 'function') return
          try {
            service.openTab(EDITOR_KIND, {})
            try { localStorage.setItem(OPEN_FLAG, '1') } catch (error) { /* ignore */ }
            sendReport('editor-open')
          } catch (error) {
            /* seat not bound yet: retry on the next tick */
          }
        }, 1500)
        window.setTimeout(() => {
          if (errors.length === 0 && findFrame() === null) errors.push('no shell frame found')
        }, 4000)

        return () => {
          disposed = true
          window.clearInterval(ensureTimer)
          if (probePersistTimer !== 0) window.clearInterval(probePersistTimer)
          if (probeReportTimer !== 0) window.clearInterval(probeReportTimer)
          window.removeEventListener('error', onError)
          window.removeEventListener('edrv:ai-status', onAiStatus)
          window.removeEventListener('click', onPanelCollapseClick, true)
          disposeFileLinkReveal()
          disposeChangedFilesReveal()
          disposePresentedFileReveal()
          window.removeEventListener('edrv:media-open', onMediaOpen)
          window.removeEventListener('keydown', onPeekEscape, true)
          disposePeekTabCloseWatcher()
          stopPeekWatchdog()
          if (chatResizerEl !== null) {
            try { chatResizerEl.remove() } catch (error) { /* ignore */ }
            chatResizerEl = null
          }
          window.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('edrv:ai-config', onAiConfigChanged)
          window.clearInterval(shippedProviderWatchdog)
          window.removeEventListener('unhandledrejection', onError)
          if (disposeOwnInline !== null) disposeOwnInline()
          disposeEditorPresence()
          for (const timer of emptyEditorRetries) window.clearTimeout(timer)
          bodyObserver.disconnect()
          if (frameObserver !== null) frameObserver.disconnect()
          if (scheduled !== 0) window.cancelAnimationFrame(scheduled)
          restore()
          disposeDiffBar()
          disposeHeroToggle()
          disposeViewToggle()
          disposeService()
          if (window.__dshCursorLayout === bridge) delete window.__dshCursorLayout
        }
      }, 'cursor-layout: shell projection')
    }

    return {
      inject: ['slots'],
      apply,
    }
  },
})
