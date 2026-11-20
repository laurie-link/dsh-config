/**
 * `@local/dsh-async-ui` — the Client half.
 *
 * It draws nothing by itself. Its only job is the moment between "the card is
 * on screen" and "the picture has arrived": a `query` image is a `/img-resolve`
 * URL (`/async-ui-img`), so until that 302 lands and the bytes download, GenUI's own `<img>` has
 * no intrinsic size and the figure collapses. Here we tag every such image with
 * `data-async-pending` (a reserved, shimmering box) and drop the tag on
 * `load`/`error`, so the card holds its shape and the picture fades into a slot
 * instead of shoving the layout around.
 *
 * Images that already carry a real `src` are never tagged: only `/async-ui-img`
 * hits the network late, everything else paints immediately.
 *
 * Second job, added because GenUI's lightbox is a native `<dialog>`: a click on
 * the backdrop does nothing there (only the × or Escape close it). A click on a
 * modal `<dialog>`'s backdrop reports the dialog itself as `event.target`, so we
 * watch for that exact case and synthesise the Escape GenUI already listens for.
 *
 * No React, no slots — one stylesheet, one observer and one listener, all owned
 * by `ctx.effect` so an unload leaves the page as it was.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-async-ui',
  factory(require) {
    /** Only async-image URLs are slow; local screenshots and https are not. */
    const SELECTOR = 'img[src*="/async-img"], img[src*="/async-ui-img"], img[src*="/img-resolve"]'
    /** Marks "resolution is still in flight" — styled by CSS below. */
    const PENDING = 'data-async-pending'
    /** Guards against tagging one element twice. */
    const BOUND = 'data-async-bound'
    /* A gallery tile whose picture we serve: its own aspect ratio decides the
       tile height in GenUI (`--gallery-image-ratio`), so a portrait artwork
       grows to 50vh while its neighbour stays a strip — that is the ragged
       row. Tag the figure and force one square tile per picture. */
    const TILE = 'data-async-tile'
    /**
     * GenUI gives every `image-group` a chrome heading: `<h3>{node.title ??
     * t('block.imageGroup')}</h3>` (`src/client/blocks/image-group.tsx:149`).
     * A gallery used as a plain strip of pictures does not want a label, and the
     * spec has no "no title" switch, so we hide the heading when it still holds
     * the untranslated default. A real `title` always wins and stays visible.
     */
    const DEFAULT_TITLES = new Set(['图片组', 'Image gallery', '圖片組'])
    /**
     * The export chrome above a card carries a warning whenever the spec points
     * at an http(s) picture (`ExportableGenuiBlock.tsx:77`, text from
     * `i18n/{zh,en}.ts`). Every picture this plugin draws is served by the host
     * route, so the warning fires on essentially every card — it is noise, not a
     * signal. Hidden by exact text, so a real custom notice still shows.
     */
    const NOTICE_TEXTS = new Set([
      '此页面含有外部媒体，离线打开时部分内容可能无法显示。',
      'External media may not appear when this file is opened offline.',
    ])
    /** Set on a hidden default heading; styled by CSS below. */
    const HIDE = 'data-async-ui-hide'

    const CSS = `
/* Markdown images of workspace files render at their intrinsic size, which
   blows past the chat column and pushes the text sideways. Only file-routed
   images are capped, so icons and avatars are untouched. */
img[src*="/api/file?"] {
  max-width: 100%;
  height: auto;
  border-radius: 10px;
}
/* genui draws map pins as a 32px circle around a bare "●" glyph, which reads as
   a smudge next to real basemap labels. Draw a proper marker instead: bigger
   ring, white core, drop shadow, warm colour when selected. */
[data-genui] .genui-map-marker {
  position: relative;
  width: 44px !important;
  height: 44px !important;
  padding: 0 !important;
  font-size: 0 !important;
  background: #315fa8 !important;
  border: 3px solid #ffffff !important;
  border-radius: 50% !important;
  box-shadow: 0 0 0 2px rgba(49, 95, 168, 0.85), 0 6px 16px rgba(0, 0, 0, 0.45) !important;
}
[data-genui] .genui-map-marker::after {
  content: '';
  position: absolute;
  inset: 13px;
  border-radius: 50%;
  background: #ffffff;
  pointer-events: none;
}
[data-genui] .genui-map-marker[aria-pressed="true"] {
  background: #e8590c !important;
  box-shadow: 0 0 0 2px rgba(232, 89, 12, 0.9), 0 6px 16px rgba(0, 0, 0, 0.45) !important;
}
img[${PENDING}] {
  width: 100%;
  min-height: min(38vh, 320px);
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  background:
    linear-gradient(100deg,
      rgba(128, 128, 128, 0.20) 25%,
      rgba(128, 128, 128, 0.42) 45%,
      rgba(128, 128, 128, 0.20) 65%)
    0 0 / 220% 100%,
    rgba(128, 128, 128, 0.16);
  animation: dsh-async-shimmer 1.2s linear infinite;
}
@keyframes dsh-async-shimmer {
  from { background-position: 120% 0; }
  to { background-position: -120% 0; }
}
@media (prefers-reduced-motion: reduce) {
  img[${PENDING}] { animation: none; }
}
[${HIDE}] { display: none !important; }
/* GenUI's gallery (local patch) now owns tile geometry: a grid fixes rows at
   4:3 and a solo picture keeps its own ratio with contain. This client used to
   force square 200px tiles because the old flex row came out ragged — kept, it
   would crop every picture and fight the mosaic. Only the shimmer inside a
   tile still needs its own box suppressed. */
[data-genui] figure[${TILE}] img[${PENDING}] {
  min-height: 0 !important;
  aspect-ratio: auto !important;
}
[data-async-ui-zoom] {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.82);
  cursor: zoom-out;
}
[data-async-ui-zoom] img {
  width: auto;
  height: auto;
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
[data-genui] img { cursor: zoom-in; }
/* Each place is a <button>, so a copy control cannot live inside it: the pill
   is a sibling inside the <li>, aligned to the row's right edge. */
[data-async-map] ul > li { display: flex; align-items: center; gap: 8px; }
[data-async-map] [data-async-copy] {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12.5px;
  line-height: 18px;
  white-space: nowrap;
  color: inherit;
  background: rgba(128, 128, 128, 0.12);
  border: 1px solid rgba(128, 128, 128, 0.42);
  border-radius: 999px;
  cursor: pointer;
}
[data-async-map] [data-async-copy]:hover {
  background: rgba(128, 128, 128, 0.22);
  border-color: rgba(128, 128, 128, 0.62);
}
[data-async-map] [data-async-copy] svg { width: 14px; height: 14px; flex: 0 0 auto; }
[data-async-map] [data-async-copy][data-async-copied] {
  color: #2f9e44;
  border-color: rgba(47, 158, 68, 0.6);
  background: rgba(47, 158, 68, 0.1);
}
[data-async-map] [data-async-copy-src] { cursor: copy; }
/* GenUI's copy chip is a small inline label; inside a detail card it should
   read as the primary action (icon + label, pill shaped). */
[data-genui] [class*="copyChip"] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 12.5px;
  line-height: 18px;
  border-radius: 999px;
  border: 1px solid rgba(128, 128, 128, 0.45);
  background: rgba(128, 128, 128, 0.1);
  cursor: pointer;
}
[data-genui] [class*="copyChip"]::before { content: '⧉'; font-size: 13px; opacity: 0.85; }
[data-genui] [class*="copyChip"]:hover { background: rgba(128, 128, 128, 0.2); }

[data-async-expand] {
  width: 96vw;
  max-width: 96vw;
  height: 94vh;
  max-height: 94vh;
  padding: 0;
  border: 0;
  border-radius: 16px;
  background: #0b0e13;
  color: #f2f4f8;
  overflow: hidden;
}
[data-async-expand]::backdrop { background: rgba(0, 0, 0, 0.78); }
[data-async-expand-body] {
  position: relative;
  height: 100%;
  padding: 0;
  box-sizing: border-box;
}
[data-async-expand-list] {
  position: absolute;
  left: 12px;
  top: 44px;
  max-height: calc(100% - 64px);
  width: 208px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(16, 18, 22, 0.86);
  backdrop-filter: blur(6px);
  z-index: 3;
}
[data-async-expand-list-head] {
  padding: 2px 6px 6px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.55);
}
[data-async-expand-item] {
  text-align: left;
  padding: 7px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #e8ecf2;
  font-size: 12.5px;
  line-height: 18px;
  cursor: pointer;
}
[data-async-expand-item]:hover { background: rgba(255, 255, 255, 0.1); }
[data-async-expand-reset] { color: #9ec5ff; }

[data-async-expand-body] [role="region"] {
  position: absolute;
  inset: 0;
  height: auto !important;
  border: 0;
  border-radius: 0;
  overflow: hidden;
  touch-action: none;
}
[data-async-expand-close] {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 4;
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 17px;
  line-height: 1;
  color: #f2f4f8;
  background: rgba(16, 22, 29, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 50%;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  cursor: pointer;
}
[data-async-expand-close]:hover { background: rgba(16, 22, 29, 0.95); }
[data-async-expand-zoom] {
  position: absolute;
  right: 12px;
  bottom: 64px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-async-expand-zoom] button {
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
  color: #f2f4f8;
  background: rgba(16, 22, 29, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 10px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  cursor: pointer;
}
[data-async-expand-zoom] button:hover { background: rgba(16, 22, 29, 0.95); }
[data-async-expand-hint] {
  position: absolute;
  left: 12px;
  top: 12px;
  z-index: 4;
  padding: 5px 11px;
  font-size: 12px;
  line-height: 18px;
  color: #e8eef7;
  background: rgba(16, 22, 29, 0.66);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
}
/* The map block ships a full-width grey bar under the canvas and one boxed row
   per place; both read as a form. Compacted here, plus a floating trigger. */
[data-async-map] { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
[data-async-map] > [role="status"] { font-size: 11px; opacity: 0.5; }
[data-async-map-ready] > [role="status"] { display: none; }
[data-async-map-controls] { display: flex; flex-wrap: wrap; gap: 6px; }
[data-async-map-controls] button {
  padding: 3px 10px;
  font-size: 12px;
  line-height: 18px;
  border-radius: 999px;
  border: 1px solid rgba(128, 128, 128, 0.4);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
[data-async-map-controls] button:disabled { opacity: 0.4; cursor: default; }
[data-async-map] ul {
  display: grid;
  gap: 6px;
  max-height: 232px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
[data-async-map] ul > li > button {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  width: auto;
  padding: 6px 10px;
  text-align: start;
  font-size: 13px;
  color: inherit;
  background: rgba(128, 128, 128, 0.07);
  border: 1px solid rgba(128, 128, 128, 0.18);
  border-radius: 8px;
  cursor: pointer;
}
[data-async-map] ul > li > button:hover { background: rgba(128, 128, 128, 0.14); }
[data-async-map] ul > li > button[aria-pressed="true"] {
  border-color: rgba(49, 95, 168, 0.9);
  background: rgba(49, 95, 168, 0.14);
}
[data-async-map] ul > li > button > span:first-child { font-weight: 600; }
[data-async-map] ul > li > button > span:not(:first-child) { font-size: 12px; opacity: 0.72; }
[data-async-map] .maplibregl-ctrl-attrib {
  font-size: 10px;
  border-radius: 6px 0 0 0;
  background: rgba(16, 22, 29, 0.55) !important;
}
[data-async-map] .maplibregl-ctrl-attrib a { color: #d7e4f7 !important; }
[data-async-expand-open] {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  margin: 0;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 18px;
  color: #f2f4f8;
  background: rgba(16, 22, 29, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  cursor: pointer;
}
[data-async-expand-open]:hover { background: rgba(16, 22, 29, 0.92); }
dialog[data-async-expand] [data-async-expand-open] { display: none; }

`

    /* Older hosts answered an unverifiable query with a 900x900 drawing instead
       of failing the request. A renderer cannot tell that drawing from a photo,
       so it survives as an empty tile ("没有找到可核对的图"). Recognise the
       drawing itself — square, and almost entirely the flat #16181d panel — and
       fail the image on purpose, which makes gallery renderers drop the tile.
       Newer hosts answer 404 and never reach this check. */
    const PLACEHOLDER_SIZE = 900
    const UNVERIFIED = '/__async-ui__/unverified-image'
    function looksLikePlaceholder(img) {
      if (img.naturalWidth !== PLACEHOLDER_SIZE || img.naturalHeight !== PLACEHOLDER_SIZE) return false
      let pixels
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx === null) return false
        ctx.drawImage(img, 0, 0, 32, 32)
        pixels = ctx.getImageData(0, 0, 32, 32).data
      } catch {
        return false
      }
      let flat = 0
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - 22) <= 5 && Math.abs(pixels[i + 1] - 24) <= 5 && Math.abs(pixels[i + 2] - 29) <= 5) {
          flat += 1
        }
      }
      return flat >= (pixels.length / 4) * 0.8
    }

    /** Hold the slot until the picture lands, then hand it back to the image. */
    function mark(img) {
      if (img.getAttribute(BOUND) === '1') return
      img.setAttribute(BOUND, '1')
      const figure = img.closest('figure')
      /* The gallery lightbox renders its own <figure> (expandedFigure) holding
         the same picture. Tagging that one would square it to a 200px tile —
         that is the "first click looks broken, second click fine" flicker. */
      if (figure !== null) {
        if (figure.closest('dialog') === null) figure.setAttribute(TILE, '')
        else figure.removeAttribute(TILE)
      }
      const settle = (event) => {
        img.removeAttribute(PENDING)
        img.removeEventListener('load', settle)
        img.removeEventListener('error', settle)
        if (event !== undefined && event.type === 'load' && looksLikePlaceholder(img)) img.src = UNVERIFIED
      }
      img.addEventListener('load', settle)
      img.addEventListener('error', settle)
      if (img.complete && img.naturalWidth > 0) {
        settle({ type: 'load' })
        return
      }
      img.setAttribute(PENDING, '')
    }

    /** Drop a gallery heading that is only GenUI's untranslated placeholder. */
    function hideAutoTitle(heading) {
      if (heading.getAttribute(HIDE) === '1') return
      const text = heading.textContent?.trim() ?? ''
      if (!DEFAULT_TITLES.has(text)) return
      heading.setAttribute(HIDE, '1')
    }

    /** Drop the "this page contains external media" line above an exported card. */
    function hideNotice(span) {
      if (span.getAttribute(HIDE) === '1') return
      const text = span.textContent?.trim() ?? ''
      if (!NOTICE_TEXTS.has(text)) return
      span.setAttribute(HIDE, '1')
    }

    /* ── Coordinates & map size ───────────────────────────────────────────
       The map node lists each place as a button whose last line is "31.2400,
       121.4882", but nothing lets you take that number away with you. A real
       button inside that button is invalid HTML, so the coordinate line itself
       becomes the copy target. Same idea for size: the node caps height at 640
       and offers no expand, so we add one that reuses the live canvas. */
    const COORD = /^-?\d{1,3}(?:\.\d+)?,\s*-?\d{1,3}(?:\.\d+)?$/
    const COPY = 'data-async-copy'
    const COPIED = 'data-async-copied'
    const EXPAND = 'data-async-expand'
    // The trigger button owns `data-async-expand-open` (it has CSS); the canvas
    // keeps a separate armed flag so the button styling never leaks onto it.
    const EXPAND_ARMED = 'data-async-expand-armed'

    /** Flash the pill into its confirmation state without touching the layout. */
    function markCopied(host) {
      if (typeof host.setLabel !== 'function') {
        host.setLabel = text => {
          const label = host.querySelector('span')
          if (label !== null) label.textContent = text
        }
      }
      host.setAttribute(COPIED, '1')
      host.setLabel('✓ 已复制')
      clearTimeout(Number(host.getAttribute('data-async-copy-timer') || 0))
      const timer = setTimeout(() => {
        if (!host.isConnected) return
        host.removeAttribute(COPIED)
        host.setLabel('复制坐标')
      }, 1600)
      host.setAttribute('data-async-copy-timer', String(timer))
    }

    function copyText(text, host) {
      const ok = () => markCopied(host)
      if (navigator.clipboard?.writeText !== undefined) {
        navigator.clipboard.writeText(text).then(ok, () => legacyCopy(text, ok))
        return
      }
      legacyCopy(text, ok)
    }

    function legacyCopy(text, ok) {
      const box = document.createElement('textarea')
      box.value = text
      box.style.position = 'fixed'
      box.style.opacity = '0'
      document.body.appendChild(box)
      box.select()
      try { document.execCommand('copy') } catch {}
      box.remove()
      ok()
    }

    const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>'

    function addCopyHint(span) {
      const text = (span.textContent ?? '').trim()
      if (!COORD.test(text)) return
      const row = span.closest('li')
      if (row === null || row.querySelector('[' + COPY + ']') !== null) return
      span.setAttribute('data-async-copy-src', '')
      const pill = document.createElement('button')
      pill.type = 'button'
      pill.setAttribute(COPY, '')
      pill.innerHTML = COPY_ICON + '<span>复制坐标</span>'
      pill.setAttribute('title', '复制坐标')
      pill.addEventListener('click', event => {
        event.stopPropagation()
        copyText(text, pill)
      })
      row.appendChild(pill)
    }

    /* Scroll zoom is off in the map block itself (the chat owns the wheel), and
       its controls are the only public handle on the engine. In the expanded
       map the pointer belongs to the map, so steal the wheel back and drive
       those buttons. */
    /* The canvas gets moved into the dialog, so remember the block it came from. */
    const MAP_SECTION = new WeakMap()

    function zoomControls(canvas) {
      const section = MAP_SECTION.get(canvas) ?? canvas.parentElement
      if (section === null || section === undefined) return null
      for (const child of section.children) {
        if (child === canvas || child.tagName === 'UL') continue
        const buttons = child.querySelectorAll(':scope > button')
        if (buttons.length >= 2) return { in: buttons[0], out: buttons[1] }
      }
      return null
    }

    function stepZoom(canvas, direction) {
      const controls = zoomControls(canvas)
      if (controls === null) return
      const button = direction > 0 ? controls.in : controls.out
      if (button instanceof HTMLButtonElement && !button.disabled) button.click()
    }

    /* A fixed-position overlay inside the chat is at the mercy of transformed
       ancestors (the map then collapses into a thin strip), so hand the canvas
       to a top-layer <dialog> instead — same trick GenUI's lightbox uses. */
    /**
     * The location list that rides on top of the full-screen map.
     *
     * Zooming away from Shanghai should not lose the three places the answer
     * listed, so every row here is a jump target: it presses the row's own
     * button inside the block, which is what makes GenUI select (and fly to)
     * that coordinate.
     */
    function expandList(section) {
      if (section === undefined || section === null) return undefined
      const rows = []
      for (const li of section.querySelectorAll('li')) {
        const button = li.querySelector('button')
        if (button === null) continue
        const label = (button.innerText || '').split('\n').map(part => part.trim()).filter(part => part !== '')[0]
        if (label === undefined) continue
        rows.push({ button, label })
      }
      if (rows.length === 0) return undefined
      const panel = document.createElement('div')
      panel.setAttribute('data-async-expand-list', '')
      const head = document.createElement('div')
      head.setAttribute('data-async-expand-list-head', '')
      head.textContent = `${rows.length} 个地点`
      panel.appendChild(head)
      for (const row of rows) {
        const item = document.createElement('button')
        item.type = 'button'
        item.setAttribute('data-async-expand-item', '')
        item.textContent = row.label
        item.title = `回到 ${row.label}`
        item.addEventListener('click', event => {
          event.stopPropagation()
          row.button.click()
        })
        panel.appendChild(item)
      }
      const reset = [...section.querySelectorAll('button')].find(button => /重置/.test(button.textContent ?? ''))
      if (reset !== undefined) {
        const all = document.createElement('button')
        all.type = 'button'
        all.setAttribute('data-async-expand-item', '')
        all.setAttribute('data-async-expand-reset', '')
        all.textContent = '回到全部'
        all.addEventListener('click', event => { event.stopPropagation(); reset.click() })
        panel.appendChild(all)
      }
      return panel
    }

    function expandMap(canvas) {
      if (canvas.closest('dialog[' + EXPAND + ']') !== null) return
      const parent = canvas.parentNode
      if (parent === null) return
      const dialog = document.createElement('dialog')
      dialog.setAttribute(EXPAND, '')
      dialog.setAttribute('aria-label', '放大的地图')
      const body = document.createElement('div')
      body.setAttribute('data-async-expand-body', '')
      const hint = document.createElement('span')
      hint.setAttribute('data-async-expand-hint', '')
      hint.textContent = '滚轮缩放 · 拖动平移'
      const out = document.createElement('button')
      out.type = 'button'
      out.textContent = '−'
      out.setAttribute('aria-label', '缩小')
      const plus = document.createElement('button')
      plus.type = 'button'
      plus.textContent = '+'
      plus.setAttribute('aria-label', '放大')
      const zoom = document.createElement('div')
      zoom.setAttribute('data-async-expand-zoom', '')
      zoom.append(plus, out)
      const close = document.createElement('button')
      close.type = 'button'
      close.setAttribute('data-async-expand-close', '')
      close.setAttribute('aria-label', '关闭地图')
      close.textContent = '×'
      const anchor = document.createComment('async-ui-map-anchor')
      parent.insertBefore(anchor, canvas)
      body.append(canvas, hint, zoom, close)
      const list = expandList(MAP_SECTION.get(canvas) ?? canvas.closest('section'))
      if (list !== undefined) body.appendChild(list)
      dialog.append(body)
      document.body.appendChild(dialog)
      const onWheel = event => {
        event.preventDefault()
        const delta = event.deltaY === 0 ? 0 : (event.deltaY < 0 ? 1 : -1)
        if (delta === 0) return
        stepZoom(canvas, delta)
      }
      const removeWheel = () => canvas.removeEventListener('wheel', onWheel)
      canvas.addEventListener('wheel', onWheel, { passive: false })
      out.addEventListener('click', () => stepZoom(canvas, -1))
      plus.addEventListener('click', () => stepZoom(canvas, 1))
      dialog.addEventListener('close', () => {
        removeWheel()
        if (anchor.parentNode !== null) anchor.parentNode.insertBefore(canvas, anchor)
        anchor.remove()
        dialog.remove()
      })
      close.addEventListener('click', () => dialog.close())
      dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close() })
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }

    /** MapLibre only exists once it mounted, so wait for its own container.
        MapLibre puts `maplibregl-map` on the element it was handed, so check
        the node itself as well as its subtree. */
    function addExpandButton(canvas) {
      if (canvas.getAttribute(EXPAND_ARMED) === '1') return
      const mounted = canvas.classList.contains('maplibregl-map')
        || canvas.querySelector('.maplibregl-map') !== null
      if (!mounted) return
      canvas.setAttribute(EXPAND_ARMED, '1')
      const section = canvas.parentElement
      if (section !== null) {
        MAP_SECTION.set(canvas, section)
        section.setAttribute('data-async-map', '')
        section.setAttribute('data-async-map-ready', '')
      }
      for (const child of section === null ? [] : section.children) {
        if (child === canvas || child.tagName === 'UL') continue
        if (child.querySelectorAll(':scope > button').length >= 2) child.setAttribute('data-async-map-controls', '')
      }
      const open = document.createElement('button')
      open.type = 'button'
      open.setAttribute('data-async-expand-open', '')
      open.textContent = '⤢ 放大'
      open.addEventListener('click', () => expandMap(canvas))
      canvas.appendChild(open)
    }

    /* Where each picture came from: the host records the source page while it
       resolves the image, and one small fetch lets the answer say so. A picture
       whose source is visible is a picture a reader can check. */
    const SOURCE = 'data-async-source'
    const SOURCES = new Map()

    function attachSource(img) {
      if (!(img instanceof HTMLImageElement)) return
      const src = img.getAttribute('src') ?? ''
      if (!src.includes('/async-img')) return
      if (img.hasAttribute(SOURCE)) return
      img.setAttribute(SOURCE, '')
      let query
      let subject
      let stamp
      try {
        const parsed = new URL(src, location.href)
        query = parsed.searchParams.get('q') ?? ''
        subject = parsed.searchParams.get('s') ?? query
        stamp = parsed.searchParams.get('w') ?? '900'
      } catch {
        return
      }
      if (query === '') return
      const cacheKey = query + '\n' + subject
      const paint = (meta) => {
        if (meta === undefined || typeof meta.page !== 'string' || meta.page === '') return
        /* A chip inside the flow would be squeezed by image-group's narrow
           column (it rendered one character per line), so the source rides on
           the picture itself: hover shows it, the attribute keeps it greppable. */
        let host = ''
        try { host = new URL(meta.page).hostname.replace(/^www\./, '') } catch { host = '' }
        if (host === '') return
        img.setAttribute('data-async-source', meta.page)
        img.title = `来源：${host}\n${String(meta.title ?? '')}`.trim()
        img.style.cursor = 'zoom-in'
      }
      const cached = SOURCES.get(cacheKey)
      if (cached !== undefined) { paint(cached); return }
      fetch('/async-img-meta?q=' + encodeURIComponent(query)
        + '&s=' + encodeURIComponent(subject)
        + '&w=' + encodeURIComponent(stamp))
        .then((response) => (response.ok ? response.json() : undefined))
        .then((meta) => { if (meta !== undefined) { SOURCES.set(cacheKey, meta); paint(meta) } })
        .catch(() => {})
    }

    function sourceFor(img) {
      if (!(img instanceof HTMLImageElement)) return
      if (!((img.getAttribute('src') ?? '').includes('/async-img'))) return
      const go = () => attachSource(img)
      if (img.complete && img.naturalWidth > 0) go()
      else img.addEventListener('load', go, { once: true })
    }

    /** Tag one element or everything under it. */
    function scan(root) {      if (root === null || root === undefined) return
      if (root instanceof HTMLImageElement) {
        if (root.matches(SELECTOR)) mark(root)
        sourceFor(root)
        return
      }
      if (root instanceof HTMLElement && root.matches('[data-genui] h3')) hideAutoTitle(root)
      if (root instanceof HTMLElement && root.matches('[data-genui-export] span')) hideNotice(root)
      if (root instanceof HTMLElement && root.matches('[data-genui] span')) addCopyHint(root)
      if (root instanceof HTMLElement && root.matches('[data-genui] div[role="region"]')) addExpandButton(root)
      if (typeof root.querySelectorAll !== 'function') return
      for (const img of root.querySelectorAll(SELECTOR)) { mark(img); sourceFor(img) }
      for (const heading of root.querySelectorAll('[data-genui] h3')) hideAutoTitle(heading)
      for (const span of root.querySelectorAll('[data-genui-export] span')) hideNotice(span)
      for (const span of root.querySelectorAll('[data-genui] span')) addCopyHint(span)
      for (const canvas of root.querySelectorAll('[data-genui] div[role="region"]')) addExpandButton(canvas)
    }

    /**
     * GenUI's gallery lightbox, identified by the `-dialog-title` id it always
     * labels itself with. Kept as a selector so an upstream rename degrades to
     * "nothing happens" instead of closing the wrong dialog.
     */
    /** The plugin's own lightbox: plain `image` nodes (cards, inline pictures)
     *  render a bare <img>, and only `image-group` ships a dialog. */
    const ZOOM = 'data-async-ui-zoom'

    const DIALOG = 'dialog[open][aria-labelledby$="-dialog-title"]'

    /** A click that lands on the modal box itself is a click outside the image. */
    function closeLightbox(dialog) {
      dialog.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
      }))
      // Older hosts without the Escape handler: fall back to the × button.
      setTimeout(() => {
        if (!dialog.open) return
        for (const button of dialog.querySelectorAll('button')) {
          const label = button.textContent?.trim()
          if (label === '×' || label === 'X') { button.click(); return }
        }
      }, 0)
    }

    function closeZoom() {
      const layer = document.querySelector('[' + ZOOM + ']')
      if (layer !== null) layer.remove()
    }

    /** Same picture, screen-sized: the crop the route serves is a thumbnail. */
    function openZoom(image) {
      closeZoom()
      const src = image.currentSrc || image.src
      if (typeof src !== 'string' || src === '') return
      const layer = document.createElement('div')
      layer.setAttribute(ZOOM, '')
      layer.setAttribute('role', 'dialog')
      layer.setAttribute('aria-modal', 'true')
      layer.setAttribute('aria-label', image.alt || 'image')
      const picture = document.createElement('img')
      picture.src = src
      picture.alt = image.alt || ''
      layer.appendChild(picture)
      layer.addEventListener('click', closeZoom)
      document.body.appendChild(layer)
    }

    /* ── Gallery viewer gestures ──────────────────────────────────────────
       GenUI's viewer pages with ←/→ and its own buttons only. A horizontal
       swipe (touch, pen or mouse drag) or a sideways trackpad scroll pages it
       too, by sending the same arrow keys its keydown handler already
       understands — nothing inside GenUI has to know about gestures. */
    const SWIPE_MIN_PX = 48
    /* The viewer's empty space around the picture: a click there closes it. */
    const VIEWER_EMPTY = '[class*="expandedFrame"], [class*="expandedFigure"]'
    let swipe = null
    let swallowClick = false
    let swallowTimer = 0
    let wheelSum = 0
    let wheelIdleTimer = 0
    let wheelLockUntil = 0

    function galleryViewerOf(target) {
      return target instanceof Element ? target.closest(DIALOG) : null
    }

    /* The viewer's <img> fills the whole frame with object-fit: contain, so
       the dark bars beside a picture are still the <img> element. Only the
       box the picture is actually drawn in counts as "on the picture". */
    function onPicture(img, x, y) {
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return true
      const box = img.getBoundingClientRect()
      const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
      const width = img.naturalWidth * scale
      const height = img.naturalHeight * scale
      const left = box.left + (box.width - width) / 2
      const top = box.top + (box.height - height) / 2
      return x >= left && x <= left + width && y >= top && y <= top + height
    }

    function pageViewer(viewer, step) {
      const key = step > 0 ? 'ArrowRight' : 'ArrowLeft'
      viewer.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }))
    }

    function onSwipeStart(event) {
      const viewer = galleryViewerOf(event.target)
      if (viewer === null || event.button !== 0 || event.target.closest('button, a') !== null) {
        swipe = null
        return
      }
      swipe = { viewer, x: event.clientX, y: event.clientY, id: event.pointerId }
    }

    function onSwipeEnd(event) {
      const start = swipe
      swipe = null
      if (start === null || event.pointerId !== start.id) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.2) return
      /* The click that ends a swipe is a page turn, not a click on empty space. */
      swallowClick = true
      clearTimeout(swallowTimer)
      swallowTimer = setTimeout(() => { swallowClick = false }, 400)
      pageViewer(start.viewer, dx < 0 ? 1 : -1)
    }

    function onSwipeCancel() {
      swipe = null
    }

    /* One page per trackpad gesture: macOS keeps sending decaying wheel events
       for a second after the fingers lift, so after a turn the wheel stays
       locked until the stream has been quiet for a moment. */
    function onViewerWheel(event) {
      const viewer = galleryViewerOf(event.target)
      if (viewer === null || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      event.preventDefault()
      const now = Date.now()
      if (now < wheelLockUntil) {
        wheelLockUntil = now + 220
        return
      }
      wheelSum += event.deltaX
      clearTimeout(wheelIdleTimer)
      wheelIdleTimer = setTimeout(() => { wheelSum = 0 }, 200)
      if (Math.abs(wheelSum) < 60) return
      pageViewer(viewer, wheelSum > 0 ? 1 : -1)
      wheelSum = 0
      wheelLockUntil = now + 220
    }

    function onPointerTarget(event) {
      const target = event.target
      const viewer = galleryViewerOf(target)
      if (viewer !== null && swallowClick) {
        swallowClick = false
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (viewer !== null && (target === viewer
        || (target instanceof Element && target.matches(VIEWER_EMPTY))
        || (target instanceof HTMLImageElement && target.closest(VIEWER_EMPTY) !== null && !onPicture(target, event.clientX, event.clientY)))) {
        closeLightbox(viewer)
        return
      }
      if (!(target instanceof HTMLImageElement)) return
      if (event.button !== 0 || event.defaultPrevented) return
      if (target.closest('[' + ZOOM + ']') !== null) return
      /* The gallery lightbox already is a full-screen view: opening our own
         zoom on top of it stacks two overlays and both want Escape. */
      if (target.closest('dialog') !== null) return
      if (target.closest('[data-genui]') === null) return
      // A gallery thumbnail is already its own button: let GenUI open it.
      if (target.closest('button, a') !== null) return
      event.preventDefault()
      openZoom(target)
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') closeZoom()
    }

    /* ── Basemap ──────────────────────────────────────────────────────────
       GenUI's `map` node is a source-free offline canvas: it draws markers and
       routes but no streets. `setGenuiMapConfig` is the only official hook and
       it wants a STYLE OBJECT, not a URL — so the host half serves the style
       JSON from /async-img-style and we hand it over once GenUI is loaded.
       Export markers: data-async-ui-basemap on <html> (no-module | fetch-… |
       ok) so a failure is visible instead of silently blank. */
    const STYLE_ENDPOINT = '/async-img-style'
    let basemapState = ''

    function markBasemap(state) {
      basemapState = state
      try { document.documentElement.setAttribute('data-async-ui-basemap', state) } catch {}
    }

    function installBasemap(genui) {
      if (basemapState === 'ok' || basemapState === 'loading') return true
      const configure = genui !== null && genui !== undefined ? genui.setGenuiMapConfig : undefined
      if (typeof configure !== 'function') return false
      markBasemap('loading')
      fetch(STYLE_ENDPOINT, { credentials: 'same-origin' })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('style ' + response.status)))
        .then((style) => {
          configure({ style })
          markBasemap('ok')
        })
        .catch((error) => markBasemap('fetch-' + String((error && error.message) || error).slice(0, 40)))
      return true
    }

    return {
      inject: [],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-async-ui', '')
          style.textContent = CSS
          document.head.appendChild(style)

          const observer = new MutationObserver((records) => {
            for (const record of records) {
              for (const node of record.addedNodes) scan(node)
              // A heading that fills in after insertion (streamed fence, React
              // re-render) changes text under an existing node: re-check the
              // parent, which is the element that gained the text.
              const target = record.target
              if (target instanceof Element) scan(target)
              else if (target !== null && target !== undefined && target.parentElement) scan(target.parentElement)
            }
          })
          observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true })
          scan(document.documentElement)

          document.addEventListener('click', onPointerTarget, true)
          document.addEventListener('keydown', onKeyDown)
          document.addEventListener('pointerdown', onSwipeStart, true)
          document.addEventListener('pointerup', onSwipeEnd, true)
          document.addEventListener('pointercancel', onSwipeCancel, true)
          document.addEventListener('wheel', onViewerWheel, { capture: true, passive: false })

          /* GenUI's bundle is ~1 MB and may not have executed yet. `require.async`
             arrives its graph row first (the sync table would just throw), so
             this works regardless of load order. */
          let timer = null
          let stopped = false
          const start = () => {
            if (stopped) return
            if (require !== null && require !== undefined && typeof require.async === 'function') {
              require.async('@changfenhuang/dsh-genui').then(
                (genui) => { if (!stopped && !installBasemap(genui)) poll() },
                () => poll(),
              )
              return
            }
            poll()
          }
          const poll = () => {
            let attempts = 0
            const tick = () => {
              if (stopped) return
              let genui = null
              try { genui = require('@changfenhuang/dsh-genui') } catch {}
              if (installBasemap(genui)) return
              attempts += 1
              if (attempts < 120) timer = setTimeout(tick, 500)
              else markBasemap('no-module')
            }
            tick()
          }
          start()

          return () => {
            stopped = true
            if (timer !== null) clearTimeout(timer)
            observer.disconnect()
            document.removeEventListener('click', onPointerTarget, true)
            document.removeEventListener('keydown', onKeyDown)
            document.removeEventListener('pointerdown', onSwipeStart, true)
            document.removeEventListener('pointerup', onSwipeEnd, true)
            document.removeEventListener('pointercancel', onSwipeCancel, true)
            document.removeEventListener('wheel', onViewerWheel, { capture: true })
            clearTimeout(swallowTimer)
            clearTimeout(wheelIdleTimer)
            closeZoom()
            style.remove()
          }
        }, 'dsh-async-ui: placeholders + lightbox backdrop')
      },
    }
  },
})
