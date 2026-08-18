import { dirname, join } from 'node:path'
import { mkdtempSync, realpathSync } from 'node:fs'
import { readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyLarkDocumentUrl,
  createAnchoredLarkDocumentComment,
  createLarkDocument,
  fetchLarkDocumentMarkdown,
  grantLarkDocumentReader,
  appendLarkDocument,
  escapeLarkDocumentTitle,
  larkDocumentAppendData,
  larkDocumentCreateData,
  LARK_DOC_MARKDOWN_FETCH_DATA,
  resolveLarkDocumentTarget,
} from '../src/larkdocs.ts'
import { collectLarkDocumentSnapshots, MAX_LARK_DOCS_PER_MESSAGE } from '../src/larkdoc-inbound.ts'
import { runPutCommand, sendDocTool } from '../src/larkdoc-publish.ts'
import { ReadLarkDocumentSessions } from '../src/larkdoc-session.ts'
import { collectInboundFiles, inboxDirectoryFor } from '../src/files.ts'
import { createFakePort, fakeMessage, mountChannel } from './harness.ts'

/** Workspaces written by these tests, removed after each case. */
const workspaces: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

function createWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-docs-')))
  workspaces.push(workspace)
  return workspace
}

function docResponse(content: string, title?: string): object {
  return {
    code: 0,
    data: { document: { content, ...title === undefined ? {} : { title } } },
  }
}

function stage(overrides: {
  workspace?: string
  enabled?: boolean
  capabilityEnabled?: boolean
  maxFileBytes?: number
  sessionId?: string
} = {}) {
  const fake = createFakePort()
  const readDocuments = new ReadLarkDocumentSessions()
  const reports: string[] = []
  const correctFailure = vi.fn(async () => {})
  const options = {
    workspace: overrides.workspace ?? createWorkspace(),
    sessionId: overrides.sessionId ?? 'lark-session-a',
    enabled: overrides.enabled ?? true,
    capabilityEnabled: overrides.capabilityEnabled ?? true,
    maxFileBytes: overrides.maxFileBytes ?? 1024,
    readDocuments,
    report: (line: string) => { reports.push(line) },
    correctFailure,
  }
  return { fake, options, readDocuments, reports, correctFailure }
}

