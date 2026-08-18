import { mkdtempSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertLarkCommentTextLimit,
  countLarkCommentTextRunes,
  LARK_DOC_ANCHOR_FETCH_DATA,
  MAX_LARK_DOC_COMMENT_RUNES,
} from '../src/larkdocs.ts'
import type { LarkCommentReplyElement } from '../src/larkdocs.ts'
import { collectLarkDocumentSnapshots } from '../src/larkdoc-inbound.ts'
import {
  COMMENT_ON_DOC_TOOL,
  commentOnDocTool,
  LarkDocumentCommentQuotas,
  READ_DOC_ANCHORS_TOOL,
  readDocAnchorsTool,
} from '../src/larkdoc-comments.ts'
import type { CommentDocPorts } from '../src/larkdoc-comments.ts'
import {
  isSameLarkDocumentFileIdentity,
  ReadLarkDocumentSessions,
} from '../src/larkdoc-session.ts'
import { createFakePort, fakeMessage, mountChannel } from './harness.ts'

const workspaces: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

function createWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-doc-comments-')))
  workspaces.push(workspace)
  return workspace
}

function docResponse(content: string, title?: string): object {
  return {
    code: 0,
    data: { document: { content, ...title === undefined ? {} : { title } } },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function directStage(limit = 20, maxFileBytes = 1024) {
  const fake = createFakePort()
  const workspace = createWorkspace()
  const readDocuments = new ReadLarkDocumentSessions()
  const quotas = new LarkDocumentCommentQuotas(limit)
  const anchorsProbe: {
    handler?: NonNullable<CommentDocPorts['afterAnchorsIdentityValidation']>
    beforeHandler?: NonNullable<CommentDocPorts['beforeAnchorsOpen']>
  } = {}
  const reports: string[] = []
  const correctFailure = vi.fn(async () => {})
  const ports: CommentDocPorts = {
    protocol: fake.port,
    readDocuments,
    quotas,
    maxFileBytes,
    report: line => { reports.push(line) },
    workspaceOf: () => workspace,
    chatIdOf: () => 'oc_chat_1',
    correctFailure,
    afterAnchorsIdentityValidation: input => anchorsProbe.handler?.(input),
    beforeAnchorsOpen: input => anchorsProbe.beforeHandler?.(input),
  }
  const exec = { agent: { session: { id: 'session-a' } } }
  return { fake, workspace, readDocuments, quotas, reports, correctFailure, anchorsProbe, ports, exec }
}

function registeredTool(
  created: Awaited<ReturnType<typeof mountChannel>>['agents']['created'][number],
  name: string,
) {
  const definition = created.registeredTools.find(tool => tool.name === name)
  if (definition === undefined) throw new Error(`${name} was not registered`)
  return definition as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> }
}

describe('document comment protocol', () => {
  it('distinguishes an inode reused for a later file generation', () => {
    const original = { device: 1n, inode: 2n, birthtimeNanoseconds: 3n }
    const replacement = { ...original, birthtimeNanoseconds: 4n }

    expect(isSameLarkDocumentFileIdentity(original, replacement)).toBe(false)
    expect(isSameLarkDocumentFileIdentity(original, { ...original })).toBe(true)
  })

  it('lands the comment-aware XML as a second file beside the original wiki snapshot', async () => {
    const stage = directStage()
    stage.fake.wikiResponses.set('wiki_1', {
      code: 0,
      data: { node: { obj_token: 'doc_1', obj_type: 'docx', title: 'Design Review' } },
    })
    stage.fake.documentResponses.set('doc_1', docResponse('# markdown', 'API title'))
    const msg = fakeMessage({
      messageId: 'om_comments',
      createTime: Date.UTC(2026, 7, 17, 14, 30, 12),
      content: 'https://bytedance.larkoffice.com/wiki/wiki_1',
    })
    const landed = await collectLarkDocumentSnapshots(msg, stage.fake.port, {
      workspace: stage.workspace,
      sessionId: 'session-a',
      enabled: true,
      capabilityEnabled: true,
      maxFileBytes: 1024,
      readDocuments: stage.readDocuments,
      report: stage.ports.report,
      correctFailure: stage.correctFailure,
    })
    stage.fake.documentResponses.set('doc_1', docResponse('<doc><block id="b1"/></doc>', 'New API title'))

    const tool = readDocAnchorsTool(stage.ports) as {
      execute(args: unknown, exec: unknown): Promise<{ path: string }>
    }
    const result = await tool.execute(
      { doc: 'https://bytedance.larkoffice.com/wiki/wiki_1' },
      stage.exec,
    )

    stage.fake.documentResponses.set('doc_1', docResponse('<doc><block id="b2"/></doc>', 'Newest API title'))
    const refreshed = await tool.execute(
      { doc: 'https://bytedance.larkoffice.com/wiki/wiki_1' },
      stage.exec,
    )

    expect(dirname(result.path)).toBe(dirname(landed.landed[0]!.path))
    expect(result.path).toBe(join(dirname(landed.landed[0]!.path), 'Design Review.blocks.xml'))
    expect(refreshed.path).toBe(result.path)
    expect(stage.readDocuments.reference('session-a', 'doc_1')?.anchorsIdentity).toBeDefined()
    expect(await readFile(result.path, 'utf8')).toBe('<doc><block id="b2"/></doc>')
    const siblings = await readdir(dirname(result.path))
    expect(siblings.filter(name => name.endsWith('.blocks.xml'))).toEqual(['Design Review.blocks.xml'])
    expect(siblings.some(name => name.endsWith('.tmp'))).toBe(false)
    expect(stage.fake.documentRequests.at(-1)).toEqual({
      method: 'POST',
      url: '/open-apis/docs_ai/v1/documents/doc_1/fetch',
      data: LARK_DOC_ANCHOR_FETCH_DATA,
    })
    expect(JSON.parse(LARK_DOC_ANCHOR_FETCH_DATA.extra_param)).toMatchObject({
      enable_user_cite_reference_map: true,
      include_comments: true,
      return_html5_block_data: true,
    })
    expect(LARK_DOC_ANCHOR_FETCH_DATA.export_option).toEqual({ export_block_id: true })
  })

  it('rejects over-limit anchored XML before writing and reports exact bytes and limit', async () => {
    const stage = directStage(20, 4)
    const snapshot = join(stage.workspace, 'snapshot.md')
    await writeFile(snapshot, 'x')
    stage.readDocuments.remember('session-a', 'doc_1', { path: snapshot, title: 'Review' })
    stage.fake.documentResponses.set('doc_1', docResponse('12345', 'Review'))
    const tool = readDocAnchorsTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }

    await expect(tool.execute({ doc: 'https://acme.feishu.cn/docx/doc_1' }, stage.exec))
      .rejects.toThrow(/5 bytes.*4 bytes/s)
    expect((await readdir(stage.workspace)).filter(name => name.endsWith('.blocks.xml'))).toEqual([])
  })

  it('rejects a deterministic parent-directory swap after containment without touching the external victim', async () => {
    const stage = directStage()
    const messageDirectory = join(stage.workspace, 'message')
    await mkdir(messageDirectory)
    const snapshot = join(messageDirectory, 'snapshot.md')
    await writeFile(snapshot, 'x')
    stage.readDocuments.remember('session-a', 'doc_1', { path: snapshot, title: 'Review' })
    stage.fake.documentResponses.set('doc_1', docResponse('first', 'Review'))
    const tool = readDocAnchorsTool(stage.ports) as {
      execute(args: unknown, exec: unknown): Promise<{ path: string }>
    }
    const args = { doc: 'https://acme.feishu.cn/docx/doc_1' }
    const first = await tool.execute(args, stage.exec)

    const outside = createWorkspace()
    const victim = join(outside, basename(first.path))
    await writeFile(victim, 'do not touch')
    const movedDirectory = join(stage.workspace, 'message-moved')
    stage.anchorsProbe.handler = async ({ phase }) => {
      if (phase !== 'refresh') return
      delete stage.anchorsProbe.handler
      await rename(messageDirectory, movedDirectory)
      await symlink(outside, messageDirectory, 'dir')
    }
    stage.fake.documentResponses.set('doc_1', docResponse('refreshed', 'Review'))
    await expect(tool.execute(args, stage.exec)).rejects.toThrow(/no longer resolves inside|path changed/)
    expect(await readFile(victim, 'utf8')).toBe('do not touch')
    expect(await readFile(join(movedDirectory, basename(first.path)), 'utf8')).toBe('first')
    expect(await readdir(outside)).toEqual([basename(first.path)])
  })

  it('cleans its exclusive empty file when the parent is swapped before open', async () => {
    const stage = directStage()
    const messageDirectory = join(stage.workspace, 'message')
    await mkdir(messageDirectory)
    const snapshot = join(messageDirectory, 'snapshot.md')
    await writeFile(snapshot, 'x')
    stage.readDocuments.remember('session-a', 'doc_1', { path: snapshot, title: 'Review' })
    stage.fake.documentResponses.set('doc_1', docResponse('must not escape', 'Review'))
    const outside = createWorkspace()
    const movedDirectory = join(stage.workspace, 'message-moved')
    stage.anchorsProbe.beforeHandler = async ({ phase }) => {
      if (phase !== 'create') return
      delete stage.anchorsProbe.beforeHandler
      await rename(messageDirectory, movedDirectory)
      await symlink(outside, messageDirectory, 'dir')
    }
    const tool = readDocAnchorsTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }

    await expect(tool.execute({ doc: 'https://acme.feishu.cn/docx/doc_1' }, stage.exec))
      .rejects.toThrow(/no longer resolves inside/)
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(movedDirectory)).toEqual(['snapshot.md'])
  })

  it('does not delete a different inode raced into the exclusive-created path during cleanup', async () => {
    const stage = directStage()
    const snapshot = join(stage.workspace, 'snapshot.md')
    await writeFile(snapshot, 'x')
    stage.readDocuments.remember('session-a', 'doc_1', { path: snapshot, title: 'Review' })
    stage.fake.documentResponses.set('doc_1', docResponse('must not overwrite replacement', 'Review'))
    let replacementPath = ''
    stage.anchorsProbe.handler = async ({ phase, path }) => {
      if (phase !== 'create') return
      delete stage.anchorsProbe.handler
      replacementPath = path
      await rm(path)
      await writeFile(path, 'other inode')
    }
    const tool = readDocAnchorsTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }

    await expect(tool.execute({ doc: 'https://acme.feishu.cn/docx/doc_1' }, stage.exec))
      .rejects.toThrow(/path changed/)
    expect(await readFile(replacementPath, 'utf8')).toBe('other inode')
  })

  it('rejects an anchors file replaced by a same-size inode and preserves the recorded identity', async () => {
    const stage = directStage()
    const snapshot = join(stage.workspace, 'snapshot.md')
    await writeFile(snapshot, 'x')
    stage.readDocuments.remember('session-a', 'doc_1', { path: snapshot, title: 'Review' })
    stage.fake.documentResponses.set('doc_1', docResponse('first', 'Review'))
    const tool = readDocAnchorsTool(stage.ports) as {
      execute(args: unknown, exec: unknown): Promise<{ path: string }>
    }
    const args = { doc: 'https://acme.feishu.cn/docx/doc_1' }
    const first = await tool.execute(args, stage.exec)
    const originalIdentity = stage.readDocuments.reference('session-a', 'doc_1')?.anchorsIdentity

    await rm(first.path)
    await writeFile(first.path, 'other')
    stage.fake.documentResponses.set('doc_1', docResponse('newer', 'Review'))
    await expect(tool.execute(args, stage.exec)).rejects.toThrow(/replaced since this conversation first created it/)
    expect(await readFile(first.path, 'utf8')).toBe('other')
    expect(stage.readDocuments.reference('session-a', 'doc_1')?.anchorsIdentity).toEqual(originalIdentity)
  })

  it('stops after deferred wiki/raw anchor requests are cancelled and never lands a file', async () => {
    const wikiStage = directStage()
    const wikiSnapshot = join(wikiStage.workspace, 'wiki.md')
    await writeFile(wikiSnapshot, 'x')
    wikiStage.readDocuments.remember('session-a', 'doc_1', { path: wikiSnapshot, title: 'Wiki' })
    const wikiResponse = deferred<object>()
    wikiStage.fake.wikiResponses.set('wiki_1', wikiResponse.promise)
    const wikiController = new AbortController()
    const wikiTool = readDocAnchorsTool(wikiStage.ports) as {
      execute(args: unknown, exec: unknown): Promise<unknown>
    }
    const resolvingWiki = wikiTool.execute(
      { doc: 'https://acme.feishu.cn/wiki/wiki_1' },
      { ...wikiStage.exec, signal: wikiController.signal },
    )
    await vi.waitFor(() => { expect(wikiStage.fake.wikiRequests).toHaveLength(1) })
    wikiController.abort(new Error('cancelled after wiki resolve started'))
    wikiResponse.resolve({ code: 0, data: { node: { obj_token: 'doc_1', obj_type: 'docx', title: 'Wiki' } } })
    await expect(resolvingWiki).rejects.toThrow(/cancelled after wiki resolve started/)
    expect(wikiStage.fake.documentRequests).toEqual([])

    const rawStage = directStage()
    const rawSnapshot = join(rawStage.workspace, 'raw.md')
    await writeFile(rawSnapshot, 'x')
    rawStage.readDocuments.remember('session-a', 'doc_1', { path: rawSnapshot, title: 'Raw' })
    const rawResponse = deferred<object>()
    rawStage.fake.documentResponses.set('doc_1', rawResponse.promise)
    const rawController = new AbortController()
    const rawTool = readDocAnchorsTool(rawStage.ports) as {
      execute(args: unknown, exec: unknown): Promise<unknown>
    }
    const fetching = rawTool.execute(
      { doc: 'https://acme.feishu.cn/docx/doc_1' },
      { ...rawStage.exec, signal: rawController.signal },
    )
    await vi.waitFor(() => { expect(rawStage.fake.documentRequests).toHaveLength(1) })
    expect(rawStage.fake.documentRequests[0]!.signal).toBe(rawController.signal)
    rawController.abort(new Error('cancelled deferred anchors fetch'))
    rawResponse.resolve(docResponse('<doc/>', 'Raw'))
    await expect(fetching).rejects.toThrow(/cancelled deferred anchors fetch/)
    expect((await readdir(rawStage.workspace)).filter(name => name.endsWith('.blocks.xml'))).toEqual([])
  })

  it('requires the final docx token to be in this session read set before either primitive calls its endpoint', async () => {
    const stage = directStage()
    stage.fake.wikiResponses.set('wiki_unread', {
      code: 0,
      data: { node: { obj_token: 'doc_unread', obj_type: 'docx', title: 'Unread' } },
    })
    stage.quotas.beginTurn('session-a', 1)
    const anchors = readDocAnchorsTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }
    const comment = commentOnDocTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }

    await expect(anchors.execute({ doc: 'https://acme.feishu.cn/wiki/wiki_unread' }, stage.exec))
      .rejects.toThrow(/not read in this conversation/)
    await expect(comment.execute({
      doc: 'https://acme.feishu.cn/wiki/wiki_unread',
      block_id: 'b1',
      text: 'comment',
    }, stage.exec)).rejects.toThrow(/not read in this conversation/)
    expect(stage.fake.documentRequests).toEqual([])
  })

  it('always sends a non-optional anchor and V2 flat text element to the resolved wiki docx token', async () => {
    const stage = directStage()
    stage.fake.wikiResponses.set('wiki_1', {
      code: 0,
      data: { node: { obj_token: 'doc_1', obj_type: 'docx', title: 'Review' } },
    })
    stage.readDocuments.remember('session-a', 'doc_1')
    stage.quotas.beginTurn('session-a', 1)
    stage.fake.documentWriteResponses.set('POST /open-apis/drive/v1/files/doc_1/new_comments', {
      code: 0,
      data: { comment_id: 'comment_1' },
    })
    const tool = commentOnDocTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }

    await expect(tool.execute({
      doc: 'https://acme.feishu.cn/wiki/wiki_1',
      block_id: 'block_1',
      text: 'Use a stable contract.',
    }, stage.exec)).resolves.toEqual({ commented: true, comment_id: 'comment_1' })

    expect(stage.fake.documentRequests).toContainEqual({
      method: 'POST',
      url: '/open-apis/drive/v1/files/doc_1/new_comments',
      data: {
        file_type: 'docx',
        reply_elements: [{ type: 'text', text: 'Use a stable contract.' }],
        anchor: { block_id: 'block_1' },
      },
    })
    expect(JSON.stringify(stage.fake.documentRequests.at(-1))).not.toContain('text_run')
  })

  it('counts Unicode code points across all text elements and rejects 10001 before the request', async () => {
    const split: readonly LarkCommentReplyElement[] = [
      { type: 'text', text: 'a'.repeat(5_000) },
      { type: 'mention_user' },
      { type: 'text', text: `😀${'b'.repeat(5_000)}` },
    ]
    expect(countLarkCommentTextRunes(split)).toBe(MAX_LARK_DOC_COMMENT_RUNES + 1)
    expect(() => { assertLarkCommentTextLimit(split) }).toThrow(/10001.*10000/s)

    const stage = directStage()
    stage.readDocuments.remember('session-a', 'doc_1')
    stage.quotas.beginTurn('session-a', 1)
    const tool = commentOnDocTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }
    await expect(tool.execute({
      doc: 'https://acme.feishu.cn/docx/doc_1',
      block_id: 'block_1',
      text: '😀'.repeat(MAX_LARK_DOC_COMMENT_RUNES + 1),
    }, stage.exec)).rejects.toThrow(/10001.*10000/s)
    expect(stage.fake.documentRequests).toEqual([])
  })

  it('rejects the 21st request in one turn and resets only when a new turn starts', async () => {
    const stage = directStage(20)
    stage.readDocuments.remember('session-a', 'doc_1')
    stage.quotas.beginTurn('session-a', 7)
    stage.fake.documentWriteResponses.set('POST /open-apis/drive/v1/files/doc_1/new_comments', {
      code: 0,
      data: { comment_id: 'comment' },
    })
    const tool = commentOnDocTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }
    const args = { doc: 'https://acme.feishu.cn/docx/doc_1', block_id: 'block_1', text: 'comment' }

    for (let index = 0; index < 20; index += 1) await tool.execute(args, stage.exec)
    await expect(tool.execute(args, stage.exec)).rejects.toThrow(/quota is exhausted.*20\/20/s)
    expect(stage.fake.documentRequests).toHaveLength(20)

    stage.quotas.beginTurn('session-a', 8)
    await expect(tool.execute(args, stage.exec)).resolves.toMatchObject({ commented: true })
    expect(stage.fake.documentRequests).toHaveLength(21)
  })

  it('spends quota only once a request starts, and never calls a landed comment a failure', async () => {
    const stage = directStage(1)
    stage.readDocuments.remember('session-a', 'doc_1')
    stage.quotas.beginTurn('session-a', 1)
    stage.fake.documentWriteResponses.set('POST /open-apis/drive/v1/files/doc_1/new_comments', {
      code: 0,
      data: { comment_id: 'comment_1' },
    })
    const tool = commentOnDocTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }
    const args = { doc: 'https://acme.feishu.cn/docx/doc_1', block_id: 'block_1', text: 'comment' }
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled before comment'))
    await expect(tool.execute(args, { ...stage.exec, signal: cancelled.signal }))
      .rejects.toThrow(/cancelled before comment/)
    await expect(tool.execute({ ...args, block_id: '' }, stage.exec)).rejects.toThrow(/non-empty block_id/)
    await expect(tool.execute(args, stage.exec)).resolves.toMatchObject({ commented: true })
    expect(stage.fake.documentRequests).toHaveLength(1)

    const sent = directStage(1)
    sent.readDocuments.remember('session-a', 'doc_1')
    sent.quotas.beginTurn('session-a', 1)
    const response = deferred<object>()
    sent.fake.documentWriteResponses.set('POST /open-apis/drive/v1/files/doc_1/new_comments', response.promise)
    const sentTool = commentOnDocTool(sent.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }
    const controller = new AbortController()
    const commenting = sentTool.execute(args, { ...sent.exec, signal: controller.signal })
    await vi.waitFor(() => { expect(sent.fake.documentRequests).toHaveLength(1) })
    expect(sent.fake.documentRequests[0]!.signal).toBe(controller.signal)
    controller.abort(new Error('cancelled after comment request started'))
    response.resolve({ code: 0, data: { comment_id: 'too_late' } })
    // The comment exists on the platform. Reporting a landed comment as failed
    // sends the model back to write the same note, and the platform keeps both,
    // so the stop is closed by naming what landed instead (design §12).
    await expect(commenting).resolves.toMatchObject({ commented: true, comment_id: 'too_late' })
    expect(sent.reports.some(line => line.includes('too_late') && line.includes('the comment did land'))).toBe(true)
    expect(sent.reports.some(line => line.includes('failed'))).toBe(false)
    await expect(sentTool.execute(args, sent.exec)).rejects.toThrow(/quota is exhausted.*1\/1/s)
    expect(sent.fake.documentRequests).toHaveLength(1)
  })

  it('preserves code and tells the model to refresh anchors for 1069302', async () => {
    const stage = directStage()
    stage.readDocuments.remember('session-a', 'doc_1')
    stage.quotas.beginTurn('session-a', 1)
    stage.fake.documentWriteResponses.set('POST /open-apis/drive/v1/files/doc_1/new_comments', {
      code: 1069302,
      msg: 'Invalid or missing parameters',
    })
    const tool = commentOnDocTool(stage.ports) as { execute(args: unknown, exec: unknown): Promise<unknown> }

    await expect(tool.execute({
      doc: 'https://acme.feishu.cn/docx/doc_1',
      block_id: 'stale',
      text: 'comment',
    }, stage.exec)).rejects.toThrow(/\[1069302\].*read_doc_anchors/s)
  })
})

