/**
 * Plan review in the chat.
 *
 * The host's `exit_plan_mode` presents a finished plan and leaves plan mode
 * once its human approves. It asks through `ctx.userQuestions` — the same
 * single-provider seam `ask_user_question` reaches for, owned by whichever UI
 * registered it first — so in a chat the tool either waits on a surface nobody
 * here is watching, or, with no provider composed at all, simply fails. That is
 * why the tool used to be denied outright, with the model told to seek approval
 * in prose.
 *
 * It is SHADOWED instead, exactly as the question tool is: an agent-scoped
 * registration of the same name, which the host's layered tool registry
 * resolves before the global one. The review becomes the card this channel
 * already asks with, and approval calls the plan service's own public switch,
 * so the state transition stays the host's rather than a copy of it.
 *
 * The plan itself does NOT ride the card. It is markdown a model wrote, and
 * this module's rule is that model text inside a card renders literally — which
 * would strip a plan of the headings and lists that make it readable. So the
 * plan is sent as an ordinary chat message first, at the same trust level as
 * every other assistant reply this channel delivers, and the card carries only
 * the decision.
 * @module dsh-lark-channel/plan
 */

import type { HostAgent, HostSessionEvent } from './host.ts'

/** The host tool this module shadows. */
export const PLAN_TOOL = 'exit_plan_mode'

/** The review question's id, and the labels its answer is read back against. */
const REVIEW_ID = 'plan-review'
const APPROVE_LABEL = '批准，开始执行'
const KEEP_PLANNING_LABEL = '继续规划'

/**
 * What the model is told the tool does.
 *
 * Mirrors the host tool's own description: a shadow that describes itself
 * differently would change when the model reaches for it, and the point of
 * shadowing is to change where the answer comes from, not what the tool is.
 */
const DESCRIPTION = 'Use only in plan mode. Present your plan for the user\'s review and, on approval, '
  + 'leave plan mode. Send the COMPLETE plan as markdown, starting with a # heading that names it. '
  + 'The user may approve (carry out the plan from your next step) or keep planning — their feedback '
  + 'comes back in the tool result; revise and present again.'

/** The plan service, narrowed to the one call this module makes. */
export interface HostPlanMode {
  /**
   * Switch one agent's plan mode. Public by the service's own contract — the
   * `/plan` command drives it through this same method.
   * @param agent - the agent whose session carries the state.
   * @param active - the state to move to.
   * @returns how the switch landed; mid-turn it queues to the next step.
   */
  set(agent: HostAgent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
}

/** What the shadow needs from the bridge to ask, and to switch. */
export interface PlanReviewPorts {
  /**
   * Send the plan to the chat as an ordinary message.
   * @param sessionId - the agent's session, which names the chat.
   * @param plan - the plan markdown, exactly as the model wrote it.
   */
  publish(sessionId: string, plan: string): Promise<void>
  /**
   * Ask the chat to decide, returning the labels chosen and anything typed.
   * @param sessionId - the agent's session, which names the chat.
   * @param heading - the plan's own heading, which titles the card.
   * @param signal - the tool execution's cancellation.
   */
  review(
    sessionId: string,
    heading: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly selected: readonly string[]; readonly custom?: string | undefined }>
  /** The plan service, when this deployment composed one. */
  planMode(): HostPlanMode | undefined
}

/** Whether plan mode is active, folded from the session log; the last one wins. */
export function planModeActive(events: readonly HostSessionEvent[]): boolean {
  let active = false
  for (const event of events) {
    if (event.type === 'plan/mode') {
      const data = (event as { data?: { active?: unknown } }).data
      if (typeof data?.active === 'boolean') active = data.active
    }
  }
  return active
}

/**
 * The review question this channel asks, in the shape its card takes.
 * @param heading - the plan's own first heading, when it has one.
 * @returns the question to hand the chat's question store.
 */
export function planReviewQuestion(heading: string | undefined): {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly options: readonly { readonly label: string; readonly description: string }[]
} {
  return {
    id: REVIEW_ID,
    header: heading === undefined || heading === '' ? '计划待确认' : heading,
    question: '上面这份计划可以开始执行吗？',
    options: [
      { label: APPROVE_LABEL, description: '离开规划模式，从下一步开始执行这份计划' },
      { label: KEEP_PLANNING_LABEL, description: '留在规划模式；你的意见会回到模型那里' },
    ],
  }
}

/** The plan's first markdown heading, which titles the card. */
export function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

/**
 * Build the agent-scoped `exit_plan_mode` that reviews in the chat.
 *
 * The refusals are thrown rather than returned, and their wording is the host
 * tool's: a tool result is what steers the model's next move, so "keep
 * planning" has to read to the model exactly as it would have from the tool
 * this one stands in for.
 * @param ports - how to publish the plan, ask, and switch the mode.
 * @returns the tool object, for `tools.register` on an agent's context.
 */
export function shadowPlanTool(ports: PlanReviewPorts): object {
  return {
    name: PLAN_TOOL,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      required: ['plan'],
      properties: {
        plan: {
          type: 'string',
          description: 'The complete plan, as markdown, starting with a # heading that names it.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['approved'],
        properties: { approved: { type: 'boolean' } },
      },
      render: () => [{
        type: 'text',
        text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.',
      }],
    },
    async execute(args: unknown, exec: unknown): Promise<{ approved: true }> {
      const plan = String((args as { plan?: unknown } | null | undefined)?.plan ?? '')
      const context = exec as { agent?: HostAgent; signal?: AbortSignal }
      const agent = context.agent
      if (agent === undefined) throw new Error(`${PLAN_TOOL} requires a calling agent (no session to switch)`)
      // A registry too old to expose the log cannot say otherwise, and
      // refusing on that basis would deny a review the host would have run.
      if (agent.session.events !== undefined && !planModeActive(agent.session.events)) {
        throw new Error(`${PLAN_TOOL} is only available in plan mode`)
      }
      if (!/^#\s+\S/.test(plan.trim())) {
        throw new Error(`${PLAN_TOOL} requires a non-empty markdown plan starting with a # heading`)
      }
      const planMode = ports.planMode()
      if (planMode === undefined) {
        throw new Error('no plan-mode service is available to leave plan mode; ask the user to switch the session mode instead')
      }
      const sessionId = agent.session.id
      await ports.publish(sessionId, plan)
      const answer = await ports.review(sessionId, firstHeading(plan), context.signal)
      const approved = answer.selected.length === 1
        && answer.selected[0] === APPROVE_LABEL
        && (answer.custom === undefined || answer.custom === '')
      if (!approved) {
        // Three different answers, three different next moves. A press of the
        // other button means revise; typed words are feedback to revise
        // against; nothing at all means the review was dismissed — and telling
        // the model to present again there would talk over the person who
        // dismissed it to say something.
        const feedback = answer.custom ?? ''
        if (answer.selected.length === 0 && feedback === '') {
          throw new Error(
            'The user dismissed the plan review to speak instead; stay in plan mode, stop here, '
            + 'and wait for their message.',
          )
        }
        throw new Error(
          feedback === ''
            ? 'The user chose to keep planning; revise the plan and present it again.'
            : `The user chose to keep planning; their feedback: ${feedback}`,
        )
      }
      // Mid-turn this queues to the next step, which is when the model's next
      // request is assembled — the same boundary the host tool's own switch
      // lands on.
      planMode.set(agent, false)
      return { approved: true }
    },
  }
}