describe('Lark document links and protocol', () => {
  it('classifies every designed URL shape without treating lookalike hosts as Lark', () => {
    expect(classifyLarkDocumentUrl('https://acme.feishu.cn/docx/doc_1?from=chat'))
      .toMatchObject({ kind: 'docx', token: 'doc_1' })
    expect(classifyLarkDocumentUrl('https://bytedance.larkoffice.com/wiki/wiki_1'))
      .toMatchObject({ kind: 'wiki', token: 'wiki_1' })
    expect(classifyLarkDocumentUrl('https://acme.larksuite.com/docs/legacy_1'))
      .toMatchObject({ kind: 'unsupported', type: 'docs', token: 'legacy_1' })
    for (const type of ['sheets', 'base', 'minutes', 'file'] as const) {
      expect(classifyLarkDocumentUrl(`https://acme.feishu.cn/${type}/${type}_1`))
        .toMatchObject({ kind: 'unsupported', type, token: `${type}_1` })
    }
    expect(classifyLarkDocumentUrl('https://example.com/docx/not_lark')).toMatchObject({ kind: 'external' })
    expect(classifyLarkDocumentUrl('https://evilfeishu.cn/docx/not_lark')).toMatchObject({ kind: 'external' })
  })

  it('sends the exact docs_ai markdown request and rejects non-zero code with code and msg', async () => {
    const { fake } = stage()
    fake.documentResponses.set('doc_1', docResponse('# body', 'Title'))

    await expect(fetchLarkDocumentMarkdown(fake.port, 'doc_1')).resolves.toEqual({
      fileToken: 'doc_1',
      title: 'Title',
      content: '# body',
    })
    expect(fake.documentRequests).toEqual([{
      method: 'POST',
      url: '/open-apis/docs_ai/v1/documents/doc_1/fetch',
      data: LARK_DOC_MARKDOWN_FETCH_DATA,
    }])

    fake.documentResponses.set('denied', { code: 1770001, msg: 'permission denied' })
    await expect(fetchLarkDocumentMarkdown(fake.port, 'denied')).rejects.toMatchObject({
      code: 1770001,
      message: 'permission denied',
    })
  })

  it('locks create payload, PUT append payload, and the typed permission-member signature', async () => {
    const { fake } = stage()
    fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0,
      data: { document: { document_id: 'doc_created', url: 'https://acme.feishu.cn/docx/doc_created' } },
    })
    fake.documentWriteResponses.set('PUT /open-apis/docs_ai/v1/documents/doc_created', {
      code: 0,
      data: { document: { revision_id: 2 } },
    })

    expect(escapeLarkDocumentTitle(`R&D <"Q1">'s`)).toBe('R&amp;D &lt;&#34;Q1&#34;&gt;&#39;s')
    expect(larkDocumentCreateData(`R&D <"Q1">'s`, '# body')).toEqual({
      content: '<title>R&amp;D &lt;&#34;Q1&#34;&gt;&#39;s</title>\n# body',
      format: 'markdown',
      parent_position: 'my_library',
    })
    expect(larkDocumentAppendData('more')).toEqual({
      format: 'markdown', command: 'block_insert_after', block_id: '-1', content: 'more',
    })

    await expect(createLarkDocument(fake.port, 'Report', '# body')).resolves.toMatchObject({
      fileToken: 'doc_created',
      title: 'Report',
      appended: false,
    })
    await expect(appendLarkDocument(
      fake.port,
      { fileToken: 'doc_created', sourceUrl: 'https://acme.feishu.cn/docx/doc_created' },
      'Report',
      'more',
    )).resolves.toMatchObject({ fileToken: 'doc_created', appended: true })
    await grantLarkDocumentReader(fake.port, 'doc_created', { type: 'openchat', id: 'oc_group_1' })

    expect(fake.documentRequests.slice(-2)).toEqual([
      {
        method: 'POST',
        url: '/open-apis/docs_ai/v1/documents',
        data: {
          content: '<title>Report</title>\n# body',
          format: 'markdown',
          parent_position: 'my_library',
        },
      },
      {
        method: 'PUT',
        url: '/open-apis/docs_ai/v1/documents/doc_created',
        data: { format: 'markdown', command: 'block_insert_after', block_id: '-1', content: 'more' },
      },
    ])
    expect(fake.permissionRequests).toEqual([{
      data: { member_type: 'openchat', member_id: 'oc_group_1', perm: 'view' },
      params: { type: 'docx', need_notification: false },
      path: { token: 'doc_created' },
    }])
  })

  it('reports a write that landed even when the turn was stopped on the way back', async () => {
    const { fake } = stage()
    fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0,
      data: { document: { document_id: 'doc_stopped', url: 'https://acme.feishu.cn/docx/doc_stopped' } },
    })
    fake.documentWriteResponses.set('PUT /open-apis/docs_ai/v1/documents/doc_stopped', {
      code: 0,
      data: { document: { revision_id: 2 } },
    })
    fake.documentWriteResponses.set('POST /open-apis/drive/v1/files/doc_stopped/new_comments', {
      code: 0,
      data: { comment_id: 'cmt_stopped' },
    })

    /**
     * A port whose answer and the cancellation arrive together: the write HAS
     * landed by the time the signal aborts. Each write gets its own controller,
     * because cancelling BEFORE a request is the branch that must still refuse.
     */
    const stopOnAnswer = (controller: AbortController) => ({
      ...fake.port,
      rawClient: {
        ...fake.port.rawClient,
        request: async (request: { method: string; url: string; data?: unknown; signal?: AbortSignal }) => {
          const response = await fake.port.rawClient.request(request)
          controller.abort(new Error('turn stopped'))
          return response
        },
        drive: {
          v1: {
            permissionMember: {
              create: async (payload: {
                data: { member_type: 'openid' | 'openchat'; member_id: string; perm: 'view' }
                params: { type: 'docx'; need_notification?: boolean }
                path: { token: string }
              }) => {
                const created = fake.port.rawClient.drive?.v1.permissionMember.create
                const response = await created!(payload)
                controller.abort(new Error('turn stopped'))
                return response
              },
            },
          },
        },
      },
    })

    const creating = new AbortController()
    await expect(createLarkDocument(stopOnAnswer(creating), 'Stopped', '# body', { signal: creating.signal }))
      .resolves.toMatchObject({ fileToken: 'doc_stopped', appended: false })
    expect(creating.signal.aborted).toBe(true)

    const appending = new AbortController()
    await expect(appendLarkDocument(
      stopOnAnswer(appending),
      { fileToken: 'doc_stopped', sourceUrl: 'https://acme.feishu.cn/docx/doc_stopped' },
      'Stopped',
      'more',
      appending.signal,
    )).resolves.toMatchObject({ fileToken: 'doc_stopped', appended: true })

    const granting = new AbortController()
    await expect(grantLarkDocumentReader(
      stopOnAnswer(granting),
      'doc_stopped',
      { type: 'openchat', id: 'oc_group_1' },
      granting.signal,
    )).resolves.toBeUndefined()

    const commenting = new AbortController()
    await expect(createAnchoredLarkDocumentComment(
      stopOnAnswer(commenting),
      'doc_stopped',
      'blk_1',
      [{ type: 'text_run', text: 'note' }],
      commenting.signal,
    )).resolves.toBe('cmt_stopped')

    // …and a cancellation that arrives BEFORE the request still costs nothing.
    const early = new AbortController()
    early.abort(new Error('turn stopped'))
    await expect(appendLarkDocument(
      stopOnAnswer(early),
      { fileToken: 'doc_stopped', sourceUrl: 'https://acme.feishu.cn/docx/doc_stopped' },
      'Stopped',
      'more',
      early.signal,
    )).rejects.toThrow(/turn stopped/u)
  })

  it('preserves backend create URLs and uses brand-standard Feishu/Lark fallbacks when absent', async () => {
    const { fake } = stage()
    fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0,
      data: { document: { document_id: 'tenant_doc', url: 'https://tenant.example/docx/tenant_doc' } },
    })
    await expect(createLarkDocument(fake.port, 'A', '')).resolves.toMatchObject({
      url: 'https://tenant.example/docx/tenant_doc',
    })

    fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0,
      data: { document: { document_id: 'feishu_doc' } },
    })
    await expect(createLarkDocument(fake.port, 'B', '', { brand: 'feishu' })).resolves.toMatchObject({
      url: 'https://www.feishu.cn/docx/feishu_doc',
    })

    fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0,
      data: { document: { document_id: 'lark_doc' } },
    })
    await expect(createLarkDocument(fake.port, 'C', '', { brand: 'lark' })).resolves.toMatchObject({
      url: 'https://www.larksuite.com/docx/lark_doc',
    })
    expect(fake.documentRequests.at(-1)?.data).toEqual({
      content: '<title>C</title>',
      format: 'markdown',
      parent_position: 'my_library',
    })
  })

  it('send_doc reuses the outbound path boundary and constrains into to this session reads', async () => {
    const workspace = createWorkspace()
    const outside = createWorkspace()
    await writeFile(join(workspace, 'report.md'), '# report')
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(join(outside, 'secret.md'), join(workspace, 'shortcut.md'))
    const fake = createFakePort()
    const reads = new ReadLarkDocumentSessions()
    const publish = vi.fn(async (_session, artifact, target) => ({
      fileToken: target?.fileToken ?? 'created',
      url: target?.sourceUrl ?? 'https://acme.feishu.cn/docx/created',
      title: artifact.title,
      appended: target !== undefined,
    }))
    const tool = sendDocTool({
      readDocuments: reads,
      maxBytes: 1024,
      report: vi.fn(),
      workspaceOf: () => workspace,
      resolveTarget: (_sessionId, value, signal) => resolveLarkDocumentTarget(fake.port, value, signal),
      withOutboundSlot: (_sessionId, operation) => operation(),
      publish,
    }) as { execute(args: unknown, exec: unknown): Promise<unknown> }
    const exec = { agent: { session: { id: 'session-a' } } }

    await expect(tool.execute({ path: join(outside, 'secret.md') }, exec)).rejects.toThrow(/leaves the workspace/)
    await expect(tool.execute({ path: 'shortcut.md' }, exec)).rejects.toThrow(/leaves the workspace/)
    await expect(tool.execute({
      path: 'report.md',
      into: 'https://acme.feishu.cn/docx/not_read',
    }, exec)).rejects.toThrow(/not read in this conversation/)
    reads.remember('session-a', 'read_doc')
    await expect(tool.execute({
      path: 'report.md',
      into: 'https://acme.feishu.cn/docx/read_doc',
    }, exec)).resolves.toMatchObject({ sent: true, appended: true })
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]![1]).toMatchObject({ title: 'report', content: '# report' })
  })

  it('/put accepts a human-selected into target without the session read constraint', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), '# report')
    const fake = createFakePort()
    const publish = vi.fn(async (artifact, target) => ({
      fileToken: target?.fileToken ?? 'created',
      url: target?.sourceUrl ?? 'https://acme.feishu.cn/docx/created',
      title: artifact.title,
      appended: target !== undefined,
    }))

    await expect(runPutCommand(
      '/put report.md --into https://acme.feishu.cn/docx/not_read',
      workspace,
      1024,
      (value, signal) => resolveLarkDocumentTarget(fake.port, value, signal),
      publish,
    )).resolves.toBeUndefined()
    expect(publish.mock.calls[0]![1]).toEqual({
      fileToken: 'not_read',
      sourceUrl: 'https://acme.feishu.cn/docx/not_read',
    })
  })
})

