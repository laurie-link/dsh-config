/**
 * dsh-vscode-mode client — 编辑区「还有没有打开的文件」广播。
 *
 * 背景（2026-11-05）：dsh-cursor-layout 把 IDE 视图 / Agent 视图按会话分别记住，默认
 * 是 IDE 视图。一个没打开任何文件的会话停在 IDE 视图只剩「暂无打开的文件」，没有可看
 * 的内容；布局插件需要「该会话的编辑区是不是空的」这一事实来：
 *   1. 切到空编辑区的会话时直接给 Agent 视图（不再先闪一下空的工作台）；
 *   2. 用户关掉最后一个文件页签（页签数 >0 → 0）时自动回 Agent 视图。
 *
 * 事实来源按可信度分两级，本模块是唯一出口（布局插件不嗅探编辑器 DOM / 存档格式）：
 *   - 内存 `liveCounts`：EditorView 每次挂载 / 增删页签后广播的最新真实值
 *     （会话卸载后条目保留，切回去仍能回答）；
 *   - localStorage 存档：EditorView 按「工作区 + 会话」落盘的页签 / 分组布局
 *     （重启后 EditorView 尚未挂载、或编辑区面板没打开时也能回答）。
 *   两级都没有 → 0：没有任何存档就是没打开过文件（空编辑区）。只有 storage 不可用 /
 *   存档损坏这类「读不到」才返回 undefined，消费方按未知处理、不得当成空。
 *
 * 广播形态：`window` 上的 `edrv:editor-presence` CustomEvent，detail 为
 * `{ sessionId, tabCount, activePath }`；同步查询走浏览器全局
 * `window.__edrvEditorPresence__.editorFileCount(sessionId)`（number 或 undefined）。
 * 存档解析是纯逻辑（storage 可注入），可在 node 环境单测。
 * @author DSH local session 2026年11月05号
 */
import { CACHE_KEY } from './paths.js'

/** 页签数变化广播事件名（EditorView 每次挂载 / 增删页签后派发一次）。 */
export const EDITOR_PRESENCE_EVENT = 'edrv:editor-presence'

/** 浏览器全局查询桥的名字（第三方 / 诊断用；由 `installEditorPresenceBridge` 装配）。 */
export const EDITOR_PRESENCE_GLOBAL = '__edrvEditorPresence__'

/** 广播负载：会话 id + 当前编辑区页签数 + 活动文件。 */
export interface EditorPresence {
  /** 会话 id（空会话没有编辑区，EditorView 不广播）。 */
  sessionId: string
  /** 该会话当前打开的磁盘文件页签数（0 = 空编辑区）。 */
  tabCount: number
  /** 活动文件路径（可为 null）。 */
  activePath: string | null
}

/** 存档读取所需的最小 Storage 面（测试可注入内存桩）。 */
export interface PresenceStorage {
  /** 键数量。 */
  readonly length: number
  /** 按序号取键名。 */
  key(index: number): string | null
  /** 按键取值。 */
  getItem(key: string): string | null
}

/** 全局查询桥的形态（`window.__edrvEditorPresence__`）。 */
export interface EditorPresenceBridge {
  /** 桥 schema 版本（消费方按需兼容）。 */
  version: string
  /**
   * 会话的文件页签数：实时广播优先，其次「工作区 + 会话」存档；
   * 没有存档 = 0（没打开过文件）；会话 id 缺失 / storage 不可用 / 存档损坏返回 undefined。
   * @param sessionId 会话 id
   * @returns 页签数（0 = 空编辑区）或 undefined（未知）
   */
  editorFileCount(sessionId: string | undefined): number | undefined
  /** 只读内存里的实时值（不含存档兜底，诊断用）。 */
  liveEditorFileCount(sessionId: string | undefined): number | undefined
  /** 只读「工作区 + 会话」存档里的页签数（诊断用）。 */
  savedEditorFileCount(sessionId: string | undefined): number | undefined
}

/** EditorView 广播过的「会话 → 真实页签数」（最后写入者胜）。 */
const liveCounts = new Map<string, number>()

/** 非负整数页签数（负数 / NaN / 小数一律收敛到合法值）。 */
function normalizeCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.floor(count)
}

/** 非空字符串或 undefined。 */
function sessionIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 广播一个会话的编辑区页签数（EditorView 在页签恢复 / 增删完成后调用）。
 * 无窗环境（node 单测）只更新内存，不派发事件。
 * @author DSH local session 2026年11月05号
 * @param presence 会话 id + 页签数 + 活动文件
 */
export function publishEditorPresence(presence: EditorPresence): void {
  const sessionId = sessionIdOf(presence?.sessionId)
  if (!sessionId) return
  const tabCount = normalizeCount(presence?.tabCount)
  const activePath = typeof presence?.activePath === 'string' && presence.activePath.length > 0
    ? presence.activePath
    : null
  liveCounts.set(sessionId, tabCount)
  try {
    window.dispatchEvent(new CustomEvent(EDITOR_PRESENCE_EVENT, {
      detail: { sessionId, tabCount, activePath },
    }))
  } catch {
    /* 无 window / 无 CustomEvent（测试）：仅内存更新 */
  }
}

/**
 * 读内存里的实时页签数。
 * @author DSH local session 2026年11月05号
 * @param sessionId 会话 id
 * @returns 页签数；该会话从未广播过返回 undefined
 */