describe('document comment bridge wiring', () => {
  it('registers both primitives only behind commentDocs and comment capability, with denied presence otherwise', async () => {
    const enabled = await mountChannel()
    await enabled.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(enabled.agents.created).toHaveLength(1) })
    expect(enabled.agents.created[0]!.registeredTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      READ_DOC_ANCHORS_TOOL,
      COMMENT_ON_DOC_TOOL,
    ]))
    await enabled.dispose()

    const disabled = await mountChannel({ commentDocs: false })
    await disabled.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(disabled.agents.created).toHaveLength(1) })
    for (const name of [READ_DOC_ANCHORS_TOOL, COMMENT_ON_DOC_TOOL]) {
      expect(disabled.agents.created[0]!.registeredTools.map(tool => tool.name)).not.toContain(name)
      expect(disabled.agents.created[0]!.denyReason(name)).toBeDefined()
      expect(disabled.agents.created[0]!.promptSections[0]?.text).toContain(name)
    }
    await disabled.dispose()

    // A capability goes dark only on a real refusal now: an unverified scope
    // map informs but cannot gate, so `scopeGrants: []` no longer turns
    // anything off. The platform's own violation is what does.
    const noCapability = await mountChannel({ docAuthorizeOnDemand: false })
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
    for (const name of [READ_DOC_ANCHORS_TOOL, COMMENT_ON_DOC_TOOL]) {
      expect(noCapability.agents.created[1]!.registeredTools.map(tool => tool.name)).not.toContain(name)
      expect(noCapability.agents.created[1]!.denyReason(name)).toBeDefined()
    }
    await noCapability.dispose()
  })

  it('creates comments without approval and leaves comment capability enabled after a resource ACL error', async () => {
    const workspace = createWorkspace()
    const harness = await mountChannel({ cwd: workspace, docAuthorizeOnDemand: false })
    harness.fake.documentResponses.set('doc_1', docResponse('# body', 'Review'))
    await harness.fake.emitMessage(fakeMessage({ content: 'https://acme.feishu.cn/docx/doc_1' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) })
    const first = harness.agents.created[0]!
    harness.ctx.emit('session/event', first.agent.session, { type: 'turn/start', data: { turn: 1 } })
    harness.fake.documentWriteResponses.set('POST /open-apis/drive/v1/files/doc_1/new_comments', {
      code: 403,
      msg: 'forbidden by document collaborator ACL',
    })
    const comment = registeredTool(first, COMMENT_ON_DOC_TOOL)

    await expect(comment.execute({
      doc: 'https://acme.feishu.cn/docx/doc_1',
      block_id: 'block_1',
      text: 'comment',
    }, { agent: first.agent })).rejects.toThrow(/\[403\].*collaborator ACL/s)
    expect(harness.fake.sent.flatMap(message => 'card' in message.input ? [message] : [])).toEqual([])

    await harness.fake.emitMessage(fakeMessage({ chatId: 'oc_chat_2', messageId: 'om_chat_2', content: 'hello' }))
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(2) })
    expect(harness.agents.created[1]!.registeredTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      READ_DOC_ANCHORS_TOOL,
      COMMENT_ON_DOC_TOOL,
    ]))
    await harness.dispose()
  })
})
