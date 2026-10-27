import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CardActionEvent } from '@larksuite/channel'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { HostSessionEvent } from '../src/host.ts'
import {
  cardControls,
  createFakeSessionQuery,
  createFakeSettings,
  createFakeWorkspaces,
  fakeMessage,
  mountChannel,
  SENDER_ID,
} from './harness.ts'

/**
 * What one chat watches, and what it stops watching.
 *
 * A session's events reach a chat through a binding — session id to renderer —
 * and a conversation can move off a session three ways: a `/sessions` press,
 * `/cd`, and `/new`. Each of those is a change of session, and the chat has to
 * stop rendering the one it left: a session live on another surface — a browser
 * — keeps producing, and a binding that outlived the conversation's stay put
 * two conversations' output in one chat at once.
 */
describe('the session a conversation watches', () => {
  /** Directories these tests let the channel write into, removed after each one. */
  const workspaces: string[] = []

  afterEach(async () => {
    for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
  })

  type Harness = Awaited<ReturnType<typeof mountChannel>>

  /**
   * One session event, as the host's own bus carries it.
   *
   * The event map types the session argument as a full `Session`; dispatch reads
   * only its id, which is the whole of what a test speaks for.
   * @param harness - the mounted channel.
   * @param sessionId - the session the event belongs to.
   * @param event - the session event to publish.
   */
  function emitEvent(harness: Harness, sessionId: string, event: HostSessionEvent): void {
    harness.ctx.emit('session/event', { id: sessionId } as unknown as Session, event as unknown as SessionEvent)
  }

  /**
   * One committed assistant answer and the turn that carried it: the two events
   * an answer reaches the chat through.
   * @param harness - the mounted channel.
   * @param sessionId - the session answering.
   * @param text - what it answered.
   */
  function emitTurn(harness: Harness, sessionId: string, text: string): void {
    emitEvent(harness, sessionId, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text }] } },
    })
    emitEvent(harness, sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }

  /** A card action pressing one button, as the conversation's own chat. */
  function clickAction(value: unknown): CardActionEvent {
    return {
      messageId: 'om_card_1',
      chatId: 'oc_chat_1',
      operator: { openId: SENDER_ID },
      action: { value, tag: 'button' },
    }
  }

  /** Every markdown body this channel sent, in order. */
  function sentMarkdown(harness: Harness): string[] {
    return harness.fake.sent
      .map(message => ('markdown' in message.input ? message.input.markdown : undefined))
      .filter((text): text is string => typeof text === 'string' && text !== '')
  }

  /** Open `/sessions` and return the card it answers with. */
  async function openPicker(harness: Harness): Promise<object> {
    const before = harness.fake.sent.length
    await harness.fake.emitMessage(fakeMessage({ content: '/sessions' }))
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(before) })
    return (harness.fake.sent.at(-1)!.input as { card: object }).card
  }

  /** Press one session row of a picker card already in hand. */
  async function pressRow(harness: Harness, card: object, sessionId: string): Promise<void> {
    const row = cardControls(card).find(
      control => (control.value as { session?: string }).session === sessionId,
    )
    expect(row, `the picker offered no pressable row for ${sessionId}`).toBeDefined()
    await harness.fake.emitCardAction(clickAction(row!.value))
  }

  /** Open the picker and press one row of it. */
  async function pick(harness: Harness, sessionId: string): Promise<void> {
    await pressRow(harness, await openPicker(harness), sessionId)
  }

  /** Let anything already queued settle, so that an absence can be asserted. */
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 20) })

  /** Two sessions to switch between, both in the directory `cwd` names. */
  function corpus(cwd: string) {
    const at = Date.now()
    return createFakeSessionQuery([
      { id: 'session-web-ui', cwd, createdAt: at - 3_000, messages: [{ text: '网页端在跑的那一个', at: at - 2_000 }] },
      { id: 'session-web-ui-2', cwd, createdAt: at - 1_000, messages: [{ text: '要切过去的另一个', at: at - 900 }] },
    ])
  }

  it('stops rendering the session a /sessions press leaves behind', async () => {
    const { query } = corpus(process.cwd())
    const harness = await mountChannel({ showProcess: false }, { sessionQuery: query })
    // A browser owns this one, so nothing here can dispose it: the only thing
    // standing between its output and this chat is the binding.
    harness.agents.declareLive('session-web-ui')

    await pick(harness, 'session-web-ui')
    emitTurn(harness, 'session-web-ui', '网页端在跑的正文')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('网页端在跑的正文') })

    await pick(harness, 'session-web-ui-2')
    const settled = harness.fake.sent.length
    emitTurn(harness, 'session-web-ui', '切走之后不该再出现')
    await settle()
    expect(harness.fake.sent.length).toBe(settled)

    // What it moved to is watched instead, in the same chat.
    emitTurn(harness, 'session-web-ui-2', '切过去之后要收到的')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('切过去之后要收到的') })
    await harness.dispose()
  })

  it('keeps rendering a session a stale card names again', async () => {
    const { query } = corpus(process.cwd())
    const harness = await mountChannel({ showProcess: false }, { sessionQuery: query })
    harness.agents.declareLive('session-web-ui')

    // Two cards drawn before either press. The second still carries the row the
    // first one moves to: a freshly drawn card states the session in use
    // instead of offering a press, so a card from before the move is how a
    // press can name the session the conversation is already on.
    const first = await openPicker(harness)
    const second = await openPicker(harness)
    await pressRow(harness, first, 'session-web-ui')
    emitTurn(harness, 'session-web-ui', '第一次按住')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('第一次按住') })

    // Naming the session it is already on is not a change of session, so the
    // renderer it watches through has to survive the press.
    await pressRow(harness, second, 'session-web-ui')
    emitTurn(harness, 'session-web-ui', '再按一次之后仍然在')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('再按一次之后仍然在') })
    await harness.dispose()
  })

  it('stops rendering the session /new leaves behind', async () => {
    const settings = createFakeSettings()
    const { query } = corpus(process.cwd())
    const harness = await mountChannel(
      { showProcess: false },
      { sessionQuery: query, settings: settings.settings },
    )
    harness.agents.declareLive('session-web-ui')

    await pick(harness, 'session-web-ui')
    emitTurn(harness, 'session-web-ui', '开新会话之前')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('开新会话之前') })

    await harness.fake.emitMessage(fakeMessage({ content: '/new' }))
    const settled = harness.fake.sent.length
    emitTurn(harness, 'session-web-ui', '开新会话之后不该再出现')
    await settle()
    expect(harness.fake.sent.length).toBe(settled)
    await harness.dispose()
  })

  it('stops rendering the session /cd leaves behind', async () => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'watch-cd-')))
    workspaces.push(target)
    const { query } = corpus(process.cwd())
    const harness = await mountChannel(
      { showProcess: false },
      { sessionQuery: query, workspaces: createFakeWorkspaces().service },
    )
    harness.agents.declareLive('session-web-ui')

    await pick(harness, 'session-web-ui')
    emitTurn(harness, 'session-web-ui', '换目录之前')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('换目录之前') })

    await harness.fake.emitMessage(fakeMessage({ content: `/cd ${target}` }))
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(0) })
    const settled = harness.fake.sent.length
    emitTurn(harness, 'session-web-ui', '换目录之后不该再出现')
    await settle()
    expect(harness.fake.sent.length).toBe(settled)
    await harness.dispose()
  })

  it('stops rendering the session a /ws press leaves behind', async () => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'watch-ws-')))
    workspaces.push(target)
    // The corpus is read again by the press, so it has to describe the
    // directory the conversation is in when the row is pressed.
    const { query } = corpus(target)
    const harness = await mountChannel(
      { showProcess: false },
      { sessionQuery: query, workspaces: createFakeWorkspaces().service },
    )
    harness.agents.declareLive('session-web-ui')

    await harness.fake.emitMessage(fakeMessage({ content: `/cd ${target}` }))
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(0) })
    await pick(harness, 'session-web-ui')
    emitTurn(harness, 'session-web-ui', '换工作区之前')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('换工作区之前') })

    // `/ws` draws the deployment default beside the directory in use; pressing
    // the default row is the same move a typed `/cd` makes.
    const before = harness.fake.sent.length
    await harness.fake.emitMessage(fakeMessage({ content: '/ws' }))
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(before) })
    const card = (harness.fake.sent.at(-1)!.input as { card: object }).card
    const row = cardControls(card).find(
      control => (control.value as { path?: string }).path === realpathSync(process.cwd()),
    )
    expect(row, 'the workspace picker offered no row for the default directory').toBeDefined()
    await harness.fake.emitCardAction(clickAction(row!.value))

    const settled = harness.fake.sent.length
    emitTurn(harness, 'session-web-ui', '换工作区之后不该再出现')
    await settle()
    expect(harness.fake.sent.length).toBe(settled)
    await harness.dispose()
  })

  it('keeps rendering a session a model switch reuses', async () => {
    const settings = createFakeSettings()
    const { query } = corpus(process.cwd())
    const harness = await mountChannel(
      { showProcess: false },
      { sessionQuery: query, settings: settings.settings },
    )
    harness.agents.declareLive('session-web-ui')

    await pick(harness, 'session-web-ui')
    emitTurn(harness, 'session-web-ui', '换模型之前')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('换模型之前') })

    // `/model` releases the conversation's agent and resumes the SAME session
    // under a new route: a release is not a change of session, and the renderer
    // it already watches through has to stay.
    await harness.fake.emitMessage(fakeMessage({ content: '/model use next-provider/next-model' }))
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(0) })
    emitTurn(harness, 'session-web-ui', '换模型之后仍然在')
    await vi.waitFor(() => { expect(sentMarkdown(harness)).toContain('换模型之后仍然在') })
    await harness.dispose()
  })
})
