import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedMessage, ResourceDescriptor } from '@larksuite/channel'
import {
  collectInboundFiles,
  describeRefusalForChat,
  describeRefusalForModel,
  GET_COMMAND,
  MESSAGE_BYTES_FACTOR,
  readOutboundFile,
  resolveOutboundFile,
  runGetCommand,
  sanitizeFileName,
  SEND_FILE_TOOL,
  sendFileTool,
} from '../src/files.ts'
import type {
  InboundFilePort,
  InboundOptions,
  OutboundFile,
  OutboundRefusal,
  SendFilePorts,
} from '../src/files.ts'
import { collectImages } from '../src/images.ts'
import type { ImagePort } from '../src/images.ts'
import { assertRegistrableTool, createFakeAttachments, createFakePort, fakeMessage } from './harness.ts'

/** Workspaces these tests wrote into, removed after each one. */
const workspaces: string[] = []

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

/** A real, empty directory standing in for a conversation's workspace. */
function createWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-files-')))
  workspaces.push(workspace)
  return workspace
}

/** One resource descriptor as the transport would normalize it. */
function resource(
  type: ResourceDescriptor['type'],
  fileKey: string,
  fileName?: string,
): ResourceDescriptor {
  return { type, fileKey, ...fileName === undefined ? {} : { fileName } }
}

/**
 * The fake transport over staged resource bytes, plus the download arguments it
 * received — the type mapping is a contract with the SDK, so it is asserted on
 * the call rather than inferred from what landed.
 */
function stageResources(bytes: Record<string, string>, contentTypes: Record<string, string> = {}) {
  const fake = createFakePort()
  for (const [fileKey, content] of Object.entries(bytes)) {
    const declared = contentTypes[fileKey]
    fake.resourceBytes.set(fileKey, {
      buffer: Buffer.from(content),
      ...declared === undefined ? {} : { contentType: declared },
    })
  }
  const calls: { fileKey: string; type: string; destPath: string }[] = []
  const port: InboundFilePort & ImagePort = {
    async downloadResourceToFile(messageId, fileKey, type, destPath) {
      calls.push({ fileKey, type, destPath })
      return fake.port.downloadResourceToFile(messageId, fileKey, type, destPath)
    },
    downloadResourceWithMeta: fake.port.downloadResourceWithMeta,
  }
  // `downloads` counts BOTH halves, which is what tells a spared round trip
  // from a repeated one.
  return { port, calls, downloads: fake.downloads }
}

/** Inbound options over one workspace, with a captured operator console. */
function stageOptions(workspace: string, overrides: Partial<InboundOptions> = {}) {
  const reports: string[] = []
  const options: InboundOptions = {
    workspace,
    enabled: true,
    maxFileBytes: 1024,
    report: (line) => { reports.push(line) },
    ...overrides,
  }
  return { options, reports }
}

/** Every file name sitting in the workspace's inbox, across message directories. */
async function inboxEntries(workspace: string): Promise<string[]> {
  const inbox = join(workspace, '.dsh-lark', 'inbox')
  const names: string[] = []
  for (const directory of await readdir(inbox)) names.push(...await readdir(join(inbox, directory)))
  return names
}

/** A message carrying resources, sent at a fixed instant. */
function fileMessage(resources: ResourceDescriptor[], overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return fakeMessage({ resources, createTime: Date.UTC(2026, 7, 17, 14, 30, 12), ...overrides })
}

describe('sanitizeFileName', () => {
  it('keeps only the last component of a path, however it escapes', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('/etc/shadow')).toBe('shadow')
    // POSIX `basename` does not split on a backslash, so the separator pass must.
    expect(sanitizeFileName('C:\\Users\\me\\app.log')).toBe('C:_Users_me_app.log')
  })

  it('strips control characters out of the name', () => {
    expect(sanitizeFileName('a\u0000b\nc.log')).toBe('abc.log')
    expect(sanitizeFileName('quiet\u007f.txt')).toBe('quiet.txt')
  })

  it('falls back for a name that sanitizes down to nothing', () => {
    expect(sanitizeFileName('..')).toBe('file')
    expect(sanitizeFileName('.')).toBe('file')
    expect(sanitizeFileName('.hidden')).toBe('hidden')
    expect(sanitizeFileName(undefined)).toBe('file')
    expect(sanitizeFileName('')).toBe('file')
  })

  it('suffixes the names Windows reserves, extension or not', () => {
    expect(sanitizeFileName('CON.txt')).toBe('CON_.txt')
    expect(sanitizeFileName('nul')).toBe('nul_')
    expect(sanitizeFileName('com1.log')).toBe('com1_.log')
    expect(sanitizeFileName('console.log')).toBe('console.log')
  })

  it('truncates a long name but keeps its extension', () => {
    const sanitized = sanitizeFileName(`${'a'.repeat(196)}.log`)
    expect(sanitized).toHaveLength(120)
    expect(sanitized.endsWith('.log')).toBe(true)
    expect(sanitized.startsWith('aaaa')).toBe(true)
  })
})

