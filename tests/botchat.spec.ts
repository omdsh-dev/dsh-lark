import { describe, expect, it } from 'vitest'
import {
  createHopBudget,
  DEFAULT_BOT_HOPS,
  exhaustedNotice,
  judgeBotMessage,
  strangerNotice,
} from '../src/botchat.ts'
import { batonNote, presenceSection } from '../src/presence.ts'

describe('hop budget', () => {
  it('spends down, and a human refills it', () => {
    const budget = createHopBudget(2)
    expect(budget.take('oc_1')).toBe(true)
    expect(budget.take('oc_1')).toBe(true)
    expect(budget.take('oc_1')).toBe(false)
    expect(budget.spent('oc_1')).toBe(2)
    // A person speaking is the signal that the exchange is still wanted.
    budget.reset('oc_1')
    expect(budget.take('oc_1')).toBe(true)
  })

  it('budgets each conversation on its own', () => {
    const budget = createHopBudget(1)
    expect(budget.take('oc_1')).toBe(true)
    expect(budget.take('oc_2')).toBe(true)
    expect(budget.take('oc_1')).toBe(false)
    budget.forget('oc_1')
    expect(budget.take('oc_1')).toBe(true)
  })

  it('admits nothing at zero', () => {
    expect(createHopBudget(0).take('oc_1')).toBe(false)
  })
})

describe('judging a bot message', () => {
  const budget = (limit = DEFAULT_BOT_HOPS): ReturnType<typeof createHopBudget> => createHopBudget(limit)

  it('answers any bot when nobody narrowed the peers', () => {
    // Empty means "no narrowing" here, exactly as it does for senders, groups,
    // and approvers.
    expect(judgeBotMessage({ senderId: 'ou_anyone', key: 'oc_1' }, new Set(), budget()))
      .toEqual({ kind: 'answer' })
  })

  it('answers a listed peer, and names one the list left out', () => {
    const peers = new Set(['ou_peer'])
    expect(judgeBotMessage({ senderId: 'ou_peer', key: 'oc_1' }, peers, budget()))
      .toEqual({ kind: 'answer' })
    const verdict = judgeBotMessage({ senderId: 'ou_stranger', key: 'oc_1' }, peers, budget())
    expect(verdict).toEqual({ kind: 'stranger', senderId: 'ou_stranger' })
    // The console line carries the id an operator has to paste into botPeers.
    expect(strangerNotice('ou_stranger', 'oc_1')).toContain('ou_stranger')
    expect(strangerNotice('ou_stranger', 'oc_1')).toContain('botPeers')
  })

  it('never answers its own voice, even when listed by mistake', () => {
    const peers = new Set(['ou_self'])
    expect(judgeBotMessage({ senderId: 'ou_self', key: 'oc_1', ownBotId: 'ou_self' }, peers, budget()))
      .toEqual({ kind: 'self' })
  })

  it('stops a peer once the exchange runs out of hops', () => {
    const peers = new Set(['ou_peer'])
    const hops = budget(2)
    const send = (): ReturnType<typeof judgeBotMessage> =>
      judgeBotMessage({ senderId: 'ou_peer', key: 'oc_1' }, peers, hops)
    expect(send().kind).toBe('answer')
    expect(send().kind).toBe('answer')
    expect(send()).toEqual({ kind: 'exhausted', spent: 2 })
    // What the room is told is actionable: it says how to restart the exchange.
    expect(exhaustedNotice(2)).toContain('2')
    expect(exhaustedNotice(2)).toContain('说句话')
  })

  it('spends a hop only for a message it answers', () => {
    const hops = budget(3)
    judgeBotMessage({ senderId: 'ou_stranger', key: 'oc_1' }, new Set(['ou_peer']), hops)
    judgeBotMessage({ senderId: 'ou_self', key: 'oc_1', ownBotId: 'ou_self' }, new Set(['ou_self']), hops)
    // Neither reached an agent, so neither cost the exchange anything.
    expect(hops.spent('oc_1')).toBe(0)
  })
})

describe('presence', () => {
  it('tells the agent who it is, in one sentence', () => {
    const text = presenceSection({ name: 'DSH Agent', openId: 'ou_abc' })
    expect(text).toContain('DSH Agent')
    expect(text).toContain('ou_abc')
    // The three things an agent kept getting wrong: speaking through tools,
    // writing reports, and answering when nothing was needed.
    expect(text).toContain('Your reply IS the message')
    expect(text).toContain('chat-sized')
    expect(text).toContain('only when there is something to say')
    // One line, so it costs a deployment's own prompt almost nothing.
    expect(text.split('\n')).toHaveLength(1)
    // The baton belongs to the bot turn that needs it, not to every human one.
    expect(text).not.toContain('@')
  })

  it('hands the baton back by id, not by name', () => {
    const note = batonNote('ou_peer')
    // Names repeat in a workspace; a mention that resolves to the wrong
    // colleague, or to nobody, ends an exchange that was meant to continue.
    expect(note).toContain('<at user_id="ou_peer"></at>')
    expect(note).toContain('say nothing')
  })

  it('works before the transport has resolved an identity', () => {
    expect(presenceSection({})).toContain('a bot account of your own')
  })

  it('names what does not work here, and only then', () => {
    expect(presenceSection({}, ['exit_plan_mode'])).toContain('Unavailable here: exit_plan_mode')
    expect(presenceSection({})).not.toContain('Unavailable here')
  })
})
