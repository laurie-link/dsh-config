/**
 * dsh-vscode-mode shared — HTML 渲染预览契约（host/client 双面）。
 *
 * 背景：Monaco 只能显示 HTML 源码；官方渲染器不认领 `.html`。本模块定义「在编辑器内用
 * 真浏览器渲染本地页面」所需的最小契约：
 *  - 哪些后缀算可预览页面（`isHtmlPath`）；
 *  - 静态站服务用到的 MIME 表（`htmlSiteMime`）；
 *  - 站点根目录判定与 URL 拼装（`siteRootOf` / `siteUrlOf`）——host 建服务、client 拼 iframe 地址共用，
 *    保证两端永不漂移。
 *
 * 预览形态：host 在 127.0.0.1 的随机端口起一个只读静态服务，根目录 = 会话工作区；
 * iframe 直接加载该地址，因此 `../assets/x.css`、`/images/x.png`、`fetch('./data.json')`
 * 全部按真实浏览器语义解析（这是相对路径重写 / `dsh-resource://` 方案做不到的）。
 * 服务与页面同机不同端口 → 不同源，预览页拿不到 DSH 页面的 DOM 与凭据。
 *
 * Purity rule: no node/react imports（与 nativeOpen.ts / keys.ts 一致）。
 */

/** 可进入渲染预览的后缀（小写、无点）。xhtml/shtml 与浏览器同源处理。 */
export const HTML_EXT_SET: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml', 'shtml'])

/**
 * 取 basename 后缀（小写、无点）；无后缀/隐藏文件返回 ''。
 * @author ddj 2026年11月04号
 * @param path 文件路径（`/` 或 `\` 分隔均可）
 * @returns 小写后缀或 ''
 */
export function suffixOfPath(path: unknown): string {
  const base = String(path ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * 判断路径是否为可用浏览器渲染的页面文件（大小写不敏感）。
 * @author ddj 2026年11月04号
 * @param path 文件路径
 * @returns 是否 HTML 页面
 */
export function isHtmlPath(path: unknown): boolean {
  const ext = suffixOfPath(path)
  return ext !== '' && HTML_EXT_SET.has(ext)
}

/**
 * 静态站 MIME 表（小写后缀、无点）。覆盖本地静态站常见资源：
 * 页面/样式/脚本/字体/图片/媒体/数据/PDF/wasm/哈希表。
 * @author ddj 2026年11月04号
 */
export const HTML_SITE_MIME: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  shtml: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  br: 'application/octet-stream',
  gz: 'application/gzip',
}

/**
 * 路径 → 预览服务 MIME（未命中回退 application/octet-stream）。
 * @author ddj 2026年11月04号
 * @param path 文件路径
 * @returns MIME 字符串
 */
export function htmlSiteMime(path: unknown): string {
  return HTML_SITE_MIME[suffixOfPath(path)] ?? 'application/octet-stream'
}

/** 站点根目录判定结果。 */
export interface HtmlSiteRoot {
  /** 静态服务根目录（绝对路径）：相对路径资源都相对它解析。 */
  root: string
  /** 页面在根目录内的相对路径（`/` 分隔，不带前导斜杠）。 */
  rel: string
}

/**
 * 判定页面文件的静态站根目录与相对路径。
 *
 * 规则：页面在工作区内 → 根目录取工作区（这样 `/images/x.png` 这类站点根相对路径也能命中）；
 * 页面在工作区外 → 退回页面所在目录（此时只有相对路径可用）。两种情况都不会把服务根暴露成 `/`。
 * @author ddj 2026年11月04号
 * @param workspace 会话工作区绝对路径（未知/为空时按「页面目录」处理）
 * @param file 页面文件绝对路径
 * @returns 根目录与相对路径；file 不在 workspace 下时 root 为 file 所在目录、rel 为 basename
 */
export function siteRootOf(workspace: string | undefined, file: string): HtmlSiteRoot {
  const target = normalizeSlashes(file)
  const base = String(workspace ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && target.length > base.length && target.slice(0, base.length + 1) === base + '/') {
    return { root: base, rel: target.slice(base.length + 1) }
  }
  const cut = target.lastIndexOf('/')
  if (cut <= 0) return { root: '/', rel: target.replace(/^\/+/, '') }
  return { root: target.slice(0, cut), rel: target.slice(cut + 1) }
}

/**
 * 把反斜杠统一成正斜杠（Windows 路径进 URL 前必须过这一步）。
 * @author ddj 2026年11月04号
 * @param value 任意路径文本
 * @returns 正斜杠形式
 */
export function normalizeSlashes(value: unknown): string {
  return String(value ?? '').replace(/\\/g, '/')
}

/**
 * 拼预览地址：`http://127.0.0.1:<port>/<rel>[?v=<version>]`。
 * 相对路径逐段编码（文件名含空格/中文/# 时不能被浏览器误解析）；
 * `version` 用于强制刷新（保存后自动重载走这里），不参与路径解析。
 * @author ddj 2026年11月04号
 * @param port 静态服务端口
 * @param rel 根目录内相对路径
 * @param version 可选缓存版本号（mtime 或自增计数）
 * @returns 可放进 iframe src 的绝对地址
 */
export function siteUrlOf(port: number, rel: string, version?: string | number): string {
  const path = normalizeSlashes(rel)
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  const query = version === undefined || version === null || version === '' ? '' : '?v=' + encodeURIComponent(String(version))
  return 'http://127.0.0.1:' + String(port) + '/' + path + query
}

/** 预览服务建立结果（host → client）。 */
export interface HtmlSiteInfo {
  /** 直接可用的页面地址（用于 iframe src；不含版本参数）。 */
  url: string
  /** 静态服务根目录（诊断用）。 */
  root: string
  /** 页面相对根目录的路径。 */
  rel: string
  /** 静态服务端口。 */
  port: number
}

/** `edrv.htmlPreview` 的 ok 载荷。 */
export interface HtmlPreviewPayload {
  site: HtmlSiteInfo
}