describe('collectInboundFiles', () => {
  it('lands every kind of file but a sticker, with the bytes that were sent', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources(
      { fk_doc: 'log lines', fk_shot: 'png bytes', fk_voice: 'opus bytes', fk_clip: 'mp4 bytes' },
      { fk_shot: 'image/png' },
    )
    const { options } = stageOptions(workspace)
    const result = await collectInboundFiles(
      fileMessage([
        resource('file', 'fk_doc', 'app.log'),
        resource('image', 'fk_shot', 'shot.png'),
        resource('audio', 'fk_voice', 'voice.opus'),
        resource('video', 'fk_clip', 'clip.mp4'),
        resource('sticker', 'fk_sticker'),
      ]),
      port,
      options,
    )

    expect(result.landed.map(file => file.fileName)).toEqual(['app.log', 'shot.png', 'voice.opus', 'clip.mp4'])
    expect(result.landed.map(file => file.type)).toEqual(['file', 'image', 'audio', 'video'])
    expect(await readFile(result.landed[0]!.path, 'utf8')).toBe('log lines')
    expect(await readFile(result.landed[3]!.path, 'utf8')).toBe('mp4 bytes')
    expect(result.landed[1]).toMatchObject({ contentType: 'image/png', bytes: 9, fileKey: 'fk_shot' })
    // A sticker is not a file, and saying so would be noise rather than a trace.
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('收到 4 个文件')
    for (const file of result.landed) expect(result.notes[0]).toContain(file.path)
  })

  it('asks the transport for an image as an image and everything else as a file', async () => {
    const workspace = createWorkspace()
    const { port, calls } = stageResources({ fk_doc: 'a', fk_shot: 'b', fk_voice: 'c', fk_clip: 'd' })
    const { options } = stageOptions(workspace)
    await collectInboundFiles(
      fileMessage([
        resource('file', 'fk_doc', 'app.log'),
        resource('image', 'fk_shot', 'shot.png'),
        resource('audio', 'fk_voice', 'voice.opus'),
        resource('video', 'fk_clip', 'clip.mp4'),
        resource('sticker', 'fk_sticker'),
      ]),
      port,
      options,
    )

    expect(calls.map(call => [call.fileKey, call.type])).toEqual([
      ['fk_doc', 'file'],
      ['fk_shot', 'image'],
      ['fk_voice', 'file'],
      ['fk_clip', 'file'],
    ])
  })

  it('puts one message\'s files in one directory named after that message', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources({ fk_a: 'a', fk_b: 'b' })
    const { options } = stageOptions(workspace)
    const result = await collectInboundFiles(
      fileMessage([resource('file', 'fk_a', 'a.log'), resource('file', 'fk_b', 'b.log')], { messageId: 'om_hashed' }),
      port,
      options,
    )

    const digest = createHash('sha256').update('om_hashed').digest('hex').slice(0, 8)
    const expected = join(workspace, '.dsh-lark', 'inbox', `2026-08-17T143012-${digest}`)
    expect(result.landed.map(file => dirname(file.path))).toEqual([expected, expected])
  })

  it('separates two files sent under one name instead of overwriting one', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources({ fk_first: 'first', fk_second: 'second' })
    const { options } = stageOptions(workspace)
    const result = await collectInboundFiles(
      fileMessage([resource('file', 'fk_first', 'app.log'), resource('file', 'fk_second', 'app.log')]),
      port,
      options,
    )

    expect(result.landed.map(file => file.fileName)).toEqual(['app.log', 'app-2.log'])
    expect(await readFile(result.landed[0]!.path, 'utf8')).toBe('first')
    expect(await readFile(result.landed[1]!.path, 'utf8')).toBe('second')
  })

  it('leaves nothing on disk when a file is over the per-file limit', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources({ fk_big: 'x'.repeat(20) })
    const { options } = stageOptions(workspace, { maxFileBytes: 10 })
    const result = await collectInboundFiles(fileMessage([resource('file', 'fk_big', 'big.log')]), port, options)

    expect(result.landed).toEqual([])
    expect(await inboxEntries(workspace)).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('big.log')
    expect(result.notes[0]).toContain('20 字节')
    expect(result.notes[0]).toContain('10 字节')
  })

  it('stops at the message total and says how many files it stopped at', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources({ fk_1: 'x'.repeat(9), fk_2: 'y'.repeat(9), fk_3: 'z'.repeat(9), fk_4: 'w'.repeat(9) })
    const { options } = stageOptions(workspace, { maxFileBytes: 10 })
    const result = await collectInboundFiles(
      fileMessage([
        resource('file', 'fk_1', '1.log'),
        resource('file', 'fk_2', '2.log'),
        resource('file', 'fk_3', '3.log'),
        resource('file', 'fk_4', '4.log'),
      ]),
      port,
      options,
    )

    // Three 9-byte files fit under 10 × 3; the fourth cannot, and nor may any
    // file behind it sneak in under the leftover.
    expect(result.landed.map(file => file.fileName)).toEqual(['1.log', '2.log', '3.log'])
    expect(await inboxEntries(workspace)).toHaveLength(3)
    expect(result.notes[1]).toContain('还有 1 个文件')
    expect(result.notes[1]).toContain(`${10 * MESSAGE_BYTES_FACTOR} 字节`)
  })

  it('keeps landing the rest of a message after one download fails', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources({ fk_ok: 'ok', fk_last: 'last' })
    const { options, reports } = stageOptions(workspace)
    const result = await collectInboundFiles(
      fileMessage([
        resource('file', 'fk_ok', 'ok.log'),
        resource('file', 'fk_gone', 'gone.log'),
        resource('file', 'fk_last', 'last.log'),
      ]),
      port,
      options,
    )

    expect(result.landed.map(file => file.fileName)).toEqual(['ok.log', 'last.log'])
    expect((await inboxEntries(workspace)).sort()).toEqual(['last.log', 'ok.log'])
    expect(result.notes[0]).toContain('收到 2 个文件')
    expect(result.notes[1]).toContain('gone.log')
    expect(result.notes[1]).toContain('no such resource fk_gone')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('gone.log')
  })

  it('downloads nothing but still tells the model when the channel is closed', async () => {
    const workspace = createWorkspace()
    const { port, calls } = stageResources({ fk_doc: 'log lines' })
    const { options } = stageOptions(workspace, { enabled: false })
    const result = await collectInboundFiles(fileMessage([resource('file', 'fk_doc', 'app.log')]), port, options)

    expect(result.landed).toEqual([])
    expect(calls).toEqual([])
    expect(await readdir(workspace)).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('receiveFiles')
  })

  it('says nothing at all about a message that carried only a sticker', async () => {
    const workspace = createWorkspace()
    const { port, calls } = stageResources({})
    const { options } = stageOptions(workspace)
    const result = await collectInboundFiles(fileMessage([resource('sticker', 'fk_sticker')]), port, options)

    expect(result).toEqual({ landed: [], notes: [] })
    expect(calls).toEqual([])
    expect(await readdir(workspace)).toEqual([])
  })

  it('skips everything and reports once when the inbox cannot be created', async () => {
    const workspace = createWorkspace()
    // A file where the channel directory belongs: the read-only-disk failure,
    // reproducible without one.
    await writeFile(join(workspace, '.dsh-lark'), 'in the way')
    const { port, calls } = stageResources({ fk_a: 'a', fk_b: 'b' })
    const { options, reports } = stageOptions(workspace)
    const result = await collectInboundFiles(
      fileMessage([resource('file', 'fk_a', 'a.log'), resource('image', 'fk_b', 'b.png')]),
      port,
      options,
    )

    expect(result.landed).toEqual([])
    expect(calls).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('收到 2 个文件')
    expect(result.notes[0]).toContain('.dsh-lark/inbox/')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('inbox directory')
  })

  it('writes nothing through an inbox that is a symlink out of the workspace', async () => {
    const workspace = createWorkspace()
    const elsewhere = createWorkspace()
    // What an injected model can arrange with one write inside its OWN
    // workspace, which every preset allows: the inbox becomes a link, and the
    // next file the sender names lands wherever it points.
    await mkdir(join(workspace, '.dsh-lark'), { recursive: true })
    symlinkSync(elsewhere, join(workspace, '.dsh-lark', 'inbox'))
    const { port, calls } = stageResources({ fk_payload: 'payload' })
    const { options, reports } = stageOptions(workspace)
    const result = await collectInboundFiles(
      fileMessage([resource('file', 'fk_payload', 'payload')]),
      port,
      options,
    )

    // The destination STRING resolves under the workspace — that is why a string
    // check clears it — and the bytes would have landed outside it anyway.
    expect(join(workspace, '.dsh-lark', 'inbox').startsWith(`${workspace}${sep}`)).toBe(true)
    expect(result.landed).toEqual([])
    expect(calls).toEqual([])
    expect(await readdir(elsewhere)).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('收到 1 个文件')
    expect(result.notes[0]).toContain('.dsh-lark/inbox/')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('inbox directory')
  })

  it('hints at .gitignore once files really landed, and not otherwise', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources({ fk_doc: 'log lines' })
    const { options } = stageOptions(workspace, { hintWorkspace: true })
    const landedResult = await collectInboundFiles(
      fileMessage([resource('file', 'fk_doc', 'app.log')]),
      port,
      options,
    )

    expect(landedResult.notes).toHaveLength(2)
    expect(landedResult.notes[1]).toContain('.gitignore')

    const emptyResult = await collectInboundFiles(
      fileMessage([resource('file', 'fk_gone', 'gone.log')], { messageId: 'om_in_2' }),
      port,
      options,
    )

    expect(emptyResult.landed).toEqual([])
    expect(emptyResult.notes.some(note => note.includes('.gitignore'))).toBe(false)
  })

  it('names an absolute path even when the caller\'s workspace is a relative one', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources({ fk_doc: 'log lines' })
    // The note goes to a model whose own tools run in some other directory, so
    // a path relative to THIS process would point at nothing it can reach.
    const { options } = stageOptions(relative(process.cwd(), workspace))
    const result = await collectInboundFiles(fileMessage([resource('file', 'fk_doc', 'app.log')]), port, options)

    expect(result.landed).toHaveLength(1)
    expect(isAbsolute(result.landed[0]!.path)).toBe(true)
    expect(await readFile(result.landed[0]!.path, 'utf8')).toBe('log lines')
    expect(result.notes[0]).toContain(result.landed[0]!.path)
  })

  it('leaves no directory behind for a message whose files all fell away', async () => {
    const workspace = createWorkspace()
    const { port } = stageResources({ fk_big: 'x'.repeat(20) })
    const { options } = stageOptions(workspace, { maxFileBytes: 10 })
    const result = await collectInboundFiles(
      fileMessage([resource('file', 'fk_big', 'big.log'), resource('file', 'fk_gone', 'gone.log')]),
      port,
      options,
    )

    // One file over the limit, one that never downloaded: an empty directory per
    // rejected message would accumulate in the workspace forever.
    expect(result.landed).toEqual([])
    expect(await readdir(join(workspace, '.dsh-lark', 'inbox'))).toEqual([])
  })

  it('tells the operator when a file it must not keep will not go away', async () => {
    const workspace = createWorkspace()
    const stubborn: InboundFilePort = {
      // A directory where the file belongs: `unlink` refuses one whoever runs
      // these tests, which is the read-only-disk failure without a read-only disk.
      async downloadResourceToFile(_messageId, _fileKey, _type, destPath) {
        await mkdir(destPath)
        return { bytesWritten: 20 }
      },
    }
    const { options, reports } = stageOptions(workspace, { maxFileBytes: 10 })
    const result = await collectInboundFiles(fileMessage([resource('file', 'fk_big', 'big.log')]), stubborn, options)

    // The note says the file was not saved and the workspace disagrees; only the
    // operator can see that, and a second note would just repeat the first.
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('未保存')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('big.log')
  })
})

