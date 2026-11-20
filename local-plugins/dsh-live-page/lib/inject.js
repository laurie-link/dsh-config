/**
 * dsh-live-page — HTML injection and the live server's file listing page.
 */
import { baseName } from './paths.js'

/** Escape text for HTML text/attribute contexts. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Extract `<title>` for labels; falls back to ''. */
export function titleOfHtml(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))
  if (!match) return ''
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** Remove CSP meta tags so the injected overlay is allowed to run. */
export function stripCspMeta(html) {
  return String(html ?? '').replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    '',
  )
}

/** Per-segment URL encoding for a workspace-relative path. */
export function encodeUrlPath(rel) {
  return String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Inject the overlay assets before `</body>`.
 * Attributes are read by overlay.js from `script#dsh-live-overlay`.
 */
export function injectOverlay(html, { file, version, title, nonce } = {}) {
  const source = stripCspMeta(String(html ?? ''))
  if (/id=["']dsh-live-overlay["']/i.test(source)) return source
  const attrs = [
    `id="dsh-live-overlay"`,
    `src="/__live/overlay.js"`,
    `defer`,
    `data-file="${escapeHtml(file)}"`,
    `data-version="${escapeHtml(version)}"`,
    `data-title="${escapeHtml(title)}"`,
    `data-nonce="${escapeHtml(nonce)}"`,
  ].join(' ')
  const tags = [
    '<link rel="stylesheet" href="/__live/overlay.css">',
    `<script ${attrs}></script>`,
  ].join('\n')
  const lower = source.toLowerCase()
  const close = lower.lastIndexOf('</body>')
  if (close === -1) return source + '\n' + tags
  return source.slice(0, close) + tags + '\n' + source.slice(close)
}

/**
 * Generated page listing the workspace HTML files. Served at `/` after the
 * one-time token redirect has set the live cookie.
 */
export function buildFileListingPage({ root, files, truncated }) {
  const rows = Array.isArray(files) ? files : []
  const name = baseName(root) || root
  const list = rows
    .map((item) => {
      const rel = String(item?.path ?? item?.rel ?? '')
      const href = '/' + encodeUrlPath(rel)
      return `<li class="row" data-path="${escapeHtml(rel)}"><a href="${escapeHtml(href)}"><span class="name">${escapeHtml(
        rel,
      )}</span><span class="go">打开 →</span></a></li>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>页面编辑 · ${escapeHtml(name)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1c1f23; --muted:#6b7280; --card:#fff; --line:#e5e7eb; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --fg:#e6e8eb; --muted:#9aa2ad; --card:#181c21; --line:#2a3038; --accent:#7dd3fc; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif; }
  header { padding:28px 24px 14px; max-width:920px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 6px; font-weight:600; }
  p.hint { margin:0; color:var(--muted); font-size:13px; }
  .search { display:block; width:100%; margin-top:16px; padding:9px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); font-size:14px; outline:none; }
  .search:focus { border-color:var(--accent); }
  main { max-width:920px; margin:0 auto; padding:0 24px 40px; }
  ul { list-style:none; padding:0; margin:12px 0 0; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--card); }
  li.row { border-top:1px solid var(--line); }
  li.row:first-child { border-top:none; }
  li.row a { display:flex; gap:12px; align-items:center; padding:10px 14px; color:inherit; text-decoration:none; }
  li.row a:hover { background:color-mix(in srgb, var(--accent) 9%, transparent); }
  .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .go { color:var(--muted); font-size:12px; flex:none; }
  .empty { padding:28px; text-align:center; color:var(--muted); }
  .truncated { margin-top:12px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>页面编辑 · ${escapeHtml(name)}</h1>
  <p class="hint">选择工作区里的 HTML 页面，在 IDE 浏览器中打开并直接编辑；页面里的修改会保存回源文件。</p>
  <input id="filter" class="search" type="search" placeholder="筛选文件路径…" autocomplete="off">
</header>
<main>
  ${list ? `<ul id="list">${list}</ul>` : '<div class="empty">工作区里没有可编辑的 HTML 文件。</div>'}
  ${truncated ? '<div class="truncated">文件较多，只列出前 1000 个；请从编辑器打开目标文件。</div>' : ''}
</main>
<script>
  (function () {
    var input = document.getElementById('filter')
    var list = document.getElementById('list')
    if (!input || !list) return
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase()
      var rows = list.querySelectorAll('li.row')
      for (var i = 0; i < rows.length; i += 1) {
        var path = (rows[i].getAttribute('data-path') || '').toLowerCase()
        rows[i].style.display = !q || path.indexOf(q) !== -1 ? '' : 'none'
      }
    })
    input.focus()
  })()
</script>
</body>
</html>`
}
