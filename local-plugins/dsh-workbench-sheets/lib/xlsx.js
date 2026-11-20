/**
 * dsh-workbench-sheets — XLSX 读写（ExcelJS）。
 * 读：整本工作簿 → 每张表二维 cell 矩阵（归一成 { v, f?, t? }），并把「保存可能丢失的结构」
 *     作为 features/warnings 交给客户端提前提示。
 * 写：加载原文件 → 只改客户端提交的 diff → 整本写回（ExcelJS 会保留未改动的单元格、
 *     样式、列宽、合并等），因此不会把用户的其它结构冲掉。
 */
import { wbError } from './errors.js'
import { MAX_CELLS, MAX_XLSX_ROWS, MAX_XLSX_COLS } from './limits.js'

/** ExcelJS 是 CJS 包，用动态 import 兼容；缺依赖时只有读写路由失败，不拖垮插件加载。 */
async function loadExcelJS() {
  try {
    const mod = await import('exceljs')
    return mod.default || mod
  } catch (error) {
    throw wbError(500, 'xlsx_unavailable', 'ExcelJS 未安装，无法读写 XLSX：' + String((error && error.message) || error))
  }
}

/** features 的中文名（lossy/warnings 文案共用）。 */
const FEATURE_LABELS = {
  charts: '图表',
  images: '图片',
  pivot: '数据透视表',
  conditionalFormatting: '条件格式',
}

/**
 * 检测保存后可能丢失的结构。
 * - 图表/图片/透视表：ExcelJS 不建模，扫描 xlsx(zip) 的条目名（zip 中央目录里是明文）；
 * - 图片另有 workbook.media 兜底；
 * - 条件格式：读 worksheet.conditionalFormattings（ExcelJS 支持较好，只做提示）。
 * @param {Buffer} buffer 原始 xlsx 字节
 * @param {object} workbook ExcelJS 工作簿
 */
export function detectFeatures(buffer, workbook) {
  const hasEntry = (needle) => buffer.includes(Buffer.from(needle, 'latin1'))
  const worksheets = (workbook && workbook.worksheets) || []
  const mediaCount = Array.isArray(workbook && workbook.media) ? workbook.media.length : 0
  return {
    charts: hasEntry('xl/charts/'),
    images: mediaCount > 0 || hasEntry('xl/media/'),
    pivot: hasEntry('xl/pivotTables/') || hasEntry('xl/pivotCache/'),
    conditionalFormatting: worksheets.some((sheet) => Array.isArray(sheet.conditionalFormattings) && sheet.conditionalFormattings.length > 0),
  }
}

/** 保存后会丢失的结构名（响应里的 lossy）。 */
export function lossyLabels(features) {
  const list = []
  if (features && features.charts) list.push(FEATURE_LABELS.charts)
  if (features && features.images) list.push(FEATURE_LABELS.images)
  if (features && features.pivot) list.push(FEATURE_LABELS.pivot)
  return list
}

/** features → 给用户看的中文警告列表。 */
export function warningsFor(features) {
  const warnings = []
  if (features && features.charts) warnings.push('工作簿含图表：保存后会丢失图表')
  if (features && features.images) warnings.push('工作簿含图片：保存后可能丢失图片')
  if (features && features.pivot) warnings.push('工作簿含数据透视表：保存后会丢失数据透视表')
  if (features && features.conditionalFormatting) warnings.push('工作簿含条件格式：保存后可能丢失部分条件格式')
  return warnings
}

/** 富文本 → 纯文本。 */
function richTextToPlain(richText) {
  if (!Array.isArray(richText)) return ''
  return richText.map((run) => (run && typeof run.text === 'string' ? run.text : '')).join('')
}

/**
 * ExcelJS 的 cell.value 归一成契约形状 { v, f?, t? }。
 * v 只会是 string/number/boolean/null（Date 统一转 ISO 字符串并标 t:'d'）。
 * @param {unknown} value ExcelJS cell.value
 */