describe('collectImages over what landed', () => {
  it('reads a landed image off the disk instead of downloading it a second time', async () => {
    const workspace = createWorkspace()
    const { port, downloads } = stageResources({ fk_shot: 'png bytes' }, { fk_shot: 'image/png' })
    const { options } = stageOptions(workspace)
    const msg = fileMessage([resource('image', 'fk_shot', 'shot.png')])
    const inbound = await collectInboundFiles(msg, port, options)
    const attachments = createFakeAttachments()

    const images = await collectImages(msg, port, inbound.landed, attachments.service, true)

    // One download, the one that put the bytes on disk.
    expect(downloads).toEqual([{ fileKey: 'fk_shot', via: 'disk' }])
    expect(images.notes).toEqual([])
    expect(images.blocks).toHaveLength(1)
    // The bytes the store received are the ones sitting in the workspace, and
    // the media type is the one the transport declared while landing them.
    expect(attachments.saved[0]).toEqual({ mediaType: 'image/png', bytes: 9, name: 'shot.png' })
  })

  it('downloads an image that never landed, so a closed inbound channel still shows one', async () => {
    const workspace = createWorkspace()
    const { port, downloads } = stageResources({ fk_shot: 'png bytes' }, { fk_shot: 'image/png' })
    // A deployment that receives no files but does pass images to its model.
    const { options } = stageOptions(workspace, { enabled: false })
    const msg = fileMessage([resource('image', 'fk_shot', 'shot.png')])
    const inbound = await collectInboundFiles(msg, port, options)
    const attachments = createFakeAttachments()

    const images = await collectImages(msg, port, inbound.landed, attachments.service, true)

    expect(inbound.landed).toEqual([])
    // Still exactly one download, just the other half of the transport.
    expect(downloads).toEqual([{ fileKey: 'fk_shot', via: 'memory' }])
    expect(images.blocks).toHaveLength(1)
    expect(attachments.saved[0]).toEqual({ mediaType: 'image/png', bytes: 9, name: 'shot.png' })
  })
})

