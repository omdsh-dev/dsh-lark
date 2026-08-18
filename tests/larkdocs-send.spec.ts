import { mkdtempSync, realpathSync } from 'node:fs'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PUT_COMMAND, SEND_DOC_TOOL } from '../src/larkdoc-publish.ts'
import { QUESTION_TIMEOUT_MS } from '../src/questions.ts'
import {
  approvalValueFromCard,
  cardTexts,
  fakeMessage,
  mountChannel,
  SENDER_ID,
} from './harness.ts'
import type { CreatedAgent } from './harness.ts'

const workspaces: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

async function workspaceWithReport(): Promise<string> {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-send-doc-')))
  workspaces.push(workspace)
  await writeFile(join(workspace, 'report.md'), '# Findings\nAll clear.\n')
  return workspace
}

function registeredTool(created: CreatedAgent) {
  const definition = created.registeredTools.find(tool => tool.name === SEND_DOC_TOOL)
  if (definition === undefined) throw new Error('send_doc was not registered')
  return definition as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> }
}

function cards(harness: Awaited<ReturnType<typeof mountChannel>>): object[] {
  return harness.fake.sent.flatMap(message => 'card' in message.input ? [message.input.card] : [])
}

function sentText(harness: Awaited<ReturnType<typeof mountChannel>>): string {
  return harness.fake.sent.map(message => JSON.stringify(message.input)).join('\n')
}

function click(value: unknown, chatId: string): CardActionEvent {
  return {
    messageId: 'om_doc_card',
    chatId,
    operator: { openId: SENDER_ID, name: 'Owner' },
    action: { tag: 'button', value },
  }
}

async function bind(
  harness: Awaited<ReturnType<typeof mountChannel>>,
  overrides: Partial<NormalizedMessage> = {},
) {
  await harness.fake.emitMessage(fakeMessage(overrides))
  await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
  const created = harness.agents.created[0]!
  return { created, tool: registeredTool(created) }
}