export function normalizeXlsxCell(value) {
  if (value === null || value === undefined) return { v: null }
  if (typeof value === 'string') return { v: value, t: 's' }
  if (typeof value === 'number') return { v: Number.isFinite(value) ? value : null, t: 'n' }
  if (typeof value === 'boolean') return { v: value, t: 'b' }
  if (value instanceof Date) return { v: value.toISOString(), t: 'd' }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return { v: richTextToPlain(value.richText), t: 's' }
    const formula = typeof value.formula === 'string'
      ? value.formula
      : (typeof value.sharedFormula === 'string' ? value.sharedFormula : undefined)
    if (formula !== undefined) {
      const result = normalizeXlsxCell(value.result)
      const cell = { v: result.v }
      if (result.t) cell.t = result.t
      cell.f = formula.replace(/^=/, '')
      return cell
    }
    if (value.error !== undefined) return { v: String(value.error), t: 's' }
    if (value.text !== undefined) return { v: String(value.text), t: 's' }
    if (value.hyperlink !== undefined) return { v: String(value.hyperlink), t: 's' }
  }
  return { v: String(value), t: 's' }
}

/** 单元格已有值的「类型基底」——保存时用它决定新值要不要转成数字/布尔/日期。 */
function baseValueOf(existing) {
  if (existing === null || existing === undefined) return undefined
  if (existing instanceof Date) return existing
  if (typeof existing === 'string' || typeof existing === 'number' || typeof existing === 'boolean') return existing
  if (typeof existing === 'object') {
    if (typeof existing.formula === 'string' || typeof existing.sharedFormula === 'string') return baseValueOf(existing.result)
    if (Array.isArray(existing.richText)) return richTextToPlain(existing.richText)
    if (existing.error !== undefined) return undefined
    if (existing.text !== undefined) return existing.text
  }
  return undefined
}

function toNumberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const text = String(value).trim()
  if (text === '') return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toBooleanValue(value) {
  if (value === true) return true
  if (value === false) return false
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === '1') return true
  if (text === 'false' || text === '0') return false
  return undefined
}

/**
 * 把「输入框里的字符串」按原单元格类型转换成 ExcelJS 可写的值。
 * 原有数字/布尔/日期单元格保持类型（用户复制粘贴数值不会变成文本），其余按文本写。
 * @param {unknown} existing 编辑前的 cell.value
 * @param {unknown} incoming 客户端提交的新值（一般是字符串）
 */
export function coerceCellValue(existing, incoming) {
  if (incoming === null || incoming === undefined) return null
  const base = baseValueOf(existing)
  if (base instanceof Date) {
    const date = new Date(String(incoming))
    return Number.isNaN(date.getTime()) ? String(incoming) : date
  }
  if (typeof base === 'number') {
    const number = toNumberValue(incoming)
    return number === undefined ? String(incoming) : number
  }
  if (typeof base === 'boolean') {
    const bool = toBooleanValue(incoming)
    return bool === undefined ? String(incoming) : bool
  }
  if (typeof incoming === 'boolean' || typeof incoming === 'number') return incoming
  return String(incoming)
}

/** 逐表读取二维 cell 矩阵（用 rowCount/columnCount 定义范围，空格子给 { v:null }）。 */
function readSheetRows(worksheet) {
  const rowCount = worksheet.rowCount || 0
  const columnCount = worksheet.columnCount || 0
  const rows = []
  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex)
    const cells = new Array(columnCount)
    for (let colIndex = 1; colIndex <= columnCount; colIndex++) {
      cells[colIndex - 1] = normalizeXlsxCell(row.getCell(colIndex).value)
    }
    rows.push(cells)
  }
  return rows
}

/**
 * 读取 xlsx 字节 → 契约里的 sheets/features/warnings。
 * 单元格总数超限直接 413（不在浏览器里做超大表渲染）。
 * @param {Buffer} buffer
 */