describe('resolveOutboundFile', () => {
  it('resolves a relative path against the workspace, and an absolute one inside it', async () => {
    const workspace = createWorkspace()
    await mkdir(join(workspace, 'out'))
    await writeFile(join(workspace, 'out', 'report.md'), 'body')
    const cleared = { path: join(workspace, 'out', 'report.md'), fileName: 'report.md', bytes: 4 }

    expect(resolveOutboundFile('out/report.md', workspace, 1024)).toEqual({ ok: true, file: cleared })
    expect(resolveOutboundFile('./out/report.md', workspace, 1024)).toEqual({ ok: true, file: cleared })
    expect(resolveOutboundFile(join(workspace, 'out', 'report.md'), workspace, 1024)).toEqual({ ok: true, file: cleared })
  })

  it('refuses a path that climbs out of the workspace', async () => {
    const workspace = createWorkspace()
    const outside = createWorkspace()
    await writeFile(join(outside, 'secret.md'), 'not yours')

    // Both spellings of the same escape: the folded `..` and the plain path.
    expect(resolveOutboundFile(`../${basename(outside)}/secret.md`, workspace, 1024))
      .toEqual({ ok: false, refusal: { code: 'outside_workspace' } })
    expect(resolveOutboundFile(join(outside, 'secret.md'), workspace, 1024))
      .toEqual({ ok: false, refusal: { code: 'outside_workspace' } })
  })

  it('follows a symlink before it decides, so one leaving the workspace is refused', async () => {
    const workspace = createWorkspace()
    const outside = createWorkspace()
    await writeFile(join(outside, 'secret.md'), 'not yours')
    const shortcut = join(workspace, 'shortcut.md')
    symlinkSync(join(outside, 'secret.md'), shortcut)

    // The link's OWN path is inside the workspace, which is the whole point: a
    // container check running before realpath would clear it and the bytes
    // would leave. This is the regression test for that ordering.
    expect(shortcut.startsWith(`${workspace}${sep}`)).toBe(true)
    expect(await readFile(shortcut, 'utf8')).toBe('not yours')
    expect(resolveOutboundFile('shortcut.md', workspace, 1024))
      .toEqual({ ok: false, refusal: { code: 'outside_workspace' } })
  })

  it('still clears a file when the workspace path is itself a symlink', async () => {
    const real = createWorkspace()
    const elsewhere = createWorkspace()
    const linked = join(elsewhere, 'project')
    symlinkSync(real, linked)
    await writeFile(join(real, 'report.md'), 'body')
    const cleared = { path: join(real, 'report.md'), fileName: 'report.md', bytes: 4 }

    // macOS points `/tmp` at `/private/var/…`, so a workspace compared without
    // canonicalizing it first judges every file inside it an escape.
    expect(realpathSync(linked)).toBe(real)
    expect(resolveOutboundFile('report.md', linked, 1024)).toEqual({ ok: true, file: cleared })
    expect(resolveOutboundFile(join(linked, 'report.md'), linked, 1024)).toEqual({ ok: true, file: cleared })
  })

  it('refuses a directory, a path with nothing there, and no path at all', async () => {
    const workspace = createWorkspace()
    await mkdir(join(workspace, 'out'))

    expect(resolveOutboundFile('out', workspace, 1024)).toEqual({ ok: false, refusal: { code: 'not_a_file' } })
    expect(resolveOutboundFile('.', workspace, 1024)).toEqual({ ok: false, refusal: { code: 'not_a_file' } })
    expect(resolveOutboundFile('missing.md', workspace, 1024)).toEqual({ ok: false, refusal: { code: 'not_found' } })
    // Naming no file is a missing path, not "the workspace is not a file".
    expect(resolveOutboundFile('', workspace, 1024)).toEqual({ ok: false, refusal: { code: 'not_found' } })
    expect(resolveOutboundFile('   ', workspace, 1024)).toEqual({ ok: false, refusal: { code: 'not_found' } })
  })

  it('refuses a file over the ceiling and weighs it against the ceiling', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'big.bin'), 'x'.repeat(2048))
    await writeFile(join(workspace, 'exact.bin'), 'x'.repeat(1024))

    expect(resolveOutboundFile('big.bin', workspace, 1024))
      .toEqual({ ok: false, refusal: { code: 'too_large', bytes: 2048, limit: 1024 } })
    // The ceiling is a ceiling: a file sitting exactly on it goes.
    expect(resolveOutboundFile('exact.bin', workspace, 1024))
      .toEqual({ ok: true, file: { path: join(workspace, 'exact.bin'), fileName: 'exact.bin', bytes: 1024 } })
  })

  it('reads the cleared file\'s own bytes', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), '# 报告')
    const verdict = resolveOutboundFile('report.md', workspace, 1024)
    if (!verdict.ok) throw new Error('a file inside the workspace should have cleared')

    expect((await readOutboundFile(verdict.file)).toString('utf8')).toBe('# 报告')
  })

  it('refuses to hand over a file that grew past the ceiling after it cleared', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'growing.log'), 'x'.repeat(512))
    const verdict = resolveOutboundFile('growing.log', workspace, 1024)
    if (!verdict.ok) throw new Error('a file under the ceiling should have cleared')

    // What a background process the agent started does while it calls the tool:
    // `readFile` reads to EOF and would return 4 KiB through a 1 KiB ceiling.
    await writeFile(join(workspace, 'growing.log'), 'x'.repeat(4096))

    await expect(readOutboundFile(verdict.file)).rejects.toThrow('growing.log changed size after it was cleared')
  })
})

