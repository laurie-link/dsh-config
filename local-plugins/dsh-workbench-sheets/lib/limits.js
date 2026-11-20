/**
 * dsh-workbench-sheets — 尺寸/数量上限（host 与 client 共享口径的单一事实源）。
 * 超限一律返回可读错误，不做静默截断：宁可拒绝，也不让用户在不知情下丢数据。
 */

/** 单个文件读取上限（字节）：超过后不载入编辑器。 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024

/** 单元格总数上限（跨工作表累计）：避免浏览器渲染与 JSON 传输被打爆。 */
export const MAX_CELLS = 300_000

/** POST /save 请求体上限（字节）：行数据以 JSON 传输，留出编码膨胀空间。 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024

/** XLSX 规范里的行列上限（用于校验编辑坐标，超出直接报错）。 */
export const MAX_XLSX_ROWS = 1_048_576
export const MAX_XLSX_COLS = 16_384

/** 人类可读的字节数（错误文案用）。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes)
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
}
