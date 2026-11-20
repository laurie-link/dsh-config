/**
 * dsh-vscode-mode client — DSH 对话文件链接的统一打开路由。
 * openPath 补丁经 compat.patchMethod 安装（链式恢复，多插件补丁互不踩踏）。
 * 作者 ddj 2026年08月24号
 */
import { patchMethod } from './compat.js'
import { openEditorView } from './events.js'
import { AUTO_OPEN_TOOL, VSCODE_OPEN_TOOL, type FileOpenContext, type FileOpenerRegistry, isAvailable, selectOpener } from './fileOpeners.js'
import { isMediaPath } from '../shared/nativeOpen.js'

/**
 * 媒体打开事件（window CustomEvent）：`detail = { path }`。
 * cursor-layout 监听它把 Agent 视图切回 IDE 视图（编辑区在那个视图里可见），
 * 使「对话里点视频/图片 → 右边直接用编辑区预览」在键盘/命令等非点击路径下也成立。
 */
export const MEDIA_OPEN_EVENT = 'edrv:media-open'

export interface OpenPathRouterOptions {
  workspaces: { openPath: (path: string) => Promise<void> }
  registry: FileOpenerRegistry
  selected: () => string
  context: () => FileOpenContext
  logger?: (message: string) => void
}

/**
 * 安装可卸载的 workspaces.openPath 路由。
 * @author ddj 2026年08月24号
 * @param options 路由依赖
 * @returns 恢复原方法的 disposer
 */
export function installOpenPathRouter(options: OpenPathRouterOptions): () => void {
  /**
   * 媒体（视频/图片）专用路由：无视「文件链接使用工具」设置，一律交给本插件编辑区。
   * 原因：官方查看器与 better-sidebar 的编辑器对视频只会显示「此文件类型不支持
   * 预览」，而本插件编辑区有视频预览面板 / 图片预览面板（见 MEDIA_EXT）。
   * @returns 已处理（打开成功）时为 true
   */
  const openMedia = async (path: string, context: FileOpenContext): Promise<boolean> => {
    const mediaOpener = options.registry.get(VSCODE_OPEN_TOOL)
    if (!mediaOpener || !isAvailable(mediaOpener)) return false
    await mediaOpener.open(path, context)
    try {
      window.dispatchEvent(new CustomEvent(MEDIA_OPEN_EVENT, { detail: { path } }))
    } catch (error) { /* 事件只是布局提示，派发失败不影响打开 */ }
    return true
  }

  const open = async (original: (path: string) => Promise<void>, path: string): Promise<void> => {
    const context = options.context()
    if (isMediaPath(path)) {
      try {
        if (await openMedia(path, context)) return
      } catch (error) {
        options.logger?.('媒体文件打开失败，回退默认路由: ' + String(error))
      }
    }
    const opener = selectOpener(options.registry, options.selected())
    if (!opener || !isAvailable(opener)) return original.call(options.workspaces, path)
    try {
      await opener.open(path, context)
    } catch (error) {
      options.logger?.('文件打开器 ' + opener.id + ' 失败，回退系统打开: ' + String(error))
      if (opener.id !== 'system') await original.call(options.workspaces, path)
      else throw error
    }
  }
  return patchMethod(options.workspaces, 'openPath', open as never)
}

/**
 * 创建 VSCodeMode 内置文件打开器。
 * @author ddj 2026年08月24号
 * @returns VSCodeMode 打开器
 */
export function vscodeOpener(): { id: string; label: string; priority: number; open: (path: string) => void } {
  return { id: VSCODE_OPEN_TOOL, label: 'VSCodeMode', priority: 100, open: (path) => openEditorView(path) }
}

/**
 * 规范化设置中的打开器 id。
 * @author ddj 2026年08月24号
 * @param value 原始设置值
 * @returns 可路由的打开器 id
 */
export function autoValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : AUTO_OPEN_TOOL
}
