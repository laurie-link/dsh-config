/**
 * dsh-vscode-mode client — HTML 渲染预览态缓存（localStorage，按工作区作用域）。
 * 语义对齐 Markdown 预览态：切换页签/刷新/重启后，处于渲染预览的 HTML 仍以预览打开。
 * 键 = CACHE_KEY.htmlPreview + scope；值为路径数组。解析/归一化纯函数可单测，IO 收在 load/save 两端。
 * 作者 ddj 2026年11月04号
 */
import { CACHE_KEY } from '../paths.js'

/** 单作用域记忆的预览态路径上限（超出按顺序丢弃最早，防 localStorage 膨胀）。 */
export const HTML_PREVIEW_CAP = 50

/**
 * 归一化预览态路径表：丢弃非字符串/空串、去重（保留首次出现顺序），超限截断。
 * @author ddj 2026年11月04号
 * @param value 待归一化的解析产物（任意输入，非数组 → 空表）
 * @returns 路径数组
 */
export function normalizeHtmlPreview(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item) continue
    if (out.includes(item)) continue
    out.push(item)
    if (out.length >= HTML_PREVIEW_CAP) break
  }
  return out
}

/**
 * 解析存档文本（空/损坏/非数组 → 空表）。
 * @author ddj 2026年11月04号
 * @param text localStorage 原文
 * @returns 路径数组
 */
export function parseHtmlPreview(text: string | null): string[] {
  if (!text) return []
  try {
    return normalizeHtmlPreview(JSON.parse(text))
  } catch (error) {
    return []
  }
}

/**
 * 读某作用域处于渲染预览的 HTML 路径集合。
 * @author ddj 2026年11月04号
 * @param scope 作用域键（scopeStore.workspaceScopeOf 产物）
 * @returns 预览态路径集合（存储不可用/无存档 → 空集）
 */
export function htmlPreviewLoad(scope: string): Set<string> {
  try {
    return new Set(parseHtmlPreview(localStorage.getItem(CACHE_KEY.htmlPreview + scope)))
  } catch (error) {
    return new Set()
  }
}

/**
 * 写某作用域的渲染预览态集合（空集删除键，避免残留空数组）。
 * @author ddj 2026年11月04号
 * @param scope 作用域键
 * @param paths 预览态路径集合
 */
export function htmlPreviewSave(scope: string, paths: Set<string>): void {
  try {
    const list = normalizeHtmlPreview(Array.from(paths))
    if (!list.length) {
      localStorage.removeItem(CACHE_KEY.htmlPreview + scope)
      return
    }
    localStorage.setItem(CACHE_KEY.htmlPreview + scope, JSON.stringify(list))
  } catch (error) { /* 存储不可用：预览态仅存活本次会话 */ }
}
