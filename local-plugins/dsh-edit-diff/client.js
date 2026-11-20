/**
 * dsh-edit-diff — 浏览器半。
 *
 * 把 `edit` / `write` / `apply_patch` 三个工具行换成 Cursor 式的改动卡片：
 *
 *   ✎ 编辑  client.ts                        +12  −3
 *   ┌──────────────────────────────────────────────────┐
 *   │  58    check() {                                 │
 *   │  59  -   return oldValue                         │
 *   │  59  +   return await next(oldValue)              │
 *   │  60    }                                          │
 *   └──────────────────────────────────────────────────┘
 *
 *  - diff 默认就地展开，不需要点开工具行；流式过程中随参数增长实时刷新。
 *  - 行号是文件里的绝对行号：宿主半 `GET /edit-diff/file` 把文件文本读给浏览器半，
 *    用 hunk 的 newText 在文件里定位，再按增删偏移推回旧行号；定位失败就不显示行号。
 *  - 点卡片 → 切到 IDE 视图并在编辑区打开该文件，跳到第一处改动（行号未知时走
 *    dsh-vscode-mode 的「聚焦差异」流程）。没有 dsh-cursor-layout 时退回官方
 *    `openFile(path, { line })`，也就是右侧栏文件预览。
 *
 * 注册方式是 keyed slot 替换：`tool.call.toolview` 的 `edit` / `write` / `apply_patch`
 * 三个 key 被本插件占用，内置行不再渲染。
 *
 * @author DSH local maintenance 2026-11-18
 */