function createFixture(harness: Awaited<ReturnType<typeof mountChannel>>, token = 'doc_created'): void {
  harness.fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
    code: 0,
    data: { document: { document_id: token, url: `https://acme.feishu.cn/docx/${token}` } },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('send_doc and /put bridge wiring', () => {
  it('shares three outbound-content slots across thread sessions and releases one after rejection', async () => {
    const workspace = await workspaceWithReport()
    const harness = await mountChannel({ cwd: workspace, sessionScope: 'chat-thread' })
    await harness.fake.emitMessage(fakeMessage({
      chatType: 'group', chatId: 'oc_group_slots', threadId: 'omt_thread_1', messageId: 'om_thread_1',
    }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    await harness.fake.emitMessage(fakeMessage({
      chatType: 'group', chatId: 'oc_group_slots', threadId: 'omt_thread_2', messageId: 'om_thread_2',
    }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(2) })
    const first = harness.agents.created[0]!
    const second = harness.agents.created[1]!
    const firstTool = registeredTool(first)
    const secondTool = registeredTool(second)
    const offer = (tool: ReturnType<typeof registeredTool>, created: CreatedAgent): Promise<unknown> => tool
      .execute({ path: 'report.md' }, { agent: created.agent })
      .then(value => value, (error: unknown) => error)

    const standing = [offer(firstTool, first), offer(firstTool, first), offer(secondTool, second)]
    await vi.waitFor(() => { expect(cards(harness)).toHaveLength(3) })
    expect(String(await offer(secondTool, second))).toContain('already has 3 outbound artifacts')
    expect(cards(harness)).toHaveLength(3)
    expect(harness.fake.documentRequests).toHaveLength(0)

    const reject = approvalValueFromCard(cards(harness)[0]!).find(value => value.decision === 'reject')!
    await harness.fake.emitCardAction(click(reject, 'oc_group_slots'))
    await Promise.race(standing)
    const replacement = offer(secondTool, second)
    await vi.waitFor(() => { expect(cards(harness)).toHaveLength(4) })
    await harness.dispose()
    await Promise.all([...standing, replacement])
  })

  it('publishes directly in p2p and grants the initiating user read access', async () => {
    const workspace = await workspaceWithReport()
    const harness = await mountChannel({ cwd: workspace })
    createFixture(harness)
    const { created, tool } = await bind(harness)

    await expect(tool.execute({ path: 'report.md' }, { agent: created.agent })).resolves.toMatchObject({
      sent: true,
      link: 'https://acme.feishu.cn/docx/doc_created',
      appended: false,
    })
    expect(cards(harness)).toHaveLength(0)
    expect(harness.fake.permissionRequests).toEqual([{
      data: { member_type: 'openid', member_id: SENDER_ID, perm: 'view' },
      params: { type: 'docx', need_notification: false },
      path: { token: 'doc_created' },
    }])
    expect(sentText(harness)).toContain('仅发起人可读')
    expect(sentText(harness)).toContain('https://acme.feishu.cn/docx/doc_created')
    await harness.dispose()
  })

  it('derives the Lark fallback brand from config.domain when create omits its URL', async () => {
    const workspace = await workspaceWithReport()
    const harness = await mountChannel({ cwd: workspace, domain: 'https://open.larksuite.com' })
    harness.fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0, data: { document: { document_id: 'lark_fallback' } },
    })
    const bound = await bind(harness)

    await expect(bound.tool.execute({ path: 'report.md' }, { agent: bound.created.agent })).resolves.toMatchObject({
      link: 'https://www.larksuite.com/docx/lark_fallback',
    })
    expect(sentText(harness)).toContain('https://www.larksuite.com/docx/lark_fallback')
    await harness.dispose()
  })

  it('creates nothing in a group until an authorized click allows publication', async () => {
    const workspace = await workspaceWithReport()
    const harness = await mountChannel({ cwd: workspace })
    createFixture(harness)
    const { created, tool } = await bind(harness, { chatType: 'group', chatId: 'oc_group_1' })

    const publishing = tool.execute({ path: 'report.md' }, { agent: created.agent })
    await vi.waitFor(() => { expect(cards(harness)).toHaveLength(1) })
    expect(harness.fake.documentRequests).toHaveLength(0)
    const approval = cards(harness)[0]!
    const text = cardTexts(approval).map(item => item.content)
    expect(text).toContain('report')
    expect(text).toContain('当前群（oc_group_1）')
    const allow = approvalValueFromCard(approval).find(value => value.decision === 'allow')!
    await harness.fake.emitCardAction(click(allow, 'oc_group_1'))

    await expect(publishing).resolves.toMatchObject({ sent: true })
    expect(harness.fake.documentRequests[0]?.method).toBe('POST')
    expect(harness.fake.permissionRequests[0]?.data).toEqual({
      member_type: 'openchat', member_id: 'oc_group_1', perm: 'view',
    })
    expect(sentText(harness)).toContain('这个群可读')
    await harness.dispose()
  })

  it('rejects and times out before create, while group /put creates with no card', async () => {
    const workspace = await workspaceWithReport()
    const rejected = await mountChannel({ cwd: workspace })
    createFixture(rejected, 'never_created')
    const bound = await bind(rejected, { chatType: 'group', chatId: 'oc_group_1' })
    const publishing = bound.tool.execute({ path: 'report.md' }, { agent: bound.created.agent })
    await vi.waitFor(() => { expect(cards(rejected)).toHaveLength(1) })
    const reject = approvalValueFromCard(cards(rejected)[0]!).find(value => value.decision === 'reject')!
    await rejected.fake.emitCardAction(click(reject, 'oc_group_1'))
    await expect(publishing).rejects.toThrow(/rejected publishing/)
    expect(rejected.fake.documentRequests).toHaveLength(0)
    await rejected.dispose()

    const timed = await mountChannel({ cwd: workspace })
    createFixture(timed, 'never_created')
    const timedBound = await bind(timed, { chatType: 'group', chatId: 'oc_group_2' })
    vi.useFakeTimers()
    const waiting = timedBound.tool.execute({ path: 'report.md' }, { agent: timedBound.created.agent })
    const timedOut = expect(waiting).rejects.toThrow(/within 30 minutes/)
    await vi.waitFor(() => { expect(cards(timed)).toHaveLength(1) })
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS)
    await timedOut
    expect(timed.fake.documentRequests).toHaveLength(0)
    vi.useRealTimers()
    await timed.dispose()

    const command = await mountChannel({ cwd: workspace })
    createFixture(command, 'put_created')
    await command.fake.emitMessage(fakeMessage({
      chatType: 'group',
      chatId: 'oc_group_3',
      content: `/${PUT_COMMAND} report.md`,
    }))
    expect(cards(command)).toHaveLength(0)
    expect(command.agents.created).toHaveLength(0)
    expect(command.fake.permissionRequests[0]?.data.member_type).toBe('openchat')
    expect(sentText(command)).toContain('https://acme.feishu.cn/docx/put_created')
    await command.dispose()
  })

  it('returns the real link and a precise warning when collaborator grant fails', async () => {
    const workspace = await workspaceWithReport()
    const harness = await mountChannel({ cwd: workspace })
    createFixture(harness)
    harness.fake.permissionResponses.set('doc_created', { code: 403, msg: 'permission member denied' })
    const { created, tool } = await bind(harness)

    await expect(tool.execute({ path: 'report.md' }, { agent: created.agent })).resolves.toMatchObject({
      sent: true,
      link: 'https://acme.feishu.cn/docx/doc_created',
      warning: expect.stringContaining('只有机器人能打开'),
    })
    expect(sentText(harness)).toContain('https://acme.feishu.cn/docx/doc_created')
    expect(sentText(harness)).toContain('只有机器人能打开，请手动共享')
    expect(harness.notices.some(line => line.includes('exists but granting'))).toBe(true)
    await harness.dispose()
  })

  it('corrects write capability for wiki target scope violations from send_doc and /put, but not resource ACLs', async () => {
    const workspace = await workspaceWithReport()
    const registerApp = async (request: {
      onQRCodeReady(input: { url: string; expireIn: number }): void
    }) => {
      request.onQRCodeReady({ url: 'https://accounts.example/authorize', expireIn: 600 })
      return { client_id: 'cli_test', client_secret: 'unchanged' }
    }
    const model = await mountChannel({ cwd: workspace, registeredBy: SENDER_ID }, { registerApp })
    model.fake.wikiResponses.set('wiki_scope', {
      code: 99991672,
      msg: 'wiki write scope missing',
      error: { permission_violations: [{ subject: 'wiki:node:write-test' }] },
    })
    const bound = await bind(model)
    await expect(bound.tool.execute({
      path: 'report.md', into: 'https://acme.feishu.cn/wiki/wiki_scope',
    }, { agent: bound.created.agent })).rejects.toThrow(/wiki write scope missing/)
    await vi.waitFor(() => { expect(cards(model).length).toBeGreaterThan(0) })
    expect(model.notices.some(line => line.includes('document write capability disabled'))).toBe(true)
    expect(model.fake.documentRequests).toHaveLength(0)
    await model.fake.emitMessage(fakeMessage({ chatId: 'oc_after_write_correction', messageId: 'om_after_correction' }))
    await vi.waitFor(() => { expect(model.agents.created).toHaveLength(2) })
    expect(model.agents.created[1]!.registeredTools.map(tool => tool.name)).not.toContain(SEND_DOC_TOOL)
    await model.dispose()

    const command = await mountChannel({ cwd: workspace, registeredBy: SENDER_ID }, { registerApp })
    command.fake.wikiResponses.set('wiki_scope', {
      code: 99991672,
      msg: 'wiki write scope missing',
      error: { permission_violations: [{ subject: 'wiki:node:write-test' }] },
    })
    await command.fake.emitMessage(fakeMessage({
      content: `/${PUT_COMMAND} report.md --into https://acme.feishu.cn/wiki/wiki_scope`,
    }))
    await vi.waitFor(() => { expect(cards(command).length).toBeGreaterThan(0) })
    expect(command.notices.some(line => line.includes('document write capability disabled'))).toBe(true)
    await command.dispose()

    const acl = await mountChannel({ cwd: workspace, registeredBy: SENDER_ID }, { registerApp })
    acl.fake.wikiResponses.set('wiki_acl', { code: 1770001, msg: 'document is not shared with this app' })
    const aclBound = await bind(acl)
    await expect(aclBound.tool.execute({
      path: 'report.md', into: 'https://acme.feishu.cn/wiki/wiki_acl',
    }, { agent: aclBound.created.agent })).rejects.toThrow(/not shared/)
    expect(cards(acl)).toHaveLength(0)
    expect(acl.notices.some(line => line.includes('document write capability disabled'))).toBe(false)
    await acl.dispose()
  })

  it('passes cancellation to deferred create/append and stops before permission or receipt', async () => {
    const workspace = await workspaceWithReport()
    const createHarness = await mountChannel({ cwd: workspace })
    const createResponse = deferred<object>()
    createHarness.fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', createResponse.promise)
    const createBound = await bind(createHarness, { chatType: 'group', chatId: 'oc_abort_create' })
    const createController = new AbortController()
    const creating = createBound.tool.execute(
      { path: 'report.md' },
      { agent: createBound.created.agent, signal: createController.signal },
    ).then(value => value, (error: unknown) => error)
    await vi.waitFor(() => { expect(cards(createHarness)).toHaveLength(1) })
    const allow = approvalValueFromCard(cards(createHarness)[0]!).find(value => value.decision === 'allow')!
    await createHarness.fake.emitCardAction(click(allow, 'oc_abort_create'))
    await vi.waitFor(() => {
      expect(createHarness.fake.documentRequests.some(request => request.method === 'POST'
        && request.url === '/open-apis/docs_ai/v1/documents')).toBe(true)
    })
    expect(createHarness.fake.documentRequests.at(-1)?.signal).toBe(createController.signal)
    createController.abort(new Error('cancelled deferred create'))
    createResponse.resolve({
      code: 0,
      data: { document: { document_id: 'created_but_cancelled', url: 'https://acme.feishu.cn/docx/cancelled' } },
    })
    expect(String(await creating)).toContain('cancelled deferred create')
    expect(createHarness.fake.permissionRequests).toHaveLength(0)
    expect(sentText(createHarness)).not.toContain('/docx/cancelled')
    await createHarness.dispose()

    const appendHarness = await mountChannel({ cwd: workspace })
    appendHarness.fake.documentResponses.set('doc_read', {
      code: 0, data: { document: { title: 'Read', content: '# snapshot' } },
    })
    const appendBound = await bind(appendHarness, {
      chatType: 'group', chatId: 'oc_abort_append', content: 'https://acme.feishu.cn/docx/doc_read',
    })
    const appendResponse = deferred<object>()
    appendHarness.fake.documentWriteResponses.set('PUT /open-apis/docs_ai/v1/documents/doc_read', appendResponse.promise)
    const appendController = new AbortController()
    const appending = appendBound.tool.execute({
      path: 'report.md', into: 'https://acme.feishu.cn/docx/doc_read',
    }, { agent: appendBound.created.agent, signal: appendController.signal })
      .then(value => value, (error: unknown) => error)
    await vi.waitFor(() => {
      expect(appendHarness.fake.documentRequests.some(request => request.method === 'PUT')).toBe(true)
    })
    expect(appendHarness.fake.documentRequests.at(-1)?.signal).toBe(appendController.signal)
    appendController.abort(new Error('cancelled deferred append'))
    appendResponse.resolve({ code: 0, data: { document: { revision_id: 2 } } })
    expect(String(await appending)).toContain('cancelled deferred append')
    expect(sentText(appendHarness)).not.toContain('已追加')
    await appendHarness.dispose()

    const grantHarness = await mountChannel({ cwd: workspace })
    createFixture(grantHarness, 'grant_cancelled')
    const grantResponse = deferred<object>()
    grantHarness.fake.permissionResponses.set('grant_cancelled', grantResponse.promise)
    const grantBound = await bind(grantHarness)
    const grantController = new AbortController()
    const granting = grantBound.tool.execute(
      { path: 'report.md' },
      { agent: grantBound.created.agent, signal: grantController.signal },
    ).then(value => value, (error: unknown) => error)
    await vi.waitFor(() => { expect(grantHarness.fake.permissionRequests).toHaveLength(1) })
    grantController.abort(new Error('cancelled deferred grant'))
    grantResponse.resolve({ code: 0, msg: 'ok' })
    expect(String(await granting)).toContain('cancelled deferred grant')
    expect(sentText(grantHarness)).not.toContain('/docx/grant_cancelled')
    await grantHarness.dispose()
  })

  it('returns partial success instead of repeating create/append when the final chat receipt fails', async () => {
    const workspace = await workspaceWithReport()
    const created = await mountChannel({ cwd: workspace })
    createFixture(created)
    const createBound = await bind(created)
    created.fake.state.failNextSend = true
    await expect(createBound.tool.execute({ path: 'report.md' }, { agent: createBound.created.agent }))
      .resolves.toMatchObject({
        sent: true,
        link: 'https://acme.feishu.cn/docx/doc_created',
        warning: expect.stringContaining('不要重试写入'),
      })
    expect(created.fake.documentRequests.filter(request => request.method === 'POST')).toHaveLength(1)
    await created.dispose()

    const appended = await mountChannel({ cwd: workspace })
    appended.fake.documentResponses.set('doc_read', {
      code: 0, data: { document: { title: 'Read', content: '# snapshot' } },
    })
    const appendBound = await bind(appended, { content: 'https://acme.feishu.cn/docx/doc_read' })
    appended.fake.documentWriteResponses.set('PUT /open-apis/docs_ai/v1/documents/doc_read', {
      code: 0, data: { document: { revision_id: 2 } },
    })
    appended.fake.state.failNextSend = true
    await expect(appendBound.tool.execute({
      path: 'report.md', into: 'https://acme.feishu.cn/docx/doc_read',
    }, { agent: appendBound.created.agent })).resolves.toMatchObject({
      sent: true,
      appended: true,
      link: 'https://acme.feishu.cn/docx/doc_read',
      warning: expect.stringContaining('不要重试写入'),
    })
    expect(appended.fake.documentRequests.filter(request => request.method === 'PUT')).toHaveLength(1)
    await appended.dispose()

    const command = await mountChannel({ cwd: workspace })
    createFixture(command, 'put_receipt')
    command.fake.state.failNextSend = true
    await command.fake.emitMessage(fakeMessage({ content: `/${PUT_COMMAND} report.md` }))
    expect(command.fake.documentRequests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(sentText(command)).toContain('https://acme.feishu.cn/docx/put_receipt')
    expect(sentText(command)).toContain('内容不会重试')
    await command.dispose()
  })

  it.skipIf(process.getuid?.() === 0)('scrubs the host path from send_doc and /put read failures', async () => {
    const workspace = await workspaceWithReport()
    const harness = await mountChannel({ cwd: workspace })
    const { created, tool } = await bind(harness)
    await chmod(join(workspace, 'report.md'), 0o000)

    const toolFailure = await tool.execute({ path: 'report.md' }, { agent: created.agent })
      .then(() => undefined, (error: unknown) => error)
    expect(String(toolFailure)).toContain('EACCES')
    expect(String(toolFailure)).not.toContain(workspace)

    await harness.fake.emitMessage(fakeMessage({ messageId: 'om_put_failed', content: `/${PUT_COMMAND} report.md` }))
    expect(sentText(harness)).toContain('EACCES')
    expect(sentText(harness)).not.toContain(workspace)
    await harness.dispose()
  })

  it('hides and denies send_doc when switched off, and keeps help/panel synchronized', async () => {
    const workspace = await workspaceWithReport()
    const enabled = await mountChannel({ cwd: workspace }, { commands: { list: () => [], execute: async () => undefined } })
    await enabled.fake.emitMessage(fakeMessage({ content: '/help' }))
    await vi.waitFor(() => { expect(sentText(enabled)).toContain(`/${PUT_COMMAND}`) })
    expect(enabled.fake.panelCreated).toContain(PUT_COMMAND)
    await enabled.dispose()

    const disabled = await mountChannel(
      { cwd: workspace, sendDocs: false },
      { commands: { list: () => [], execute: async () => undefined } },
    )
    await disabled.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(disabled.agents.created).toHaveLength(1) })
    const created = disabled.agents.created[0]!
    expect(created.registeredTools.map(tool => tool.name)).not.toContain(SEND_DOC_TOOL)
    expect(created.denyReason(SEND_DOC_TOOL)).toBeDefined()
    expect(created.promptSections.find(section => section.name === 'lark-channel:presence')?.text).toContain(SEND_DOC_TOOL)
    expect(disabled.fake.panelCreated).not.toContain(PUT_COMMAND)
    await disabled.dispose()

    // A capability goes dark only on a real refusal now: an unverified scope
    // map informs but cannot gate, so `scopeGrants: []` no longer turns
    // anything off. The platform's own violation is what does.
    const noCapability = await mountChannel({ cwd: workspace, docAuthorizeOnDemand: false })
    noCapability.fake.documentResponses.set('doc_denied', {
      code: 99991672,
      msg: 'Access denied',
      error: { permission_violations: [{ subject: 'docx:document:readonly' }] },
    })
    await noCapability.fake.emitMessage(fakeMessage({ content: 'https://acme.feishu.cn/docx/doc_denied' }))
    await vi.waitFor(() => { expect(noCapability.agents.created).toHaveLength(1) })
    // A new chat, because the agent that made the failing call keeps the tool
    // table it was born with.
    await noCapability.fake.emitMessage(fakeMessage({ chatId: 'oc_dark', messageId: 'om_dark', content: 'hi' }))
    await vi.waitFor(() => { expect(noCapability.agents.created).toHaveLength(2) })
    expect(noCapability.agents.created[1]!.registeredTools.map(tool => tool.name)).not.toContain(SEND_DOC_TOOL)
    expect(noCapability.agents.created[1]!.denyReason(SEND_DOC_TOOL)).toBeDefined()
    await noCapability.dispose()

    const oldRegistry = await mountChannel({ cwd: workspace }, { agentsCanRegisterTools: false })
    await oldRegistry.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(oldRegistry.agents.created).toHaveLength(1) })
    expect(oldRegistry.agents.created[0]!.denyReason(SEND_DOC_TOOL)).toBeDefined()
    expect(oldRegistry.notices.some(line =>
      line.includes(SEND_DOC_TOOL) && line.includes('could not be registered'))).toBe(true)
    await oldRegistry.dispose()
  })
})
