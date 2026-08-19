import { describe, expect, it, vi } from 'vitest'
import {
  isUnconfined,
  PERMISSION_ACTION,
  permissionActionValue,
  readPresets,
  requestedEscalation,
  switchPreset,
  UNCONFINED_PRESET,
} from '../src/permission.ts'
import { approvalCard, permissionCard, settledPermissionCard, statusCard } from '../src/cards.ts'
import { cardControls, cardTexts } from './harness.ts'
import type { HostAgent, HostCommands } from '../src/host.ts'

/** An agent stub; the command runtime is what actually gets driven. */
const agent = { id: 's1', session: { id: 's1' }, followup: () => {}, cancel: () => {} } as unknown as HostAgent

/** A command runtime answering with fixed text, recording the lines it ran. */
function fakeCommands(replies: Record<string, string>) {
  const ran: string[] = []
  const commands: HostCommands = {
    list: () => [],
    execute: async (_agent, line) => {
      ran.push(line)
      const text = replies[line.trim()]
      return text === undefined
        ? { result: { kind: 'error' as const, text: `unknown ${line}` } }
        : { result: { kind: 'success' as const, text } }
    },
  }
  return { commands, ran }
}

/** A projection registry answering with one fixed cut, as the host's does. */
function fakeProjections(values: Record<string, unknown>) {
  const reads: string[] = []
  return {
    reads,
    projections: {
      snapshot: (session: { id: string }) => {
        reads.push(session.id)
        return { asOfSeq: 1, values }
      },
    },
  }
}

describe('reading which preset is in force', () => {
  it('reads the published projection, not a command and not the raw log', () => {
    // Three ways to answer this question, and only one of them is a read that
    // stays a read: `/permission` appends to the session log, folding the log
    // costs the whole log per card, and the projection is the host's own
    // cached, schema-carrying answer.
    const { projections, reads } = fakeProjections({
      permissions: {
        currentValue: 'danger-full-access',
        options: [{ value: 'workspace-write' }, { value: 'danger-full-access' }],
      },
    })
    expect(readPresets(projections, agent)).toEqual({
      current: 'danger-full-access',
      available: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
    })
    expect(reads).toEqual(['s1'])
  })

  it('claims nothing where nothing published it', () => {
    expect(readPresets(undefined, agent)).toEqual({ available: [] })
    expect(readPresets(fakeProjections({}).projections, agent)).toEqual({ available: [] })
    expect(readPresets(fakeProjections({ permissions: {} }).projections, agent)).toEqual({ available: [] })
    const broken = { snapshot: () => { throw new Error('cache is cold') } }
    expect(readPresets(broken, agent)).toEqual({ available: [] })
  })

  it('keeps what the host published about each preset, and skips what it cannot read', () => {
    // The host names and explains its own presets, including ones a deployment
    // added: reducing them to a value leaves a card able to explain exactly
    // the names this plugin happens to hardcode.
    const { projections } = fakeProjections({
      permissions: {
        currentValue: 'a',
        options: [
          { value: 'a', name: 'Confined', description: 'Writes inside the workspace.' },
          { name: 'b' },
          { other: 'c' },
        ],
      },
    })
    expect(readPresets(projections, agent)).toEqual({
      current: 'a',
      available: [
        { value: 'a', name: 'Confined', description: 'Writes inside the workspace.' },
        { value: 'b', name: 'b' },
      ],
    })
  })
})

describe('switching the preset', () => {
  it('runs the host command with the chosen name', async () => {
    const { commands, ran } = fakeCommands({ '/permission danger-full-access': 'preset danger-full-access' })
    expect(await switchPreset(agent, commands, UNCONFINED_PRESET, AbortSignal.timeout(1000)))
      .toEqual({ ok: true, detail: 'preset danger-full-access' })
    expect(ran).toEqual(['/permission danger-full-access'])
  })

  it('reports a refusal instead of claiming success', async () => {
    const { commands } = fakeCommands({})
    const outcome = await switchPreset(agent, commands, 'nonsense', AbortSignal.timeout(1000))
    expect(outcome.ok).toBe(false)
    expect(await switchPreset(agent, undefined, UNCONFINED_PRESET, AbortSignal.timeout(1000)))
      .toEqual({ ok: false, detail: 'no command runtime is composed' })
  })
})