describe('automatic document snapshots', () => {
  it('uses an Axios platform ACL message and tells the reader to add the bot as collaborator', async () => {
    const { fake, options } = stage()
    vi.spyOn(fake.port.rawClient, 'request').mockRejectedValue(Object.assign(
      new Error('Request failed with status code 403'),
      { response: { data: { code: 1770001, msg: 'document is not shared with this app' } } },
    ))

    const result = await collectLarkDocumentSnapshots(
      fakeMessage({ content: 'https://acme.feishu.cn/docx/acl_doc' }),
      fake.port,
      options,
    )

    expect(result.notes.join('\n')).toContain('[1770001] document is not shared with this app')
    expect(result.notes.join('\n')).toContain('请把它加进文档协作者')
  })

  it('resolves wiki with params.token, sanitizes the title, and lands a point-in-time snapshot', async () => {
    const { fake, options, readDocuments } = stage()
    fake.wikiResponses.set('wiki_1', {
      code: 0,
      data: { node: { obj_token: 'doc_1', obj_type: 'docx', title: '../Design/Review' } },
    })
    fake.documentResponses.set('doc_1', docResponse('# frozen body'))
    const msg = fakeMessage({
      messageId: 'om_wiki',
      createTime: Date.UTC(2026, 7, 17, 14, 30, 12),
      content: '请看 https://bytedance.larkoffice.com/wiki/wiki_1。',
    })

    const result = await collectLarkDocumentSnapshots(msg, fake.port, options)

    expect(fake.wikiRequests).toEqual([{ params: { token: 'wiki_1' } }])
    expect(result.landed).toHaveLength(1)
    expect(result.landed[0]!.fileName).toBe('Review.md')
    expect(dirname(result.landed[0]!.path)).toBe(inboxDirectoryFor(msg, options.workspace))
    expect(await readFile(result.landed[0]!.path, 'utf8')).toBe('# frozen body')
    expect(result.notes.join('\n')).toContain('已存为快照到工作区')
    expect(result.notes.join('\n')).toContain('快照是读取那一刻的内容')
    expect(result.notes.join('\n')).toContain(result.landed[0]!.path)
    expect(readDocuments.has(options.sessionId, 'doc_1')).toBe(true)
  })

  it('uses the resolved file token as the title fallback', async () => {
    const { fake, options } = stage()
    fake.documentResponses.set('doc_without_title', docResponse('body'))

    const result = await collectLarkDocumentSnapshots(
      fakeMessage({ content: 'https://acme.feishu.cn/docx/doc_without_title' }),
      fake.port,
      options,
    )

    expect(result.landed[0]!.fileName).toBe('doc_without_title.md')
  })

  it('shares the exact message directory and collision rules with ordinary inbound files', async () => {
    const workspace = createWorkspace()
    const { fake, options } = stage({ workspace })
    fake.resourceBytes.set('file_1', { buffer: Buffer.from('ordinary file') })
    fake.documentResponses.set('doc_1', docResponse('snapshot', 'notes'))
    const msg = fakeMessage({
      messageId: 'om_shared',
      createTime: Date.UTC(2026, 7, 17, 14, 30, 12),
      content: 'https://acme.feishu.cn/docx/doc_1',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'notes.md' }],
    })
    const files = await collectInboundFiles(msg, fake.port, {
      workspace,
      enabled: true,
      maxFileBytes: 1024,
      report: options.report,
    })

    const docs = await collectLarkDocumentSnapshots(msg, fake.port, options)

    expect(dirname(files.landed[0]!.path)).toBe(dirname(docs.landed[0]!.path))
    expect(docs.landed[0]!.fileName).toBe('notes-2.md')
    expect((await readdir(dirname(docs.landed[0]!.path))).sort()).toEqual(['notes-2.md', 'notes.md'])
  })

  it('caps reads at three documents and records the exact skipped count', async () => {
    const { fake, options } = stage()
    const links = Array.from({ length: MAX_LARK_DOCS_PER_MESSAGE + 2 }, (_, index) => `doc_${index + 1}`)
    for (const token of links) fake.documentResponses.set(token, docResponse(token, token))

    const result = await collectLarkDocumentSnapshots(
      fakeMessage({ content: links.map(token => `https://acme.feishu.cn/docx/${token}`).join(' ') }),
      fake.port,
      options,
    )

    expect(result.landed).toHaveLength(3)
    expect(fake.documentRequests).toHaveLength(3)
    expect(result.notes.join('\n')).toContain('后 2 篇未读取')
  })

  it('discards an over-limit body before landing and does not authorize that token', async () => {
    const { fake, options, readDocuments } = stage({ maxFileBytes: 4 })
    fake.documentResponses.set('doc_big', docResponse('12345'))

    const result = await collectLarkDocumentSnapshots(
      fakeMessage({ content: 'https://acme.feishu.cn/docx/doc_big' }),
      fake.port,
      options,
    )

    expect(result.landed).toEqual([])
    expect(result.notes.join('\n')).toContain('5 字节')
    expect(result.notes.join('\n')).toContain('4 字节')
    expect(readDocuments.has(options.sessionId, 'doc_big')).toBe(false)
    expect(await readdir(options.workspace)).toEqual([])
  })

  it('does no API or disk work when the switch or capability gate is closed, but leaves a note', async () => {
    for (const overrides of [{ enabled: false }, { capabilityEnabled: false }]) {
      const { fake, options } = stage(overrides)
      const result = await collectLarkDocumentSnapshots(
        fakeMessage({ content: 'https://acme.feishu.cn/docx/doc_1' }),
        fake.port,
        options,
      )

      expect(result.landed).toEqual([])
      expect(result.notes.join('\n')).toContain('未读取')
      expect(result.notes.join('\n')).toContain('没有落盘快照')
      expect(fake.documentRequests).toEqual([])
      expect(await readdir(options.workspace)).toEqual([])
    }
  })

  it('reports unsupported kinds, includes wiki obj_type, and keeps reading after a failure', async () => {
    const { fake, options, correctFailure } = stage()
    fake.documentResponses.set('denied', {
      code: 99991663,
      msg: 'permission denied',
      error: { permission_violations: [{ subject: 'docx:document:readonly' }] },
    })
    fake.wikiResponses.set('wiki_sheet', {
      code: 0,
      data: { node: { obj_token: 'sheet_1', obj_type: 'sheet' } },
    })
    fake.documentResponses.set('ok', docResponse('still read', 'OK'))
    const result = await collectLarkDocumentSnapshots(fakeMessage({ content: [
      'https://acme.feishu.cn/sheets/sheet_link',
      'https://acme.feishu.cn/docx/denied',
      'https://acme.feishu.cn/wiki/wiki_sheet',
      'https://acme.feishu.cn/docx/ok',
      'https://example.com/docx/ignored',
    ].join(' ') }), fake.port, options)

    expect(result.landed.map(document => document.fileToken)).toEqual(['ok'])
    expect(result.notes.join('\n')).toContain('飞书表格')
    expect(result.notes.join('\n')).toContain('指向 sheet')
    expect(result.notes.join('\n')).toContain('[99991663] permission denied')
    expect(correctFailure).toHaveBeenCalledOnce()
  })
})

