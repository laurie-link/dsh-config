/**
 * dsh-session-search — Client half.
 *
 * A Cursor-style conversation search palette for the DSH sidebar:
 *
 *   · a new sidebar nav row under 「自动化任务」 opens a centered overlay;
 *   · the overlay lists 最近对话 on open and searches every conversation by
 *     title, session id, workspace label AND message content (literals
 *     substring, so Chinese queries match) while you type;
 *   · ↓/↑ + Enter or a click jumps straight to the conversation;
 *   · the shipped 工作区 search icon is hidden, and the shipped Mod+K request
 *     for it is redirected into this palette (whatever triggered it, since the
 *     desktop key bridge dispatches the old command before the page).
 *
 * Content hits come from this bundle's Host half through the same-origin
 * routes `/dsh-session-search/search` and `/dsh-session-search/status`.
 *
 * Plain-JS client plugin, no build: only the loader-provided modules (react)
 * may be required. Every visible string goes through the Client locale service
 * under the `sessionSearch` namespace (zh + en).
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useSyncExternalStore } = React

    const NS = 'sessionSearch'
    const ROUTE_SEARCH = '/dsh-session-search/search'
    const ROUTE_STATUS = '/dsh-session-search/status'
    const ENTRY_ID = 'session-search'
    const PALETTE_ID = 'session-search-palette'
    const ENTRY_ATTR = 'data-dsh-session-search-entry'
    const SHIPPED_SEARCH_EXPANDED = '_searchSlotExpanded'
    const SEARCH_DEBOUNCE_MS = 160
    const STATUS_POLL_MS = 700
    const RECENT_LIMIT = 30
    const RESULT_LIMIT = 40

    // ---------------------------------------------------------------------
    // locale dictionaries
    // ---------------------------------------------------------------------

    const zh = {
      'panel.title': '会话搜索',
      'panel.aria': '打开会话搜索',
      'dialog.aria': '会话搜索',
      'placeholder': '搜索会话标题或对话内容…',
      'recent.title': '最近对话',
      'recent.empty': '还没有可跳转的对话。',
      'search.results': '搜索结果',
      'search.searching': '正在搜索…',
      'search.empty': '没有匹配的对话。',
      'search.error': '内容搜索暂时不可用，仅显示标题匹配。',
      'search.titleMatchOnly': '标题匹配',
      'match.content': '内容匹配',
      'index.idle': '正在准备内容索引…',
      'index.building': '首次搜索正在建立内容索引（{done}/{total}）…',
      'index.ready': '已索引 {total} 个会话',
      'index.unavailable': '内容索引不可用，仅能按标题搜索。',
      'index.error': '内容索引建立失败：{message}',
      'hint.move': '选择',
      'hint.open': '打开',
      'hint.close': '关闭',
      'untitled': '未命名对话',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'time.months': '{n} 个月前',
      'time.years': '{n} 年前',
      'page.subtitle': '按标题和对话内容搜索全部会话；不输入关键词时列出最近对话。',
      'count.results': '{n} 个结果',
    }

    const en = {
      'panel.title': 'Session search',
      'panel.aria': 'Open session search',
      'dialog.aria': 'Session search',
      'placeholder': 'Search session titles or message content…',
      'recent.title': 'Recent conversations',
      'recent.empty': 'No conversation to jump to yet.',
      'search.results': 'Search results',
      'search.searching': 'Searching…',
      'search.empty': 'No matching conversation.',
      'search.error': 'Content search is unavailable; showing title matches only.',
      'search.titleMatchOnly': 'Title match',
      'match.content': 'Content match',
      'index.idle': 'Preparing the content index…',
      'index.building': 'Building the content index for the first search ({done}/{total})…',
      'index.ready': 'Indexed {total} sessions',
      'index.unavailable': 'Content index unavailable; title search only.',
      'index.error': 'Content index failed: {message}',
      'hint.move': 'move',
      'hint.open': 'open',
      'hint.close': 'close',
      'untitled': 'Untitled conversation',
      'time.now': 'now',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
      'time.days': '{n}d ago',
      'time.months': '{n}mo ago',
      'time.years': '{n}y ago',
      'page.subtitle': 'Search every conversation by title and message content; recent conversations appear when the box is empty.',
      'count.results': '{n} results',
    }

    // ---------------------------------------------------------------------
    // styles
    // ---------------------------------------------------------------------

    const CSS = `
.dsss-root { position: fixed; inset: 0; z-index: 2400; pointer-events: auto; display: flex; align-items: flex-start; justify-content: center; font-family: var(--dsw-font-family, inherit); }
.dsss-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, .42); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); animation: dsss-fade .12s ease-out; }
.dsss-dialog { position: relative; margin-top: 11vh; width: min(720px, calc(100vw - 40px)); max-height: 74vh; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-2, #1c1d22); border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, .12)); border-radius: var(--dsw-radius-xl, 16px); box-shadow: var(--dsw-shadow-lv3, 0 24px 64px rgba(0, 0, 0, .5)); overflow: hidden; animation: dsss-pop .14s ease-out; }
.dsss-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, .08)); }
.dsss-glyph { color: var(--dsw-alias-label-secondary, #9aa0ad); flex: none; display: flex; }
.dsss-input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: var(--dsw-alias-label-primary, #e8eaf0); font-size: 15px; line-height: 22px; font-family: inherit; }
.dsss-input::placeholder { color: var(--dsw-alias-label-tertiary, #7c8290); }
.dsss-esc { flex: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #7c8290); border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, .1)); border-radius: 6px; padding: 1px 6px; }
.dsss-body { overflow-y: auto; padding: 8px; min-height: 88px; overscroll-behavior: contain; }
.dsss-section { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #7c8290); padding: 8px 10px 6px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dsss-sectionHint { color: var(--dsw-alias-label-caption, #6b7280); font-size: 11px; }
.dsss-row { display: flex; width: 100%; gap: 10px; align-items: flex-start; text-align: left; padding: 8px 10px; border-radius: 10px; border: none; background: transparent; color: inherit; cursor: pointer; font-family: inherit; }
.dsss-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12)); }
.dsss-rowActive, .dsss-rowActive:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .18)); }
.dsss-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; background: var(--dsw-alias-state-idle-primary, #6b7280); }
.dsss-dot-running { background: var(--dsw-alias-brand-primary, #4c8dff); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4c8dff) 22%, transparent); }
.dsss-dot-warn { background: var(--dsw-alias-state-warn-primary, #e0a63a); }
.dsss-dot-done { background: var(--dsw-alias-state-success-primary, #37b26c); }
.dsss-rowBody { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dsss-rowLine { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.dsss-rowTitle { flex: 1; min-width: 0; font-size: 13.5px; line-height: 19px; color: var(--dsw-alias-label-primary, #e8eaf0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsss-rowTime { flex: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #7c8290); }
.dsss-rowMeta { font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #7c8290); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsss-rowSnippet { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary, #a8afbd); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.dsss-mark { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4c8dff) 26%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; }
.dsss-empty { padding: 26px 16px; text-align: center; color: var(--dsw-alias-label-tertiary, #7c8290); font-size: 13px; line-height: 20px; }
.dsss-note { padding: 10px 12px 4px; color: var(--dsw-alias-state-warn-primary, #e0a63a); font-size: 12px; line-height: 18px; }
.dsss-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 14px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, .08)); color: var(--dsw-alias-label-tertiary, #7c8290); font-size: 11.5px; line-height: 16px; }
.dsss-hints { display: flex; align-items: center; gap: 10px; }
.dsss-kbdGroup { display: inline-flex; align-items: center; gap: 4px; }
.dsss-kbd { border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, .1)); border-radius: 5px; padding: 0 4px; font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-secondary, #a8afbd); }
.dsss-panelIcon { display: block; }
.dsss-panelIconWrap { display: inline-flex; align-items: center; justify-content: center; }
.dsss-page { height: 100%; overflow: auto; display: flex; justify-content: center; padding: clamp(24px, 5vh, 56px) 20px 40px; box-sizing: border-box; }
.dsss-pageInner { width: min(760px, 100%); display: flex; flex-direction: column; min-height: 0; }
.dsss-pageTitle { font-size: 20px; line-height: 28px; font-weight: 600; color: var(--dsw-alias-label-primary, #e8eaf0); margin: 0 0 6px; }
.dsss-pageSub { font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-tertiary, #7c8290); margin: 0 0 18px; }
.dsss-pageBox { border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, .08)); border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-layer-1, #17181c); overflow: hidden; display: flex; flex-direction: column; min-height: 0; flex: 1; }
.dsss-pageBody { overflow-y: auto; padding: 8px; min-height: 160px; }
@keyframes dsss-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsss-pop { from { opacity: 0; transform: translateY(-6px) scale(.994); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .dsss-backdrop, .dsss-dialog { animation: none; } }
/* The shipped workspace search icon is replaced by the new sidebar entry. */
[class*="_searchSlot"] { display: none !important; }
/* If the shipped Mod+K still expands the hidden search, keep the 工作区 header stable. */
[class*="_sectionLabelHidden"] { opacity: 1 !important; visibility: visible !important; max-width: 45% !important; margin-right: 0 !important; transform: none !important; }
`

    // ---------------------------------------------------------------------
    // small utilities
    // ---------------------------------------------------------------------

    /** Append this plugin's stylesheet once; the disposer removes it. */
    function injectStyles() {
      const tagId = 'dsh-session-search/styles'
      const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-session-search'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /** Resolve a same-origin route against the app base, robust to sub-paths. */
    function appUrlOf(path) {
      try {
        return new URL(String(path).replace(/^\/+/, ''), new URL('.', document.baseURI)).href
      } catch {
        return String(path)
      }
    }

    /** Tiny external store for the palette's open state. */
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set: (next) => {
          state = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              /* listener failures must not break the store */
            }
          }
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /** Directory base name for sessions without a Workspace title. */
    function workspaceLabelOf(cwd) {
      const raw = String(cwd || '').replace(/\\/g, '/')
      const base = raw.split('/').filter(Boolean).pop() || ''
      return base === '' ? raw : base
    }

    /** Split caller text into lowercase highlight/search terms. */
    function splitTerms(query) {
      const seen = new Set()
      const terms = []
      for (const piece of String(query || '').toLowerCase().split(/\s+/)) {
        const term = piece.trim()
        if (term === '' || seen.has(term)) continue
        seen.add(term)
        terms.push(term)
        if (terms.length >= 6) break
      }
      return terms
    }

    /** DSH-style compact relative time through the locale service. */
    function relativeTime(at, t) {
      const value = Number(at) || 0
      if (value <= 0) return ''
      const diff = Math.max(0, Date.now() - value)
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return t('time.now')
      if (minutes < 60) return t('time.minutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hours', { n: hours })
      const days = Math.floor(hours / 24)
      if (days < 30) return t('time.days', { n: days })
      const months = Math.floor(days / 30)
      if (months < 12) return t('time.months', { n: months })
      return t('time.years', { n: Math.floor(months / 12) })
    }

    /** Status dot tone for one session row. */
    function toneOf(item) {
      const status = item.status
      if (status !== undefined && status !== null) {
        if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) return 'warn'
        if (status.running === true) return 'running'
        if (status.completionUnread === true) return 'done'
      }
      if (item.running === true) return 'running'
      return 'idle'
    }

    /** Render text with every query term wrapped in a <mark>. */
    function highlightText(text, terms) {
      const value = String(text || '')
      if (value === '' || terms.length === 0) return value
      const lower = value.toLowerCase()
      const ranges = []
      for (const term of terms) {
        if (term === '') continue
        let from = 0
        while (ranges.length < 48) {
          const at = lower.indexOf(term, from)
          if (at < 0) break
          ranges.push([at, at + term.length])
          from = at + term.length
        }
      }
      if (ranges.length === 0) return value
      ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      const merged = []
      for (const range of ranges) {
        const last = merged[merged.length - 1]
        if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
        else merged.push([range[0], range[1]])
      }
      const out = []
      let cursor = 0
      for (let index = 0; index < merged.length; index += 1) {
        const [start, end] = merged[index]
        if (start > cursor) out.push(value.slice(cursor, start))
        out.push(h('mark', { key: 'mark-' + index, className: 'dsss-mark' }, value.slice(start, end)))
        cursor = end
      }
      if (cursor < value.length) out.push(value.slice(cursor))
      return out
    }

    // ---------------------------------------------------------------------
    // host routes
    // ---------------------------------------------------------------------

    /** One search request; resolves to the Host payload. */
    async function fetchSearch(query, signal) {
      const response = await fetch(appUrlOf(ROUTE_SEARCH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit: RESULT_LIMIT }),
        cache: 'no-store',
        signal,
      })
      const data = await response.json().catch(() => ({}))
      return { ok: response.ok, data }
    }

    /** One status probe; also kicks the lazy index build on the Host. */
    async function fetchStatus(signal) {
      const response = await fetch(appUrlOf(ROUTE_STATUS), { cache: 'no-store', signal })
      return await response.json().catch(() => ({}))
    }

    // ---------------------------------------------------------------------
    // hooks
    // ---------------------------------------------------------------------

    /** The client-side catalog: every jumpable conversation, newest first. */
    function useCatalog(props, t) {
      const list = props.useSessions((snapshot) => snapshot)
      const workspaces = props.useWorkspaces((snapshot) => snapshot)
      const statuses = props.useSessionStatus((snapshot) => snapshot)
      return useMemo(() => {
        if (list === undefined || list === null || list.byId === undefined || list.byId === null) return []
        const archived = new Set((workspaces !== undefined && workspaces !== null && workspaces.archivedSessionIds) || [])
        const workspaceOf = new Map()
        const workspaceItems = (workspaces !== undefined && workspaces !== null && workspaces.items) || []
        for (const workspace of workspaceItems) {
          for (const sessionId of workspace.sessionIds || []) {
            if (!workspaceOf.has(sessionId)) workspaceOf.set(sessionId, String(workspace.title || ''))
          }
        }
        const items = []
        for (const id of list.ids || []) {
          const summary = list.byId[id]
          if (summary === undefined || summary === null) continue
          if (summary.blank === true) continue
          if (summary.origin === 'subagent') continue
          if (archived.has(id)) continue
          const title = String(summary.title || '').trim()
          items.push({
            id,
            title: title === '' ? t('untitled') : title,
            rawTitle: title,
            workspace: workspaceOf.get(id) || workspaceLabelOf(summary.cwd) || '',
            updatedAt: Number(summary.updatedAt) || 0,
            running: summary.running === true,
            status: statuses === undefined || statuses === null ? undefined : statuses.get(id),
            cwd: summary.cwd,
            match: 'recent',
            snippet: '',
          })
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt)
        return items
      }, [list, workspaces, statuses, t])
    }

    /** Debounced content search against the Host index. */
    function useContentSearch(query, enabled) {
      const normalized = String(query || '').trim()
      const idle = { query: '', status: 'idle', items: [], tookMs: 0, phase: '', total: 0, error: null }
      const [snapshot, setSnapshot] = useState(idle)
      useEffect(() => {
        if (!enabled || normalized === '') {
          setSnapshot(idle)
          return undefined
        }
        const controller = new AbortController()
        setSnapshot((previous) => ({
          query: normalized,
          status: 'loading',
          items: previous.query === normalized ? previous.items : [],
          tookMs: 0,
          phase: previous.phase,
          total: previous.total,
          error: null,
        }))
        const timer = window.setTimeout(() => {
          fetchSearch(normalized, controller.signal).then(
            ({ ok, data }) => {
              if (controller.signal.aborted) return
              setSnapshot({
                query: normalized,
                status: ok ? 'ready' : 'error',
                items: Array.isArray(data.items) ? data.items : [],
                tookMs: Number(data.tookMs) || 0,
                phase: typeof data.phase === 'string' ? data.phase : '',
                total: Number(data.total) || 0,
                error: typeof data.error === 'string' ? data.error : null,
              })
            },
            (error) => {
              if (controller.signal.aborted) return
              setSnapshot({
                query: normalized,
                status: 'error',
                items: [],
                tookMs: 0,
                phase: '',
                total: 0,
                error: String(error && error.message ? error.message : error),
              })
            },
          )
        }, SEARCH_DEBOUNCE_MS)
        return () => {
          controller.abort()
          window.clearTimeout(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `idle` is a constant literal
      }, [normalized, enabled])
      return snapshot
    }

    /** Poll the Host index status while the palette is visible. */
    function useIndexStatus(active) {
      const [status, setStatus] = useState(null)
      useEffect(() => {
        if (!active) return undefined
        let alive = true
        let timer = 0
        const tick = () => {
          fetchStatus().then(
            (data) => {
              if (!alive) return
              setStatus({
                phase: typeof data.phase === 'string' ? data.phase : 'idle',
                indexed: Number(data.indexed) || 0,
                total: Number(data.total) || 0,
                error: typeof data.error === 'string' ? data.error : null,
              })
              timer = window.setTimeout(tick, STATUS_POLL_MS)
            },
            () => {
              if (!alive) return
              setStatus((previous) => previous || { phase: 'error', indexed: 0, total: 0, error: null })
              timer = window.setTimeout(tick, STATUS_POLL_MS * 2)
            },
          )
        }
        tick()
        return () => {
          alive = false
          window.clearTimeout(timer)
        }
      }, [active])
      return status
    }

    /** Merge local title/workspace matches with Host content hits. */
    function composeResults(catalog, query, content) {
      const normalized = String(query || '').trim()
      if (normalized === '') return catalog.slice(0, RECENT_LIMIT)
      const needle = normalized.toLowerCase()
      const titleHits = []
      for (const item of catalog) {
        if (
          item.rawTitle.toLowerCase().includes(needle) ||
          item.id.toLowerCase().includes(needle) ||
          item.workspace.toLowerCase().includes(needle)
        ) {
          titleHits.push({ ...item, match: 'title' })
        }
      }
      const byId = new Map(catalog.map((item) => [item.id, item]))
      const seen = new Set(titleHits.map((item) => item.id))
      const contentHits = []
      for (const hit of content.items || []) {
        const sessionId = String((hit && hit.sessionId) || '')
        if (sessionId === '' || seen.has(sessionId)) continue
        const item = byId.get(sessionId)
        if (item === undefined) continue
        seen.add(sessionId)
        contentHits.push({
          ...item,
          match: 'content',
          snippet: String((hit && hit.snippet) || ''),
        })
      }
      return titleHits.concat(contentHits).slice(0, RESULT_LIMIT)
    }

    // ---------------------------------------------------------------------
    // shared pieces
    // ---------------------------------------------------------------------

    /** Magnifier glyph used by the sidebar row and the palette header. */
    function SearchGlyph({ size = 16, className = 'dsss-glyph' }) {
      return h(
        'svg',
        {
          className,
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 10.5, cy: 10.5, r: 6.2 }),
        h('path', { d: 'M15.2 15.2 20 20' }),
      )
    }

    /** One result row shared by the palette and the fallback main panel. */
    function ResultRow({ item, active, index, terms, t, onPick, onHover }) {
      const tone = toneOf(item)
      const metaParts = []
      if (item.workspace !== '') metaParts.push(item.workspace)
      if (item.match === 'content') metaParts.push(t('match.content'))
      return h(
        'button',
        {
          type: 'button',
          className: 'dsss-row' + (active ? ' dsss-rowActive' : ''),
          'data-dsss-active': active ? 'true' : undefined,
          title: item.title,
          onClick: () => onPick(item),
          onPointerMove: () => {
            if (!active) onHover(index)
          },
        },
        h('span', { className: 'dsss-dot dsss-dot-' + tone }),
        h(
          'span',
          { className: 'dsss-rowBody' },
          h(
            'span',
            { className: 'dsss-rowLine' },
            h('span', { className: 'dsss-rowTitle' }, highlightText(item.title, terms)),
            h('span', { className: 'dsss-rowTime' }, relativeTime(item.updatedAt, t)),
          ),
          metaParts.length > 0 ? h('span', { className: 'dsss-rowMeta' }, metaParts.join(' · ')) : null,
          item.snippet !== '' && item.snippet !== undefined ? h('span', { className: 'dsss-rowSnippet' }, highlightText(item.snippet, terms)) : null,
        ),
      )
    }

    /** Keyboard-navigation helper shared by both surfaces. */
    function useResultNavigation(results, onPick) {
      const [active, setActive] = useState(0)
      const listRef = useRef(null)
      useEffect(() => {
        setActive((current) => (results.length === 0 ? 0 : Math.min(current, results.length - 1)))
      }, [results])
      useEffect(() => {
        const container = listRef.current
        if (container === null) return
        const node = container.querySelector('[data-dsss-active="true"]')
        if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
      }, [active, results])
      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive((current) => (results.length === 0 ? 0 : Math.min(current + 1, results.length - 1)))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((current) => Math.max(0, current - 1))
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const item = results[active]
          if (item !== undefined) onPick(item)
        }
      }
      return { active, setActive, listRef, onKeyDown }
    }

    /** Index progress line for the footer. */
    function indexHint(status, t) {
      if (status === null) return ''
      if (status.phase === 'unavailable') return t('index.unavailable')
      if (status.phase === 'error') return t('index.error', { message: String(status.error || '') })
      if (status.phase === 'idle') return t('index.idle')
      if (status.phase === 'building') return t('index.building', { done: status.indexed, total: Math.max(status.total, status.indexed) })
      return t('index.ready', { total: status.total })
    }

    /** One result section (label + rows + empty/loading notes). */
    function ResultsSection({ label, hint, items, terms, t, navigation, onPick, emptyText, noteText }) {
      const { active, listRef, onHover } = navigation
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dsss-section' },
          h('span', null, label),
          hint !== '' && hint !== undefined && hint !== null ? h('span', { className: 'dsss-sectionHint' }, hint) : null,
        ),
        h(
          'div',
          { ref: listRef },
          items.map((item, index) =>
            h(ResultRow, {
              key: item.id + ':' + item.match,
              item,
              index,
              active: index === active,
              terms,
              t,
              onPick,
              onHover: (next) => navigation.setActive(next),
            }),
          ),
        ),
        items.length === 0 && emptyText !== undefined ? h('div', { className: 'dsss-empty' }, emptyText) : null,
        noteText !== undefined && noteText !== null ? h('div', { className: 'dsss-note' }, noteText) : null,
      )
    }

    // ---------------------------------------------------------------------
    // palette overlay (shell.overlay)
    // ---------------------------------------------------------------------

    function PaletteDialog(props) {
      const t = props.t || props.tr || ((key) => key)
      const palette = props.palette || {}
      const close = palette.close || (() => {})
      const openSession = props.openSession || (() => {})
      const catalog = useCatalog(props, t)
      const [query, setQuery] = useState('')
      const terms = useMemo(() => splitTerms(query), [query])
      const normalized = query.trim()
      const searching = normalized !== ''
      const content = useContentSearch(query, true)
      const indexStatus = useIndexStatus(true)
      const results = useMemo(() => composeResults(catalog, query, content), [catalog, query, content])
      const inputRef = useRef(null)

      const pick = (item) => {
        close()
        openSession(item.id)
      }
      const navigation = useResultNavigation(results, pick)

      useEffect(() => {
        const frame = window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
        return () => window.cancelAnimationFrame(frame)
      }, [])

      useEffect(() => {
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.body.style.overflow = previous
        }
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [close])

      const pending = searching && (content.status === 'loading' || content.query !== normalized)
      const errorNote = searching && content.status === 'error' ? t('search.error') : null
      const sectionLabel = searching ? t('search.results') : t('recent.title')
      const sectionHint = searching ? (pending ? t('search.searching') : String(results.length)) : String(results.length)
      const emptyText = searching ? t('search.empty') : t('recent.empty')
      const statusHint = indexHint(indexStatus, t)

      return h(
        'div',
        { className: 'dsss-root', 'data-dsh-session-search-palette': 'true' },
        h('div', { className: 'dsss-backdrop', onClick: close }),
        h(
          'div',
          {
            className: 'dsss-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('dialog.aria'),
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'dsss-head' },
            h(SearchGlyph, { size: 17 }),
            h('input', {
              ref: inputRef,
              className: 'dsss-input',
              type: 'text',
              value: query,
              placeholder: t('placeholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => {
                setQuery(event.target.value)
                navigation.setActive(0)
              },
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  close()
                  return
                }
                navigation.onKeyDown(event)
              },
            }),
            h('span', { className: 'dsss-esc' }, 'Esc'),
          ),
          h(
            'div',
            { className: 'dsss-body' },
            h(ResultsSection, {
              label: sectionLabel,
              hint: sectionHint,
              items: results,
              terms,
              t,
              navigation,
              onPick: pick,
              emptyText: pending ? undefined : emptyText,
              noteText: errorNote,
            }),
            pending ? h('div', { className: 'dsss-empty' }, t('search.searching')) : null,
          ),
          h(
            'div',
            { className: 'dsss-foot' },
            h(
              'span',
              { className: 'dsss-hints' },
              h('span', { className: 'dsss-kbdGroup' }, h('span', { className: 'dsss-kbd' }, '↑'), h('span', { className: 'dsss-kbd' }, '↓'), h('span', null, t('hint.move'))),
              h('span', { className: 'dsss-kbdGroup' }, h('span', { className: 'dsss-kbd' }, 'Enter'), h('span', null, t('hint.open'))),
              h('span', { className: 'dsss-kbdGroup' }, h('span', { className: 'dsss-kbd' }, 'Esc'), h('span', null, t('hint.close'))),
            ),
            h('span', { className: 'dsss-badge' }, statusHint),
          ),
        ),
      )
    }

    function PaletteOverlay(props) {
      const palette = props.palette || {}
      const store = palette.store
      const state = useSyncExternalStore(store.subscribe, store.get)
      if (!state.open) return null
      // Remount per open: query, selection and focus start clean.
      return h(PaletteDialog, { key: 'palette-' + String(state.nonce), ...props })
    }

    // ---------------------------------------------------------------------
    // fallback main panel (reachable from the 更多 menu) + sidebar entry
    // ---------------------------------------------------------------------

    function SearchPage(props) {
      const t = props.t || props.tr || ((key) => key)
      const entry = props.entry || {}
      const openSession = entry.openSession || (() => {})
      const catalog = useCatalog(props, t)
      const [query, setQuery] = useState('')
      const terms = useMemo(() => splitTerms(query), [query])
      const normalized = query.trim()
      const content = useContentSearch(query, true)
      const indexStatus = useIndexStatus(true)
      const results = useMemo(() => composeResults(catalog, query, content), [catalog, query, content])
      const pick = (item) => openSession(item.id)
      const navigation = useResultNavigation(results, pick)
      const pending = normalized !== '' && (content.status === 'loading' || content.query !== normalized)
      return h(
        'div',
        { className: 'dsss-page' },
        h(
          'div',
          { className: 'dsss-pageInner' },
          h('h1', { className: 'dsss-pageTitle' }, t('panel.title')),
          h('p', { className: 'dsss-pageSub' }, t('page.subtitle')),
          h(
            'div',
            { className: 'dsss-pageBox' },
            h(
              'div',
              { className: 'dsss-head' },
              h(SearchGlyph, { size: 17 }),
              h('input', {
                className: 'dsss-input',
                type: 'text',
                value: query,
                placeholder: t('placeholder'),
                spellCheck: false,
                autoComplete: 'off',
                autoFocus: true,
                onChange: (event) => {
                  setQuery(event.target.value)
                  navigation.setActive(0)
                },
                onKeyDown: navigation.onKeyDown,
              }),
            ),
            h(
              'div',
              { className: 'dsss-pageBody' },
              h(ResultsSection, {
                label: normalized === '' ? t('recent.title') : t('search.results'),
                hint: pending ? t('search.searching') : String(results.length),
                items: results,
                terms,
                t,
                navigation,
                onPick: pick,
                emptyText: pending ? undefined : normalized === '' ? t('recent.empty') : t('search.empty'),
                noteText: normalized !== '' && content.status === 'error' ? t('search.error') : null,
              }),
              pending ? h('div', { className: 'dsss-empty' }, t('search.searching')) : null,
            ),
            h('div', { className: 'dsss-foot' }, h('span', null, indexHint(indexStatus, t)), h('span', null, t('count.results', { n: results.length }))),
          ),
        ),
      )
    }

    /** Sidebar row glyph; also marks the sidebar-owned row button for the click gate. */
    function PanelIcon(props) {
      const size = Number(props.size) || 16
      const wrapperRef = useRef(null)
      useEffect(() => {
        const node = wrapperRef.current
        const button = node !== null && node.closest ? node.closest('button') : null
        if (button === null) return undefined
        button.setAttribute(ENTRY_ATTR, '')
        return () => {
          button.removeAttribute(ENTRY_ATTR)
        }
      }, [])
      return h('span', { ref: wrapperRef, className: 'dsss-panelIconWrap' }, h(SearchGlyph, { size }))
    }

    // ---------------------------------------------------------------------
    // apply
    // ---------------------------------------------------------------------

    function apply(ctx) {
      const RETRY_MS = 250
      const MAX_ATTEMPTS = 60
      let disposed = false
      let installed = false
      let attempts = 0
      let retryTimer = 0
      const disposers = []

      /** Read one Client service without assuming it exists at apply time. */
      const serviceOf = (name) => {
        try {
          return typeof ctx.get === 'function' ? ctx.get(name) : undefined
        } catch {
          return undefined
        }
      }

      const openSession = (sessionId) => {
        const uiWorkspace = serviceOf('uiWorkspace')
        if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.openSession !== 'function') return
        try {
          uiWorkspace.openSession(sessionId)
        } catch (error) {
          console.warn('[session-search] openSession failed:', error)
        }
      }

      const install = () => {
        if (disposed || installed) return
        retryTimer = 0
        const slots = serviceOf('slots') ?? ctx.slots
        const locale = serviceOf('locale')
        const ready =
          slots !== undefined &&
          slots !== null &&
          typeof slots.register === 'function' &&
          typeof slots.inject === 'function' &&
          locale !== undefined &&
          locale !== null &&
          typeof locale.bind === 'function' &&
          document.body !== null
        if (!ready) {
          attempts += 1
          if (attempts < MAX_ATTEMPTS) {
            retryTimer = window.setTimeout(install, RETRY_MS)
          } else {
            console.warn('[session-search] Client services unavailable; plugin disabled')
          }
          return
        }
        installed = true
        const t = locale.bind(NS)
        const store = createStore({ open: false, nonce: 0 })
        const open = () => {
          const previous = store.get()
          store.set({ open: true, nonce: previous.nonce + 1 })
        }
        const close = () => {
          const previous = store.get()
          store.set({ open: false, nonce: previous.nonce })
        }

        disposers.push(ctx.effect(() => locale.register(NS, { zh, en }), 'session-search: dictionaries'))
        disposers.push(ctx.effect(() => injectStyles(), 'session-search: styles'))

        // 1. The centered palette.
        disposers.push(
          ctx.effect(
            () =>
              slots.inject('shell.overlay', () =>
                slots.register(
                  {
                    name: 'shell.overlay',
                    id: PALETTE_ID,
                    order: 60,
                    locale: NS,
                    inject: () => ({ palette: { store, open, close }, openSession, tr: t }),
                  },
                  PaletteOverlay,
                ),
              ),
            'session-search: palette',
          ),
        )

        // 2. The sidebar row, directly under the 自动化任务 (schedules) row: the
        //    shipped panels use order 0 (plugins) and 10 (schedules), so 15 sits
        //    in between those and the 更多 launcher that closes the list.
        disposers.push(
          ctx.effect(
            () =>
              slots.inject('sidebar.panellist', () =>
                slots.register(
                  {
                    name: 'sidebar.panellist',
                    id: ENTRY_ID,
                    order: 15,
                    label: () => t('panel.title'),
                    locale: NS,
                    inject: () => ({ entry: { open, close, openSession }, tr: t }),
                  },
                  PanelIcon,
                ),
              ),
            'session-search: sidebar entry',
          ),
        )

        // 3. Fallback main panel: some navigation paths call
        //    layout.selectPanel(ENTRY_ID), which requires a registered main key.
        disposers.push(
          ctx.effect(
            () =>
              slots.inject('main', () =>
                slots.register(
                  {
                    name: 'main',
                    key: ENTRY_ID,
                    locale: NS,
                    inject: () => ({ entry: { open, close, openSession }, tr: t }),
                  },
                  SearchPage,
                ),
              ),
            'session-search: main panel',
          ),
        )

        // 4. The sidebar row's click is owned by the sidebar (it would call
        //    layout.selectPanel). Because this row opens an overlay instead of a
        //    main panel, gate the click in the capture phase before React sees it.
        disposers.push(
          ctx.effect(() => {
            const onClickCapture = (event) => {
              const target = event.target instanceof Element ? event.target : null
              if (target === null) return
              const button = target.closest('button[' + ENTRY_ATTR + ']')
              if (button === null) return
              event.preventDefault()
              event.stopPropagation()
              open()
            }
            document.addEventListener('click', onClickCapture, true)
            return () => document.removeEventListener('click', onClickCapture, true)
          }, 'session-search: sidebar click gate'),
        )

        // 5. Redirect the shipped Mod+K search request into this palette. The
        //    desktop key bridge runs the old `session.search` command before the
        //    page, so watching the shipped search expand is the trigger that
        //    works for both native and DOM input; the expansion is then collapsed
        //    so the hidden shipped search never keeps state or focus.
        disposers.push(
          ctx.effect(() => {
            const collapseShippedSearch = (slot) => {
              const input = slot.querySelector('input')
              if (input === null) return
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
            }
            const observer = new MutationObserver((records) => {
              for (const record of records) {
                const node = record.target
                if (!(node instanceof HTMLElement)) continue
                if (String(node.className || '').includes(SHIPPED_SEARCH_EXPANDED) !== true) continue
                collapseShippedSearch(node)
                open()
                return
              }
            })
            observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] })
            return () => observer.disconnect()
          }, 'session-search: shipped shortcut redirect'),
        )
      }

      install()

      ctx.effect(() => () => {
        disposed = true
        if (retryTimer !== 0) window.clearTimeout(retryTimer)
        retryTimer = 0
        installed = false
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* disposal is best effort */
          }
        }
        disposers.length = 0
      }, 'session-search: teardown')
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
