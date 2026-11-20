/** XLSX 读写、diff 应用、公式/样式保留、版本守卫与结构告警测试（在 /tmp 副本上进行）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'

import {
  readSheetFile,
  saveXlsxFile,
} from '../lib/sheetIo.js'
import {
  normalizeXlsxCell,
  coerceCellValue,
  detectFeatures,
  lossyLabels,
  warningsFor,
} from '../lib/xlsx.js'
import { WbError } from '../lib/errors.js'
import { copySample, withTempDir, runPython, hasOpenpyxl } from './helpers.mjs'

test('读取 sample.xlsx：两个 sheet、值与类型正确、无结构告警', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.xlsx')
    const data = await readSheetFile(file, 'xlsx')
    assert.equal(data.ok, true)
    assert.equal(data.kind, 'xlsx')
    assert.deepEqual(data.sheets.map((sheet) => sheet.name), ['Sheet1', 'Second'])
    assert.deepEqual(data.sheets.map((sheet) => sheet.index), [0, 1])
    const sheet1 = data.sheets[0]
    assert.equal(sheet1.rows[0][0].v, 'Name')
    assert.equal(sheet1.rows[0][0].t, 's')
    // 样例文件可能被浏览器验收改过个别值（如 B2 被改成 999），这里只断言结构与类型
    assert.equal(sheet1.rows[1][0].v, 'Item 1')
    assert.equal(sheet1.rows[1][1].t, 'n')
    assert.equal(typeof sheet1.rows[1][1].v, 'number')
    assert.equal(sheet1.rows[1][2].v, 2.5)
    assert.deepEqual(data.sheets[1].rows[0][0], { v: 'A', t: 's' })
    assert.deepEqual(data.features, { charts: false, images: false, pivot: false, conditionalFormatting: false })
    assert.deepEqual(data.warnings, [])
    assert.ok(data.mtimeMs > 0 && data.size > 0)
  })
})

test('保存 sample.xlsx 的 Sheet1!B2：只改该 cell，数字类型保留，其他 sheet 不动', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.xlsx')
    const first = await readSheetFile(file, 'xlsx')
    const result = await saveXlsxFile(file, [{ sheet: 'Sheet1', row: 2, col: 2, v: '99' }], {
      mtimeMs: first.mtimeMs,
      size: first.size,
    })
    assert.equal(result.ok, true)
    assert.ok(result.mtimeMs >= first.mtimeMs)
    assert.deepEqual(result.lossy, [])

    const second = await readSheetFile(file, 'xlsx')
    assert.equal(second.sheets[0].rows[1][1].v, 99) // 原单元格是数字，写入仍为数字
    assert.equal(second.sheets[0].rows[0][0].v, 'Name')
    assert.equal(second.sheets[1].rows[1][0].v, 1)

    if (hasOpenpyxl()) {
      const code = [
        'import json, sys, openpyxl',
        'wb = openpyxl.load_workbook(sys.argv[1])',
        'print(json.dumps({"sheets": wb.sheetnames, "b2": wb["Sheet1"]["B2"].value, "a1": wb["Sheet1"]["A1"].value, "second_a2": wb["Second"]["A2"].value}))',
      ].join('\n')
      const checked = runPython(code, [file])
      assert.equal(checked.ok, true, checked.error)
      const parsed = JSON.parse(checked.stdout)
      assert.deepEqual(parsed.sheets, ['Sheet1', 'Second'])
      assert.equal(parsed.b2, 99)
      assert.equal(parsed.a1, 'Name')
      assert.equal(parsed.second_a2, 1)
    }
  })
})

test('公式与样式在保存其它 cell 后保留（ExcelJS + openpyxl 双重校验）', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'formula.xlsx')
    const build = new ExcelJS.Workbook()
    const sheet = build.addWorksheet('Formula')
    sheet.getCell('A1').value = 2
    sheet.getCell('A2').value = 3
    sheet.getCell('A3').value = { formula: 'A1+A2' }
    sheet.getCell('B1').value = 'styled'
    sheet.getCell('B1').font = { bold: true, color: { argb: 'FFFF0000' } }
    sheet.getCell('B1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
    await build.xlsx.writeFile(file)

    const data = await readSheetFile(file, 'xlsx')
    const formulaCell = data.sheets[0].rows[2][0]
    assert.equal(formulaCell.f, 'A1+A2')
    assert.equal(formulaCell.v, null)

    await saveXlsxFile(file, [{ sheet: 'Formula', row: 2, col: 2, v: 'hello' }], {
      mtimeMs: data.mtimeMs,
      size: data.size,
    })

    const reloaded = new ExcelJS.Workbook()
    await reloaded.xlsx.readFile(file)
    const reSheet = reloaded.getWorksheet('Formula')
    assert.equal(reSheet.getCell('A3').value.formula, 'A1+A2')
    assert.equal(reSheet.getCell('B2').value, 'hello')
    assert.equal(reSheet.getCell('B1').font.bold, true)
    assert.equal(reSheet.getCell('B1').fill.fgColor.argb, 'FFFFFF00')

    if (hasOpenpyxl()) {
      const code = [
        'import json, sys, openpyxl',
        'wb = openpyxl.load_workbook(sys.argv[1])',
        'ws = wb["Formula"]',
        'print(json.dumps({"formula": ws["A3"].value, "b1": ws["B1"].value, "b1_bold": bool(ws["B1"].font.bold)}))',
      ].join('\n')
      const checked = runPython(code, [file])
      assert.equal(checked.ok, true, checked.error)
      const parsed = JSON.parse(checked.stdout)
      assert.equal(parsed.formula, '=A1+A2')
      assert.equal(parsed.b1, 'styled')
      assert.equal(parsed.b1_bold, true)
    }
  })
})

test('编辑公式单元格：写入新公式（无结果缓存）且旧公式被替换', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'edit-formula.xlsx')
    const build = new ExcelJS.Workbook()
    const sheet = build.addWorksheet('S')
    sheet.getCell('A1').value = 1
    sheet.getCell('B1').value = { formula: 'A1*2' }
    await build.xlsx.writeFile(file)

    const data = await readSheetFile(file, 'xlsx')
    await saveXlsxFile(file, [{ sheet: 'S', row: 1, col: 2, f: 'A1+10' }], {
      mtimeMs: data.mtimeMs,
      size: data.size,
    })
    const reloaded = new ExcelJS.Workbook()
    await reloaded.xlsx.readFile(file)
    assert.equal(reloaded.getWorksheet('S').getCell('B1').value.formula, 'A1+10')
  })
})

test('blank 编辑清空单元格', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'blank.xlsx')
    const build = new ExcelJS.Workbook()
    build.addWorksheet('S').getCell('A1').value = 'x'
    await build.xlsx.writeFile(file)
    const data = await readSheetFile(file, 'xlsx')
    await saveXlsxFile(file, [{ sheet: 'S', row: 1, col: 1, blank: true }], {
      mtimeMs: data.mtimeMs,
      size: data.size,
    })
    const reloaded = new ExcelJS.Workbook()
    await reloaded.xlsx.readFile(file)
    assert.equal(reloaded.getWorksheet('S').getCell('A1').value, null)
  })
})

test('版本守卫：外部改动 XLSX 后保存 → 409 conflict', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.xlsx')
    const data = await readSheetFile(file, 'xlsx')
    await fsp.appendFile(file, Buffer.from([0, 1, 2]))
    await assert.rejects(
      () => saveXlsxFile(file, [{ sheet: 'Sheet1', row: 2, col: 2, v: '1' }], { mtimeMs: data.mtimeMs, size: data.size }),
      (error) => error instanceof WbError && error.status === 409 && error.code === 'conflict',
    )
  })
})

test('空 edits 不落盘，直接返回当前版本', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.xlsx')
    const data = await readSheetFile(file, 'xlsx')
    const before = await fsp.stat(file)
    const result = await saveXlsxFile(file, [], { mtimeMs: data.mtimeMs, size: data.size })
    assert.equal(result.ok, true)
    assert.deepEqual(result.lossy, [])
    assert.equal(result.mtimeMs, data.mtimeMs)
    const after = await fsp.stat(file)
    assert.equal(after.size, before.size)
  })
})

test('非法 edits（不存在的 sheet / 非法坐标）→ 400 bad_edit', async () => {
  await withTempDir(async (dir) => {
    const file = await copySample(dir, 'sample.xlsx')
    const data = await readSheetFile(file, 'xlsx')
    const version = { mtimeMs: data.mtimeMs, size: data.size }
    await assert.rejects(
      () => saveXlsxFile(file, [{ sheet: 'Nope', row: 1, col: 1, v: 'x' }], version),
      (error) => error instanceof WbError && error.status === 400 && error.code === 'bad_edit',
    )
    await assert.rejects(
      () => saveXlsxFile(file, [{ sheet: 'Sheet1', row: 0, col: 1, v: 'x' }], version),
      (error) => error instanceof WbError && error.status === 400 && error.code === 'bad_edit',
    )
    await assert.rejects(
      () => saveXlsxFile(file, [{ sheet: 'Sheet1', row: 1, col: 0, v: 'x' }], version),
      (error) => error instanceof WbError && error.status === 400,
    )
  })
})

test('损坏的 XLSX → 400 bad_xlsx 可读错误', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'broken.xlsx')
    await fsp.writeFile(file, Buffer.from('this is not a zip file'))
    await assert.rejects(
      () => readSheetFile(file, 'xlsx'),
      (error) => error instanceof WbError && error.status === 400 && error.code === 'bad_xlsx',
    )
  })
})

test('单元格数超 30 万 → 413 too_large', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'big.xlsx')
    const build = new ExcelJS.Workbook()
    const sheet = build.addWorksheet('Big')
    // 稀疏的远端单元格：ExcelJS 只写两个 cell，但 rowCount/columnCount 很大
    sheet.getCell('A1').value = 'x'
    sheet.getCell('ZZ100000').value = 'y'
    await build.xlsx.writeFile(file)
    await assert.rejects(
      () => readSheetFile(file, 'xlsx'),
      (error) => error instanceof WbError && error.status === 413 && error.code === 'too_large',
    )
  })
})

test('detectFeatures：图表/图片/透视表/条件格式都能识别，lossy 与 warnings 文案一致', () => {
  const buffer = Buffer.concat([
    Buffer.from('PK\u0003\u0004dummy'),
    Buffer.from('xl/charts/chart1.xml', 'latin1'),
    Buffer.from('xl/pivotTables/pivotTable1.xml', 'latin1'),
    Buffer.from('xl/media/image1.png', 'latin1'),
  ])
  const workbook = { worksheets: [{ conditionalFormattings: [{}] }], media: [{}] }
  const features = detectFeatures(buffer, workbook)
  assert.deepEqual(features, { charts: true, images: true, pivot: true, conditionalFormatting: true })
  assert.deepEqual(lossyLabels(features), ['图表', '图片', '数据透视表'])
  assert.equal(warningsFor(features).length, 4)
  assert.deepEqual(lossyLabels({}), [])
  assert.deepEqual(warningsFor({}), [])
})

test('normalizeXlsxCell：富文本/公式/日期/错误/超链接归一', () => {
  assert.deepEqual(normalizeXlsxCell(null), { v: null })
  assert.deepEqual(normalizeXlsxCell('abc'), { v: 'abc', t: 's' })
  assert.deepEqual(normalizeXlsxCell(2.5), { v: 2.5, t: 'n' })
  assert.deepEqual(normalizeXlsxCell(true), { v: true, t: 'b' })
  assert.deepEqual(normalizeXlsxCell(new Date('2026-11-04T00:00:00.000Z')), { v: '2026-11-04T00:00:00.000Z', t: 'd' })
  assert.deepEqual(
    normalizeXlsxCell({ richText: [{ text: '你' }, { text: '好' }] }),
    { v: '你好', t: 's' },
  )
  assert.deepEqual(
    normalizeXlsxCell({ formula: '=A1+A2', result: 5 }),
    { v: 5, t: 'n', f: 'A1+A2' },
  )
  assert.deepEqual(normalizeXlsxCell({ formula: 'A1' }), { v: null, f: 'A1' })
  assert.deepEqual(normalizeXlsxCell({ error: '#N/A' }), { v: '#N/A', t: 's' })
  assert.deepEqual(normalizeXlsxCell({ text: '链接', hyperlink: 'https://example.com' }), { v: '链接', t: 's' })
})

test('coerceCellValue：按原单元格类型派生新值的类型', () => {
  assert.equal(coerceCellValue(1, '4.5'), 4.5)
  assert.equal(coerceCellValue('text', '4.5'), '4.5')
  assert.equal(coerceCellValue(true, 'false'), false)
  assert.equal(coerceCellValue(false, 'true'), true)
  assert.equal(coerceCellValue({ formula: 'A1', result: 7 }, '8'), 8)
  const date = coerceCellValue(new Date('2020-01-01T00:00:00Z'), '2026-11-04T00:00:00.000Z')
  assert.ok(date instanceof Date)
  assert.equal(date.toISOString(), '2026-11-04T00:00:00.000Z')
  assert.equal(coerceCellValue('x', null), null)
  assert.equal(coerceCellValue(1, 'not-a-number'), 'not-a-number')
})