window.__ModuleLoader__.load({
  id: 'dsh-edit-diff',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    /** `<style>` 标记，热重载时不重复插入。 */
    const STYLE_ID = 'dsh-edit-diff/style'
    /** 卡片默认最多显示多少行 diff。 */
    const MAX_ROWS = 10
    /** LCS 的格子数上限，超过就退化成「整块删 + 整块加」。 */
    const MAX_LCS_CELLS = 240000
    /** 文件文本缓存有效期（毫秒）。 */
    const FILE_CACHE_TTL = 8000
    /** 文件文本缓存条目上限。 */
    const FILE_CACHE_MAX = 48
    /** 定位 hunk 时最多扫文件多少行。 */
    const MAX_LOCATE_LINES = 40000
    /** 参与定位的 hunk 行数上限。 */
    const MAX_NEEDLE_LINES = 400
    /** 头部保留的上下文行数。 */
    const HEAD_CONTEXT = 1
    /** 尾部保留的上下文行数。 */
    const TAIL_CONTEXT = 1

    const CSS = `
.dsh-edit-diff {
  display: block;
  margin: 4px 0 10px;
  min-width: 0;
  font-size: var(--dsh-content-font-size-secondary, 12px);
}
.dsh-edit-diff-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 2px 4px 3px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, #9aa0a8);
  user-select: none;
  transition: background-color .12s ease;
}
.dsh-edit-diff-head:hover { background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, .09)); }
.dsh-edit-diff-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c8dff); outline-offset: 1px; }
.dsh-edit-diff-ico { flex: none; display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-edit-diff-verb { flex: none; color: var(--dsw-alias-label-secondary, #9aa0a8); }
.dsh-edit-diff-file {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #e6e8eb);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.dsh-edit-diff-dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  opacity: .85;
}
.dsh-edit-diff-stats { flex: none; display: inline-flex; gap: 6px; margin-left: auto; font-variant-numeric: tabular-nums; }
.dsh-edit-diff-add { color: var(--dsw-alias-state-success-primary, #3fb950); }
.dsh-edit-diff-del { color: var(--dsw-alias-state-error-primary, #f85149); }
.dsh-edit-diff-zero { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dsh-edit-diff-sec { display: block; margin-top: 2px; }
.dsh-edit-diff-secbar {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, #9aa0a8);
}
.dsh-edit-diff-secbar:hover { background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, .09)); }
.dsh-edit-diff-box {
  margin-left: 19px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(128, 128, 128, .22));
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-secondary, rgba(128, 128, 128, .04));
}
.dsh-edit-diff-line {
  display: flex;
  align-items: stretch;
  min-width: 0;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--dsh-content-font-size-secondary, 12px);
  line-height: 18px;
}
.dsh-edit-diff-line[data-kind="add"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #3fb950) 15%, transparent); }
.dsh-edit-diff-line[data-kind="del"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f85149) 15%, transparent); }
.dsh-edit-diff-no {
  flex: none;
  width: 42px;
  padding: 0 8px 0 4px;
  text-align: right;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  opacity: .8;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.dsh-edit-diff-no[data-empty="1"] { opacity: 0; }
.dsh-edit-diff-sign {
  flex: none;
  width: 13px;
  text-align: center;
  user-select: none;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dsh-edit-diff-line[data-kind="add"] .dsh-edit-diff-sign { color: var(--dsw-alias-state-success-primary, #3fb950); }
.dsh-edit-diff-line[data-kind="del"] .dsh-edit-diff-sign { color: var(--dsw-alias-state-error-primary, #f85149); }
.dsh-edit-diff-text {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 10px;
  white-space: pre;
  overflow-x: auto;
  overflow-y: hidden;
  color: var(--dsw-alias-label-primary, #e6e8eb);
  scrollbar-width: none;
}
.dsh-edit-diff-text::-webkit-scrollbar { display: none; }
.dsh-edit-diff-text[data-empty="1"]::after { content: " "; }
.dsh-edit-diff-more {
  display: block;
  margin: 0 0 0 19px;
  padding: 3px 8px 4px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(128, 128, 128, .22));
  border-top: none;
  border-radius: 0 0 8px 8px;
  background: none;
  color: var(--dsw-alias-label-secondary, #9aa0a8);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-edit-diff-more:hover { color: var(--dsw-alias-label-primary, #e6e8eb); background: var(--dsw-alias-bg-hover, rgba(128, 128, 128, .09)); }
.dsh-edit-diff-box[data-more="1"] { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.dsh-edit-diff-pending { margin-left: 19px; padding: 6px 10px; color: var(--dsw-alias-label-secondary, #9aa0a8); }
.dsh-edit-diff-pending-dot {
  display: inline-block;
  width: 6px; height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: dsh-edit-diff-pulse 1.1s ease-in-out infinite;
}
@keyframes dsh-edit-diff-pulse {
  0%, 100% { opacity: .25; transform: scale(.75); }
  50% { opacity: 1; transform: scale(1); }
}
.dsh-edit-diff-error {
  margin: 2px 0 0 19px;
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #f85149) 40%, transparent);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary, #f85149);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--dsh-content-font-size-secondary, 12px);
  line-height: 17px;
  white-space: pre-wrap;
  word-break: break-word;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-edit-diff-pending-dot { animation: none; opacity: .75; }
}
`

    /* ---------------------------------------------------------------- 工具 */

    /** 幂等插入样式表。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', 'dsh-edit-diff')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** 去掉多余的 `.` / `..` 段，保留前导 `/`。 */
    function normalizePath(input) {
      const parts = String(input).split('/')
      const abs = parts.length > 0 && parts[0] === ''
      const out = []
      for (const part of parts) {
        if (part === '' || part === '.') continue
        if (part === '..') {
          if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
          else if (!abs) out.push('..')
          continue
        }
        out.push(part)
      }
      const body = out.join('/')
      return abs ? '/' + body : body
    }

    /** 把工具参数里的路径解析成绝对路径（`~` 展开，相对路径拼 cwd）。 */
    function absoluteOf(cwd, home, raw) {
      if (typeof raw !== 'string') return null
      let value = raw.trim().replace(/\\/g, '/')
      if (value === '') return null
      if (value === '~' || value.startsWith('~/')) {
        if (typeof home !== 'string' || home === '') return null
        value = home.replace(/\\/g, '/') + value.slice(1)
      }
      if (/^[a-zA-Z]:\//.test(value) || value.startsWith('/')) return normalizePath(value)
      if (typeof cwd !== 'string' || cwd === '') return null
      return normalizePath(cwd.replace(/\\/g, '/') + '/' + value)
    }

    /** 绝对路径 → 便于阅读的显示路径（cwd 相对、home 显示 `~`）。 */
    function displayPath(cwd, home, abs) {
      if (typeof abs !== 'string' || abs === '') return ''
      const root = typeof cwd === 'string' ? normalizePath(cwd) : ''
      if (root !== '' && root !== '/' && (abs === root || abs.startsWith(root + '/'))) {
        return abs.length > root.length ? abs.slice(root.length + 1) : abs.split('/').pop()
      }
      const userHome = typeof home === 'string' ? normalizePath(home) : ''
      if (userHome !== '' && abs.startsWith(userHome + '/')) return '~/' + abs.slice(userHome.length + 1)
      return abs
    }

    /** 显示路径拆成「目录 / 文件名」。 */
    /**
     * 文本按行切开：末尾那个换行不当成多出来的一行（Cursor 也不会画出空行）。
     * @param text - 原始文本
     * @returns 行数组
     */
    function linesOf(text) {
      const value = text === undefined || text === null ? '' : String(text)
      if (value === '') return ['']
      let body = value
      if (body.endsWith('\r\n')) body = body.slice(0, -2)
      else if (body.endsWith('\n')) body = body.slice(0, -1)
      return body.split('\n')
    }

    function splitPath(value) {
      if (typeof value !== 'string' || value === '') return { dir: '', base: '' }
      const index = value.lastIndexOf('/')
      if (index < 0) return { dir: '', base: value }
      return { dir: value.slice(0, index), base: value.slice(index + 1) }
    }

    /* ---------------------------------------------------------------- diff */

    /**
     * 行级 LCS 的中间段比较。
     * @param a - 旧行
     * @param b - 新行
     * @returns 操作序列 `{ t: 'eq' | 'del' | 'add', text }`
     */
    function lcsOps(a, b) {
      const n = a.length
      const m = b.length
      const width = m + 1
      const dp = new Int32Array((n + 1) * width)
      for (let i = n - 1; i >= 0; i -= 1) {
        const row = i * width
        const next = row + width
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[row + j] = a[i] === b[j]
            ? dp[next + j + 1] + 1
            : Math.max(dp[next + j], dp[row + j + 1])
        }
      }
      const ops = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          ops.push({ t: 'eq', text: a[i] })
          i += 1
          j += 1
        } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
          ops.push({ t: 'del', text: a[i] })
          i += 1
        } else {
          ops.push({ t: 'add', text: b[j] })
          j += 1
        }
      }
      while (i < n) { ops.push({ t: 'del', text: a[i] }); i += 1 }
      while (j < m) { ops.push({ t: 'add', text: b[j] }); j += 1 }
      return ops
    }

    /**
     * 两段文本的行级差异：先剥掉公共前后缀，再对中间段做 LCS。
     * @param oldText - 旧文本；null 表示纯新增（整段都是新行）
     * @param newText - 新文本
     * @returns 操作序列
     */
    function diffOps(oldText, newText) {
      const after = linesOf(newText)
      const before = oldText === undefined || oldText === null ? [] : linesOf(oldText)
      let start = 0
      while (start < before.length && start < after.length && before[start] === after[start]) start += 1
      let endBefore = before.length
      let endAfter = after.length
      while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
        endBefore -= 1
        endAfter -= 1
      }
      const ops = []
      for (let i = 0; i < start; i += 1) ops.push({ t: 'eq', text: before[i] })
      const middleBefore = before.slice(start, endBefore)
      const middleAfter = after.slice(start, endAfter)
      const cells = middleBefore.length * middleAfter.length
      if (middleBefore.length === 0) {
        for (const line of middleAfter) ops.push({ t: 'add', text: line })
      } else if (middleAfter.length === 0) {
        for (const line of middleBefore) ops.push({ t: 'del', text: line })
      } else if (cells <= MAX_LCS_CELLS) {
        for (const op of lcsOps(middleBefore, middleAfter)) ops.push(op)
      } else {
        for (const line of middleBefore) ops.push({ t: 'del', text: line })
        for (const line of middleAfter) ops.push({ t: 'add', text: line })
      }
      for (let i = endBefore; i < before.length; i += 1) ops.push({ t: 'eq', text: before[i] })
      return ops
    }

    /**
     * 在一段行数组里找 needle 这一整块连续出现的位置。
     * @param haystack - 文件行
     * @param needle - 要找的连续行
     * @param from - 从这里开始找
     * @returns 命中下标，找不到返回 -1
     */
    function findBlock(haystack, needle, from) {
      if (needle.length === 0) return -1
      const first = needle[0]
      const limit = Math.min(haystack.length, MAX_LOCATE_LINES) - needle.length
      for (let i = Math.max(0, from); i <= limit; i += 1) {
        if (haystack[i] !== first) continue
        let hit = true
        for (let k = 1; k < needle.length; k += 1) {
          if (haystack[i + k] !== needle[k]) { hit = false; break }
        }
        if (hit) return i
      }
      return -1
    }

    /**
     * 把操作序列变成带行号的行。
     * @param ops - 操作序列
     * @param newStart - hunk 第一行在新文件里的行号（1-based）；null 表示不知道
     * @returns 行对象数组
     */
    function buildRows(ops, newStart) {
      const known = typeof newStart === 'number' && newStart > 0
      let newNo = known ? newStart : 0
      let delta = 0
      const rows = []
      for (const op of ops) {
        if (op.t === 'eq') {
          rows.push({ kind: 'ctx', no: known ? newNo : null, text: op.text })
          if (known) newNo += 1
        } else if (op.t === 'add') {
          rows.push({ kind: 'add', no: known ? newNo : null, text: op.text })
          if (known) newNo += 1
          delta += 1
        } else {
          rows.push({ kind: 'del', no: known ? newNo - delta : null, text: op.text })
          delta -= 1
        }
      }
      return rows
    }

    /**
     * 在新文件里定位 hunk 的第一行。
     * 先拿整块新文本直接匹配；匹配不上（多是编辑还没落盘，或之后又被改过）再退到
     * 「用最长的一段未改动行当锚点」：锚点在文件里的位置减去它在块内前面有几行，
     * 就是这一块的第一行。
     * @param fileLines - 文件行
     * @param ops - 操作序列
     * @param after - 新块行
     * @param from - 从这里开始找
     * @returns 1-based 行号，找不到返回 null
     */
    function locateNewStart(fileLines, ops, after, from) {
      if (after.length === 0) return null
      const direct = findBlock(fileLines, after, from)
      if (direct >= 0) return direct + 1
      const runs = []
      let newIndex = 0
      let run = null
      for (const op of ops) {
        if (op.t === 'eq') {
          if (run === null) run = { at: newIndex, lines: [] }
          run.lines.push(op.text)
          newIndex += 1
        } else {
          if (run !== null) { runs.push(run); run = null }
          if (op.t === 'add') newIndex += 1
        }
      }
      if (run !== null) runs.push(run)
      runs.sort((a, b) => b.lines.length - a.lines.length)
      for (const candidate of runs) {
        if (candidate.lines.length > MAX_NEEDLE_LINES) continue
        const hit = findBlock(fileLines, candidate.lines, from)
        if (hit < 0) continue
        const start = hit + 1 - candidate.at
        if (start > 0) return start
      }
      return null
    }

    /**
     * 头尾各留少量上下文，中间的整段不变行去掉（Cursor 式紧凑 diff）。
     * @param rows - 行数组
     * @returns 裁剪后的行数组
     */
    function trimContext(rows) {
      if (rows.length === 0) return rows
      let head = 0
      while (head < rows.length && rows[head].kind === 'ctx') head += 1
      let tail = rows.length
      while (tail > head && rows[tail - 1].kind === 'ctx') tail -= 1
      const skipHead = Math.max(0, head - HEAD_CONTEXT)
      const skipTail = Math.max(0, (rows.length - tail) - TAIL_CONTEXT)
      if (skipHead === 0 && skipTail === 0) return rows
      return rows.slice(skipHead, rows.length - skipTail)
    }

    /* ---------------------------------------------------------- 文件文本 */

    /** 文件文本缓存：绝对路径 → { text, at }。 */
    const fileCache = new Map()

    /** 缓存命中就直接返回。 */
    function cachedText(path) {
      const hit = fileCache.get(path)
      if (hit === undefined) return null
      if (Date.now() - hit.at > FILE_CACHE_TTL) {
        fileCache.delete(path)
        return null
      }
      return hit.text
    }

    /**
     * 拉一份文件文本（带缓存）；失败返回 null，卡片照常渲染，只是没有行号。
     * @param path - 绝对路径
     * @returns 文件文本或 null
     */
    async function readFileText(path) {
      const hit = cachedText(path)
      if (hit !== null) return hit
      try {
        const response = await fetch('/edit-diff/file?path=' + encodeURIComponent(path), {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return null
        const body = await response.json()
        if (body === null || typeof body !== 'object' || body.ok !== true) return null
        if (typeof body.text !== 'string') return null
        fileCache.set(path, { text: body.text, at: Date.now() })
        while (fileCache.size > FILE_CACHE_MAX) {
          const oldest = fileCache.keys().next()
          if (oldest.done) break
          fileCache.delete(oldest.value)
        }
        return body.text
      } catch (error) {
        return null
      }
    }

    /**
     * 按需拉取一批文件文本。
     * @param paths - 绝对路径数组
     * @param enabled - false 时不发请求
     * @returns 当前可用的文本表（未就绪时为空对象）
     */
    function useFileTexts(paths, enabled) {
      const key = enabled && paths.length > 0 ? paths.join('\u0001') : ''
      const [snapshot, setSnapshot] = useState({ key: '', texts: {} })
      useEffect(() => {
        if (key === '') return undefined
        let alive = true
        const list = key.split('\u0001')
        const texts = {}
        let remaining = list.length
        for (const path of list) {
          readFileText(path).then((text) => {
            remaining -= 1
            if (text !== null) texts[path] = text
            if (!alive) return
            if (remaining === 0) setSnapshot({ key, texts })
          })
        }
        return () => { alive = false }
      }, [key])
      return snapshot.key === key ? snapshot.texts : {}
    }

    /* ---------------------------------------------------------------- 模型 */

    /**
     * 参数读取器：结果阶段若调用已滑出窗口，退回 `call.argsRaw` 的解析值。
     * @param block - 工具块
     * @returns `(key) => string | undefined`
     */
    function argumentReader(block) {
      const args = block && block.args
      let parsed = null
      if (block && block.kind === 'tool-result' && block.call && typeof block.call.argsRaw === 'string') {
        try {
          const value = JSON.parse(block.call.argsRaw)
          if (value !== null && typeof value === 'object') parsed = value
        } catch (error) {
          parsed = null
        }
      }
      return (key) => {
        if (parsed !== null && typeof parsed[key] === 'string') return parsed[key]
        if (args && typeof args.text === 'function') {
          try {
            const value = args.text(key)
            if (typeof value === 'string') return value
          } catch (error) {
            return undefined
          }
        }
        return undefined
      }
    }

    /** 结果元数据里的 diffs 是否合法。 */
    function narrowDiffs(value) {
      if (!Array.isArray(value) || value.length === 0) return null
      const out = []
      for (const hunk of value) {
        if (hunk === null || typeof hunk !== 'object') return null
        const path = hunk.path
        const oldText = hunk.oldText
        const newText = hunk.newText
        if (typeof path !== 'string') return null
        if (oldText !== null && typeof oldText !== 'string') return null
        if (typeof newText !== 'string') return null
        out.push({ path, oldText, newText })
      }
      return out
    }

    /** 未落地时按参数推出来的意图 diff。 */
    function intentDiffs(toolName, read) {
      if (toolName === 'write') {
        const path = read('file_path') || read('path')
        const content = read('content')
        if (typeof path !== 'string' || typeof content !== 'string') return []
        return [{ path, oldText: null, newText: content }]
      }
      if (toolName === 'edit') {
        const path = read('file_path') || read('path')
        const oldText = read('old_string')
        const newText = read('new_string')
        if (typeof path !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string') return []
        return [{ path, oldText: oldText === '' ? null : oldText, newText }]
      }
      if (toolName === 'str_replace_editor') {
        const path = read('path')
        if (typeof path !== 'string') return []
        const command = read('command')
        if (command === 'create') {
          const fileText = read('file_text')
          return [{ path, oldText: null, newText: typeof fileText === 'string' ? fileText : '' }]
        }
        if (command === 'str_replace') {
          const oldText = read('old_str')
          const newText = read('new_str')
          if (typeof oldText !== 'string' || typeof newText !== 'string') return []
          return [{ path, oldText: oldText === '' ? null : oldText, newText }]
        }
      }
      return []
    }

    /** 结果文本里第一行有内容的错误信息。 */
    function firstErrorLine(block) {
      const content = block && block.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part === null || typeof part !== 'object') continue
          if (part.type !== 'text' || typeof part.text !== 'string') continue
          const line = part.text.split('\n').find((item) => item.trim() !== '')
          if (line !== undefined) return line.trim()
        }
      }
      const error = block && block.error
      if (error !== null && typeof error === 'object' && typeof error.reason === 'string' && error.reason !== '') {
        return error.reason
      }
      return null
    }

    /** 标题动词。 */
    function verbOf(toolName, operation) {
      if (toolName === 'edit' || toolName === 'str_replace_editor') return '编辑'
      if (toolName === 'write') return operation === 'create' ? '新建' : '写入'
      if (toolName === 'apply_patch') return '修改'
      return '写入'
    }

    /**
     * 卡片模型：状态、文件分组、hunk 行。
     * @param toolName - 工具名
     * @param block - 工具块
     * @param cwd - 会话工作目录
     * @param home - 用户 home
     * @returns 渲染所需的数据
     */
    function buildModel(toolName, block, cwd, home) {
      const settled = block !== null && typeof block === 'object' && block.kind === 'tool-result'
      const isError = settled && block.isError === true
      const stopped = settled && block.meta !== null && typeof block.meta === 'object' && block.meta.stopped === true
      const read = argumentReader(block)
      const meta = settled ? block.meta : null
      const operation = meta !== null && typeof meta === 'object' && typeof meta.operation === 'string' ? meta.operation : undefined

      let hunks = []
      let source = 'intent'
      if (settled && !isError) {
        const applied = narrowDiffs(meta !== null && typeof meta === 'object' ? meta.diffs : null)
        if (applied !== null) {
          hunks = applied
          source = 'applied'
        }
      }
      if (hunks.length === 0) {
        const intent = intentDiffs(toolName, read)
        if (intent.length > 0) hunks = intent
      }

      const state = !settled ? 'running' : stopped ? 'stopped' : isError ? 'error' : 'ok'
      const files = []
      const index = new Map()
      for (const hunk of hunks) {
        const abs = absoluteOf(cwd, home, hunk.path)
        const key = abs !== null ? abs : hunk.path
        let entry = index.get(key)
        if (entry === undefined) {
          const display = abs !== null ? displayPath(cwd, home, abs) : String(hunk.path)
          entry = { key, abs, display, hunks: [], added: 0, removed: 0, rows: [] }
          index.set(key, entry)
          files.push(entry)
        }
        entry.hunks.push(hunk)
      }

      return {
        settled,
        state,
        isError,
        operation,
        source,
        files,
        errorText: state === 'error' ? firstErrorLine(block) : null,
      }
    }

    /**
     * 给每个 hunk 算出带行号的行（需要文件文本；拿不到就只给相对结构）。
     * @param files - buildModel 的文件分组
     * @param texts - 绝对路径 → 文件文本
     * @returns 每个文件的行与计数
     */
    function layoutFiles(files, texts) {
      const out = []
      for (const file of files) {
        const text = file.abs !== null && texts !== null ? texts[file.abs] : undefined
        const fileLines = typeof text === 'string' ? text.split('\n') : null
        let cursor = 0
        let added = 0
        let removed = 0
        const blocks = []
        for (const hunk of file.hunks) {
          const before = hunk.oldText === null ? [] : linesOf(hunk.oldText)
          const after = linesOf(hunk.newText)
          const ops = diffOps(hunk.oldText, hunk.newText)
          let newStart = null
          if (fileLines !== null) {
            newStart = locateNewStart(fileLines, ops, after, cursor)
            if (newStart === null && before.length > 0 && before.length <= MAX_NEEDLE_LINES) {
              const at = findBlock(fileLines, before, cursor)
              if (at >= 0) newStart = at + 1
            }
            if (newStart !== null) cursor = newStart - 1 + after.length
          }
          for (const op of ops) {
            if (op.t === 'add') added += 1
            else if (op.t === 'del') removed += 1
          }
          const rows = trimContext(buildRows(ops, newStart))
          let focus = null
          for (const row of rows) {
            if (row.kind === 'add' && typeof row.no === 'number') { focus = row.no; break }
          }
          if (focus === null) {
            for (const row of rows) {
              if (row.kind === 'del' && typeof row.no === 'number') { focus = row.no; break }
            }
          }
          let focusEnd = focus
          for (const row of rows) {
            if (typeof row.no === 'number' && (row.kind === 'add' || row.kind === 'del')) focusEnd = Math.max(focusEnd === null ? 0 : focusEnd, row.no)
          }
          blocks.push({ rows, focus, focusEnd, beforeLines: before.length, afterLines: after.length })
          void before
        }
        out.push({
          key: file.key,
          abs: file.abs,
          display: file.display,
          added,
          removed,
          blocks,
        })
      }
      return out
    }

    /* -------------------------------------------------------------- 交互 */

    /**
     * 打开文件：优先请 dsh-cursor-layout 切到 IDE 视图并开在编辑区，失败就退回官方 openFile。
     * @param detail - { abs, raw, line, focusDiff }
     * @param openFile - 聊天层给的 openFile
     * @param sessionId - 当前会话
     */
    function revealFile(detail, openFile, sessionId) {
      const target = detail.abs !== null ? detail.abs : detail.raw
      if (typeof target !== 'string' || target === '') return
      const bridge = typeof window !== 'undefined' ? window.__dshCursorLayout : null
      ping('reveal', {
        target: String(target),
        line: String(detail.line),
        hasBridge: typeof bridge === 'object' && bridge !== null ? 'yes' : 'no',
      })
      if (bridge !== null && typeof bridge === 'object' && typeof bridge.reveal === 'function') {
        try {
          const handled = bridge.reveal({
            path: target,
            line: detail.line,
            endLine: detail.endLine,
            focusDiff: detail.line === null || detail.line === undefined ? detail.focusDiff !== false : false,
            sessionId,
          })
          ping('reveal-result', { handled: String(handled) })
          if (handled !== false) return
        } catch (error) {
          /* 桥接坏了就退回官方路径 */
        }
      }
      if (typeof openFile !== 'function') return
      try {
        openFile(target, typeof detail.line === 'number' ? { line: detail.line } : undefined)
      } catch (error) {
        /* 打开失败时不打断对话 */
      }
    }

    /* -------------------------------------------------------------- 组件 */

    /** 一个文件区块（多文件卡片里每个文件一层）。 */
    function FileSection({ file, shared, openFile, sessionId, rawOf }) {
      const [expanded, setExpanded] = useState(false)
      const blocks = file.blocks
      const total = blocks.reduce((sum, block) => sum + block.rows.length, 0)
      const over = total > MAX_ROWS
      const raw = rawOf(file.key)
      const jump = (() => {
        for (const block of blocks) {
          if (typeof block.focus === 'number') return block.focus
        }
        return null
      })()
      const jumpEnd = (() => {
        for (const block of blocks) {
          if (typeof block.focus === 'number') return typeof block.focusEnd === 'number' ? block.focusEnd : block.focus
        }
        return null
      })()

      let remaining = over && !expanded ? MAX_ROWS : Number.POSITIVE_INFINITY
      const visible = []
      for (const block of blocks) {
        for (const row of block.rows) {
          if (remaining <= 0) break
          visible.push({ row, shared })
          remaining -= 1
        }
        if (remaining <= 0) break
      }

      return h('div', { className: 'dsh-edit-diff-sec' },
        shared
          ? null
          : h('div',
            {
              className: 'dsh-edit-diff-secbar',
              role: 'button',
              tabIndex: 0,
              title: file.abs !== null ? file.abs : file.display,
              onClick: () => revealFile({ abs: file.abs, raw, line: jump, endLine: jumpEnd }, openFile, sessionId),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  revealFile({ abs: file.abs, raw, line: jump, endLine: jumpEnd }, openFile, sessionId)
                }
              },
            },
            h('span', { className: 'dsh-edit-diff-file' }, splitPath(file.display).base),
            h('span', { className: 'dsh-edit-diff-dir' }, splitPath(file.display).dir),
            h('span', { className: 'dsh-edit-diff-stats' },
              file.added > 0 ? h('span', { className: 'dsh-edit-diff-add' }, '+' + file.added) : null,
              file.removed > 0 ? h('span', { className: 'dsh-edit-diff-del' }, '\u2212' + file.removed) : null,
            ),
          ),
        h('div', { className: 'dsh-edit-diff-box', 'data-more': over && !expanded ? '1' : '0' },
          visible.map((item, index) => h('div', {
            key: index,
            className: 'dsh-edit-diff-line',
            'data-kind': item.row.kind === 'ctx' ? 'ctx' : item.row.kind,
          },
          h('span', {
            className: 'dsh-edit-diff-no',
            'data-empty': typeof item.row.no === 'number' ? '0' : '1',
          }, typeof item.row.no === 'number' ? String(item.row.no) : ''),
          h('span', { className: 'dsh-edit-diff-sign' },
            item.row.kind === 'add' ? '+' : item.row.kind === 'del' ? '-' : ''),
          h('span', {
            className: 'dsh-edit-diff-text',
            'data-empty': item.row.text === '' ? '1' : '0',
          }, item.row.text),
          )),
        ),
        over
          ? h('button', {
            type: 'button',
            className: 'dsh-edit-diff-more',
            onClick: (event) => { event.stopPropagation(); setExpanded((value) => !value) },
          }, expanded ? '收起' : '展开全部 ' + total + ' 行')
          : null,
      )
    }

    /** 工具行本体。 */
    function EditDiffRow(props) {
      const { toolName, block, cwd, home, openFile, sessionId } = props
      const model = useMemo(() => buildModel(toolName, block, cwd, home), [toolName, block, cwd, home])
      const paths = useMemo(() => model.files.map((file) => file.abs).filter((value) => value !== null), [model])
      const texts = useFileTexts(paths, paths.length > 0)
      const files = useMemo(() => layoutFiles(model.files, texts), [model, texts])
      const [expandedAll, setExpandedAll] = useState(false)

      const rawByKey = useMemo(() => {
        const map = new Map()
        for (const file of model.files) {
          for (const hunk of file.hunks) {
            if (!map.has(file.key)) map.set(file.key, hunk.path)
          }
        }
        return map
      }, [model])

      const totalAdded = files.reduce((sum, file) => sum + file.added, 0)
      const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0)
      const multi = files.length > 1
      const single = files.length === 1 ? files[0] : null
      const verb = verbOf(toolName, model.operation)

      const headText = multi
        ? files.length + ' 个文件'
        : single !== null ? splitPath(single.display).base : ''
      const headDir = multi || single === null ? '' : splitPath(single.display).dir
      const headJump = (() => {
        for (const file of files) {
          for (const block of file.blocks) {
            if (typeof block.focus === 'number') return { file, line: block.focus }
          }
        }
        return files.length > 0 ? { file: files[0], line: null } : null
      })()

      const openHead = () => {
        if (headJump === null) return
        revealFile({
          abs: headJump.file.abs,
          raw: rawByKey.get(headJump.file.key),
          line: headJump.line,
        }, openFile, sessionId)
      }

      const blocksTotal = files.reduce(
        (sum, file) => sum + file.blocks.reduce((inner, block) => inner + block.rows.length, 0), 0)
      const overAll = multi && blocksTotal > MAX_ROWS * 2 && !expandedAll
      const shown = overAll ? files.slice(0, 3) : files

      return h('div', { className: 'dsh-edit-diff', 'data-state': model.state },
        h('div',
          {
            className: 'dsh-edit-diff-head',
            role: 'button',
            tabIndex: 0,
            title: headJump !== null && headJump.file.abs !== null ? headJump.file.abs : undefined,
            onClick: openHead,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openHead()
              }
            },
          },
          h('span', { className: 'dsh-edit-diff-ico', 'aria-hidden': 'true' }, pencilIcon()),
          h('span', { className: 'dsh-edit-diff-verb' }, verb),
          h('span', { className: 'dsh-edit-diff-file' }, headText),
          headDir !== '' ? h('span', { className: 'dsh-edit-diff-dir' }, headDir) : null,
          h('span', { className: 'dsh-edit-diff-stats' },
            totalAdded > 0
              ? h('span', { className: 'dsh-edit-diff-add' }, '+' + totalAdded)
              : null,
            totalRemoved > 0
              ? h('span', { className: 'dsh-edit-diff-del' }, '\u2212' + totalRemoved)
              : null,
            totalAdded === 0 && totalRemoved === 0
              ? h('span', { className: 'dsh-edit-diff-zero' }, model.state === 'running' ? '' : '无改动')
              : null,
          ),
        ),
        model.errorText !== null
          ? h('div', { className: 'dsh-edit-diff-error' }, model.errorText)
          : null,
        model.state === 'running' && blocksTotal === 0
          ? h('div', { className: 'dsh-edit-diff-pending' },
            h('span', { className: 'dsh-edit-diff-pending-dot', 'aria-hidden': 'true' }),
            toolName === 'edit' ? '正在编辑…' : '正在写入…',
          )
          : null,
        shown.map((file) => h(FileSection, {
          key: file.key,
          file,
          shared: multi === false,
          openFile,
          sessionId,
          rawOf: (key) => rawByKey.get(key),
        })),
        overAll
          ? h('button', {
            type: 'button',
            className: 'dsh-edit-diff-more',
            onClick: (event) => { event.stopPropagation(); setExpandedAll(true) },
          }, '展开其余 ' + (files.length - shown.length) + ' 个文件')
          : null,
      )
    }

    /** 14px 铅笔图标（和内置文件改动行同一个体量）。 */
    function pencilIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        focusable: 'false',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M11.2 2.3l2.5 2.5-8.1 8.1-3.2.7.7-3.2 8.1-8.1z' }),
        h('path', { d: 'M9.6 3.9l2.5 2.5' }),
      )
    }

    /** Plugin apply：占住三个 keyed toolview。 */
    /**
     * 往宿主半打一行诊断（成功与否都不影响界面）。
     * @param event - 事件名
     * @param extra - 附加字段
     */
    function ping(event, extra) {
      try {
        const params = new URLSearchParams({ event, at: String(Date.now()) })
        if (extra !== undefined && extra !== null) {
          for (const [key, value] of Object.entries(extra)) params.set(key, String(value))
        }
        void fetch('/edit-diff/ping?' + params.toString()).catch(() => {})
      } catch (error) {
        /* 诊断失败不影响卡片 */
      }
    }

    function apply(ctx) {
      ensureStyle()
      ping('apply', { version: '0.1.0' })
      ctx.effect(() => {
        let dispose = null
        let mountCount = 0
        const mount = () => {
          mountCount += 1
          if (dispose !== null) {
            try { dispose() } catch (error) { /* 座位可能已卸载 */ }
            dispose = null
          }
          try {
            if (ctx === null || ctx === undefined || ctx.slots === undefined) {
              ping('mount-error', { reason: 'no-slots' })
              return
            }
            dispose = ctx.slots.inject('tool.call.toolview', function* register() {
              for (const key of ['edit', 'write', 'apply_patch']) {
                // keyed 座位同优先级会报「already has an entry」，内置行在 0，得用更小的数字把它盖掉
                // （运行时规则：priority 越小越优先渲染）。
                yield ctx.slots.register({ name: 'tool.call.toolview', key, priority: -10 }, EditDiffRow)
              }
            })
            ping('mount-ok', { attempt: mountCount })
          } catch (error) {
            ping('mount-error', { reason: String((error && error.message) || error).slice(0, 160) })
          }
        }
        mount()
        // keyed 座位是「后注册的覆盖先注册的」，内置行有可能比我们晚一步落座，补两次确保最后是我们。
        const timers = [1200, 4000].map((delay) => window.setTimeout(mount, delay))
        return () => {
          for (const timer of timers) window.clearTimeout(timer)
          try { dispose() } catch (error) { /* 座位可能已卸载 */ }
        }
      }, 'edit-diff: file mutation rows')

      if (typeof window !== 'undefined') {
        window.__dshEditDiff = { version: '0.1.0', debug: { diffOps, findBlock, buildRows, trimContext, linesOf, layoutFiles, buildModel } }
      }
      for (const delay of [1200, 4000, 9000]) {
        window.setTimeout(() => ping('tick', { delay, style: document.getElementById(STYLE_ID) !== null }), delay)
      }
    }

    return {
      inject: ['slots'],
      apply,
    }
  },
})
