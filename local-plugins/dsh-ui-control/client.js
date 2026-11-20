/**
 * dsh-ui-control — the Client half.
 *
 * A headless module: it registers no visible UI. It keeps a poll loop to the
 * Host so the agent's tools can reach this window, and it knows which
 * conversation this window shows (a zero-size occupant of the composer row
 * reports it; the sidebar's own session attribute is the fallback). Commands are
 * applied against the live Client services — `cursorLayout` for the projection,
 * `layout` for the right column, `sidebarRight` and `betterSidebar` for the
 * tabs — and the answer is what the tool reports back.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ui-control',
  factory(require) {
    const React = require('react')

    const SESSION_SLOT = 'conversation.input.left'
    const SESSION_ATTR = 'data-sidebar-right-session'
    const VIEW_ATTR = '[data-cursor-mode]'
    const COLLAPSED_ATTR = 'data-rightbar-collapsed'
    const POLL_MS = 700
    const CLIENT_KEY = 'dsh-ui-control/client'

    /** A directory base: no query, no hash, one trailing slash. */
    function directoryBase(raw) {
      const url = new URL(raw === '' || raw === undefined ? 'http://dsh.internal/' : String(raw), 'http://dsh.internal/')
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return url.href
    }

    /** Absolute URL for one of this plugin's routes, keeping any proxy prefix. */
    function routeUrl(path, params) {
      const base = typeof document === 'undefined' || typeof document.baseURI !== 'string' ? 'http://dsh.internal/' : document.baseURI
      const url = new URL(path, directoryBase(base))
      if (params !== undefined) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      return url.toString()
    }

    /** Stable id for this window, so two windows never steal each other's commands. */
    function clientId() {
      try {
        const existing = window.sessionStorage.getItem(CLIENT_KEY)
        if (typeof existing === 'string' && existing !== '') return existing
        const created = `w-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
        window.sessionStorage.setItem(CLIENT_KEY, created)
        return created
      } catch {
        return `w-${Math.random().toString(36).slice(2)}`
      }
    }

    /** Wait for the browser to paint the frame we just changed. */
    function nextFrame() {
      return new Promise((resolve) => {
        try {
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
        } catch {
          setTimeout(resolve, 32)
        }
      })
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        const id = clientId()
        /** The conversation this window shows; '' until a surface reports it. */
        let currentSession = ''
        let stopped = false
        let polling = false

        const service = (name) => {
          try {
            return typeof ctx.get === 'function' ? ctx.get(name) : undefined
          } catch {
            return undefined
          }
        }

        const domSession = () => {
          try {
            const node = document.querySelector(`[${SESSION_ATTR}]`)
            if (node === null) return ''
            const raw = node.getAttribute(SESSION_ATTR)
            return typeof raw === 'string' ? raw.trim() : ''
          } catch {
            return ''
          }
        }

        const shownSession = () => (currentSession !== '' ? currentSession : domSession())

        const frame = () => {
          try {
            return document.querySelector(VIEW_ATTR)
          } catch {
            return null
          }
        }

        const setSession = (next) => {
          if (typeof next !== 'string' || next === '') return
          currentSession = next
        }

        /** Zero-size composer occupant: the reliable source of the on-screen conversation. */
        function SessionProbe(props) {
          const sessionId = props !== undefined && props !== null && typeof props.sessionId === 'string' ? props.sessionId : ''
          React.useEffect(() => {
            if (sessionId !== '') setSession(sessionId)
          }, [sessionId])
          return null
        }

        /** Switch the projection, preferring the face cursor-layout exposes. */
        const applyView = (view) => {
          const target = view === 'agent' ? 'agent' : 'cursor'
          const cursorLayout = service('cursorLayout')
          if (cursorLayout !== undefined && typeof cursorLayout.setView === 'function') {
            try {
              cursorLayout.setView(target)
              return true
            } catch {
              /* fall through to the DOM projection */
            }
          }
          const node = frame()
          if (node === null) return false
          try {
            node.setAttribute('data-cursor-mode', target)
            window.dispatchEvent(new CustomEvent('cursor-layout:view', { detail: { view: target } }))
            return true
          } catch {
            return false
          }
        }

        const viewOf = () => {
          const cursorLayout = service('cursorLayout')
          if (cursorLayout !== undefined && typeof cursorLayout.view === 'string') return cursorLayout.view
          const node = frame()
          if (node === null) return 'cursor'
          return node.getAttribute('data-cursor-mode') === 'agent' ? 'agent' : 'cursor'
        }

        const collapsed = () => {
          const node = frame()
          return node !== null && typeof node.hasAttribute === 'function' && node.hasAttribute(COLLAPSED_ATTR)
        }

        const openSidebar = () => {
          const layout = service('layout')
          if (layout === undefined || typeof layout.openRightbar !== 'function') return false
          try {
            layout.openRightbar(true, false)
            return true
          } catch {
            return false
          }
        }

        const closeSidebar = () => {
          const layout = service('layout')
          if (layout === undefined || typeof layout.closeRightbar !== 'function') return false
          try {
            layout.closeRightbar()
            return true
          } catch {
            return false
          }
        }

        /** Bring the calling conversation on screen so the open lands where it was meant to. */
        const focusSession = (sessionId) => {
          if (sessionId === '' || sessionId === shownSession()) return false
          const uiWorkspace = service('uiWorkspace')
          if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') return false
          try {
            uiWorkspace.openSession(sessionId)
            currentSession = sessionId
            return true
          } catch {
            return false
          }
        }

        /** Open one page or file in the right column. */
        const openTarget = async (params, sessionId) => {
          const wanted = params.view === 'agent' ? 'agent' : params.view === 'current' ? viewOf() : 'cursor'
          const isUrl = typeof params.url === 'string' && params.url !== ''
          // A page only lives in the workbench column, which the Agent view hides.
          applyView(isUrl && wanted === 'agent' ? 'cursor' : wanted)
          await nextFrame()
          // Open the column unconditionally: `openRightbar` is an open operation, not a toggle.
          openSidebar()
          await nextFrame()
          if (isUrl) {
            const sidebarRight = service('sidebarRight')
            if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') {
              return { ok: false, detail: 'this window has no right-sidebar browser tab to open into' }
            }
            try {
              sidebarRight.openTab('browser', { params: { url: params.url } })
              return { ok: true, detail: `opened ${params.url} in the sidebar browser` }
            } catch (error) {
              return { ok: false, detail: `the sidebar browser refused it (${String(error && error.message ? error.message : error)})` }
            }
          }
          const betterSidebar = service('betterSidebar')
          if (betterSidebar !== undefined && typeof betterSidebar.openFile === 'function') {
            try {
              betterSidebar.openFile({ sessionId }, params.path, params.title === '' ? undefined : params.title)
              return { ok: true, detail: `opened ${params.path} in the sidebar editor` }
            } catch (error) {
              return { ok: false, detail: `the sidebar editor refused it (${String(error && error.message ? error.message : error)})` }
            }
          }
          return { ok: false, detail: 'this window has no sidebar editor to open a file in' }
        }

        /** Run one Host command. */
        /** Compact dump of the interfaces this window exposes. */
        const describe = () => {
          const keysOf = (value) => {
            if (value === undefined || value === null) return 'missing'
            try {
              if (typeof value.keys === 'function') return [...value.keys()].slice(0, 20).join(',')
              if (Array.isArray(value)) return value.slice(0, 20).map((x) => (typeof x === 'object' && x !== null ? (x.kind ?? x.id ?? x.type ?? '?') : String(x))).join(',')
              return Object.keys(value).slice(0, 20).join(',')
            } catch {
              return 'throw'
            }
          }
          const safe = (fn) => {
            try {
              const value = fn()
              return value === undefined || value === null ? String(value) : JSON.stringify(value).slice(0, 300)
            } catch (error) {
              return `throw:${String(error && error.message ? error.message : error).slice(0, 80)}`
            }
          }
          const tabs = service('sidebarRightTabs')
          const better = service('betterSidebar')
          const work = service('uiWorkspace')
          const sessions = service('sessions')
          const lines = [
            `kinds=${tabs === undefined ? 'n/a' : keysOf(tabs.kinds)}`,
            `heroSlots=${[...document.querySelectorAll('[data-slot^="conversation.hero"]')].map((n) => n.getAttribute('data-slot')).join('+') || 'none'}`,
            `headerSeat=${document.querySelector('[data-slot="conversation.session.header.actions"]') === null ? 'absent' : 'present'}`,
            `toggles=${[...document.querySelectorAll('[data-cursor-layout-toggle]')].map((n) => {
              const seat = n.closest('[data-slot]')
              return `${n.getAttribute('data-view')}@${seat === null ? 'no-slot' : seat.getAttribute('data-slot')}`
            }).join(',')}`,
            `layoutPanels=${safe(() => service('layout').panels)}`,
            `layoutInfo=${safe(() => service('layout').panelInfo)}`,
          ]
          return lines.join(' | ')
        }

        const run = async (command) => {
          const params = command !== null && typeof command.params === 'object' && command.params !== null ? command.params : {}
          const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
          if (params.focus === true && focusSession(sessionId)) await nextFrame()
          if (command.action === 'view') {
            const target = params.view === 'agent' ? 'agent' : 'cursor'
            const ok = applyView(target)
            await nextFrame()
            const now = viewOf()
            return {
              ok: ok && now === target,
              detail: ok ? `the window shows the ${target === 'agent' ? 'Agent' : 'IDE'} view` : 'this window could not change its projection',
            }
          }
          if (command.action === 'sidebar') {
            if (params.action === 'close') {
              const ok = closeSidebar()
              return { ok, detail: ok ? 'the right sidebar is hidden' : 'this window cannot hide its sidebar' }
            }
            if (params.action === 'toggle') {
              const ok = collapsed() ? openSidebar() : closeSidebar()
              return { ok, detail: ok ? 'the right sidebar was toggled' : 'this window cannot toggle its sidebar' }
            }
            const ok = openSidebar()
            return { ok, detail: ok ? 'the right sidebar is shown' : 'this window cannot show its sidebar' }
          }
          if (command.action === 'describe') return { ok: true, detail: describe() }
          if (command.action === 'tabsprobe') {
            const right = service('sidebarRight')
            if (right === undefined) return { ok: false, detail: 'no sidebarRight' }
            const norm = (value, depth = 0) => {
              try {
                if (value === undefined || value === null) return String(value)
                if (typeof value === 'function') return 'fn'
                if (Array.isArray(value)) return `[${value.slice(0, 4).map((v) => (v !== null && typeof v === 'object' ? `{${Object.keys(v).slice(0, 8).join('/')}}` : String(v).slice(0, 24))).join(',')}]`
                if (typeof value === 'object' && typeof value.keys === 'function') return `map(${[...value.keys()].slice(0, 6).join(',')})`
                if (typeof value === 'object') {
                  if (depth > 1) return '{…}'
                  return `{${Object.keys(value).slice(0, 10).map((k) => `${k}:${norm(value[k], depth + 1)}`).join(',')}}`
                }
                return String(value).slice(0, 40)
              } catch {
                return 'throw'
              }
            }
            const call = (fn) => {
              try {
                return fn()
              } catch (error) {
                return `throw:${String(error && error.message ? error.message : error).slice(0, 60)}`
              }
            }
            return {
              ok: true,
              detail: [
                `tabs=${norm(right.tabs)}`,
                `openTabs=${norm(right.openTabs)}`,
                `active=${norm(right.active)}`,
                `focusedTarget=${norm(right.focusedTarget)}`,
                `commandTarget=${norm(right.commandTarget)}`,
                `screen=${norm(right.screen)}`,
                `menuTabs=${norm(call(() => right.menuTabs()))}`,
                `canClose(active)=${norm(call(() => right.canCloseTarget(right.commandTarget)))}`,
              ].join(' || ').slice(0, 1900),
            }
          }
          if (command.action === 'tab') {
            const right = service('sidebarRight')
            if (right === undefined) return { ok: false, detail: 'this window has no right sidebar' }
            const rows = []
            const addRow = (id, title, raw, source) => {
              const cleanId = typeof id === 'string' ? id : id === undefined || id === null ? '' : String(id)
              const cleanTitle = typeof title === 'string' ? title : ''
              if (cleanId === '' && cleanTitle === '') return
              rows.push({ id: cleanId, title: cleanTitle, raw, source })
            }
            const collect = () => {
              rows.length = 0
              try {
                const menu = typeof right.menuTabs === 'function' ? right.menuTabs() : undefined
                if (Array.isArray(menu)) {
                  for (const item of menu) {
                    if (item === null || typeof item !== 'object') continue
                    addRow(item.id ?? item.key ?? item.tabId, item.title ?? item.label ?? item.name, item, 'menu')
                  }
                }
              } catch {
                /* the menu face is optional */
              }
              if (rows.length === 0) {
                try {
                  const tabs = right.tabs
                  if (Array.isArray(tabs)) for (const item of tabs) addRow(item.id ?? item.key, item.title ?? item.label, item, 'tabs')
                  else if (tabs !== null && typeof tabs === 'object' && typeof tabs.forEach === 'function' && typeof tabs.get === 'function') {
                    tabs.forEach((value, key) => addRow(key, value !== null && typeof value === 'object' ? value.title ?? value.label : value, value, 'tabs'))
                  } else if (tabs !== null && typeof tabs === 'object') {
                    for (const key of Object.keys(tabs)) {
                      const value = tabs[key]
                      addRow(key, value !== null && typeof value === 'object' ? value.title ?? value.label : value, value, 'tabs')
                    }
                  }
                } catch {
                  /* tabs may be a store that refuses enumeration */
                }
              }
              let activeId = ''
              try {
                const active = right.active
                activeId = typeof active === 'string' ? active : active !== null && typeof active === 'object' ? String(active.id ?? active.key ?? '') : ''
              } catch {
                activeId = ''
              }
              return activeId
            }
            const activeId = collect()
            const mark = (row) => (row.id !== '' && row.id === activeId ? '*' : ' ')
            const resolve = (spec) => {
              const wanted = typeof spec === 'string' ? spec.trim() : ''
              if (wanted === '' || wanted === 'active') return null
              const asIndex = Number.parseInt(wanted, 10)
              if (Number.isInteger(asIndex) && String(asIndex) === wanted && asIndex >= 1 && asIndex <= rows.length) return rows[asIndex - 1]
              const byId = rows.find((row) => row.id === wanted)
              if (byId !== undefined) return byId
              const lower = wanted.toLowerCase()
              const byTitle = rows.find((row) => row.title.toLowerCase().includes(lower))
              return byTitle === undefined ? null : byTitle
            }
            if (params.action === 'show') {
              return {
                ok: rows.length > 0,
                detail: rows.map((row, index) => `${index + 1}.${mark(row)}${row.title === '' ? row.id : row.title}${row.id === '' ? '' : ` [${row.id}]`}`).join(' ; ') || 'no workbench tabs are open',
              }
            }
            if (params.action === 'switch' || params.action === 'close') {
              applyView('cursor')
              await nextFrame()
              openSidebar()
              await nextFrame()
              collect()
              const row = resolve(params.tab)
              if (params.tab !== '' && params.tab !== 'active' && row === null) {
                return { ok: false, detail: `no open tab matches "${params.tab}" — ui_tab action=show lists them` }
              }
              const target = row === null ? (right.commandTarget ?? right.focusedTarget) : row.raw
              if (params.action === 'switch') {
                if (typeof right.focus !== 'function') return { ok: false, detail: 'this window cannot focus a tab' }
                right.focus(target)
                await nextFrame()
                const nowActive = (() => {
                  try {
                    const active = right.active
                    return typeof active === 'string' ? active : active !== null && typeof active === 'object' ? String(active.id ?? active.key ?? '') : ''
                  } catch {
                    return ''
                  }
                })()
                return { ok: true, detail: `switched to ${row === null ? 'the active tab' : `"${row.title || row.id}"`}${nowActive === '' ? '' : ` (active=${nowActive})`}` }
              }
              if (typeof right.closeTarget !== 'function') return { ok: false, detail: 'this window cannot close a tab' }
              if (typeof right.canCloseTarget === 'function' && right.canCloseTarget(target) === false) {
                return { ok: false, detail: 'that tab refuses to close (unsaved work or a pinned panel)' }
              }
              right.closeTarget(target)
              await nextFrame()
              collect()
              return { ok: true, detail: `closed ${row === null ? 'the active tab' : `"${row.title || row.id}"`}; ${rows.length} tab(s) left` }
            }

            const tabs = service('sidebarRightTabs')
            if (params.action === 'list') {
              let kinds = []
              try {
                const registry = tabs !== undefined && tabs.kinds !== undefined ? tabs.kinds : undefined
                if (registry !== undefined && typeof registry.keys === 'function') kinds = [...registry.keys()]
                else if (Array.isArray(registry)) kinds = registry
              } catch {
                kinds = []
              }
              return { ok: kinds.length > 0, detail: kinds.join(',') }
            }
            const kind = typeof params.kind === 'string' ? params.kind : ''
            if (kind === '') return { ok: false, detail: 'give a tab kind (ui_tab action=list lists them)' }
            applyView('cursor')
            await nextFrame()
            openSidebar()
            await nextFrame()
            const options = {}
            if (typeof params.url === 'string' && params.url !== '') options.params = { url: params.url }
            try {
              right.openTab(kind, options)
            } catch (error) {
              return { ok: false, detail: `no tab of kind "${kind}" could be opened (${String(error && error.message ? error.message : error)})` }
            }
            await nextFrame()
            let active = ''
            try {
              active = typeof right.active === 'string' ? right.active : JSON.stringify(right.active)
            } catch {
              active = ''
            }
            return { ok: true, detail: `opened tab "${kind}"${params.url ? ` for ${params.url}` : ''}${active === '' ? '' : `; active=${active}`}` }
          }
          if (command.action === 'session') {
            const work = service('uiWorkspace')
            if (work === undefined) return { ok: false, detail: 'this window has no workspace controller' }
            if (params.action === 'list') {
              const rows = []
              const titleOf = (record) => {
                if (record === null || typeof record !== 'object') return ''
                for (const key of ['title', 'name', 'summary']) {
                  if (typeof record[key] === 'string' && record[key] !== '') return record[key]
                }
                const header = record.header
                if (header !== null && typeof header === 'object' && typeof header.title === 'string') return header.title
                return ''
              }
              try {
                const list = work.sessions === undefined || work.sessions === null ? undefined : work.sessions.list
                const snapshot = list !== undefined && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
                const ids = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.ids) ? snapshot.ids : []
                const byId = snapshot !== null && typeof snapshot === 'object' && snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {}
                for (const id of ids.slice(0, 12)) {
                  if (typeof id !== 'string' || id === '') continue
                  const title = titleOf(byId[id])
                  rows.push(`${id}${title === '' ? '' : ` » ${title}`}`)
                }
              } catch {
                /* best effort: an explicit id still works */
              }
              return {
                ok: rows.length > 0,
                detail: rows.join(' ; ') || 'this window could not enumerate conversations',
              }
            }
            const target = typeof params.session === 'string' ? params.session : ''
            if (target === '') return { ok: false, detail: 'give a session id (ui_session action=list lists them)' }
            try {
              work.openSession(target)
            } catch (error) {
              return { ok: false, detail: `could not open that conversation (${String(error && error.message ? error.message : error)})` }
            }
            currentSession = target
            return { ok: true, detail: `the window now shows ${target}` }
          }
          if (command.action === 'open') return openTarget(params, sessionId)
          return { ok: false, detail: `unknown command "${String(command.action)}"` }
        }

        const ack = (commandId, ok, detail) => {
          const url = routeUrl('ui-control/ack', { id: commandId, ok: ok === true ? '1' : '0', detail: String(detail === undefined ? '' : detail).slice(0, 2000) })
          try {
            void fetch(url, { cache: 'no-store' }).catch(() => undefined)
          } catch {
            /* the tool falls back to its timeout message */
          }
        }

        const handle = async (command) => {
          const commandId = typeof command.id === 'string' ? command.id : ''
          let outcome
          try {
            outcome = await run(command)
          } catch (error) {
            outcome = { ok: false, detail: String(error && error.message ? error.message : error) }
          }
          if (commandId !== '') ack(commandId, outcome.ok === true, outcome.detail)
        }

        const poll = async () => {
          if (stopped || polling) return
          polling = true
          try {
            const url = routeUrl('ui-control/poll', { client: id, session: shownSession() })
            const response = await fetch(url, { cache: 'no-store' })
            if (response.ok) {
              const body = await response.json()
              const commands = body !== null && typeof body === 'object' && Array.isArray(body.commands) ? body.commands : []
              for (const command of commands) {
                if (command !== null && typeof command === 'object') await handle(command)
              }
            }
          } catch {
            /* the window keeps polling; a dropped request costs one tick */
          } finally {
            polling = false
          }
        }

        ctx.effect(() => {
          stopped = false
          void poll()
          const timer = window.setInterval(() => void poll(), POLL_MS)
          return () => {
            stopped = true
            window.clearInterval(timer)
          }
        }, 'dsh-ui-control: host link')

        try {
          ctx.effect(
            () => ctx.slots.inject(SESSION_SLOT, () => ctx.slots.register({
              name: SESSION_SLOT,
              id: 'dsh-ui-control-session',
              order: 40,
            }, SessionProbe)),
            'dsh-ui-control: session probe',
          )
        } catch {
          /* the composer row is optional; the sidebar attribute keeps us working */
        }

        /**
         * Source links: chat text carries a bare globe in front of citations
         * (U+1F30D..U+1F310, sometimes followed by U+FE0F). Every external anchor
         * gets the site's own favicon and loses that placeholder, so a citation
         * reads with the site mark instead of an emoji. Plain text "🌐 Site name"
         * gets the icon of the site named in SITE_MAP.
         * Client-side only — a page refresh picks it up.
         */
        function installLinkFavicons() {
          if (typeof document === 'undefined' || document.body === null) return () => {}
          const MARK = 'data-dsh-link-favicon'
          const GLOBE = /[\u{1F30D}-\u{1F310}]/u
          const LEADING_GLOBE = /^[\s\uFE0F]*[\u{1F30D}-\u{1F310}][\s\uFE0F]*/u
          const TRAILING_GLOBE = /[\s\uFE0F]*[\u{1F30D}-\u{1F310}][\s\uFE0F]*$/u
          const LABEL_END = /[\u{1F30D}-\u{1F310}、，,;；\n]/u
          const SKIP_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'])
          const SKIP_TREE = 'nav, header, [role="tablist"], [contenteditable="true"], textarea, input'
          // DSH renders every external anchor as <a><svg class="…linkIcon…">globe</svg>text</a>,
          // so the globe is an element, not a character, and only a class hook can find it.
          const LINK_ICON = /linkIcon/

          const style = document.createElement('style')
          style.setAttribute('data-dsh-link-favicon-style', '')
          style.textContent = [
            'img.dsh-link-favicon {',
            '  width: 14px; height: 14px; margin: 0 4px 0 0; border-radius: 3px;',
            '  object-fit: contain; vertical-align: -2px; display: inline-block;',
            '}',
            'a[data-dsh-link-favicon]:not([data-dsh-link-favicon="skip"]) > svg[class*="linkIcon"],',
            'a[data-dsh-link-favicon]:not([data-dsh-link-favicon="skip"]) > span[class*="linkIcon"] {',
            '  display: none !important;',
            '}',
          ].join('\n')
          document.head.appendChild(style)

          /** A 14px site mark; the icon service knows every site, the site's own file is the fallback. */
          const favicon = (host) => {
            const icon = document.createElement('img')
            icon.className = 'dsh-link-favicon'
            icon.alt = ''
            icon.decoding = 'async'
            icon.referrerPolicy = 'no-referrer'
            icon.src = `https://icons.duckduckgo.com/ip3/${host}.ico`
            icon.addEventListener('error', () => {
              const fallback = `https://${host}/favicon.ico`
              if (icon.getAttribute('src') === fallback) {
                icon.remove()
                return
              }
              icon.setAttribute('src', fallback)
            })
            return icon
          }

          /** The last text node at or before `node`, so a wrapped sibling still counts. */
          const lastText = (node) => {
            if (node === null) return null
            if (node.nodeType === 3) return node
            if (node.nodeType !== 1) return null
            return document.createTreeWalker(node, NodeFilter.SHOW_TEXT).lastChild()
          }

          /** The text just before `root` ends with a globe, or `root` starts with one: drop it. */
          const dropGlobe = (root) => {
            const previous = lastText(root.previousSibling)
            if (previous !== null && typeof previous.nodeValue === 'string') {
              const cut = previous.nodeValue.replace(TRAILING_GLOBE, '')
              if (cut !== previous.nodeValue) previous.nodeValue = cut
            }
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
            let node = walker.nextNode()
            while (node !== null) {
              const text = node.nodeValue
              if (typeof text === 'string' && text.trim() !== '') {
                const cut = text.replace(LEADING_GLOBE, '')
                if (cut !== text) node.nodeValue = cut
                return
              }
              node = walker.nextNode()
            }
          }

          /** DSH's own anchor globe; the site mark takes its place. */
          const stripLinkIcon = (anchor) => {
            for (const child of Array.from(anchor.children)) {
              if (child.classList !== undefined && child.classList.contains('dsh-link-favicon')) continue
              const name = child.getAttribute('class') || ''
              if (LINK_ICON.test(name)) child.remove()
            }
          }

          /** True when this anchor already carries our mark. */
          const hasFavicon = (anchor) => Array.from(anchor.children).some(
            (child) => child.classList !== undefined && child.classList.contains('dsh-link-favicon'),
          )

          const decorate = (anchor) => {
            const marked = anchor.getAttribute(MARK)
            if (marked === 'skip') return
            if (marked !== null) {
              // React repaints anchors on every streamed token: keep the globe out and the mark in.
              stripLinkIcon(anchor)
              dropGlobe(anchor)
              if (!hasFavicon(anchor)) anchor.insertBefore(favicon(marked), anchor.firstChild)
              return
            }
            let url
            try {
              url = new URL(anchor.getAttribute('href') || '', document.baseURI)
            } catch {
              anchor.setAttribute(MARK, 'skip')
              return
            }
            const absolute = url.protocol === 'http:' || url.protocol === 'https:'
            if (!absolute || SKIP_HOSTS.has(url.hostname) || url.host === window.location.host) {
              anchor.setAttribute(MARK, 'skip')
              return
            }
            anchor.setAttribute(MARK, url.hostname)
            dropGlobe(anchor)
            stripLinkIcon(anchor)
            anchor.insertBefore(favicon(url.hostname), anchor.firstChild)
          }

          // Sites this profile cites by name only ("🌐 Leek Duck · …"), with the
          // domain whose favicon stands for them.
          const SITE_MAP = [
            [/leek\s*duck/i, 'leekduck.com'],
            [/serebi/i, 'serebii.net'],
            [/pok[eé]mon\s*go\s*hub/i, 'pokemongohub.net'],
            [/pok[eé]mon\s*go\s*live|官方活动公告|官方公告|official\s+announcement/i, 'pokemongolive.com'],
            [/(^|\s)r\/[a-z0-9_]+|reddit/i, 'reddit.com'],
            [/youtube/i, 'youtube.com'],
            [/twitter|x\.com/i, 'x.com'],
            [/niantic/i, 'nianticlabs.com'],
            [/wikipedia/i, 'wikipedia.org'],
            [/github/i, 'github.com'],
          ]

          /** Every globe left in plain text becomes the favicon of the site it names. */
          const decorateGlobes = () => {
            const body = document.body
            if (body === null || !GLOBE.test(body.textContent || '')) return
            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
            const pending = []
            let node = walker.nextNode()
            while (node !== null) {
              const text = node.nodeValue
              if (typeof text === 'string' && GLOBE.test(text)) {
                const parent = node.parentElement
                if (parent !== null && parent.closest(`${SKIP_TREE}, script, style, noscript`) === null) pending.push(node)
              }
              node = walker.nextNode()
            }
            for (const target of pending) {
              if (!target.isConnected) continue
              const text = target.nodeValue
              if (typeof text !== 'string' || !GLOBE.test(text)) continue
              const fragment = document.createDocumentFragment()
              let rest = text
              for (;;) {
                const at = rest.search(GLOBE)
                if (at < 0) break
                const before = rest.slice(0, at)
                const after = rest.slice(at + 2)
                const stop = after.search(LABEL_END)
                const label = (stop < 0 ? after : after.slice(0, stop)).replace(/^[\s\uFE0F]+/u, '').slice(0, 64)
                const match = SITE_MAP.find(([pattern]) => pattern.test(label))
                fragment.append(before)
                if (match === undefined) {
                  fragment.append(rest.slice(at, at + 2))
                  rest = after
                  continue
                }
                fragment.append(favicon(match[1]))
                rest = after.replace(/^[\s\uFE0F]+/u, '')
              }
              fragment.append(rest)
              target.replaceWith(fragment)
            }
          }

          let queued = false
          let timer = 0
          const sweep = () => {
            queued = false
            timer = 0
            for (const anchor of document.querySelectorAll('a[href]')) {
              const mark = anchor.getAttribute(MARK)
              if (mark !== null) {
                // A streamed re-render can put DSH's globe and the label back: restore both.
                if (mark !== 'skip' && anchor.querySelector('svg[class*="linkIcon"]') !== null) decorate(anchor)
                else if (mark !== 'skip' && GLOBE.test(anchor.textContent || '')) dropGlobe(anchor)
                continue
              }
              if (anchor.closest(SKIP_TREE) !== null) {
                anchor.setAttribute(MARK, 'skip')
                continue
              }
              decorate(anchor)
            }
            decorateGlobes()
          }
          const schedule = () => {
            if (queued) return
            queued = true
            timer = window.setTimeout(sweep, 120)
          }

          schedule()
          const observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          return () => {
            observer.disconnect()
            if (timer !== 0) window.clearTimeout(timer)
            style.remove()
          }
        }

        try {
          ctx.effect(() => installLinkFavicons(), 'dsh-ui-control: link favicons')
        } catch {
          /* decoration is optional; the rest of the plugin still works */
        }
      },
    }
  },
})
