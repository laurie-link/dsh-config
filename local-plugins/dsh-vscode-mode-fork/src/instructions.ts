/**
 * dsh-vscode-mode host —— 「实际注入的指令文件」发现（AGENTS.md 指令链，只读）。
 *
 * 口径与 DSH 核心 `@deepseek-ai/dsh-agent-instructions` 对齐（2026-11 版实现）：
 * - 用户链：`$DSH_HOME/AGENTS.md` → `$DSH_AGENTS_HOME|~/.agents/AGENTS.md`，两条共用一条预算链，
 *   无 `.local` overlay；同名不算重复，按内容去重。
 * - 项目链：从项目根（最近的含 `.git` 祖先，找不到则回落会话 cwd）到 cwd 的每个目录，
 *   依次取 `AGENTS.md` / `CLAUDE.md` 基础候选与 `AGENTS.local.md` / `CLAUDE.local.md` overlay；
 *   同一目录内的候选组按「去首尾空白后的内容」去重（复制一份的 CLAUDE.md 只渲染一次）。
 * - 预算：用户链与项目链各 64 KiB（核心默认），超预算的宽泛文件被省略、最后的具体文件被截断；
 *   本模块只做粗算标记，供面板提示，不参与真实注入。
 * 不写盘、不改语义：真实注入仍由核心插件完成，这里只回答「模型实际会读到哪些文件」。
 *
 * 作者 ddj 2026年11月05号
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { dshHome } from './paths.js'
import { listSkillCatalog } from './skillCatalog.js'
import type {
  InstructionEntry,
  InstructionScope,
  InstructionSkill,
  InstructionView,
} from './shared/instructions.js'

// --region 常量（与核心默认值一致）
/** 共享 agents 根的环境变量名。 */
export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'
/** 共享 agents 根目录名（home 下）。 */
const AGENTS_DIR_NAME = '.agents'
/** 项目链每个目录的基础候选（按序加载，内容相同则折叠）。 */
export const INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
/** 项目链每个目录的本地 overlay 候选（在基础候选之后加载）。 */
export const LOCAL_INSTRUCTION_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const
/** 项目根标记（目录式与文件式 .git 都算命中）。 */
export const PROJECT_ROOT_MARKERS = ['.git'] as const
/** 用户链单个文件的候选名（用户根不带 .local overlay）。 */
const USER_INSTRUCTION_FILE = 'AGENTS.md'
/** 每条链的字节预算（核心默认 maxBytes）。 */
export const INSTRUCTION_MAX_BYTES = 65536
/** 单个源文件读取上限（超出只统计大小，不参与内容去重）。 */
const SOURCE_MAX_BYTES = 1024 * 1024
// --endregion

// --region 路径解析（纯）
/**
 * 共享 agents 根：`$DSH_AGENTS_HOME` 优先，否则 `~/.agents`。
 * @author ddj 2026年11月05号
 * @param env 环境变量表（测试可注入）
 * @returns 绝对路径
 */
export function agentsHomeDir(env: Record<string, string | undefined> = process.env): string {
  const value = env[AGENTS_HOME_ENV]
  const path = value && value.trim() ? value.trim() : join(homedir(), AGENTS_DIR_NAME)
  if (path === '~') return resolve(homedir())
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(join(homedir(), path.slice(2)))
  return resolve(path)
}

/**
 * 是否存在任一项目根标记（目录式 / 文件式都算）。
 * @author ddj 2026年11月05号
 * @param dir 候选目录
 * @param markers 标记名
 * @returns 命中标记名或 null
 */
export function projectRootMarkerOf(dir: string, markers: readonly string[] = PROJECT_ROOT_MARKERS): string | null {
  for (const marker of markers) if (existsSync(join(dir, marker))) return marker
  return null
}

/**
 * 向上找项目根：最近的含标记祖先；到文件系统根仍未命中则回落 cwd（与核心一致）。
 * @author ddj 2026年11月05号
 * @param cwd 会话工作区
 * @param markers 标记名
 * @returns 项目根与命中标记（回落时 marked=false）
 */
export function findInstructionRoot(
  cwd: string,
  markers: readonly string[] = PROJECT_ROOT_MARKERS,
): { root: string; marked: boolean; marker: string | null } {
  const start = resolve(cwd)
  let current = start
  // 与核心一致：一直上溯到文件系统根，不设层数上限（dirname 收敛即终止）
  for (;;) {
    const marker = projectRootMarkerOf(current, markers)
    if (marker) return { root: current, marked: true, marker }
    const parent = dirname(current)
    if (parent === current) return { root: start, marked: false, marker: null }
    current = parent
  }
}

