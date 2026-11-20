/**
 * dsh-workbench-sheets — 面向文件的高层读写（路由层直接调用，测试也直接调用）。
 * 把「读文件 → 解析 → 返回契约数据」和「版本守卫 → 生成新字节 → 原子写回」收在一处，
 * index.js 只负责 HTTP 壳（解析 query/body、错误转 JSON）。
 */
import {
  statFile,
  assertFresh,
  writeFileAtomic,
  readFileBuffer,
} from './fsutil.js'
import {
  decodeCsvBuffer,
  parseCsv,
  serializeCsv,
  detectEol,
  endsWithEol,
  encodeCsvBuffer,
  normalizeSaveRows,
  csvCellCount,
} from './csv.js'
import { readWorkbookData, buildXlsxBuffer } from './xlsx.js'
import { MAX_FILE_BYTES, MAX_CELLS, formatBytes } from './limits.js'
import { wbError } from './errors.js'

/** 超过单文件上限时的统一可读错误。 */
function assertSizeLimit(size) {
  if (size > MAX_FILE_BYTES) {
    throw wbError(
      413,
      'too_large',
      `文件过大（${formatBytes(size)}，上限 ${formatBytes(MAX_FILE_BYTES)}），暂不支持在浏览器中编辑`,
    )
  }
}

/**
 * GET /workbench-sheets/file 的核心实现。
 * @param {string} absPath 宿主绝对路径
 * @param {'csv'|'tsv'|'xlsx'} kind 文件类型
 */
export async function readSheetFile(absPath, kind) {
  const stat = await statFile(absPath)
  assertSizeLimit(stat.size)
  const buffer = await readFileBuffer(absPath)
  if (kind === 'xlsx') {
    const data = await readWorkbookData(buffer)
    return {
      ok: true,
      kind,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sheets: data.sheets,
      features: data.features,
      warnings: data.warnings,
    }
  }
  const format = decodeCsvBuffer(buffer, kind)
  const rows = parseCsv(format.text, format.delimiter)
  return {
    ok: true,
    kind,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    delimiter: format.delimiter,
    rows,
    encoding: format.encoding,
    hasBom: format.hasBom,
    eol: detectEol(format.text),
  }
}

/**
 * POST /workbench-sheets/save（CSV/TSV）：整表回写。
 * 保留原文件的 BOM 状态、编码、分隔符、行结束符风格与结尾换行。
 * @param {string} absPath
 * @param {'csv'|'tsv'} kind
 * @param {Array<Array<string>>} rowsInput 客户端提交的完整 rows
 * @param {{mtimeMs:number,size:number}} expected 客户端读文件时拿到的版本
 */
export async function saveCsvFile(absPath, kind, rowsInput, expected) {
  const stat = await statFile(absPath)
  assertFresh(expected, stat)
  assertSizeLimit(stat.size)
  const rows = normalizeSaveRows(rowsInput)
  if (csvCellCount(rows) > MAX_CELLS) {
    throw wbError(413, 'too_large', `表格单元格数超过 ${MAX_CELLS} 上限，无法保存`)
  }
  const original = await readFileBuffer(absPath)
  const format = decodeCsvBuffer(original, kind)
  const text = serializeCsv(rows, {
    delimiter: format.delimiter,
    eol: detectEol(format.text),
    trailingEol: endsWithEol(format.text),
  })
  const output = encodeCsvBuffer(text, format)
  await writeFileAtomic(absPath, output, { mode: stat.mode })
  const after = await statFile(absPath)
  return { ok: true, mtimeMs: after.mtimeMs, size: after.size }
}

/**
 * POST /workbench-sheets/save（XLSX）：只提交 diff，加载原文件后最小改动写回。
 * @param {string} absPath
 * @param {Array<{sheet:string,row:number,col:number,v?:unknown,f?:string,blank?:boolean}>} editsInput
 * @param {{mtimeMs:number,size:number}} expected
 */
export async function saveXlsxFile(absPath, editsInput, expected) {
  const stat = await statFile(absPath)
  assertFresh(expected, stat)
  assertSizeLimit(stat.size)
  if (!Array.isArray(editsInput)) throw wbError(400, 'bad_edits', 'edits 必须是数组')
  if (editsInput.length > MAX_CELLS) throw wbError(413, 'too_large', '编辑项过多，无法保存')
  if (editsInput.length === 0) {
    // 没有改动：不落盘，直接返回当前版本（客户端据此清脏即可）
    return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size, lossy: [] }
  }
  const original = await readFileBuffer(absPath)
  const { buffer, lossy, warnings } = await buildXlsxBuffer(original, editsInput)
  await writeFileAtomic(absPath, buffer, { mode: stat.mode })
  const after = await statFile(absPath)
  return { ok: true, mtimeMs: after.mtimeMs, size: after.size, lossy, warnings }
}