export async function readWorkbookData(buffer) {
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch (error) {
    throw wbError(400, 'bad_xlsx', '无法解析 XLSX 文件：' + String((error && error.message) || error))
  }
  const worksheets = workbook.worksheets || []
  if (worksheets.length === 0) throw wbError(400, 'bad_xlsx', '工作簿里没有工作表')
  let cells = 0
  for (const worksheet of worksheets) cells += (worksheet.rowCount || 0) * (worksheet.columnCount || 0)
  if (cells > MAX_CELLS) {
    throw wbError(413, 'too_large', `表格过大（约 ${cells} 个单元格，上限 ${MAX_CELLS}），暂不支持在浏览器中编辑`)
  }
  const sheets = worksheets.map((worksheet, index) => ({
    name: worksheet.name,
    index,
    rows: readSheetRows(worksheet),
  }))
  const features = detectFeatures(buffer, workbook)
  return { sheets, features, warnings: warningsFor(features) }
}

/** 校验单条 edit（sheet/row/col 都是 1 基，与 Excel 一致）。 */
function applyEdit(workbookByName, edit) {
  if (edit === null || typeof edit !== 'object') throw wbError(400, 'bad_edit', '编辑项格式不正确')
  const sheetName = typeof edit.sheet === 'string' ? edit.sheet : ''
  if (!sheetName) throw wbError(400, 'bad_edit', '编辑项缺少 sheet')
  const worksheet = workbookByName.get(sheetName)
  if (!worksheet) throw wbError(400, 'bad_edit', '工作表不存在：' + sheetName)
  const row = edit.row
  const col = edit.col
  if (!Number.isInteger(row) || row < 1 || row > MAX_XLSX_ROWS) {
    throw wbError(400, 'bad_edit', '编辑项行号非法（1-' + MAX_XLSX_ROWS + '）：' + String(row))
  }
  if (!Number.isInteger(col) || col < 1 || col > MAX_XLSX_COLS) {
    throw wbError(400, 'bad_edit', '编辑项列号非法（1-' + MAX_XLSX_COLS + '）：' + String(col))
  }
  const cell = worksheet.getRow(row).getCell(col)
  if (edit.blank === true) { cell.value = null; return }
  if (typeof edit.f === 'string' && edit.f.trim() !== '') {
    const formula = edit.f.replace(/^=/, '')
    // 客户端不提供结果缓存；写纯公式，Excel/WPS 打开时会重算
    cell.value = edit.v === undefined ? { formula } : { formula, result: edit.v }
    return
  }
  cell.value = coerceCellValue(cell.value, edit.v)
}

/**
 * 把 diff 应用到原文件并写出新字节（不落盘，落盘由调用方做）。
 * @param {Buffer} originalBuffer 原 xlsx 字节
 * @param {Array<{sheet:string,row:number,col:number,v?:unknown,f?:string,blank?:boolean}>} edits
 * @returns {Promise<{buffer: Buffer, features: object, warnings: string[], lossy: string[]}>}
 */
export async function buildXlsxBuffer(originalBuffer, edits) {
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(originalBuffer)
  } catch (error) {
    throw wbError(400, 'bad_xlsx', '无法解析 XLSX 文件：' + String((error && error.message) || error))
  }
  const features = detectFeatures(originalBuffer, workbook)
  const worksheetByName = new Map((workbook.worksheets || []).map((worksheet) => [worksheet.name, worksheet]))
  for (const edit of edits) applyEdit(worksheetByName, edit)
  let output
  try {
    output = await workbook.xlsx.writeBuffer()
  } catch (error) {
    throw wbError(500, 'xlsx_write_failed', '写回 XLSX 失败：' + String((error && error.message) || error))
  }
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output)
  return { buffer, features, warnings: warningsFor(features), lossy: lossyLabels(features) }
}
