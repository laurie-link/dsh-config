/**
 * dsh-enter-plan-mode — Host half.
 *
 * Gives the model a Claude Code style `EnterPlanMode`: one tool it can call on
 * its own judgement when a task deserves a plan before code. Plan mode itself
 * stays owned by @deepseek-ai/dsh-plan-mode — this plugin only adds the entry
 * side:
 *
 *   - `enter_plan_mode` switches the session to plan mode through
 *     `ctx.planMode.set(agent, true)`. The switch applies from the next step,
 *     where the plan guidance and the reviewed `exit_plan_mode` tool appear.
 *   - Leaving still requires the user: `exit_plan_mode` raises the plan review,
 *     and no tool can silently cancel plan mode.
 *   - Subagents cannot enter. They have no user to approve a plan, so a child
 *     that entered plan mode would be stuck; the tool is not listed for them.
 *
 * The plan-mode service is composed per Agent (the root entry may be disabled
 * while an Agent preset mounts it), so the controller is resolved from the
 * calling Agent's preset or context during tool admission and execution.
 *
 * The plan-mode service narrates an applied switch as "The user switched this
 * session to plan mode." That wording is wrong when the model switched by
 * itself, so this plugin suppresses exactly that narration for its own switch
 * (a patched `narration` on the controller prototype, restored on unload). The
 * tool result already tells the model what happened.
 *
 * @author DSH local maintenance 2026-11-19
 */

/** Loader row name. */
export const name = 'enter-plan-mode'

/** Only the tool registry is guaranteed at root; plan mode is per Agent. */
export const inject = ['tools']

/** Prototype slot holding the narration patch, shared across plugin reloads. */
const PATCH = Symbol.for('dsh-enter-plan-mode/narration')

/** How long a pending narration suppression survives when no narration runs. */
const SUPPRESS_TTL_MS = 60_000

const DESCRIPTION = `Switch this session into plan mode when the task deserves a plan before code.

Use it when any of these hold:
- the user asks for a plan, an approach, or a design before implementation;
- the request is a new feature or a meaningful behavior change;
- several valid approaches exist and the choice materially affects the result;
- the work spans multiple files or subsystems, or depends on architectural decisions;
- you would have to modify unfamiliar code;
- the requirements are ambiguous enough that implementing now would be guessing.

Do not use it for a single obvious edit, a small fix with one clear cause, a question, a review, or work the user asked you to just carry out.

Plan mode is read-only by contract. While it is active, explore with non-mutating reads, searches, and checks; never edit or write files, change configuration, run formatters or code generation, commit, or otherwise execute the plan. Resolve discoverable facts by inspection instead of asking. Then present the complete plan through exit_plan_mode, which waits for the user's approval; leaving plan mode is always the user's decision.

The switch applies from your next step. Call this tool on its own and stop there: do not also edit files in the same response.`

/** Whether this agent is a subagent child rather than a user-facing session. */
function isSubagent(agent) {
  const meta = agent?.session?.meta
  if (meta === undefined || meta === null) return false
  if (meta.origin === 'subagent') return true
  return typeof meta.delegationDepth === 'number' && meta.delegationDepth > 0
}

/**
 * Look up the controller within the caller's preset first. A preset can mount
 * planMode inside an isolated group, outside the Agent context's service view.
 *
 * @param ctx - plugin context.
 * @param agent - calling Agent.
 * @returns the controller, or undefined when plan mode is not composed.
 */
function resolvePlanMode(ctx, agent) {
  const presets = ctx.get('agentPresets')
  return presets?.serviceFor(agent, 'planMode')
    ?? agent.ctx.get('planMode')
    ?? ctx.get('planMode')
}

/**
 * Patch the controller prototype so a switch this plugin caused is not
 * reported to the user as "The user switched this session to plan mode."
 *
 * @param controller - live plan-mode controller.
 * @returns the suppression record, or null when narration cannot be patched.
 */
function ensureNarrationPatch(controller) {
  const proto = Object.getPrototypeOf(controller)
  const existing = proto[PATCH]
  if (existing !== undefined) return existing
  const original = proto.narration
  if (typeof original !== 'function') return null
  const state = { original, suppressed: new WeakSet(), proto }
  proto[PATCH] = state
  proto.narration = function narration(session, target) {
    const live = proto[PATCH]
    if (live !== undefined && target === true && live.suppressed.has(session)) {
      live.suppressed.delete(session)
      return undefined
    }
    return state.original.call(this, session, target)
  }
  return state
}

/**
 * Restore the prototype exactly as found, if this plugin patched it.
 *
 * @param state - suppression record from ensureNarrationPatch.
 */
function restoreNarrationPatch(state) {
  if (state === null || state === undefined) return
  const { proto } = state
  if (proto[PATCH] !== state) return
  delete proto[PATCH]
  proto.narration = state.original
}

/**
 * Mount the entry tool.
 *
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  let patch = null
  ctx.effect(() => () => { restoreNarrationPatch(patch) })

  ctx.effect(() => ctx.tools.register({
    name: 'enter_plan_mode',
    description: DESCRIPTION,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['active', 'changed'],
        properties: {
          active: { type: 'boolean' },
          changed: { type: 'boolean' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.changed
          ? 'Plan mode is now active (applies from your next step). Explore with non-mutating reads; when the plan is ready, call exit_plan_mode with the complete plan — the user approves it or sends you back to planning.'
          : 'This session is already in plan mode.',
      }],
    },
    execute: async (_args, exec) => {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('enter_plan_mode needs a calling agent')
      }
      const planMode = resolvePlanMode(ctx, agent)
      if (planMode === undefined) {
        throw new Error('enter_plan_mode is unavailable: plan mode is not composed for this agent')
      }
      const state = planMode.get(agent)
      if (state.active && state.pending === undefined) {
        return { active: true, changed: false }
      }
      if (patch === null) patch = ensureNarrationPatch(planMode)
      patch?.suppressed.add(agent.session)
      const timer = setTimeout(() => { patch?.suppressed.delete(agent.session) }, SUPPRESS_TTL_MS)
      timer.unref?.()
      let outcome
      try {
        outcome = planMode.set(agent, true)
      } catch (error) {
        patch?.suppressed.delete(agent.session)
        throw error
      }
      if (outcome === 'noop') {
        patch?.suppressed.delete(agent.session)
        return { active: true, changed: false }
      }
      return { active: true, changed: true }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Switching to plan mode',
      kind: 'other',
      content: [{ type: 'text', text: 'Planning this task before changing anything.' }],
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'Plan mode',
      content: result.content,
    }),
  }, {
    when: ({ agent }) => !isSubagent(agent) && resolvePlanMode(ctx, agent) !== undefined,
  }))
}