describe('outbound refusal wording', () => {
  /** Every refusal the check can reach, so neither voice can grow a hole. */
  const refusals: OutboundRefusal[] = [
    { code: 'outside_workspace' },
    { code: 'not_found' },
    { code: 'not_a_file' },
    { code: 'too_large', bytes: 25 * 1024 * 1024, limit: 20 * 1024 * 1024 },
  ]

  it('speaks English to the model and 中文 to the chat', () => {
    for (const refusal of refusals) {
      expect(describeRefusalForModel(refusal)).not.toMatch(/[一-鿿]/)
      expect(describeRefusalForChat(refusal)).toMatch(/[一-鿿]/)
    }
  })

  it('tells the model where its boundary is, without naming a path it did not supply', () => {
    const text = describeRefusalForModel({ code: 'outside_workspace' })

    expect(text).toContain('only files inside the current workspace can be sent')
    expect(text).not.toContain('/')
  })

  it('carries the real size and the ceiling in both voices', () => {
    const refusal: OutboundRefusal = { code: 'too_large', bytes: 25 * 1024 * 1024, limit: 20 * 1024 * 1024 }

    for (const text of [describeRefusalForModel(refusal), describeRefusalForChat(refusal)]) {
      expect(text).toContain('25.0 MiB')
      expect(text).toContain('20.0 MiB')
    }
  })
})