describe('what a consent card is allowed to claim', () => {
  /** The deployment's table, as the host service publishes it. */
  const table = (entries: Record<string, { sandbox: string; approval: string }>) => ({
    names: Object.keys(entries),
    resolve: (name: string) => {
      const spec = entries[name]
      if (spec === undefined) throw new Error(`unknown preset ${name}`)
      return spec
    },
  })

  it('describes a preset by what it does, not by what it is called', () => {
    // A deployment writes its own table. Describing `workspace-write` from the
    // name, when the table made it unconfined, asks a room to authorize one
    // thing while granting another — on a consent screen.
    const { projections } = fakeProjections({
      permissions: {
        currentValue: 'read-only',
        options: [{ value: 'read-only' }, { value: 'workspace-write' }],
      },
    })
    const state = readPresets(projections, agent, table({
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'danger-full-access', approval: 'never' },
    }))
    expect(state.available).toEqual([
      { value: 'read-only', name: 'read-only', sandbox: 'read-only', approval: 'ask' },
      { value: 'workspace-write', name: 'workspace-write', sandbox: 'danger-full-access', approval: 'never' },
    ])

    const card = permissionCard({ current: 'read-only', presets: state.available, valueFor: () => ({}) })
    const shown = cardTexts(card).map((t) => t.content).join('\n')
    // The misleadingly named row carries the loud description…
    expect(shown).toContain('不再有审批卡')
    // …and the row that really is read-only carries the quiet one.
    expect(shown).toContain('只读')
  })

  it('tells the two halves apart when a deployment mixes them', () => {
    const rows = [
      { value: 'quiet', sandbox: 'workspace-write', approval: 'never' },
      { value: 'roomy', sandbox: 'danger-full-access', approval: 'ask' },
    ]
    const shown = cardTexts(permissionCard({ presets: rows, valueFor: () => ({}) })).map((t) => t.content).join('\n')
    expect(shown).toContain('沙箱边界不变')
    expect(shown).toContain('越界的操作仍会弹审批卡')
  })

  it('judges "stop asking" by both knobs together', () => {
    expect(isUnconfined({ value: 'x', name: 'x', sandbox: 'danger-full-access', approval: 'never' })).toBe(true)
    expect(isUnconfined({ value: 'x', name: 'x', sandbox: 'danger-full-access', approval: 'ask' })).toBe(false)
    expect(isUnconfined({ value: 'x', name: 'x', sandbox: 'workspace-write', approval: 'never' })).toBe(false)
    // Unknowable is not the same as false; the caller decides what to do then.
    expect(isUnconfined({ value: 'x', name: 'x' })).toBe(false)
    expect(isUnconfined(undefined)).toBe(false)
  })
})

describe('what the surfaces after a switch say', () => {
  it('describes the settled card by the knobs, not the name it was clicked with', () => {
    // The button carries a name, and a name is the one thing a deployment is
    // free to redefine. A settled card that read it back from the name would
    // tell the room the switch did something other than what it did.
    const misleading = { value: 'workspace-write', sandbox: 'danger-full-access', approval: 'never' }
    const settled = settledPermissionCard({ preset: misleading })
    const shown = cardTexts(settled).map((t) => t.content).join('\n')
    expect(shown).toContain('已切到 workspace-write')
    expect(shown).toContain('不再有审批卡')

    // And the honest one still reads quietly.
    const honest = settledPermissionCard({
      preset: { value: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
    })
    expect(cardTexts(honest).map((t) => t.content).join('\n')).toContain('只能写工作区')
  })

  it('marks the status row from the knobs too', () => {
    const fields = {
      workspace: '/w',
      workspaceIsDefault: true,
      route: 'p/m',
      routeIsDefault: true,
      sessionId: 's',
      activity: 'idle' as const,
      pendingApprovals: 0,
      version: '0.0.6',
      documentCapabilities: { zh: '写 ✓', en: 'write ✓' },
      commentSurface: { zh: '已启用', en: 'Enabled' },
      refresh: {},
    }
    const loud = statusCard({
      ...fields,
      preset: { value: 'workspace-write', sandbox: 'danger-full-access', approval: 'never' },
    })
    expect(cardTexts(loud).some((t) => t.content.includes('不再弹审批卡'))).toBe(true)

    const quiet = statusCard({
      ...fields,
      preset: { value: 'danger-full-access', sandbox: 'workspace-write', approval: 'ask' },
    })
    expect(cardTexts(quiet).some((t) => t.content.includes('不再弹审批卡'))).toBe(false)
  })
})

describe('a switch cancelled after the command started', () => {
  it('rethrows the cancellation instead of reporting a failed switch', async () => {
    // The abort can arrive while the host command is already running — a
    // `/new` or a disposal lands there routinely. Swallowing it into an error
    // result loses the one fact the caller needs: nothing failed, the
    // conversation moved on.
    const controller = new AbortController()
    const reason = new Error('the conversation moved on')
    const commands: HostCommands = {
      list: () => [],
      execute: async (_agent, _line, signal) => {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
        })
        return { result: { kind: 'success' as const, text: 'unreachable' } }
      },
    }

    const running = switchPreset(agent, commands, UNCONFINED_PRESET, controller.signal)
    controller.abort(reason)
    await expect(running).rejects.toBe(reason)
  })

  it('still reports an ordinary failure as one', async () => {
    const commands: HostCommands = {
      list: () => [],
      execute: async () => { throw new Error('no such preset') },
    }
    expect(await switchPreset(agent, commands, 'nonsense', AbortSignal.timeout(1000)))
      .toEqual({ ok: false, detail: 'no such preset' })
  })
})

describe('the escalation a call asked for', () => {
  it('reads the mode out of the call arguments', () => {
    expect(requestedEscalation('{"command":"rm -rf /x","sandbox_permissions":"danger-full-access"}'))
      .toBe('danger-full-access')
    expect(requestedEscalation('{"command":"ls"}')).toBeUndefined()
    // Malformed arguments are not a reason to fail an approval card.
    expect(requestedEscalation('not json')).toBeUndefined()
    expect(requestedEscalation(undefined)).toBeUndefined()
  })
})

