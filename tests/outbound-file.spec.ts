import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeReadFailure,
  describeRefusalForChat,
  describeRefusalForModel,
  GET_COMMAND,
  readOutboundFile,
  resolveOutboundFile,
  runGetCommand,
  SEND_FILE_TOOL,
  sendFileTool,
} from '../src/outbound-file.ts'
import type { OutboundFile, OutboundRefusal, SendFilePorts } from '../src/outbound-file.ts'
import { assertRegistrableTool } from './harness.ts'

/** Workspaces these tests wrote into, removed after each one. */
const workspaces: string[] = []

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

/** A real, empty directory standing in for a conversation's workspace. */
function createWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-outbound-')))
  workspaces.push(workspace)
  return workspace
}

describe('resolveOutboundFile', () => {
  it('resolves a relative path against the workspace, and an absolute one inside it', async () => {
    const workspace = createWorkspace()
    await mkdir(join(workspace, 'out'))
    await writeFile(join(workspace, 'out', 'report.md'), 'body')
    const cleared = {
      path: join(workspace, 'out', 'report.md'),
      fileName: 'report.md',
      bytes: 4,
      pathInWorkspace: join('out', 'report.md'),
      workspaceName: basename(workspace),
    }

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
    const cleared = {
      path: join(real, 'report.md'),
      fileName: 'report.md',
      bytes: 4,
      pathInWorkspace: 'report.md',
      // The canonical directory's name, not the link's: `project` is a name the
      // caller typed, and everything a card shows has to come off what the
      // filesystem actually holds.
      workspaceName: basename(real),
    }

    // macOS points `/tmp` at `/private/var/…`, so a workspace compared without
    // canonicalizing it first judges every file inside it an escape.
    expect(realpathSync(linked)).toBe(real)
    expect(resolveOutboundFile('report.md', linked, 1024)).toEqual({ ok: true, file: cleared })
    expect(resolveOutboundFile(join(linked, 'report.md'), linked, 1024)).toEqual({ ok: true, file: cleared })
  })

  it('names a file by where it really sits, so a symlink cannot rename it', async () => {
    const workspace = createWorkspace()
    await mkdir(join(workspace, 'secrets'))
    await writeFile(join(workspace, 'secrets', 'tokens.env'), 'TOKEN=x')
    symlinkSync(join(workspace, 'secrets', 'tokens.env'), join(workspace, 'report.md'))

    const verdict = resolveOutboundFile('report.md', workspace, 1024)
    if (!verdict.ok) throw new Error('a link to a file inside the workspace should have cleared')
    // What an approval card shows is this, not the path the model typed: a room
    // asked about `report.md` would allow a file it has not been shown. The
    // relative form is cut from the canonical path, which is what keeps that
    // shortening honest.
    expect(verdict.file.pathInWorkspace).toBe(join('secrets', 'tokens.env'))
    expect(verdict.file.fileName).toBe('tokens.env')
  })

  it('refuses a sibling directory whose name merely starts with the workspace\'s', async () => {
    const parent = createWorkspace()
    // Literal names, because `mkdtemp` names are never prefixes of each other:
    // nothing else here would notice the check dropping the separator it appends.
    const workspace = join(parent, 'ws')
    const sibling = join(parent, 'ws-evil')
    await mkdir(workspace)
    await mkdir(sibling)
    await writeFile(join(sibling, 'secret.md'), 'not yours')

    expect(sibling.startsWith(workspace)).toBe(true)
    expect(resolveOutboundFile(join(sibling, 'secret.md'), workspace, 1024))
      .toEqual({ ok: false, refusal: { code: 'outside_workspace' } })
    expect(resolveOutboundFile('../ws-evil/secret.md', workspace, 1024))
      .toEqual({ ok: false, refusal: { code: 'outside_workspace' } })
  })

  it('refuses a path carrying a NUL byte instead of letting the filesystem throw', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), 'body')

    // A model can write any string into the argument, and `path.resolve` keeps a
    // NUL — only the filesystem rejects it, which must arrive as a refusal the
    // model reads rather than as an ERR_INVALID_ARG_VALUE thrown mid-turn.
    expect(resolveOutboundFile('report.md\u0000.png', workspace, 1024))
      .toEqual({ ok: false, refusal: { code: 'not_found' } })
  })

  it('refuses everything when the workspace itself is not there', () => {
    const missing = join(createWorkspace(), 'never-created')

    // The uncanonicalizable workspace still bounds the check rather than
    // widening it: a `/cd` target removed under a live conversation must not
    // turn the container check into "anywhere at all".
    expect(resolveOutboundFile('report.md', missing, 1024))
      .toEqual({ ok: false, refusal: { code: 'not_found' } })
    expect(resolveOutboundFile('/etc/hosts', missing, 1024))
      .toEqual({ ok: false, refusal: { code: 'outside_workspace' } })
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
    expect(resolveOutboundFile('exact.bin', workspace, 1024)).toEqual({
      ok: true,
      file: {
        path: join(workspace, 'exact.bin'),
        fileName: 'exact.bin',
        bytes: 1024,
        pathInWorkspace: 'exact.bin',
        workspaceName: basename(workspace),
      },
    })
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

  it('reports a read failure without the host prefix Node puts in it', async () => {
    const workspace = createWorkspace()
    await mkdir(join(workspace, 'out'))
    await writeFile(join(workspace, 'out', 'report.md'), 'body')
    const verdict = resolveOutboundFile('out/report.md', workspace, 1024)
    if (!verdict.ok) throw new Error('a file inside the workspace should have cleared')

    // A genuine filesystem failure rather than a hand-written one: what has to be
    // scrubbed is whatever Node actually writes into the message, and a test that
    // invents the message would keep passing after Node changed it.
    await rm(join(workspace, 'out', 'report.md'))
    const failure = await readOutboundFile(verdict.file).then(() => undefined, (error: unknown) => error)

    const detail = describeReadFailure(failure, verdict.file)
    // The reason survives, and so does which file it was about.
    expect(detail).toContain('ENOENT')
    expect(detail).toContain(`'${join('out', 'report.md')}'`)
    // The map of the host does not. This sentence reaches both a room and the
    // model, and the failure branch is the one an injection can provoke.
    expect(detail).not.toContain(workspace)
  })

  it('leaves a failure that names no path alone', () => {
    const workspace = createWorkspace()
    const file = {
      path: join(workspace, 'out.zip'),
      fileName: 'out.zip',
      bytes: 1,
      pathInWorkspace: 'out.zip',
      workspaceName: basename(workspace),
    }

    expect(describeReadFailure(new Error('out.zip changed size after it was cleared'), file))
      .toBe('out.zip changed size after it was cleared')
    // Not every rejection is an `Error`, and the scrub must not be what decides
    // whether one can be reported at all.
    expect(describeReadFailure('nope', file)).toBe('nope')
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

    // One formatter serves the card and both refusal voices now, and it prints a
    // whole size without a trailing `.0` — `25 MiB over a 20 MiB limit`.
    for (const text of [describeRefusalForModel(refusal), describeRefusalForChat(refusal)]) {
      expect(text).toContain('25 MiB')
      expect(text).toContain('20 MiB')
    }
  })

  it('climbs past MiB instead of quoting thousands of them', () => {
    const refusal: OutboundRefusal = { code: 'too_large', bytes: 3 * 1024 ** 3, limit: 2 * 1024 ** 3 }

    // The formatter these voices used to own stopped at MiB, so a 3 GiB file
    // read as `3072.0 MiB` — digits to parse rather than a size to read.
    for (const text of [describeRefusalForModel(refusal), describeRefusalForChat(refusal)]) {
      expect(text).toContain('3 GiB')
      expect(text).toContain('2 GiB')
      expect(text).not.toContain('MiB')
    }
  })

  it('collapses a size that is not a size, instead of printing NaN at a reader', () => {
    const refusal: OutboundRefusal = { code: 'too_large', bytes: Number.NaN, limit: -1 }

    // The old formatter divided whatever it was handed and printed the result;
    // the shared one guards its input, so a broken stat reads as zero.
    expect(describeRefusalForChat(refusal)).toContain('0 字节')
    expect(describeRefusalForChat(refusal)).not.toContain('NaN')
    expect(describeRefusalForModel(refusal)).toContain('0 bytes')
  })

  it('spells a size the way the approval card spells it', () => {
    const refusal: OutboundRefusal = { code: 'too_large', bytes: 1258291, limit: 1024 * 1024 }

    // The room reading the card and the model reading the error must not be told
    // two different sizes for one file, which `KB` beside `KiB` guaranteed.
    for (const text of [describeRefusalForModel(refusal), describeRefusalForChat(refusal)]) {
      expect(text).toContain('1.2 MiB')
      expect(text).not.toContain('MB')
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
      file: {
        path: join(workspace, 'report.md'),
        fileName: 'report.md',
        bytes: 4,
        pathInWorkspace: 'report.md',
        workspaceName: basename(workspace),
      },
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

    // And ONLY the escape: a model mistyping a path, naming a directory, or
    // picking too big a file is making its own mistake, not an operator's event
    // — reporting those hands a model that keeps guessing a console to write to.
    const mundane = stageSendPorts(workspace)
    const tool = sendFileTool(mundane.ports) as Runnable
    await expect(tool.execute({ path: 'missing.md' }, execFor('s1'))).rejects.toThrow(/no file at that path/)
    await expect(tool.execute({ path: '.' }, execFor('s1'))).rejects.toThrow(/not a regular file/)
    await writeFile(join(workspace, 'huge.bin'), 'x'.repeat(2048))
    await expect(tool.execute({ path: 'huge.bin' }, execFor('s1'))).rejects.toThrow(/single-file limit/)
    expect(mundane.reports).toEqual([])

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
    expect(sent[0]!.file).toEqual({
      path: join(workspace, 'report.md'),
      fileName: 'report.md',
      bytes: 8,
      pathInWorkspace: 'report.md',
      workspaceName: basename(workspace),
    })
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

  // Root reads a mode-000 file regardless, which would leave this passing for the
  // wrong reason rather than failing.
  it.skipIf(process.getuid?.() === 0)('tells the chat a read failed without printing the host path', async () => {
    const workspace = createWorkspace()
    await mkdir(join(workspace, 'out'))
    const path = join(workspace, 'out', 'report.md')
    await writeFile(path, 'body')
    // Stats as a regular file under the ceiling, so it clears the check and fails
    // in the read — where the message Node builds quotes the absolute path.
    await chmod(path, 0o000)
    const sent: OutboundFile[] = []
    const reply = await runGetCommand(
      `/${GET_COMMAND} out/report.md`,
      workspace,
      1024,
      async (file) => { sent.push(file) },
    )

    expect(sent).toEqual([])
    expect(reply).toContain('⚠️')
    // Which file, and why, in the form the human typed it.
    expect(reply).toContain(join('out', 'report.md'))
    expect(reply).toContain('EACCES')
    // `/get` answers in the chat, and in a group that is a whole room.
    expect(reply).not.toContain(workspace)
  })
})
