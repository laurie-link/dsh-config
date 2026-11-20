/**
 * dsh-workbench-sheets — 错误类型与 HTTP 分类。
 * 路由只捕获异常并转成 { ok:false, error, code }，绝不把内部堆栈暴露给客户端；
 * 文件系统错误按 err.code 归类成可读中文，其余归为 500。
 */

/** 带 HTTP 语义的插件错误（路由层统一转 JSON）。 */
export class WbError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'WbError'
    this.status = status
    this.code = code
  }
}

/** 构造 WbError 的简写。 */
export function wbError(status, code, message) {
  return new WbError(status, code, message)
}

/** node:fs 常见错误码 → [HTTP 状态, 业务码, 可读文案]。 */
const FS_ERRORS = {
  ENOENT: [404, 'not_found', '文件不存在（可能已被移动或删除）'],
  EACCES: [403, 'forbidden', '没有权限读写该文件'],
  EPERM: [403, 'forbidden', '没有权限读写该文件'],
  EISDIR: [400, 'is_directory', '目标是目录，不能作为文件打开'],
  ENOSPC: [507, 'no_space', '磁盘空间不足，保存失败'],
  ENAMETOOLONG: [400, 'bad_path', '文件路径过长'],
  EROFS: [403, 'read_only', '目标文件所在的磁盘是只读的'],
}

/**
 * 任意异常 → { status, body }（路由层直接返回）。
 * body 形如 { ok:false, error, code }。
 */
export function toHttpError(error) {
  if (error instanceof WbError) {
    return { status: error.status, body: { ok: false, error: error.message, code: error.code } }
  }
  const fsCode = error && typeof error.code === 'string' ? error.code : undefined
  if (fsCode && FS_ERRORS[fsCode]) {
    const [status, code, message] = FS_ERRORS[fsCode]
    return { status, body: { ok: false, error: message, code } }
  }
  const message = String((error && error.message) || error)
  return { status: 500, body: { ok: false, error: '服务器内部错误：' + message, code: 'internal' } }
}