/** The tool as the registry hands it back, with the parts tests drive. */
interface Runnable {
  readonly name: string
  readonly description: string
  execute(args: unknown, exec: unknown): Promise<{ sent: true }>
}

/**
 * The tool description, verbatim from the design. Pinned here because it IS the
 * model's contract with the tool — including the sentence that keeps a short
 * answer out of an attachment.
 */
const SEND_FILE_DESCRIPTION = 'Send one file from the current workspace to this chat, so the person who asked '
  + 'can download it. Use it for artifacts: reports, diffs, generated images, exported data. Short content '
  + 'belongs in your reply instead — never send a file just to say a few sentences. One call sends one file; '
  + 'call it again for more.'

/** One tool execution context, as the host passes it. */
function execFor(sessionId: string, signal?: AbortSignal) {
  return { agent: { session: { id: sessionId } }, ...signal === undefined ? {} : { signal } }
}

/** `send_file` ports over one workspace, recording what was delivered and reported. */
function stageSendPorts(workspace: string | undefined, overrides: Partial<SendFilePorts> = {}) {
  const delivered: { sessionId: string; file: OutboundFile; signal: AbortSignal | undefined }[] = []
  const reports: string[] = []
  const ports: SendFilePorts = {
    deliver: async (sessionId, file, signal) => {
      delivered.push({ sessionId, file, signal })
      return undefined
    },
    workspaceOf: () => workspace,
    maxBytes: 1024,
    report: (line) => { reports.push(line) },
    ...overrides,
  }
  return { ports, delivered, reports }
}

