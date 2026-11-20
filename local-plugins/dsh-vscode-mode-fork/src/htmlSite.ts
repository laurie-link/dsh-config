/**
 * dsh-vscode-mode host — 编辑器内 HTML 渲染预览的只读静态站点服务。
 *
 * 背景：Monaco 只能显示 HTML 源码，官方渲染器不认领 `.html`。本模块在 `127.0.0.1`
 * 的随机端口起一个只读静态服务、根目录 = 会话工作区，client 用 `<iframe>` 直接加载
 * `http://127.0.0.1:<port>/<相对路径>`：
 *  - 同机不同端口 = 不同源，预览页拿不到 DSH 页面 DOM 与凭据；
 *  - `/images/x.png`、`../assets/x.css`、`fetch('./a.json')` 全部按真实浏览器语义解析，
 *    这是相对路径重写 / 自定义协议方案做不到的。
 *
 * 设计取舍：
 *  - 每个站点根目录只起一个服务（`Map<root, Promise<...>>`）：并发 ensure 幂等，卸载时统一回收；
 *  - 只读 + `cache-control: no-store`：预览必须反映最新磁盘内容，服务端不缓存、不写盘；
 *  - 先 realpath 再判定归属：符号链接逃逸（指向根目录外）一律 403，绝不把根目录外内容当资源；
 *  - 任何请求处理异常收敛成 500 文本，单次坏请求绝不崩掉 host 进程。
 *
 * 作者 ddj 2026-11-04
 */
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { log } from './log.js'
import type { HtmlSiteInfo } from './shared/htmlPreview.js'
import { htmlSiteMime, normalizeSlashes, siteRootOf, siteUrlOf } from './shared/htmlPreview.js'

/** 站点服务监听地址：只绑回环，绝不暴露到局域网。 */
const SITE_HOST = '127.0.0.1'
/** 目录请求的默认页面（`/sub/` 与 `/sub` 都回落到它）。 */
const INDEX_FILE = 'index.html'
/** 请求方法白名单：只读预览不需要任何写方法。 */
const SITE_METHODS = 'GET, HEAD'

/** 一个已建立的站点服务（端口 + 服务实例）。 */
interface HtmlSiteServer {
  /** 系统分配的监听端口。 */
  port: number
  /** 静态服务实例。 */
  server: Server
}

/** 站点目标解析结果：命中文件 / 越界（403） / 不存在（404）。 */
type SiteTarget = { kind: 'file'; path: string; size: number } | { kind: 'forbidden' } | { kind: 'missing' }

/** 站点根目录 → 服务 Promise（Promise 让并发 ensure 共享同一次 listen）。 */
const sites = new Map<string, Promise<HtmlSiteServer>>()

/**
 * 判定目标路径是否仍在站点根目录内（realpath 之后比较，符号链接逃逸也拦得住）。
 * @author ddj 2026年11月04号
 * @param root 站点根目录（已 realpath）
 * @param target 待判定目标（已 realpath）
 * @returns 目标为 root 的后代时为 true（root 本身与越界路径均为 false）
 */
function insideSiteRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/**
 * 把请求 URL 解成根目录内相对文件路径（忽略 query，`?v=` 只用于绕过浏览器缓存）。
 * @author ddj 2026年11月04号
 * @param rawUrl 原始 `req.url`
 * @returns 成功返回根目录内相对路径（`/` 分隔）；失败返回状态码与中文错误文案
 */
function decodeRequestPath(rawUrl: string | undefined): { rel: string } | { status: number; err: string } {
  let pathname: string
  try {
    pathname = new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return { status: 400, err: '请求路径无法解析' }
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { status: 400, err: '请求路径编码非法' }
  }
  if (decoded.includes('\0')) return { status: 400, err: '请求路径非法' }
  const rel = normalizeSlashes(decoded).replace(/^\/+/, '')
  // 以 / 结尾（含根路径 /）即目录请求：补默认页；不带斜杠的目录交给 resolveSiteTarget 回落
  return { rel: rel.endsWith('/') || rel === '' ? rel + INDEX_FILE : rel }
}

/**
 * 解析站点内请求路径：realpath → 归属判定 → 目录回落 index.html。
 * @author ddj 2026年11月04号
 * @param root 站点根目录（已 realpath）
 * @param relPath 根目录内相对路径
 * @returns 命中文件（含大小）、越界或不存在
 */
