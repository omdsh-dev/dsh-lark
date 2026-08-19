import { join } from 'node:path'
import { mkdtempSync, realpathSync } from 'node:fs'
import { rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendLarkDocument,
  classifyLarkDocumentUrl,
  createLarkDocument,
  escapeLarkDocumentTitle,
  grantLarkDocumentReader,
  larkDocumentAppendData,
  larkDocumentCreateData,
  resolveLarkDocumentTarget,
} from '../src/larkdocs.ts'
import { runPutCommand, sendDocTool } from '../src/larkdoc-publish.ts'
import { createFakePort } from './harness.ts'

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

describe('Lark document links and write protocol', () => {
  it('classifies designed URL shapes without treating lookalike hosts as Lark', () => {
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

  it('resolves direct and wiki append targets while rejecting non-docx wiki nodes', async () => {
    const fake = createFakePort()
    await expect(resolveLarkDocumentTarget(fake.port, 'https://acme.feishu.cn/docx/doc_1')).resolves.toEqual({
      fileToken: 'doc_1',
      sourceUrl: 'https://acme.feishu.cn/docx/doc_1',
    })
    fake.wikiResponses.set('wiki_1', {
      code: 0,
      data: { node: { obj_token: 'doc_2', obj_type: 'docx', title: 'Review' } },
    })
    await expect(resolveLarkDocumentTarget(fake.port, 'https://acme.feishu.cn/wiki/wiki_1')).resolves.toEqual({
      fileToken: 'doc_2',
      sourceUrl: 'https://acme.feishu.cn/wiki/wiki_1',
    })
    fake.wikiResponses.set('wiki_sheet', {
      code: 0,
      data: { node: { obj_token: 'sheet_1', obj_type: 'sheet' } },
    })
    await expect(resolveLarkDocumentTarget(fake.port, 'https://acme.feishu.cn/wiki/wiki_sheet'))
      .rejects.toThrow(/points to sheet/u)
  })

  it('locks create payload, PUT append payload, and typed permission-member signature', async () => {
    const fake = createFakePort()
    fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0,
      data: { document: { document_id: 'doc_created', url: 'https://acme.feishu.cn/docx/doc_created' } },
    })
    fake.documentWriteResponses.set('PUT /open-apis/docs_ai/v1/documents/doc_created', { code: 0 })

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
      fileToken: 'doc_created', appended: false,
    })
    await expect(appendLarkDocument(
      fake.port,
      { fileToken: 'doc_created', sourceUrl: 'https://acme.feishu.cn/docx/doc_created' },
      'Report',
      'more',
    )).resolves.toMatchObject({ fileToken: 'doc_created', appended: true })
    await grantLarkDocumentReader(fake.port, 'doc_created', { type: 'openchat', id: 'oc_group_1' })

    expect(fake.documentRequests).toEqual([
      {
        method: 'POST',
        url: '/open-apis/docs_ai/v1/documents',
        data: { content: '<title>Report</title>\n# body', format: 'markdown', parent_position: 'my_library' },
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

  it('preserves backend create URLs and uses the configured brand fallback', async () => {
    const fake = createFakePort()
    fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0,
      data: { document: { document_id: 'tenant_doc', url: 'https://tenant.example/docx/tenant_doc' } },
    })
    await expect(createLarkDocument(fake.port, 'A', '')).resolves.toMatchObject({
      url: 'https://tenant.example/docx/tenant_doc',
    })
    fake.documentWriteResponses.set('POST /open-apis/docs_ai/v1/documents', {
      code: 0,
      data: { document: { document_id: 'lark_doc' } },
    })
    await expect(createLarkDocument(fake.port, 'B', '', { brand: 'lark' })).resolves.toMatchObject({
      url: 'https://www.larksuite.com/docx/lark_doc',
    })
  })
})

describe('document publication policy', () => {
  it('keeps send_doc on create-only targets and reuses the outbound path boundary', async () => {
    const workspace = createWorkspace()
    const outside = createWorkspace()
    await writeFile(join(workspace, 'report.md'), '# report')
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(join(outside, 'secret.md'), join(workspace, 'shortcut.md'))
    const publish = vi.fn(async (_session, artifact) => ({
      fileToken: 'created',
      url: 'https://acme.feishu.cn/docx/created',
      title: artifact.title,
      appended: false,
    }))
    const definition = sendDocTool({
      maxBytes: 1024,
      report: vi.fn(),
      workspaceOf: () => workspace,
      withOutboundSlot: (_sessionId, operation) => operation(),
      publish,
    }) as {
      parameters: { properties: Record<string, unknown> }
      execute(args: unknown, exec: unknown): Promise<unknown>
    }
    const exec = { agent: { session: { id: 'session-a' } } }

    expect(definition.parameters.properties).toEqual({
      path: { type: 'string', description: 'Path to the markdown file, inside the workspace.' },
    })
    await expect(definition.execute({ path: join(outside, 'secret.md') }, exec)).rejects.toThrow(/leaves the workspace/u)
    await expect(definition.execute({ path: 'shortcut.md' }, exec)).rejects.toThrow(/leaves the workspace/u)
    await expect(definition.execute({ path: 'report.md' }, exec))
      .resolves.toMatchObject({ sent: true, appended: false })
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]![1]).toMatchObject({ title: 'report', content: '# report' })
    expect(publish.mock.calls[0]![0]).toBe('session-a')
  })

  it('/put retains the human-selected into target', async () => {
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
