/**
 * dsh-workbench-sheets — 文件读写与版本守卫。
 * 写入采用「同目录临时文件 + rename」，避免写到一半失败把原文件截断；
 * 写前用 mtimeMs/size 做乐观并发守卫，外部改动过就 409 拒绝。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { wbError } from './errors.js'

/** 读取文件 stat 并转成插件内部版本信息（目录直接报错）。 */
export async function statFile(absPath) {
  const stat = await fsp.stat(absPath)
  if (stat.isDirectory()) throw wbError(400, 'is_directory', '目标是目录，不能作为文件打开')
  return { mtimeMs: stat.mtimeMs, size: stat.size, mode: stat.mode }
}

/**
 * 版本守卫：客户端读文件时拿到的 mtimeMs/size 必须与当前磁盘一致。
 * mtime 用 0.5ms 容差（JSON 往返与文件系统精度都可能带来浮点尾差）；
 * size 必须严格相等——大小变了说明内容一定变了。
 */
export function assertFresh(expected, actual) {
  const mtimeMs = Number(expected && expected.mtimeMs)
  const size = Number(expected && expected.size)
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) {
    throw wbError(400, 'bad_version', '缺少文件版本信息（mtimeMs/size），请重新加载后再保存')
  }
  if (Math.abs(actual.mtimeMs - mtimeMs) > 0.5 || actual.size !== size) {
    throw wbError(409, 'conflict', '文件已被外部修改，请重新加载后再保存')
  }
}

/** 原子写入：同目录临时文件 + rename；失败时清理临时文件。 */
export async function writeFileAtomic(absPath, buffer, options = {}) {
  const dir = path.dirname(absPath)
  const tmp = path.join(
    dir,
    '.' + path.basename(absPath) + '.wbs-tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8),
  )
  const mode = typeof options.mode === 'number' ? options.mode & 0o777 : undefined
  try {
    await fsp.writeFile(tmp, buffer, mode === undefined ? undefined : { mode })
    await fsp.rename(tmp, absPath)
  } catch (error) {
    try { await fsp.unlink(tmp) } catch { /* 临时文件可能都没创建成功 */ }
    throw error
  }
}

/** 读取整文件（调用方需先做尺寸上限判断）。 */
export async function readFileBuffer(absPath) {
  return fsp.readFile(absPath)
}
