/**
 * dsh-vscode-mode client — 编辑器内 HTML 渲染预览面板。
 *
 * 需求（2026-11-04）：本地 `.html` 文件要能像浏览器那样看渲染结果，而不是只有 Monaco 源码。
 *
 * 实现要点：
 * - 渲染用 `<iframe>` 指向 host 起的 loopback 只读静态服务（`edrv.htmlPreview` 返回地址），
 *   不是 `srcdoc`、也不做相对路径重写：`../assets/x.css`、`/images/x.png`、`fetch('./a.json')`
 *   全部按真实浏览器语义解析，静态站（PoKeep 这类）才能完整渲染。
 * - 服务与 DSH 页面同机不同端口 = 不同源：预览页拿不到宿主 DOM 与凭据，同时页面脚本、
 *   localStorage、外链 CDN 都按正常网页运行（这不是「安全沙箱」，是浏览器级隔离）。
 * - 刷新策略：保存 / 外部改动由 EditorView 通过 `reloadToken` 自增触发（iframe key 变化即重载，
 *   再用 `?v=` 绕开浏览器内存缓存）；工具条另有手动 ⟳ 与「以源码打开」。
 *
 * 与既有 Markdown 预览面板形态保持一致：工具条 + 内容区；本面板只读，不参与脏标记。
 * 作者 ddj 2026年11月04号
 */
import React from 'react'
import { rpc } from '../rpc.js'
import { siteUrlOf } from '../../shared/htmlPreview.js'
import type { HtmlSiteInfo } from '../../shared/htmlPreview.js'

/** 预览面板 props（面板由 EditorView 装配，形状保持宽松避免跨文件类型耦合）。 */
interface HtmlPanelProps {
  /** 磁盘路径（工作区相对或绝对，交给 host 解析）。 */
  path: string
  /** 会话 id（host 用它定位工作区根目录）。 */
  sessionId: string
  /** 外部触发重载的计数：保存成功 / 磁盘被外部改动时由 EditorView 自增。 */
  reloadToken?: number
  /** 切回源码编辑（工具条按钮）。 */
  onToggleSource?: () => void
}

/** iframe 允许的能力：预览目的是「像浏览器一样」，因此放行脚本、表单、弹窗与下载。 */
const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-popups-to-escape-sandbox'

/**
 * HTML 渲染预览面板。
 * @author ddj 2026年11月04号
 * @param props 面板输入（路径、会话、重载计数与切回源码回调）
 * @returns 预览面板元素
 */
export function HtmlPanel(props: HtmlPanelProps) {
  const path = String(props?.path ?? '')
  const sessionId = String(props?.sessionId ?? '')
  const reloadToken = Number(props?.reloadToken ?? 0)
  const onToggleSource = props?.onToggleSource
  const [site, setSite] = React.useState<HtmlSiteInfo | null>(null)
  const [sitePath, setSitePath] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [localReload, setLocalReload] = React.useState(0)

  // 站点地址只在「换了文件」或手动刷新时重新解析；保存/外部改动只换版本号，省一次 RPC。
  React.useEffect(() => {
    if (!path) return undefined
    let alive = true
    setLoading(site === null || sitePath !== path)
    setError(null)
    rpc('edrv.htmlPreview', { sessionId, path }).then((result) => {
      if (!alive) return
      if (result?.ok) { setSite(result.site); setSitePath(path); setError(null) } else { setSite(null); setSitePath(''); setError(result?.error || '无法建立 HTML 预览服务') }
    }).catch((failure) => {
      if (!alive) return
      setSite(null)
      setSitePath('')
      setError(failure?.message ? String(failure.message) : String(failure))
    }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // site/sitePath 参与判定但不作为依赖：只在 path/session/手动刷新变化时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, sessionId, localReload])

  const version = reloadToken + localReload
  const src = site ? siteUrlOf(site.port, site.rel, version) : ''
  const hostLabel = site ? '127.0.0.1:' + String(site.port) : ''

  /** @private @author ddj 2026年11月04号 Re-establish the site and force one reload. */
  function reload() { setLocalReload((count) => count + 1) }

  const status = error
    ? '预览不可用：' + error
    : loading
      ? '正在建立渲染预览…'
      : '渲染预览 · ' + hostLabel + ' · 保存后自动刷新'

  const body = error
    ? React.createElement('div', { className: 'edrv-htmlview-fallback' },
        React.createElement('div', { className: 'edrv-htmlview-fallback-title' }, '无法渲染该 HTML 页面'),
        React.createElement('div', null, error),
        React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: reload }, '⟳ 重试'))
    : src
      ? React.createElement('iframe', {
          key: src,
          className: 'edrv-htmlview-frame',
          src,
          title: 'HTML 渲染预览',
          sandbox: FRAME_SANDBOX,
          referrerPolicy: 'no-referrer',
          allow: 'clipboard-read; clipboard-write; fullscreen',
        })
      : React.createElement('div', { className: 'edrv-htmlview-fallback' }, status)

  return React.createElement('div', { className: 'edrv-htmlview' },
    React.createElement('div', { className: 'edrv-htmlview-bar' },
      React.createElement('span', { className: 'edrv-htmlview-meta', title: site ? site.root : undefined }, status),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost', title: '重新解析地址并刷新预览',
        onClick: reload,
      }, '⟳ 刷新'),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost', title: '切回源码编辑',
        onClick: () => onToggleSource?.(),
      }, '以源码打开')),
    React.createElement('div', { className: 'edrv-htmlview-stage' }, body))
}