export function liveEditorFileCount(sessionId: unknown): number | undefined {
  const id = sessionIdOf(sessionId)
  if (!id) return undefined
  const count = liveCounts.get(id)
  return typeof count === 'number' ? count : undefined
}

/** 解析「页签存档」（`{ tabs: [{ path }], active }`）里的页签数；形状不对 → undefined。 */
function countTabsArchive(raw: string | null): number | undefined {
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    const tabs = (parsed as { tabs?: unknown } | null)?.tabs
    return Array.isArray(tabs) ? tabs.length : undefined
  } catch {
    return undefined
  }
}

/** 解析「分组布局存档」（`{ v: 1, groups: [{ tabs: [] }] }`）里的页签总数；形状不对 → undefined。 */
function countLayoutArchive(raw: string | null): number | undefined {
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    const groups = (parsed as { groups?: unknown } | null)?.groups
    if (!Array.isArray(groups)) return undefined
    let total = 0
    for (const group of groups) {
      const tabs = (group as { tabs?: unknown } | null)?.tabs
      if (Array.isArray(tabs)) total += tabs.length
    }
    return total
  } catch {
    return undefined
  }
}

/**
 * 从「工作区 + 会话」存档读出页签数：分组布局键优先（与 EditorView 的恢复顺序一致），
 * 页签键兜底。键形如 `<前缀><scope>|<sessionId>`，按后缀匹配会话，无需知道 scope。
 * 没有该会话的任何存档 = 没打开过文件 = 0；只有 storage 不可用 / 存档损坏才返回
 * undefined（未知，消费方不得当成空编辑区）。
 * @author DSH local session 2026年11月05号
 * @param sessionId 会话 id
 * @param storage 存档（缺省 window.localStorage；测试可注入）
 * @returns 页签数；读不到（storage 不可用 / 存档损坏）返回 undefined
 */
export function savedEditorFileCount(sessionId: unknown, storage?: PresenceStorage | null): number | undefined {
  const id = sessionIdOf(sessionId)
  if (!id) return undefined
  let store: PresenceStorage | null
  try {
    store = storage ?? (typeof window === 'undefined' ? null : window.localStorage)
  } catch {
    return undefined
  }
  if (!store) return undefined
  const suffix = '|' + id
  let tabsKey: string | null = null
  let layoutKey: string | null = null
  let length = 0
  try {
    length = store.length
  } catch {
    return undefined
  }
  for (let index = 0; index < length; index += 1) {
    let key: string | null = null
    try {
      key = store.key(index)
    } catch {
      key = null
    }
    if (key === null || !key.endsWith(suffix)) continue
    if (tabsKey === null && key.startsWith(CACHE_KEY.editorSession)) tabsKey = key
    else if (layoutKey === null && key.startsWith(CACHE_KEY.editorLayoutSession)) layoutKey = key
  }
  // 没有任何「工作区 + 会话」存档 = 这个会话没打开过文件 = 空编辑区
  if (tabsKey === null && layoutKey === null) return 0
  try {
    const layoutCount = layoutKey === null ? undefined : countLayoutArchive(store.getItem(layoutKey))
    if (typeof layoutCount === 'number') return layoutCount
    const tabsCount = tabsKey === null ? undefined : countTabsArchive(store.getItem(tabsKey))
    if (typeof tabsCount === 'number') return tabsCount
  } catch {
    return undefined
  }
  // 存档都在但都解析不出页签数组（损坏 / 旧形状）：按未知处理，消费方不会误判成「空」
  return undefined
}

/**
 * 会话的文件页签数：实时广播优先，其次存档兜底。
 * @author DSH local session 2026年11月05号
 * @param sessionId 会话 id
 * @param storage 存档（缺省 window.localStorage；测试可注入）
 * @returns 页签数（0 = 空编辑区 / 没有存档）或 undefined（storage 不可用 / 存档损坏）
 */
export function editorFileCount(sessionId: unknown, storage?: PresenceStorage | null): number | undefined {
  const live = liveEditorFileCount(sessionId)
  if (live !== undefined) return live
  return savedEditorFileCount(sessionId, storage)
}

/**
 * 装配浏览器全局查询桥 `window.__edrvEditorPresence__`（幂等；HMR 重挂重复调用只覆盖）。
 * @author DSH local session 2026年11月05号
 * @returns 注销器（只在全局仍归本次安装时删除）
 */
export function installEditorPresenceBridge(): () => void {
  if (typeof window === 'undefined') return () => {}
  const host = window as unknown as Record<string, unknown>
  const bridge: EditorPresenceBridge = {
    // 2：没有存档 = 0（空编辑区）；1：没有存档 = undefined。消费方按 undefined=未知处理即可兼容。
    version: '2',
    editorFileCount: (sessionId) => editorFileCount(sessionId),
    liveEditorFileCount: (sessionId) => liveEditorFileCount(sessionId),
    savedEditorFileCount: (sessionId) => savedEditorFileCount(sessionId),
  }
  host[EDITOR_PRESENCE_GLOBAL] = bridge
  return () => {
    if (host[EDITOR_PRESENCE_GLOBAL] === bridge) delete host[EDITOR_PRESENCE_GLOBAL]
  }
}