describe('send_file tool', () => {
  it('registers as a definition the host registry would accept', () => {
    const { ports } = stageSendPorts(createWorkspace())
    assertRegistrableTool(sendFileTool(ports) as { name: string })
    const tool = sendFileTool(ports) as Runnable

    expect(tool.name).toBe(SEND_FILE_TOOL)
    expect(tool.description).toBe(SEND_FILE_DESCRIPTION)
  })

  it('delivers the canonical file to the calling session\'s chat', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), 'body')
    const { ports, delivered } = stageSendPorts(workspace)

    expect(await (sendFileTool(ports) as Runnable).execute({ path: './report.md' }, execFor('s1')))
      .toEqual({ sent: true })
    expect(delivered).toEqual([{
      sessionId: 's1',
      file: { path: join(workspace, 'report.md'), fileName: 'report.md', bytes: 4 },
      signal: undefined,
    }])
  })

  it("hands the execution's cancellation down to the deliverer", async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), 'body')
    const { ports, delivered } = stageSendPorts(workspace)
    const controller = new AbortController()

    await (sendFileTool(ports) as Runnable).execute({ path: 'report.md' }, execFor('s1', controller.signal))
    // The gate can outlive this call — a group approval waits for a human — so
    // the cancellation has to travel with it, or a stopped turn leaves a live
    // card that still releases the file.
    expect(delivered[0]!.signal).toBe(controller.signal)
  })

  it('reports a refused path to the operator, once, and leaves delivery failures to the deliverer', async () => {
    const workspace = createWorkspace()
    const outside = createWorkspace()
    await writeFile(join(workspace, 'report.md'), 'body')
    await writeFile(join(outside, 'secret.env'), 'TOKEN=1')
    const escape = join(outside, 'secret.env')
    const refused = stageSendPorts(workspace)

    await expect((sendFileTool(refused.ports) as Runnable).execute({ path: escape }, execFor('s1')))
      .rejects.toThrow(describeRefusalForModel({ code: 'outside_workspace' }))
    // A refused path never reaches the deliverer, so this is the only chance to
    // leave a trace — and reaching outside the workspace is an operator's event.
    expect(refused.reports).toHaveLength(1)
    expect(refused.reports[0]).toContain('outside_workspace')
    expect(refused.reports[0]).toContain(escape)
    expect(refused.reports[0]).toMatch(/^lark-channel: /)

    // The deliverer reports its own failures, with the transport's code; saying
    // it again here would put every upload failure on the console twice.
    const undelivered = stageSendPorts(workspace, { deliver: async () => 'The upload failed.' })
    await expect((sendFileTool(undelivered.ports) as Runnable).execute({ path: 'report.md' }, execFor('s1')))
      .rejects.toThrow('The upload failed.')
    expect(undelivered.reports).toEqual([])
  })

  it('throws in English when there is no agent, and when its session has no chat', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), 'body')
    const orphan = await (sendFileTool(stageSendPorts(workspace).ports) as Runnable)
      .execute({ path: 'report.md' }, {})
      .catch((error: Error) => error)
    const chatless = await (sendFileTool(stageSendPorts(undefined).ports) as Runnable)
      .execute({ path: 'report.md' }, execFor('s1'))
      .catch((error: Error) => error)

    expect(orphan).toBeInstanceOf(Error)
    expect((orphan as Error).message).toContain('requires a calling agent')
    expect(chatless).toBeInstanceOf(Error)
    expect((chatless as Error).message).toContain('no chat for this session')
    // A tool error is what the model reads next, so it is English like the rest.
    for (const error of [orphan, chatless]) expect((error as Error).message).not.toMatch(/[一-鿿]/)
  })

  it('throws the refusal, and whatever else stopped the delivery', async () => {
    const workspace = createWorkspace()
    const outside = createWorkspace()
    await writeFile(join(workspace, 'report.md'), 'body')
    await writeFile(join(outside, 'secret.md'), 'not yours')
    const refused = stageSendPorts(workspace)

    await expect((sendFileTool(refused.ports) as Runnable).execute({ path: join(outside, 'secret.md') }, execFor('s1')))
      .rejects.toThrow(describeRefusalForModel({ code: 'outside_workspace' }))
    // A malformed call is the model's mistake to hear about as a refusal, not a
    // type error thrown from inside its turn.
    await expect((sendFileTool(refused.ports) as Runnable).execute({}, execFor('s1')))
      .rejects.toThrow(describeRefusalForModel({ code: 'not_found' }))
    await expect((sendFileTool(refused.ports) as Runnable).execute(null, execFor('s1')))
      .rejects.toThrow(describeRefusalForModel({ code: 'not_found' }))
    expect(refused.delivered).toEqual([])

    const undelivered = stageSendPorts(workspace, { deliver: async () => 'The user rejected the send.' })
    await expect((sendFileTool(undelivered.ports) as Runnable).execute({ path: 'report.md' }, execFor('s1')))
      .rejects.toThrow('The user rejected the send.')
  })
})