async function resolveSiteTarget(root: string, relPath: string): Promise<SiteTarget> {
  let target: string
  try {
    target = await realpath(resolve(root, relPath))
  } catch {
    return { kind: 'missing' }
  }
  if (!insideSiteRoot(root, target)) return { kind: 'forbidden' }
  let info = await stat(target).catch(() => null)
  if (!info) return { kind: 'missing' }
  if (info.isDirectory()) {
    let index: string
    try {
      index = await realpath(join(target, INDEX_FILE))
    } catch {
      return { kind: 'missing' }
    }
    // 目录本身在 root 内，但 index.html 仍可能是指向 root 外的符号链接
    if (!insideSiteRoot(root, index)) return { kind: 'forbidden' }
    info = await stat(index).catch(() => null)
    if (!info?.isFile()) return { kind: 'missing' }
    return { kind: 'file', path: index, size: info.size }
  }
  if (!info.isFile()) return { kind: 'missing' }
  return { kind: 'file', path: target, size: info.size }
}

/**
 * 纯文本响应（错误页 / 405）：不缓存、不泄漏内部细节。
 * @author ddj 2026年11月04号
 * @param res HTTP 响应
 * @param status 状态码
 * @param text 纯文本正文
 * @param headOnly 为 true 时只发头不写 body（HEAD 请求）
 */
function replyText(res: ServerResponse, status: number, text: string, headOnly = false): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  if (headOnly) {
    res.end()
    return
  }
  res.end(text)
}

/**
 * 单个静态请求：方法校验 → 路径解码 → 归属判定 → 流式返回文件。
 * 异常一律收敛成 500 文本，不让坏请求逃逸成 host 未处理异常。
 * @author ddj 2026年11月04号
 * @param root 站点根目录
 * @param req Node 请求
 * @param res Node 响应
 */
async function serveSiteFile(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? '').toUpperCase()
  const headOnly = method === 'HEAD'
  try {
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', SITE_METHODS)
      replyText(res, 405, 'Method Not Allowed')
      return
    }
    const parsed = decodeRequestPath(req.url)
    if ('err' in parsed) {
      replyText(res, parsed.status, parsed.err, headOnly)
      return
    }
    const target = await resolveSiteTarget(root, parsed.rel)
    if (target.kind === 'forbidden') {
      replyText(res, 403, 'Forbidden', headOnly)
      return
    }
    if (target.kind === 'missing') {
      replyText(res, 404, 'Not Found', headOnly)
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', htmlSiteMime(target.path))
    // 预览必须反映最新磁盘内容：禁止任何层级的缓存
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(target.size))
    if (headOnly) {
      res.end()
      return
    }
    const stream = createReadStream(target.path)
    stream.once('error', (error) => {
      log.warn('HTML 预览读取失败（' + target.path + '）：' + String(error))
      if (!res.headersSent) replyText(res, 500, 'Internal Server Error')
      else res.destroy()
    })
    stream.pipe(res)
  } catch (error) {
    log.warn('HTML 预览请求处理失败：' + String(error))
    replyText(res, 500, 'Internal Server Error', headOnly)
  }
}

/**
 * 在随机端口起一个站点服务（只绑 127.0.0.1），listening 后返回真实端口。
 * @author ddj 2026年11月04号
 * @param root 站点根目录（服务只读该目录内文件）
 * @returns 已监听的端口与服务实例
 */
function startSiteServer(root: string): Promise<HtmlSiteServer> {
  return new Promise<HtmlSiteServer>((done, fail) => {
    const server = createServer((req, res) => {
      void serveSiteFile(root, req, res)
    })
    // 运行期异常（如客户端异常断开）只记日志：绝不让 error 事件逃逸成 unhandled
    server.on('error', (error) => log.warn('HTML 预览静态服务异常（' + root + '）：' + String(error)))

    /** 监听成功：把系统分配的端口交回调用方。 */
    function onListening(): void {
      server.off('error', onFailure)
      const address = server.address()
      if (!address || typeof address === 'string') {
        closeQuietly(server)
        fail(new Error('无法获取 HTML 预览服务端口'))
        return
      }
      done({ port: address.port, server })
    }
    /** 监听失败：清掉一次性标记、关掉半开服务再把错误抛给调用方。 */
    function onFailure(error: Error): void {
      server.off('listening', onListening)
      closeQuietly(server)
      fail(error)
    }
    server.once('listening', onListening)
    server.once('error', onFailure)
    server.listen(0, SITE_HOST)
  })
}

