/**
 * dsh-vscode-mode 共享契约 —— 「实际注入的指令文件」视图（AGENTS.md 指令链）。
 *
 * 为什么另起一份视图，而不是复用规则（.mdc）视图：`.mdc` 只是本插件自己注册的
 * systemPrompt section（order 400），而模型真正每次请求都会读到的是 DSH 核心
 * `@deepseek-ai/dsh-agent-instructions` 组装的 AGENTS.md 指令链（用户全局 + 项目链）。
 * 面板若只展示 `.mdc`，用户会误以为「面板里的规则 = 模型读到的规则」。本视图只读复述
 * 核心的解析口径（候选名/项目根标记/去重/预算），不改变任何注入语义。
 *
 * 纯类型模块：禁 node/react 导入（与 shared/rules.ts、shared/skillCatalog.ts 同约束）。
 */

/** 指令文件所处的链段：用户全局（DSH_HOME）、共享 agents 根、项目链。 */
export type InstructionGroup = 'user-global' | 'shared-agents' | 'project'

/** 预算与去重的作用域：用户链与项目链各自独立预算（核心即如此）。 */
export type InstructionScope = 'user' | 'project'

/** 指令链中的单个候选文件（缺失的候选也会列出，便于看到完整链）。 */
export interface InstructionEntry {
  group: InstructionGroup
  scope: InstructionScope
  /** 文件名（AGENTS.md / CLAUDE.md / *.local.md）。 */
  file: string
  /** 绝对路径。 */
  absPath: string
  /** 展示用路径（home 缩写为 ~）。 */
  display: string
  /** 项目链所属目录（相对项目根；根目录为 '.'；用户链不设置）。 */
  dirRel?: string
  /** 文件是否存在（false 时仅作占位展示，不可点击）。 */
  exists: boolean
  /** 字节数（缺失为 0）。 */
  size: number
  /** 修改时间毫秒（缺失为 0）。 */
  mtime: number
  /** 同候选组内与更早文件去空白后内容一致，核心只渲染一次。 */
  duplicate?: boolean
  /** 所在链预算已用尽，核心会省略此文件。 */
  skipped?: boolean
  /** 该链最具体的文件自身超预算：核心仍会截断注入（已计入 injectedCount）。 */
  partial?: boolean
}

/** 技能目录条目（正文不注入，仅目录级可见，按需由模型读取 SKILL.md）。 */
export interface InstructionSkill {
  name: string
  description: string
  absPath: string
  scope: InstructionScope
}

/** instructions.list 的返回载荷（只读快照，无缓存、不写盘）。 */
export interface InstructionView {
  /** 会话工作区（客户端传入；缺失为空串）。 */
  cwd: string
  /** 解析出的项目根（.git 最近的祖先；找不到时回落 cwd，与核心一致）。 */
  projectRoot: string
  /** 项目根是否由 .git 标记确认（false = 回落 cwd）。 */
  projectRootMarked: boolean
  /** harness home（$DSH_HOME 或 ~/.dsh）。 */
  dshHome: string
  /** 共享 agents 根（$DSH_AGENTS_HOME 或 ~/.agents）。 */
  agentsHome: string
  /** 指令链：用户全局 → 共享 agents → 项目根→cwd 逐目录逐候选。 */
  entries: InstructionEntry[]
  /** 用户全局技能 + 当前工作区技能（正文按需加载）。 */
  skills: InstructionSkill[]
  /** 实际会被渲染的文件数（存在、未去重、未超预算）。 */
  injectedCount: number
  /** 用户链已用字节（去重与超预算文件不计）。 */
  userBytes: number
  /** 项目链已用字节（去重与超预算文件不计）。 */
  projectBytes: number
  /** 每条链的字节预算（核心默认 64 KiB）。 */
  budgetBytes: number
  /** 是否有文件因预算被省略（口径为本地粗算，非核心精确的逐级降级）。 */
  truncated: boolean
}
