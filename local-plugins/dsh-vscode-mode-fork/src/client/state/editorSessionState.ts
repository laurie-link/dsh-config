/**
 * dsh-vscode-mode client — 编辑区「按对话」状态键。
 *
 * 背景：页签 / 活动文件 / 分组布局原先按「工作区」持久化，同一工作区里的所有对话共享一份
 * 编辑区状态：在 A 对话打开 A 文件，切到 B 对话改 B 文件，再切回 A 时看到的是 B 文件。
 * 本模块把这三项状态的键扩展成 `工作区作用域|会话 id`，让每个对话各留各的编辑区；
 * model 缓存 / 文档缓冲 / 预览态仍按工作区共享（同一文件在两个对话里必须是同一份缓冲，
 * 不能各拿一份，否则未保存修改会互相覆盖）。
 *
 * 键语法沿用 localStorage 前缀表（paths.ts），本模块只负责拼接 / 读写 / 一次性迁移；
 * 页签归一化与布局解析仍在 EditorView（那里才有 cwd、DELEGATED_EXT_SET 等上下文）。
 * 纯逻辑依赖注入（storage 可替换），可在 node 环境单测。
 * @author DSH user session 2026年11月05号
 */

import { CACHE_KEY } from '../paths.js'

/** localStorage 最小接口（注入内存桩便于 node 单测）。 */
export interface EditorSessionStorage {
  /** 读键值。 */
  getItem(key: string): string | null
  /** 写键值（可能抛配额错误，调用方负责兜底）。 */
  setItem(key: string, value: string): void
  /** 删键。 */
  removeItem(key: string): void
}

/**
 * 编辑区状态键的会话段：`<工作区作用域>|<会话 id>`。
 * 作用域键形如 `ws:/path` / `sid:<id>`，会话 id 不含 `|`，拼接无歧义。
 * @param scope 工作区作用域键（scopeStore.workspaceScopeOf 产物）
 * @param sessionId 会话 id
 * @returns 会话段字符串
 */
export function editorSessionKey(scope: string, sessionId: string): string {
  return String(scope) + '|' + String(sessionId)
}

/**
 * 页签 / 活动文件的 localStorage 键（按「工作区 + 会话」）。
 * @param scope 工作区作用域键
 * @param sessionId 会话 id
 * @returns 完整键名
 */
export function editorTabsKey(scope: string, sessionId: string): string {
  return CACHE_KEY.editorSession + editorSessionKey(scope, sessionId)
}

/**
 * 编辑区分组布局的 localStorage 键（按「工作区 + 会话」）。
 * @param scope 工作区作用域键
 * @param sessionId 会话 id
 * @returns 完整键名
 */
export function editorLayoutKey(scope: string, sessionId: string): string {
  return CACHE_KEY.editorLayoutSession + editorSessionKey(scope, sessionId)
}

/**
 * 一次性迁移：把旧「工作区级」编辑区存档复制到当前对话名下，并删除旧工作区级键。
 *
 * 只在当前对话还没有任何会话级存档时迁移，且迁移成功后删除旧键——保证升级后**只有当前对话**
 * 继承旧存档，同工作区里的其它对话从空编辑区开始（这正是「按对话隔离」要的行为）。
 * 迁移是写入优先、删除在后的形状：写失败时保留旧键，下次挂载还能重试。
 * @param storage localStorage 或测试用内存桩
 * @param scope 工作区作用域键
 * @param sessionId 会话 id
 * @returns 是否迁移了任一键
 */
export function migrateWorkspaceEditorState(
  storage: EditorSessionStorage,
  scope: string,
  sessionId: string,
): boolean {
  if (!sessionId) return false
  const tabsKey = editorTabsKey(scope, sessionId)
  const layoutKey = editorLayoutKey(scope, sessionId)
  let hasSessionState = false
  try {
    hasSessionState = storage.getItem(tabsKey) !== null || storage.getItem(layoutKey) !== null
  } catch {
    return false
  }
  if (hasSessionState) return false
  const workspaceTabs = CACHE_KEY.editor + String(scope)
  const workspaceLegacy = CACHE_KEY.editorLegacy + String(scope)
  const workspaceLayout = CACHE_KEY.editorLayout + String(scope)
  let migrated = false
  try {
    const tabs = storage.getItem(workspaceTabs) ?? storage.getItem(workspaceLegacy)
    if (tabs !== null) {
      storage.setItem(tabsKey, tabs)
      migrated = true
    }
    const layout = storage.getItem(workspaceLayout)
    if (layout !== null) {
      storage.setItem(layoutKey, layout)
      migrated = true
    }
  } catch {
    return migrated
  }
  if (migrated) {
    // 写成功后才清旧键：清失败也无害（下次因会话键已存在而不再迁移）
    try {
      storage.removeItem(workspaceTabs)
      storage.removeItem(workspaceLegacy)
      storage.removeItem(workspaceLayout)
    } catch {
      /* 配额 / 隐私模式：旧键残留不影响正确性 */
    }
  }
  return migrated
}
