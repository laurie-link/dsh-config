/**
 * dsh-workbench-sheets — CSV/TSV 编解码。
 * 解析是 RFC4180 风格的字符状态机（支持引号、双引号转义、引号内换行）；
 * 序列化时按原文件的 BOM 状态、分隔符、行结束符风格回写，尽量做到字节级保真。
 */
import { wbError } from './errors.js'
import { MAX_CELLS } from './limits.js'

/** 候选分隔符（按优先级排序，同分时取靠前者）。 */
const DELIMITER_CANDIDATES = [',', ';', '\t', '|']

/** 从路径后缀推测分隔符：.tsv 恒为制表符。 */
function delimiterForExt(ext) {
  return ext === 'tsv' ? '\t' : null
}

/**
 * 解码 CSV 字节：识别 UTF-8 / UTF-16LE BOM，返回文本与回写所需的事实。
 * UTF-16BE 明确拒绝（契约只要求 utf-8/utf-16le，静默转码风险更大）。
 * @returns {{text: string, encoding: 'utf-8'|'utf-16le', hasBom: boolean, delimiter: string}}
 */
export function decodeCsvBuffer(buffer, ext) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    const text = buffer.subarray(3).toString('utf8')
    return { text, encoding: 'utf-8', hasBom: true, delimiter: detectDelimiter(text, ext) }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const text = buffer.subarray(2).toString('utf16le')
    return { text, encoding: 'utf-16le', hasBom: true, delimiter: detectDelimiter(text, ext) }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw wbError(400, 'unsupported_encoding', '暂不支持 UTF-16BE 编码的文件，请先转成 UTF-8')
  }
  const text = buffer.toString('utf8')
  return { text, encoding: 'utf-8', hasBom: false, delimiter: detectDelimiter(text, ext) }
}

/** 按原格式把文本编码回字节（补回 BOM）。 */
export function encodeCsvBuffer(text, format) {
  const body = Buffer.from(text, format.encoding === 'utf-16le' ? 'utf16le' : 'utf8')
  if (!format.hasBom) return body
  const bom = format.encoding === 'utf-16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xef, 0xbb, 0xbf])
  return Buffer.concat([bom, body])
}

/**
 * 分隔符嗅探：对每个候选分别解析样例，取「每行列数众数」最优的候选。
 * 认错也不会破坏数据（解析/序列化用同一个分隔符），只是显示不对。
 * @param {string} text 文件全文
 * @param {'csv'|'tsv'} ext 后缀（tsv 直接返回制表符）
 */
export function detectDelimiter(text, ext) {
  const forced = delimiterForExt(ext)
  if (forced !== null) return forced
  const sample = text.length > 65536 ? text.slice(0, 65536) : text
  let best = ','
  let bestScore = 0
  for (const candidate of DELIMITER_CANDIDATES) {
    const rows = parseCsv(sample, candidate, false)
    // 样例被截断时，最后一行可能是半行，剔除后再统计
    if (sample.length < text.length && rows.length > 0) rows.pop()
    const counts = rows.slice(0, 20).map((row) => row.length).filter((count) => count > 0)
    if (counts.length === 0) continue
    const freq = new Map()
    for (const count of counts) freq.set(count, (freq.get(count) || 0) + 1)
    let modeFreq = 0
    let modeCount = 0
    for (const [count, times] of freq) {
      if (times > modeFreq || (times === modeFreq && count > modeCount)) {
        modeFreq = times
        modeCount = count
      }
    }
    const score = modeCount >= 2 ? modeFreq * 1000 + modeCount : 0
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/**
 * 行结束符风格判定（取出现次数最多者；CRLF 同分优先，其次 LF）。
 * 没有任何换行时默认 LF（新建文件场景）。
 */
export function detectEol(text) {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) { crlf++; index++ } else cr++
    } else if (code === 10) {
      lf++
    }
  }
  if (crlf === 0 && lf === 0 && cr === 0) return '\n'
  if (crlf >= lf && crlf >= cr) return '\r\n'
  if (lf >= cr) return '\n'
  return '\r'
}

/** 文件是否以换行结尾（回写时保留这个细节）。 */
export function endsWithEol(text) {
  return /(?:\r\n|\n|\r)$/.test(text)
}

/**
 * RFC4180 风格解析。
 * @param {string} text 文本
 * @param {string} delimiter 分隔符
 * @param {boolean} enforceLimit 是否执行单元格上限（嗅探样例时关闭）
 * @returns {string[][]}
 */
export function parseCsv(text, delimiter, enforceLimit = true) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let fieldStarted = false
  let cells = 0

  const pushField = () => {
    row.push(field)
    field = ''
    fieldStarted = false
    cells += 1
    if (enforceLimit && cells > MAX_CELLS) {
      throw wbError(413, 'too_large', `表格单元格数超过 ${MAX_CELLS} 上限，暂不支持在浏览器中编辑`)
    }
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++ } else inQuotes = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && !fieldStarted) {
      inQuotes = true
      fieldStarted = true
      continue
    }
    if (char === delimiter) { pushField(); continue }
    if (char === '\r') {
      if (text[index + 1] === '\n') index++
      pushRow()
      continue
    }
    if (char === '\n') { pushRow(); continue }
    field += char
    fieldStarted = true
  }
  // 文件末尾没有换行时，把最后一行补上（有空行时同理）
  if (field !== '' || row.length > 0) pushRow()
  return rows
}

/** 单元格序列化（命中分隔符 / 引号 / 换行才加引号，引号翻倍转义）。 */
function serializeField(value, delimiter) {
  const text = value === null || value === undefined ? '' : String(value)
  if (text.includes(delimiter) || /["\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return text
}

/**
 * 序列化二维数组。
 * @param {Array<Array<string>>} rows 行数据
 * @param {{delimiter?: string, eol?: string, trailingEol?: boolean}} options 回写风格
 */
export function serializeCsv(rows, options = {}) {
  const delimiter = options.delimiter || ','
  const eol = options.eol || '\n'
  const text = (rows || [])
    .map((row) => (Array.isArray(row) ? row : []).map((field) => serializeField(field, delimiter)).join(delimiter))
    .join(eol)
  if (options.trailingEol && text !== '') return text + eol
  return text
}

/** 行数据单元格总数。 */
export function csvCellCount(rows) {
  let cells = 0
  for (const row of rows || []) cells += Array.isArray(row) ? row.length : 0
  return cells
}

/**
 * 校验并规范化保存请求里的 rows（只接受字符串/数字/布尔/null，其余 400）。
 * 同时执行单元格总数上限检查。
 */
export function normalizeSaveRows(input) {
  if (!Array.isArray(input)) throw wbError(400, 'bad_rows', 'rows 必须是二维数组')
  const rows = []
  let cells = 0
  for (const rawRow of input) {
    if (!Array.isArray(rawRow)) throw wbError(400, 'bad_rows', 'rows 的每一行都必须是数组')
    const row = []
    for (const rawCell of rawRow) {
      if (rawCell === null || rawCell === undefined) row.push('')
      else if (typeof rawCell === 'string') row.push(rawCell)
      else if (typeof rawCell === 'number' || typeof rawCell === 'boolean') row.push(String(rawCell))
      else throw wbError(400, 'bad_rows', '单元格只支持字符串、数字或布尔值')
    }
    cells += row.length
    if (cells > MAX_CELLS) {
      throw wbError(413, 'too_large', `表格单元格数超过 ${MAX_CELLS} 上限，无法保存`)
    }
    rows.push(row)
  }
  return rows
}