describe('the approval card that grants it', () => {
  it('names the escalation, and offers to open the session only then', () => {
    const plain = approvalCard({ toolName: 'bash', command: 'ls', allow: {}, reject: {} })
    expect(cardControls(plain)).toHaveLength(2)
    expect(cardTexts(plain).some((t) => t.content.includes('提升到'))).toBe(false)

    const escalating = approvalCard({
      toolName: 'bash',
      command: 'rm -rf /etc/x',
      escalateTo: 'danger-full-access',
      allow: { id: 'a1' },
      reject: { id: 'a1' },
      always: { id: 'a1', always: true },
    })
    // What is being granted is on the card, not only which tool ran.
    expect(cardTexts(escalating).some((t) => t.content.includes('danger-full-access'))).toBe(true)
    expect(cardControls(escalating).map((c) => c.value)).toEqual([
      { id: 'a1' },
      { id: 'a1', always: true },
      { id: 'a1' },
    ])
    // And the cost of the loud button is stated where it is pressed.
    const foot = cardTexts(escalating).map((t) => t.content).join('\n')
    expect(foot).toContain('不再有审批卡')
    expect(foot).toContain('/permission')
  })
})

describe('the permission picker', () => {
  it('states what each preset means, and marks the one in force', () => {
    const card = permissionCard({
      current: 'workspace-write',
      presets: [{ value: 'workspace-write' }, { value: 'danger-full-access' }],
      valueFor: (preset) => ({ kind: PERMISSION_ACTION, preset, key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' }),
    })
    const shown = cardTexts(card).map((t) => t.content)
    expect(shown).toContain('当前使用中')
    expect(shown.some((t) => t.includes('不再有审批卡'))).toBe(true)
    // The one in force is stated, not offered: re-picking it does nothing.
    expect(cardControls(card).map((c) => (c.value as { preset: string }).preset)).toEqual(['danger-full-access'])
  })

  it('explains every preset the shipped sandbox modes can produce', () => {
    // A deployment that overrides the preset table usually writes only
    // `sandbox` and `approval`, and the host's own descriptions go with the
    // defaults it replaced. The three shipped modes are therefore explained
    // from the name alone — checked here against the table this deployment
    // actually composes.
    const card = permissionCard({
      current: 'workspace-write',
      presets: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }],
      valueFor: (preset) => ({ preset }),
    })
    const shown = cardTexts(card).map((t) => t.content).join('\n')
    expect(shown).toContain('只读')
    expect(shown).toContain('只能写工作区')
    expect(shown).toContain('不再有审批卡')
  })

  it('accepts only its own well-formed payloads', () => {
    const value = {
      kind: PERMISSION_ACTION,
      preset: 'workspace-write',
      key: 'oc_1',
      chatId: 'oc_1',
      chatType: 'p2p',
    }
    expect(permissionActionValue(value)).toEqual(value)
    expect(permissionActionValue({ ...value, owner: 'ou_1' })).toEqual({ ...value, owner: 'ou_1' })
    expect(permissionActionValue({ ...value, kind: 'other' })).toBeUndefined()
    expect(permissionActionValue({ ...value, preset: '' })).toBeUndefined()
    expect(permissionActionValue({ ...value, chatId: undefined })).toBeUndefined()
    // The conversation key is what resolves the live session: a payload
    // without one could only guess which of a chat's sessions it meant.
    expect(permissionActionValue({ ...value, key: undefined })).toBeUndefined()
    expect(permissionActionValue(null)).toBeUndefined()
  })
})

describe('the picker once a preset was chosen', () => {
  it('states the choice and offers nothing to press', () => {
    const settled = settledPermissionCard({ preset: { value: 'danger-full-access' } })
    expect(cardControls(settled)).toHaveLength(0)
    const shown = cardTexts(settled).map((t) => t.content)
    expect(shown.some((t) => t.includes('已切到 danger-full-access'))).toBe(true)
    // What was just granted is restated where the decision landed.
    expect(shown.some((t) => t.includes('不再有审批卡'))).toBe(true)
    expect(shown.some((t) => t.includes('/permission'))).toBe(true)
  })

  it('says a held switch has not happened yet', () => {
    const held = settledPermissionCard({ preset: { value: 'workspace-write' }, stage: 'held' })
    expect(cardControls(held)).toHaveLength(0)
    const shown = cardTexts(held).map((t) => t.content).join('\n')
    expect(shown).toContain('本轮任务结束后切到 workspace-write')
    expect(shown).not.toContain('已切到')
  })
})

describe('switching through a runtime that answers nothing', () => {
  it('reports the refusal rather than claiming a switch', async () => {
    const execute = vi.fn(async () => undefined)
    const commands = { list: () => [], execute } as unknown as HostCommands
    expect(await switchPreset(agent, commands, 'workspace-write', AbortSignal.timeout(1000)))
      .toEqual({ ok: false, detail: 'the host does not offer /permission' })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