/**
 * 静默关闭服务（启动失败/清理路径使用）：不对已关闭或未监听的服务抛错。
 * @author ddj 2026年11月04号
 * @param server 服务实例
 */
function closeQuietly(server: Server): void {
  try {
    server.close()
  } catch {
    /* 服务可能还没开始监听：无需清理 */
  }
}

/**
 * 取（或建立）root 对应的服务 Promise；建立失败时移出缓存，下一次调用可重试。
 * @author ddj 2026年11月04号
 * @param root 站点根目录
 * @returns 该根目录唯一的服务器 Promise
 */
function siteEntryOf(root: string): Promise<HtmlSiteServer> {
  const existing = sites.get(root)
  if (existing) return existing
  const entry = startSiteServer(root).catch((error) => {
    // 只清理自己这一条，避免误删并发建立的新条目
    if (sites.get(root) === entry) sites.delete(root)
    throw error
  })
  sites.set(root, entry)
  return entry
}

/**
 * 建立/复用静态站点服务并返回可直接放进 iframe 的地址。
 * @public
 * @author ddj 2026年11月04号
 * @param input 会话工作区（可空）与页面文件路径（绝对路径或工作区相对路径）
 * @returns 站点地址、静态根目录、页面相对路径与端口
 * @throws 无法解析路径 / 文件不存在 / 目标是目录 / 根目录不安全时抛出可读中文错误
 */
export async function ensureHtmlSite(input: { workspace?: string; file: string }): Promise<HtmlSiteInfo> {
  const workspace = typeof input?.workspace === 'string' && input.workspace !== '' ? input.workspace : undefined
  const file = typeof input?.file === 'string' ? input.file : ''
  if (file === '') throw new Error('无法解析预览文件路径')
  const absFile = isAbsolute(file) ? file : workspace ? resolve(workspace, file) : ''
  if (!absFile) throw new Error('无法解析预览文件路径')

  // 先 stat 原始路径：用可读中文区分「不存在」与「是目录」
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absFile)
  } catch {
    throw new Error('文件不存在')
  }
  if (info.isDirectory()) throw new Error('目标是目录，不是页面文件')
  if (!info.isFile()) throw new Error('目标不是普通文件')

  // 先 realpath 再判定归属：/tmp → /private/tmp 这类符号链接错位不能影响根目录计算
  let realFile: string
  try {
    realFile = await realpath(absFile)
  } catch {
    throw new Error('文件不存在')
  }
  const realWorkspace = workspace ? await realpath(workspace).catch(() => undefined) : undefined
  const site = siteRootOf(realWorkspace, realFile)

  // 安全护栏：绝不把文件系统根（或无法判定的根）暴露成静态服务根
  if (!site.root || site.root === '/' || !isAbsolute(site.root) || dirname(site.root) === site.root) {
    throw new Error('无法确定预览站点根目录：不能把整个文件系统暴露成服务根')
  }
  if (!site.rel || site.rel === '..' || site.rel.startsWith('../') || isAbsolute(site.rel)) {
    throw new Error('无法解析预览文件路径')
  }

  const running = await siteEntryOf(site.root)
  return { url: siteUrlOf(running.port, site.rel), root: site.root, rel: site.rel, port: running.port }
}

/**
 * 关闭单个站点服务：强制断开 keep-alive 连接，避免卸载时被挂起连接卡住。
 * @author ddj 2026年11月04号
 * @param server 服务实例
 * @returns 服务已关闭（或已不可用时）完成
 */
function closeSiteServer(server: Server): Promise<void> {
  return new Promise<void>((done) => {
    let settled = false
    /** 幂等收尾：close 回调与异常路径只放行一次。 */
    function finish(): void {
      if (settled) return
      settled = true
      done()
    }
    try {
      server.close(finish)
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
    } catch {
      finish()
    }
  })
}

/**
 * 关闭全部静态服务（插件 unload / host 退出时调用）。
 * @public
 * @author ddj 2026年11月04号
 * @description 幂等：Map 先清空，重复调用不抛、不等待已关闭的服务。
 */
export async function disposeHtmlSites(): Promise<void> {
  const entries = [...sites.values()]
  sites.clear()
  await Promise.allSettled(
    entries.map(async (entry) => {
      const running = await entry.catch(() => null)
      if (running) await closeSiteServer(running.server)
    }),
  )
}