/**
 * 构造项目链目录序列：项目根 → cwd（含两端），宽泛在前、具体在后。
 * @author ddj 2026年11月05号
 * @param root 项目根
 * @param cwd 会话工作区
 * @returns 目录绝对路径数组（root 不在 cwd 祖先链上时只返回 cwd）
 */
export function instructionChainDirs(root: string, cwd: string): string[] {
  const resolvedRoot = resolve(root)
  const dirs: string[] = []
  let current = resolve(cwd)
  while (true) {
    dirs.push(current)
    if (current === resolvedRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  // 走不到根（root 不是 cwd 祖先）时退化为仅 cwd，避免把无关目录混进项目链
  if (dirs[dirs.length - 1] !== resolvedRoot) return [resolve(cwd)]
  return dirs.reverse()
}

/**
 * 绝对路径 → 展示路径（home 缩写为 `~`，分隔符统一为 `/`）。
 * @author ddj 2026年11月05号
 * @param absPath 绝对路径
 * @param home 用户目录
 * @returns 展示路径
 */
export function displayInstructionPath(absPath: string, home: string = homedir()): string {
  const target = resolve(absPath)
  const normalized = target.split(sep).join('/')
  const homeNormalized = resolve(home).split(sep).join('/')
  if (normalized === homeNormalized) return '~'
  if (normalized.startsWith(homeNormalized + '/')) return '~/' + normalized.slice(homeNormalized.length + 1)
  return normalized
}
// --endregion

// --region 读取与去重
/** 单个候选文件的探测结果。 */
interface ProbedFile {
  exists: boolean
  size: number
  mtime: number
  /** 去首尾空白后的内容摘要；缺失/超限/读失败为 null（不参与去重）。 */
  digest: string | null
}

/**
 * 探测一个候选文件：存在性 + 大小/mtime + 内容摘要（有上限，失败不抛）。
 * @author ddj 2026年11月05号
 * @param absPath 绝对路径
 * @returns 探测结果
 */
async function probeFile(absPath: string): Promise<ProbedFile> {
  const info = await stat(absPath).catch(() => null)
  if (!info || !info.isFile()) return { exists: false, size: 0, mtime: 0, digest: null }
  if (info.size > SOURCE_MAX_BYTES) return { exists: true, size: info.size, mtime: info.mtimeMs, digest: null }
  const text = await readFile(absPath, 'utf8').catch(() => null)
  if (text === null) return { exists: true, size: info.size, mtime: info.mtimeMs, digest: null }
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  return {
    exists: true,
    size: info.size,
    mtime: info.mtimeMs,
    digest: createHash('sha1').update(trimmed).digest('hex'),
  }
}

/** 去重账本：同候选组内摘要 → 首个渲染该内容的文件。 */
type DigestBook = Map<string, Map<string, string>>

/**
 * 记录一条候选并在需要时判定为重复（同组同摘要只保留第一次）。
 * @author ddj 2026年11月05号
 * @param book 组 → (摘要 → 首次文件名)
 * @param groupKey 候选组键（用户链为 'user'，项目链为目录相对路径）
 * @param file 文件名
 * @param digest 内容摘要（null 时直接视为不重复）
 * @returns 是否为重复项
 */
function markDuplicate(book: DigestBook, groupKey: string, file: string, digest: string | null): boolean {
  if (digest === null) return false
  let group = book.get(groupKey)
  if (!group) { group = new Map(); book.set(groupKey, group) }
  if (group.has(digest)) return true
  group.set(digest, file)
  return false
}

/**
 * 按核心的保留优先级结算一条链的预算。
 * 核心语义：一条链内优先保留「最具体」的文件——先整份丢弃更宽泛的文件，
 * 剩下的那条最宽泛文件才被截断。因此这里从链尾（最具体）向前累计：
 * 放不下的条目一律标记 skipped；若连最具体的那条自身都超预算，标记 partial
 * （核心会截断注入，仍算已注入）。
 * @author ddj 2026年11月05号
 * @param entries 该链全部条目（顺序：宽泛 → 具体）
 * @param budget 该链预算（字节）
 * @returns 已用字节与是否发生省略/截断
 */
function settleChainBudget(entries: InstructionEntry[], budget: number): { used: number; truncated: boolean } {
  let used = 0
  let truncated = false
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry.exists || entry.duplicate) continue
    if (used + entry.size <= budget) { used += entry.size; continue }
    if (used === 0 && index === entries.length - 1) {
      // 最具体的那条自身放不下：核心会截断注入，这里标 partial 并保留注入语义
      entry.partial = true
      used = budget
      truncated = true
      continue
    }
    entry.skipped = true
    truncated = true
  }
  return { used, truncated }
}
// --endregion

