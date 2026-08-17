import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedMessage, ResourceDescriptor } from '@larksuite/channel'
import { collectInboundFiles, MESSAGE_BYTES_FACTOR, sanitizeFileName } from '../src/files.ts'
import type { InboundFilePort, InboundOptions } from '../src/files.ts'
import { collectImages } from '../src/images.ts'
import type { ImagePort } from '../src/images.ts'
import { createFakeAttachments, createFakePort, fakeMessage } from './harness.ts'

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

