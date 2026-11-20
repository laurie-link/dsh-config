/**
 * dsh-vscode-mode shared — 原生打开范围判定（host/client 双面契约）。
 * 背景：DSH 文件预览双形态——本插件认领 `dsh-resource://file/**` 进 Monaco 编辑，
 * 官方渲染器（Office 预览/不可预览提示/表格预览）看认领让位。本模块承载「原生打开」
 * 范围的单一事实源：默认集 = 让位清单（插件本来就不认领的后缀），用户可经设置
 * `nativeOpenExts`（逗号分隔）增删；host 的 Config schema 默认值与 client 的
 * 文件树点击判定 / claim 认领判定共用，保证三处永不同源漂移。
 * 本地改动静默差异（2026-11-04，用户定制）：CSV/TSV/XLSX/PDF 改为默认让位官方渲染器，
 * 由 sidecar 插件（dsh-workbench-sheets）在官方侧栏里提供可编辑表格/PDF 预览；
 * 官方 Office / 不可预览二进制容器仍按原策略让位。
 * 作者 ddj 2026年09月22号
 */

/**
 * Office 文档后缀：官方 `dsh-client-ui-sidebar-documentpreview` 的 Office 渲染器
 * 声明 `doc/docx/xls/xlsx/ppt/pptx`（0.1.6 起侧栏 Office 预览；0.1.7 扩展表格 CSV/TSV
 * 只读预览）。本插件让位官方（不认领），否则会把这些文件路由进 Monaco 而丢掉官方预览。
 */
export const OFFICE_EXT: readonly string[] = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers']

/**
 * 官方渲染器接管的扩展名：Office 文档 + CSV/TSV 表格 + PDF。
 * 本地定制（2026-11-04）：xlsx/csv/tsv/pdf 一律让位官方侧栏渲染器，
 * 由 dsh-workbench-sheets 提供可编辑表格（xlsx/csv）与 PDF 预览；
 * 本插件不再独占 Excel 面板与 PDF 注释面板。
 */
export const DELEGATE_EXT: readonly string[] = [...OFFICE_EXT, 'csv', 'tsv', 'pdf']

/**
 * 官方「不可预览二进制容器」清单（`UNVIEWABLE_BINARY_EXTENSIONS`，逐项取自
 * `dsh-client-ui-sidebar-documentpreview/lib/client.js`）。这些后缀官方会给出
 * 「无法预览」提示；本插件让位官方，避免把二进制当文本读成乱码。
 *
 * ⚠️ 刻意例外：官方清单含 `avif`，但本插件图片预览支持 avif（浏览器原生解码），
 * 故从本表**移除** `avif` —— 保留本插件的图片预览优于官方的「不可预览」。
 * @author ddj 2026年09月18号
 */
export const BLIND_EXT: readonly string[] = [
  // 媒体（2026-11-04 本机定制：浏览器可解码的视频后缀 mp4/mov/m4v/webm 移出本表，
  // 改由本插件的编辑区视频预览面板接管；avi/mkv/flv/wmv 等浏览器无法解码的仍让位官方）
  'avi', 'mkv', 'flv', 'wmv', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus',
  // 归档
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar',
  // 可执行与库
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'class', 'pyc', 'wasm',
  // 字体
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // 磁盘映像
  'dmg', 'iso', 'img',
  // 数据库与设计文件
  'sqlite', 'db', 'psd', 'ai', 'sketch', 'tiff', 'tif', 'heic', 'heif',
]

/** 原生打开默认后缀集 = 让位清单并集（两清单元素天然互斥，直接拼接）。 */
export const DEFAULT_NATIVE_EXT: readonly string[] = [...DELEGATE_EXT, ...BLIND_EXT]

/** 默认范围的设置序列（逗号分隔；Config schema 默认值与设置页回显同源）。 */
export const DEFAULT_NATIVE_CSV: string = DEFAULT_NATIVE_EXT.join(',')

/**
 * 取 path 的 basename 后缀（小写、无点）；无后缀/隐藏文件返回 ''。
 * @author ddj 2026年09月22号
 * @param path 文件路径（`/` 或 `\` 分隔均可）
 * @returns 小写后缀或 ''
 */
export function suffixOf(path: unknown): string {
  const base = String(path ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * 媒体后缀（视频 + 浏览器可解码图片）：点开时**始终**进本插件编辑区，
 * 由编辑区的视频预览面板 / 图片预览面板渲染，而不是交给官方查看器或
 * better-sidebar 的编辑器（后者对视频只会给「此文件类型不支持预览」）。
 * 本地定制（2026-11-05，用户要求：Agent 视图里点对话中的视频/图片，右边用
 * VSCode 编辑区预览）。
 */
export const MEDIA_EXT: readonly string[] = [
  // 视频（浏览器 <video> 可解码）
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg',
  // 图片（编辑区图片预览支持）
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg',
]

/**
 * 判断路径是否媒体文件（见 {@link MEDIA_EXT}）。
 * @param path 文件路径
 * @returns 是媒体文件时为 true
 */
export function isMediaPath(path: unknown): boolean {
  const ext = suffixOf(path)
  return ext !== '' && MEDIA_EXT.includes(ext)
}

/**
 * 解析设置串为后缀集合：逗号分隔、去空白、去前导点、小写；空段丢弃。
 * 解析失败/空串 → 空集合（= 不追加任何原生打开范围，让位仍走 deferToOfficial）。
 * @author ddj 2026年09月22号
 * @param csv 逗号分隔后缀串
 * @returns 后缀集合
 */
export function parseExtCsv(csv: unknown): Set<string> {
  const out = new Set<string>()
  if (typeof csv !== 'string') return out
  for (const raw of csv.split(',')) {
    const item = raw.trim().replace(/^\./, '').toLowerCase()
    if (item) out.add(item)
  }
  return out
}

/**
 * 该路径是否命中「原生打开」范围（仅看用户配置集合；默认集语义由调用方
 * 与 deferToOfficial 取并，保持两判定各司其职）。
 * @author ddj 2026年09月22号
 * @param path 文件路径
 * @param exts 已解析的后缀集合（parseExtCsv 产物）
 * @returns 是否命中
 */
export function inNativeOpen(path: unknown, exts: ReadonlySet<string>): boolean {
  const ext = suffixOf(path)
  return ext !== '' && exts.has(ext)
}
