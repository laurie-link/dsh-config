/**
 * dsh-compaction-retry — Client half.
 *
 * 在对话输入框上方（`conversation.input.dock` 座位）显示一条 Codex 式的压缩状态：
 *   「正在压缩上下文…」——压缩期间（含自动压力压缩、切模型前的压缩、`/compact`）
 *   永远有提示，不再是"界面没反应"。
 *   重试等待期间追加「上游限流，第 N 次重试（约 Xs 后继续）」；切模型前的压缩追加
 *   「切换 xxx 前的准备」；超过 2 秒追加「已用 Ns」。
 *
 * 数据来自 Host 半的 loopback 路由 `GET /compaction-retry/status`（约 600ms 轮询一次，
 * 页面隐藏时跳过），状态按当前会话过滤（dock 的 props 自带 sessionId）。
 *
 * @author DSH local maintenance 2026-11-07
 */
window.__ModuleLoader__.load({
  id: 'dsh-compaction-retry',
  factory(require) {
    const React = require('react')

    /** `<style>` 标记，热重载时不重复插入。 */
    const STYLE_ID = 'dsh-compaction-retry/style'
    /** 轮询间隔（毫秒）。 */
    const POLL_MS = 600

    const CSS = `
.dsh-compaction-retry-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 2px 6px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-size: var(--dsh-content-font-size-secondary, 12px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
  user-select: none;
}
.dsh-compaction-retry-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  opacity: .75;
  animation: dsh-compaction-retry-pulse 1.1s ease-in-out infinite;
}
.dsh-compaction-retry-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-compaction-retry-retry {
  color: var(--dsw-alias-label-secondary, #b7bcc5);
}
@keyframes dsh-compaction-retry-pulse {
  0%, 100% { opacity: .25; transform: scale(.75); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-compaction-retry-dot { animation: none; opacity: .75; }
}
`

    /** 产品根 URL（桌面端是 dsh-app://，浏览器是同源）。 */
    function statusUrl() {
      try {
        return new URL('compaction-retry/status', new URL('.', document.baseURI)).href
      } catch (error) {
        return '/compaction-retry/status'
      }
    }

    /** 注入样式（幂等）。 */
    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.dataset.plugin = 'dsh-compaction-retry'
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (error) { /* 样式失败不影响功能 */ }
    }

    /** provider/model → 人读的模型名（只取 model 段）。 */
    function shortModel(value) {
      const text = String(value || '')
      const slash = text.lastIndexOf('/')
      return slash >= 0 ? text.slice(slash + 1) : text
    }

    /** 秒数 → "12s" / "1m05s"。 */
    function formatElapsed(seconds) {
      if (seconds < 60) return seconds + 's'
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      return minutes + 'm' + (rest < 10 ? '0' + rest : String(rest)) + 's'
    }

    /**
     * 输入框上方的压缩状态行。
     * @param props - dock 座位传入的 props（含 sessionId）
     */
    function CompactionStatusRow(props) {
      const sessionId = props !== null && props !== undefined && typeof props.sessionId === 'string' ? props.sessionId : ''
      const [entry, setEntry] = React.useState(null)
      const [now, setNow] = React.useState(() => Date.now())

      React.useEffect(() => {
        let alive = true
        let timer = 0
        const poll = () => {
          if (!alive) return
          if (typeof document !== 'undefined' && document.hidden === true) return
          let request
          try {
            request = fetch(statusUrl(), { cache: 'no-store', credentials: 'same-origin' })
          } catch (error) { return }
          request
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => {
              if (!alive) return
              const sessions = data !== null && data !== undefined && data.sessions !== null && typeof data.sessions === 'object' ? data.sessions : null
              const next = sessions !== null && sessionId !== '' && sessions[sessionId] !== undefined ? sessions[sessionId] : null
              setEntry(next)
            })
            .catch(() => { if (alive) setEntry(null) })
        }
        poll()
        timer = window.setInterval(poll, POLL_MS)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [sessionId])

      // 可见时有 1s tick：已用时间 / 重试倒计时都能动。
      React.useEffect(() => {
        if (entry === null) return undefined
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [entry])

      if (entry === null) return null

      const paused = entry.retry !== null && entry.retry !== undefined
      const startedAt = typeof entry.startedAt === 'number' ? entry.startedAt : now
      const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
      const switchInfo = entry.switch !== null && entry.switch !== undefined ? entry.switch : null
      const retry = paused ? entry.retry : null

      let text = '正在压缩上下文…'
      const facts = []
      if (switchInfo !== null && typeof switchInfo.to === 'string' && switchInfo.to !== '') {
        facts.push('切换 ' + shortModel(switchInfo.to) + ' 前的准备')
      }
      if (elapsedSeconds >= 2) facts.push('已用 ' + formatElapsed(elapsedSeconds))
      if (retry !== null) {
        const untilAt = typeof retry.untilAt === 'number' ? retry.untilAt : 0
        const leftSeconds = untilAt > 0 ? Math.max(0, Math.ceil((untilAt - now) / 1000)) : 0
        const cause = retry.status === 429 || retry.code === 'RATE_LIMIT' ? '限流' : '繁忙'
        const attempt = typeof retry.attempt === 'number' ? retry.attempt : 1
        facts.push('上游' + cause + '，第 ' + attempt + ' 次重试' + (leftSeconds > 0 ? '（约 ' + leftSeconds + 's 后继续）' : '中'))
      }
      const detail = facts.length > 0 ? ' ' + facts.join(' · ') : ''
      const title = paused
        ? '压缩请求被上游限流，正在按普通请求的重试策略重试（策略见 dsh-compaction-retry）'
        : 'DSH 正在压缩会话历史，完成后继续'

      return React.createElement(
        'div',
        { className: 'dsh-compaction-retry-row', title, role: 'status', 'aria-live': 'polite' },
        React.createElement('span', { className: 'dsh-compaction-retry-dot', 'aria-hidden': 'true' }),
        React.createElement(
          'span',
          { className: 'dsh-compaction-retry-text' },
          text,
          React.createElement('span', { className: 'dsh-compaction-retry-retry' }, detail),
        ),
      )
    }

    /** Plugin apply：注册状态行，并在卸载时移除。 */
    function apply(ctx) {
      ensureStyle()
      try { void fetch('/edit-diff/ping?event=probe-compaction-apply') } catch (error) { /* probe */ }
      ctx.effect(() => {
        const dispose = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'compaction-retry-status',
          order: 15,
        }, CompactionStatusRow))
        return () => {
          try { dispose() } catch (error) { /* 座位可能已卸载 */ }
        }
      }, 'compaction-retry: compaction status row')
    }

    return {
      inject: ['slots'],
      apply,
    }
  },
})
