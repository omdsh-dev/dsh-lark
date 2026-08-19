import { describe, expect, it } from 'vitest'
import { firstHeading, PLAN_TOOL, planModeActive, planReviewQuestion, shadowPlanTool } from '../src/plan.ts'
import type { PlanReviewPorts } from '../src/plan.ts'
import { assertRegistrableTool } from './harness.ts'

/** The tool as the registry hands it back, with the one method tests drive. */
interface Runnable {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<{ approved: true }>
}

/** One agent, in plan mode unless a test says otherwise. */
function fakeAgent(events: { type: string; data: unknown }[] = [{ type: 'plan/mode', data: { active: true } }]) {
  return { id: 's1', session: { id: 's1', events }, followup: () => {}, cancel: () => {} }
}

/** Ports recording what the review published and how it was answered. */
function createPorts(
  answer: { selected: string[]; custom?: string },
  options: { planMode?: boolean } = {},
) {
  const published: string[] = []
  const headings: (string | undefined)[] = []
  const switched: boolean[] = []
  const ports: PlanReviewPorts = {
    publish: async (_sessionId, plan) => { published.push(plan) },
    review: async (_sessionId, heading) => {
      headings.push(heading)
      return answer
    },
    planMode: () => options.planMode === false
      ? undefined
      : { set: (_agent, active) => { switched.push(active); return 'queued' } },
  }
  return { ports, published, headings, switched }
}

/** The plan a well-behaved model presents. */
const PLAN = '# 迁移计划\n\n1. 跑测试\n2. 发预发'

describe('plan review', () => {
  it('reads plan mode off the session log, last one wins', () => {
    expect(planModeActive([])).toBe(false)
    expect(planModeActive([{ type: 'plan/mode', data: { active: true } }])).toBe(true)
    expect(planModeActive([
      { type: 'plan/mode', data: { active: true } },
      { type: 'turn/start', data: {} },
      { type: 'plan/mode', data: { active: false } },
    ])).toBe(false)
  })

  it('titles the card with the plan\'s own heading', () => {
    expect(firstHeading(PLAN)).toBe('迁移计划')
    expect(firstHeading('no heading here')).toBeUndefined()
    expect(planReviewQuestion('迁移计划').header).toBe('迁移计划')
    expect(planReviewQuestion(undefined).header).toBe('计划待确认')
    // Two ways out, and each says what it does.
    expect(planReviewQuestion(undefined).options).toHaveLength(2)
  })

  it('registers as a definition the host registry would accept', () => {
    const { ports } = createPorts({ selected: [] })
    assertRegistrableTool(shadowPlanTool(ports) as { name: string })
    expect((shadowPlanTool(ports) as Runnable).name).toBe(PLAN_TOOL)
  })

  it('publishes the plan, then leaves plan mode on approval', async () => {
    const { ports, published, headings, switched } = createPorts({ selected: ['批准，开始执行'] })
    const tool = shadowPlanTool(ports) as Runnable

    expect(await tool.execute({ plan: PLAN }, { agent: fakeAgent() })).toEqual({ approved: true })
    // The plan goes out whole, as the model wrote it.
    expect(published).toEqual([PLAN])
    expect(headings).toEqual(['迁移计划'])
    expect(switched).toEqual([false])
  })

  it('stays in plan mode on every answer that is not approval', async () => {
    const kept = createPorts({ selected: ['继续规划'] })
    await expect((shadowPlanTool(kept.ports) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('revise the plan and present it again')
    expect(kept.switched).toEqual([])

    // Typed words are feedback the model revises against, so they ride back.
    const feedback = createPorts({ selected: [], custom: '回滚方案还没写' })
    await expect((shadowPlanTool(feedback.ports) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('回滚方案还没写')
    expect(feedback.switched).toEqual([])

    // A dismissed review is someone about to speak: stop, do not re-present.
    const dismissed = createPorts({ selected: [] })
    await expect((shadowPlanTool(dismissed.ports) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('wait for their message')
    expect(dismissed.switched).toEqual([])
  })

  it('refuses before it publishes anything the chat would have to read', async () => {
    const outside = createPorts({ selected: ['批准，开始执行'] })
    await expect((shadowPlanTool(outside.ports) as Runnable)
      .execute({ plan: PLAN }, { agent: fakeAgent([{ type: 'plan/mode', data: { active: false } }]) }))
      .rejects.toThrow('only available in plan mode')

    const headless = createPorts({ selected: ['批准，开始执行'] })
    await expect((shadowPlanTool(headless.ports) as Runnable)
      .execute({ plan: '步骤一' }, { agent: fakeAgent() }))
      .rejects.toThrow('# heading')

    const noService = createPorts({ selected: ['批准，开始执行'] }, { planMode: false })
    await expect((shadowPlanTool(noService.ports) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('no plan-mode service')

    // None of those reached the chat: a refusal the model can act on is not
    // worth a message the human has to read.
    expect([...outside.published, ...headless.published, ...noService.published]).toEqual([])
  })

  it('reviews anyway when the registry is too old to expose the session log', async () => {
    const { ports, switched } = createPorts({ selected: ['批准，开始执行'] })
    const agent = { id: 's1', session: { id: 's1' }, followup: () => {}, cancel: () => {} }
    expect(await (shadowPlanTool(ports) as Runnable).execute({ plan: PLAN }, { agent })).toEqual({ approved: true })
    expect(switched).toEqual([false])
  })
})