// --region 组装
/**
 * 组装「实际注入的指令文件」视图：用户链 + 项目链 + 技能目录快照。
 * @author ddj 2026年11月05号
 * @param cwd 会话工作区（缺省取 process.cwd，与面板无会话时的兜底一致）
 * @returns 只读视图（缺失候选也列出，便于展示完整链）
 */
export async function listInstructions(cwd?: string): Promise<InstructionView> {
  const home = dshHome()
  const agentsHome = agentsHomeDir()
  const workdir = cwd && cwd.trim() ? resolve(cwd) : resolve(process.cwd())
  const { root, marked } = findInstructionRoot(workdir)
  const book: DigestBook = new Map()

  // 用户链：DSH_HOME/AGENTS.md → 共享 agents 根/AGENTS.md（共用一条预算链，按内容去重）
  const userEntries: InstructionEntry[] = []
  for (const [group, dir] of [['user-global', home], ['shared-agents', agentsHome]] as const) {
    const absPath = join(dir, USER_INSTRUCTION_FILE)
    const probed = await probeFile(absPath)
    userEntries.push({
      group,
      scope: 'user',
      file: USER_INSTRUCTION_FILE,
      absPath,
      display: displayInstructionPath(absPath),
      exists: probed.exists,
      size: probed.size,
      mtime: probed.mtime,
      ...(markDuplicate(book, 'user', absPath, probed.digest) ? { duplicate: true } : {}),
    })
  }
  const userSettle = settleChainBudget(userEntries, INSTRUCTION_MAX_BYTES)

  // 项目链：项目根 → cwd，每目录按 基础候选 + overlay 候选 顺序
  const projectEntries: InstructionEntry[] = []
  const candidates = [...INSTRUCTION_CANDIDATES, ...LOCAL_INSTRUCTION_CANDIDATES]
  for (const dir of instructionChainDirs(root, workdir)) {
    const rel = relative(root, dir).split(sep).join('/') || '.'
    for (const file of candidates) {
      const absPath = join(dir, file)
      const probed = await probeFile(absPath)
      if (!probed.exists) continue // 缺失的项目候选不占位：链可能很长，空态另行提示
      projectEntries.push({
        group: 'project',
        scope: 'project',
        file,
        absPath,
        display: displayInstructionPath(absPath),
        dirRel: rel,
        exists: true,
        size: probed.size,
        mtime: probed.mtime,
        ...(markDuplicate(book, 'project:' + rel, absPath, probed.digest) ? { duplicate: true } : {}),
      })
    }
  }
  const projectSettle = settleChainBudget(projectEntries, INSTRUCTION_MAX_BYTES)

  // 技能：正文不注入，只给目录级可见性（与指令链共用同一次项目根解析，避免两套 up-walk 分叉）
  const catalog = await listSkillCatalog(workdir, root).catch(() => null)
  const skills: InstructionSkill[] = [
    ...(catalog?.user ?? []).map((skill) => ({ name: skill.name, description: skill.description, absPath: skill.path, scope: 'user' as InstructionScope })),
    ...(catalog?.project ?? []).map((skill) => ({ name: skill.name, description: skill.description, absPath: skill.path, scope: 'project' as InstructionScope })),
  ]

  const entries = [...userEntries, ...projectEntries]
  const injectedCount = entries.filter((entry) => entry.exists && !entry.duplicate && !entry.skipped).length
  return {
    cwd: workdir,
    projectRoot: root,
    projectRootMarked: marked,
    dshHome: home,
    agentsHome,
    entries,
    skills,
    injectedCount,
    userBytes: userSettle.used,
    projectBytes: projectSettle.used,
    budgetBytes: INSTRUCTION_MAX_BYTES,
    truncated: userSettle.truncated || projectSettle.truncated,
  }
}
// --endregion