describe('read document session boundary and bridge wiring', () => {
  it('isolates tokens per session and clears only the reset session', () => {
    const reads = new ReadLarkDocumentSessions()
    reads.remember('session-a', 'doc_1')
    reads.remember('session-b', 'doc_1')
    reads.remember('session-b', 'doc_2')

    reads.clear('session-a')

    expect([...reads.tokens('session-a')]).toEqual([])
    expect([...reads.tokens('session-b')]).toEqual(['doc_1', 'doc_2'])
  })

  it('clears the current session on /new', async () => {
    const clear = vi.spyOn(ReadLarkDocumentSessions.prototype, 'clear')
    const harness = await mountChannel()

    await harness.fake.emitMessage(fakeMessage({ content: '/new' }))

    expect(clear).toHaveBeenCalledOnce()
    expect(clear.mock.calls[0]![0]).toContain('oc_chat_1')
    await harness.dispose()
  })

  it('places a document failure in the model input instead of swallowing the turn', async () => {
    const workspace = createWorkspace()
    const harness = await mountChannel({ cwd: workspace })
    harness.fake.documentResponses.set('forbidden', { code: 403, msg: 'forbidden by resource permission' })

    await harness.fake.emitMessage(fakeMessage({
      content: '分析这篇 https://acme.feishu.cn/docx/forbidden',
    }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const created = harness.agents.created[0]!
    await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledOnce() })

    const content = created.agent.followup.mock.calls[0]![0].content
    const text = content.find(block => block.type === 'text')
    expect(text).toMatchObject({ type: 'text' })
    expect(text?.type === 'text' ? text.text : '').toContain('机器人没有这篇文档的权限')
    expect(harness.notices.some(line => line.includes('agent creation failed'))).toBe(false)
    await harness.dispose()
  })
})
