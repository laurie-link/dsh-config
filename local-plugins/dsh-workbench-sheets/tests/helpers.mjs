/**
 * 测试公共工具：临时目录、真实样例文件副本、python3/openpyxl 交叉校验。
 * 所有测试都在 /tmp 副本上进行，绝不修改 ~/Documents/视频/_dsh-preview-test 里的原件。
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')

/**
 * 样例文件目录：优先用 Lead 的验收目录（存在时），否则用自建 fixture。
 * 测试必须自给自足：验收目录被清理后（本次交付收尾就会删掉）测试仍要全绿。
 */
export const SAMPLE_DIR = path.join(os.homedir(), 'Documents', '视频', '_dsh-preview-test')

/** 生成与验收样例一致的 CSV（4 列 21 行、CRLF、无 BOM）。 */
async function writeSampleCsv(target) {
  const escape = (value) => (/[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value)
  const lines = ['name,qty,price,note']
  for (let i = 1; i <= 20; i += 1) {
    const note = i % 5 === 0 ? '含逗号, test' : ''
    lines.push(['item-' + i, String(i * 3), (i * 1.5).toFixed(1), note].map(escape).join(','))
  }
  await fsp.writeFile(target, lines.join('\r\n') + '\r\n', 'utf8')
}

/** 生成与验收样例一致的 XLSX（Sheet1：Name/Qty/Price + 10 行；Second：A/B）。 */
async function writeSampleXlsx(target) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow(['Name', 'Qty', 'Price'])
  for (let i = 1; i <= 10; i += 1) sheet.addRow(['Item ' + i, i, i * 2.5])
  const second = workbook.addWorksheet('Second')
  second.addRow(['A', 'B'])
  second.addRow([1, 2])
  await workbook.xlsx.writeFile(target)
}

/** 样例缺失时生成（仅供测试，不写用户目录）。 */
async function writeFixture(dir, name) {
  const target = path.join(dir, name)
  if (name.endsWith('.csv')) await writeSampleCsv(target)
  else if (name.endsWith('.xlsx')) await writeSampleXlsx(target)
  else throw new Error('没有 ' + name + ' 的测试 fixture 生成器')
  return target
}

/** 建临时目录（调用方负责清理；推荐用 withTempDir）。 */
export async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wbs-test-'))
}

/** 在临时目录里执行回调，结束后递归删除。 */
export async function withTempDir(fn) {
  const dir = await makeTempDir()
  try {
    return await fn(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

/** 把样例复制进临时目录并返回副本路径；验收目录不存在时用内建 fixture 生成。 */
export async function copySample(dir, name) {
  const source = path.join(SAMPLE_DIR, name)
  const target = path.join(dir, name)
  try {
    await fsp.copyFile(source, target)
    return target
  } catch (error) {
    if (error && error.code === 'ENOENT') return writeFixture(dir, name)
    throw error
  }
}

/** 跑一段 python 代码（args 追加到 sys.argv[1:）。 */
export function runPython(code, args = []) {
  const result = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8' })
  if (result.error) return { ok: false, error: String(result.error) }
  if (result.status !== 0) return { ok: false, error: result.stderr || 'python3 退出码 ' + result.status }
  return { ok: true, stdout: result.stdout.trim() }
}

/** 本机是否装了 openpyxl（缺了对应用例跳过，不让测试环境失败）。 */
export function hasOpenpyxl() {
  return runPython('import openpyxl').ok
}
