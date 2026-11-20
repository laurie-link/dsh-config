/** CSV/TSV 解析、序列化、格式保真与保存链路测试（全部在 /tmp 副本上进行）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import {
  decodeCsvBuffer,
  parseCsv,
  serializeCsv,
  detectEol,
  endsWithEol,
  encodeCsvBuffer,
  detectDelimiter,
} from '../lib/csv.js'
import { readSheetFile, saveCsvFile } from '../lib/sheetIo.js'
import { WbError } from '../lib/errors.js'
import { copySample, withTempDir } from './helpers.mjs'

test('读取 sample.csv：4 列 21 行、CRLF、无 BOM', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.csv')
    const data = await readSheetFile(file, 'csv')
    assert.equal(data.ok, true)
    assert.equal(data.kind, 'csv')
    assert.equal(data.delimiter, ',')
    assert.equal(data.encoding, 'utf-8')
    assert.equal(data.hasBom, false)
    assert.equal(data.eol, '\r\n')
    assert.equal(data.rows.length, 21)
    assert.equal(data.rows[0].length, 4)
    assert.deepEqual(data.rows[0], ['name', 'qty', 'price', 'note'])
    // 带逗号的引号字段要解析成一个单元格
    assert.equal(data.rows[5][3], '含逗号, test')
    assert.ok(data.mtimeMs > 0)
    assert.ok(data.size > 0)
  })
})

test('sample.csv 往返序列化字节级一致（BOM/分隔符/行尾/结尾换行全保真）', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.csv')
    const original = await fsp.readFile(file)
    const format = decodeCsvBuffer(original, 'csv')
    const rows = parseCsv(format.text, format.delimiter)
    const text = serializeCsv(rows, {
      delimiter: format.delimiter,
      eol: detectEol(format.text),
      trailingEol: endsWithEol(format.text),
    })
    const roundTrip = encodeCsvBuffer(text, format)
    assert.equal(roundTrip.equals(original), true)
  })
})

test('修改单元格并保存：值写回磁盘、CRLF 保留、其它行不变', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.csv')
    const first = await readSheetFile(file, 'csv')
    first.rows[1][0] = 'item-1-changed'
    first.rows[1][1] = '999'
    const result = await saveCsvFile(file, 'csv', first.rows, { mtimeMs: first.mtimeMs, size: first.size })
    assert.equal(result.ok, true)
    assert.ok(result.mtimeMs >= first.mtimeMs)

    const raw = await fsp.readFile(file)
    assert.equal(raw[0], 0x6e) // 'n'（name），没有意外加 BOM
    assert.ok(raw.toString('utf8').includes('\r\n'))
    assert.ok(raw.toString('utf8').includes('item-1-changed,999'))

    const second = await readSheetFile(file, 'csv')
    assert.equal(second.rows[1][0], 'item-1-changed')
    assert.equal(second.rows[1][1], '999')
    assert.equal(second.rows[0][0], 'name')
    assert.equal(second.rows.length, first.rows.length)
    // 带逗号的字段仍然用引号保护
    assert.equal(second.rows[5][3], '含逗号, test')
  })
})

test('保留 UTF-8 BOM 状态', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'bom.csv')
    await fsp.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\r\n1,2\r\n')]))
    const data = await readSheetFile(file, 'csv')
    assert.equal(data.hasBom, true)
    assert.deepEqual(data.rows, [['a', 'b'], ['1', '2']])
    data.rows[1][1] = '3'
    await saveCsvFile(file, 'csv', data.rows, { mtimeMs: data.mtimeMs, size: data.size })
    const raw = await fsp.readFile(file)
    assert.deepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf])
    assert.equal(raw.subarray(3).toString('utf8'), 'a,b\r\n1,3\r\n')
  })
})

test('UTF-16LE 读写保持编码与 BOM', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'utf16.tsv')
    const body = Buffer.from('a\tb\r\n1\t2\r\n', 'utf16le')
    await fsp.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), body]))
    const data = await readSheetFile(file, 'tsv')
    assert.equal(data.encoding, 'utf-16le')
    assert.equal(data.hasBom, true)
    assert.equal(data.delimiter, '\t')
    data.rows[1][0] = 'X'
    await saveCsvFile(file, 'tsv', data.rows, { mtimeMs: data.mtimeMs, size: data.size })
    const raw = await fsp.readFile(file)
    assert.deepEqual([raw[0], raw[1]], [0xff, 0xfe])
    assert.equal(raw.subarray(2).toString('utf16le'), 'a\tb\r\nX\t2\r\n')
  })
})

test('UTF-16BE 明确拒绝（可读错误）', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'be.csv')
    await fsp.writeFile(file, Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x2c]))
    await assert.rejects(
      () => readSheetFile(file, 'csv'),
      (error) => error instanceof WbError && error.status === 400 && error.code === 'unsupported_encoding',
    )
  })
})

test('分隔符嗅探：分号 / 制表符 / 默认逗号', () => {
  assert.equal(detectDelimiter('a;b;c\r\n1;2;3\r\n', 'csv'), ';')
  assert.equal(detectDelimiter('a\tb\tc\r\n1\t2\t3\r\n', 'csv'), '\t')
  // .tsv 后缀强制制表符，即使内容看起来像逗号分隔
  assert.equal(detectDelimiter('a,b\r\n1,2\r\n', 'tsv'), '\t')
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n', 'csv'), ',')
})

test('引号内换行与转义引号可往返', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'quoted.csv')
    const original = 'a,b\r\n"line1\nline2",2\r\n"say ""hi""",3\r\n'
    await fsp.writeFile(file, Buffer.from(original))
    const data = await readSheetFile(file, 'csv')
    assert.equal(data.rows[1][0], 'line1\nline2')
    assert.equal(data.rows[2][0], 'say "hi"')
    await saveCsvFile(file, 'csv', data.rows, { mtimeMs: data.mtimeMs, size: data.size })
    assert.equal(await fsp.readFile(file, 'utf8'), original)
  })
})

test('版本守卫：外部改动后保存 → 409 conflict', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.csv')
    const data = await readSheetFile(file, 'csv')
    await fsp.appendFile(file, 'external,1\r\n')
    await assert.rejects(
      () => saveCsvFile(file, 'csv', data.rows, { mtimeMs: data.mtimeMs, size: data.size }),
      (error) => error instanceof WbError && error.status === 409 && error.code === 'conflict',
    )
  })
})

test('超大文件（>32MiB）读取被拒绝，错误可读', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'huge.csv')
    await fsp.writeFile(file, '')
    await fsp.truncate(file, 33 * 1024 * 1024)
    await assert.rejects(
      () => readSheetFile(file, 'csv'),
      (error) => error instanceof WbError && error.status === 413 && error.code === 'too_large' && /32\.0 MiB/.test(error.message),
    )
  })
})

test('单元格数超 30 万被拒绝，错误可读', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'wide.csv')
    const line = new Array(400).fill('x').join(',')
    const lines = new Array(1000).fill(line).join('\n')
    await fsp.writeFile(file, lines)
    await assert.rejects(
      () => readSheetFile(file, 'csv'),
      (error) => error instanceof WbError && error.status === 413 && error.code === 'too_large' && /300000/.test(error.message),
    )
  })
})

test('保存时拒绝非法 rows 形状', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.csv')
    const data = await readSheetFile(file, 'csv')
    await assert.rejects(
      () => saveCsvFile(file, 'csv', 'not-an-array', { mtimeMs: data.mtimeMs, size: data.size }),
      (error) => error instanceof WbError && error.status === 400 && error.code === 'bad_rows',
    )
  })
})