describe('runGetCommand', () => {
  it('explains itself when the line carries no path', async () => {
    const workspace = createWorkspace()
    const sent: OutboundFile[] = []
    const reply = await runGetCommand(`/${GET_COMMAND}`, workspace, 1024, async (file) => { sent.push(file) })

    expect(reply).toContain(`/${GET_COMMAND} <路径>`)
    expect(sent).toEqual([])
  })

  it('refuses in 中文 what the tool refuses in English, through the same check', async () => {
    const workspace = createWorkspace()
    const outside = createWorkspace()
    await writeFile(join(outside, 'secret.md'), 'not yours')
    const sent: OutboundFile[] = []
    const reply = await runGetCommand(
      `/${GET_COMMAND} ${join(outside, 'secret.md')}`,
      workspace,
      1024,
      async (file) => { sent.push(file) },
    )

    expect(reply).toBe(`⚠️ ${describeRefusalForChat({ code: 'outside_workspace' })}`)
    expect(sent).toEqual([])
  })

  it('says nothing at all when the file itself is the reply', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), '# 报告')
    const sent: { file: OutboundFile; bytes: Buffer }[] = []
    const reply = await runGetCommand(
      `/${GET_COMMAND}   ./report.md  `,
      workspace,
      1024,
      async (file, bytes) => { sent.push({ file, bytes }) },
    )

    expect(reply).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.file).toEqual({ path: join(workspace, 'report.md'), fileName: 'report.md', bytes: 8 })
    expect(sent[0]!.bytes.toString('utf8')).toBe('# 报告')
  })

  it('tells the chat when the send failed instead of going quiet', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), 'body')
    const reply = await runGetCommand(`/${GET_COMMAND} report.md`, workspace, 1024, async () => {
      throw new Error('upload rejected: 230013')
    })

    expect(reply).toContain('⚠️')
    expect(reply).toContain('report.md')
    expect(reply).toContain('230013')
  })
})
