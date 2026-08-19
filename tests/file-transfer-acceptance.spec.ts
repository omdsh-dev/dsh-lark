/**
 * Independent acceptance checks for file transfer.
 *
 * These do NOT re-test what `files.spec.ts` (units) and `plugin.spec.ts`
 * (wiring) already cover. They pin the decisions that live in `docs/adr/` and
 * nowhere in a type — the ones a later change can quietly undo because no
 * compiler complains: the defaults being ON, the group gate being
 * unconfigurable, inbound files following the workspace and never being
 * deleted, and a hostile file name staying inside the inbox end to end.
 *
 * Every case drives the real plugin through the fake transport, so a passing
 * case means the behaviour happened — not that the code reads as if it would.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '@larksuite/channel'
import { Config } from '../src/config.ts'
import { SEND_FILE_TOOL } from '../src/outbound-file.ts'
import { fakeMessage, mountChannel } from './harness.ts'
import type { CreatedAgent } from './harness.ts'

/** Directories these tests let the channel write into, removed after each one. */
const workspaces: string[] = []

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

/** A real, empty directory to mount as the deployment's `cwd`. */
function createWorkspace(): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lark-accept-')))
  workspaces.push(workspace)
  return workspace
}

type Harness = Awaited<ReturnType<typeof mountChannel>>

/** The text block of one followup, which is where every note rides. */
function followupText(created: CreatedAgent, index = 0): string {
  const block = created.agent.followup.mock.calls[index]?.[0].content[0]
  return block?.type === 'text' ? block.text : ''
}

/** An inbound message carrying files the transport can serve. */
function withFiles(
  harness: Harness,
  files: readonly { fileKey: string; fileName: string; bytes: string; type?: 'file' | 'image' }[],
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  for (const file of files) harness.fake.resourceBytes.set(file.fileKey, { buffer: Buffer.from(file.bytes) })
  return fakeMessage({
    content: '看下这些',
    resources: files.map((file) => ({
      type: file.type ?? 'file',
      fileKey: file.fileKey,
      fileName: file.fileName,
    })),
    ...overrides,
  })
}

/** Every file that landed anywhere under one workspace's inbox, as absolute paths. */
async function landedFiles(workspace: string): Promise<string[]> {
  const inbox = join(workspace, '.dsh-lark', 'inbox')
  const found: string[] = []
  let directories: string[]
  try {
    directories = await readdir(inbox)
  } catch {
    return found
  }
  for (const directory of directories) {
    for (const name of await readdir(join(inbox, directory))) found.push(join(inbox, directory, name))
  }
  return found.sort()
}

/** Wait until the agent for one conversation exists and has consumed `count` messages. */
async function consumed(harness: Harness, index: number, count: number): Promise<CreatedAgent> {
  await vi.waitFor(() => { expect(harness.agents.created.length).toBeGreaterThan(index) })
  const created = harness.agents.created[index]!
  await vi.waitFor(() => { expect(created.agent.followup).toHaveBeenCalledTimes(count) })
  return created
}

describe('file transfer · the defaults are the feature', () => {
  // Decisions 4 and 14: both halves default ON. A silent flip to `false` would
  // not fail a type check and would not fail any behavioural test that opts in
  // explicitly — it would just quietly turn the feature off for everyone.
  it('lands files and offers send_file with no file configuration at all', async () => {
    const workspace = createWorkspace()
    const harness = await mountChannel({ cwd: workspace })

    await harness.fake.emitMessage(withFiles(harness, [{ fileKey: 'fk_a', fileName: 'app.log', bytes: 'boom' }]))
    const created = await consumed(harness, 0, 1)

    const landed = await landedFiles(workspace)
    expect(landed).toHaveLength(1)
    expect(await readFile(landed[0]!, 'utf8')).toBe('boom')
    expect(created.registeredTools.map((tool) => tool.name)).toContain(SEND_FILE_TOOL)
    await harness.dispose()
  })

  it('resolves both switches on and both ceilings to 20 MiB when nothing is set', () => {
    const resolved = new Config({}) as Record<string, unknown>
    expect(resolved.receiveFiles).toBe(true)
    expect(resolved.sendFiles).toBe(true)
    expect(resolved.maxReceiveFileBytes).toBe(20 * 1024 * 1024)
    expect(resolved.maxSendFileBytes).toBe(20 * 1024 * 1024)
  })
})

describe('file transfer · the group gate is not a setting', () => {
  // ADR 0002's red line. A knob that turns this off would be an official back
  // door onto the injection chain, and it would be opened for convenience.
  it('exposes exactly four file knobs, and none of them is about approval', () => {
    const knobs = Object.keys(new Config({}) as Record<string, unknown>)
      .filter((key) => /file/i.test(key))
      .sort()
    expect(knobs).toEqual(['maxReceiveFileBytes', 'maxSendFileBytes', 'receiveFiles', 'sendFiles'])
  })

  it('still asks the group even with every other permission opened up', async () => {
    const workspace = createWorkspace()
    await writeFile(join(workspace, 'report.md'), '# findings\n')
    const harness = await mountChannel({
      cwd: workspace,
      // Everything a deployment could plausibly loosen, loosened.
      sendFiles: true,
      receiveFiles: true,
      requireMention: false,
      approvers: [],
      senderAllowlist: [],
      groupAllowlist: [],
      denyTools: [],
    })
    await harness.fake.emitMessage(fakeMessage({ chatType: 'group', chatId: 'oc_group_1' }))
    const created = await vi.waitFor(() => {
      expect(harness.agents.created).toHaveLength(1)
      return harness.agents.created[0]!
    })
    const tool = created.registeredTools.find((entry) => entry.name === SEND_FILE_TOOL) as unknown as {
      execute(args: unknown, exec: unknown): Promise<unknown>
    }

    const sending = tool.execute({ path: 'report.md' }, { agent: created.agent })
    await vi.waitFor(() => {
      expect(harness.fake.sent.filter((message) => 'card' in message.input)).toHaveLength(1)
    })
    // The gate held: nothing left the machine on the strength of configuration.
    expect(harness.fake.sent.filter((message) => 'file' in message.input)).toHaveLength(0)

    await harness.dispose()
    await expect(sending).rejects.toThrow()
  })
})

describe('file transfer · inbound files belong to the workspace', () => {
  // ADR 0001's consequence: files follow the directory, not the conversation.
  it('lands later files in the directory /cd moved to, leaving the first one behind', async () => {
    const first = createWorkspace()
    const second = createWorkspace()
    const harness = await mountChannel({ cwd: first })

    await harness.fake.emitMessage(withFiles(harness, [{ fileKey: 'fk_1', fileName: 'before.log', bytes: 'a' }]))
    await consumed(harness, 0, 1)

    await harness.fake.emitMessage(fakeMessage({ content: `/cd ${second}`, messageId: 'om_cd' }))
    await vi.waitFor(() => {
      expect(harness.fake.sent.map((message) => JSON.stringify(message.input)).join()).toContain(second)
    })

    await harness.fake.emitMessage(
      withFiles(harness, [{ fileKey: 'fk_2', fileName: 'after.log', bytes: 'b' }], { messageId: 'om_in_2' }),
    )
    await consumed(harness, 1, 1)

    expect((await landedFiles(first)).map((path) => path.split('/').pop())).toEqual(['before.log'])
    expect((await landedFiles(second)).map((path) => path.split('/').pop())).toEqual(['after.log'])
    await harness.dispose()
  })

  // ADR 0001 again, and the epoch principle it borrows from: a chat command
  // must not be able to destroy a record. The log someone sent may be the only
  // copy of it.
  it('keeps every landed file across /new, which only starts the context over', async () => {
    const workspace = createWorkspace()
    const harness = await mountChannel({ cwd: workspace })

    await harness.fake.emitMessage(withFiles(harness, [{ fileKey: 'fk_old', fileName: 'old.log', bytes: 'old' }]))
    await consumed(harness, 0, 1)

    await harness.fake.emitMessage(fakeMessage({ content: '/new', messageId: 'om_new' }))
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(0) })

    await harness.fake.emitMessage(
      withFiles(harness, [{ fileKey: 'fk_new', fileName: 'new.log', bytes: 'new' }], { messageId: 'om_in_2' }),
    )
    await consumed(harness, 1, 1)

    const landed = (await landedFiles(workspace)).map((path) => path.split('/').pop())
    expect(landed.sort()).toEqual(['new.log', 'old.log'])
    await harness.dispose()
  })
})

describe('file transfer · one message, several files', () => {
  it('lands all three in one directory and names every path to the model', async () => {
    const workspace = createWorkspace()
    const harness = await mountChannel({ cwd: workspace })

    await harness.fake.emitMessage(withFiles(harness, [
      { fileKey: 'fk_x', fileName: 'a.log', bytes: 'aaa' },
      { fileKey: 'fk_y', fileName: 'b.json', bytes: 'bbb' },
      { fileKey: 'fk_z', fileName: 'c.txt', bytes: 'ccc' },
    ]))
    const created = await consumed(harness, 0, 1)

    const landed = await landedFiles(workspace)
    expect(landed).toHaveLength(3)
    // One message, one directory — the whole point of grouping by message.
    expect(new Set(landed.map((path) => dirname(path))).size).toBe(1)

    const text = followupText(created)
    for (const path of landed) expect(text).toContain(path)
    await harness.dispose()
  })
})

describe('file transfer · a hostile name cannot leave the inbox', () => {
  // The sender controls `fileName`. Sanitising is unit-tested; what is NOT
  // covered anywhere is that the sanitised name is what the WHOLE inbound path
  // actually writes to — a later refactor could sanitise for the note and open
  // the file with the raw name.
  it.each([
    ['posix traversal', '../../../../evil.sh'],
    ['windows traversal', '..\\..\\windows.bat'],
    ['absolute path', '/etc/passwd'],
    ['bare dots', '../..'],
    ['leading dot', '.bashrc'],
  ])('keeps a %s inside the inbox', async (_label, hostile) => {
    const workspace = createWorkspace()
    const harness = await mountChannel({ cwd: workspace })

    await harness.fake.emitMessage(withFiles(harness, [{ fileKey: 'fk_evil', fileName: hostile, bytes: 'payload' }]))
    const created = await consumed(harness, 0, 1)

    const landed = await landedFiles(workspace)
    expect(landed).toHaveLength(1)
    const path = landed[0]!
    const name = path.split('/').pop()!

    // The properties that matter, and that hold on every platform: the name
    // carries no separator of either family, and the bytes sit under the inbox
    // without climbing out of it.
    expect(name).not.toMatch(/[/\\]/)
    const inbox = join(workspace, '.dsh-lark', 'inbox')
    expect(relative(inbox, path).startsWith('..')).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('payload')
    // And the model is told the real path, not the name it was sent under.
    expect(followupText(created)).toContain(path)
    await harness.dispose()
  })

  // Exact names, only where POSIX `basename` makes the outcome deterministic.
  // A backslash path is deliberately absent: `basename` does not treat `\` as a
  // separator off Windows, so the name it yields is platform-dependent —
  // safe either way, which is what the case above pins.
  it.each([
    ['../../../../evil.sh', 'evil.sh'],
    ['/etc/passwd', 'passwd'],
  ])('strips %s down to %s', async (hostile, expected) => {
    const workspace = createWorkspace()
    const harness = await mountChannel({ cwd: workspace })

    await harness.fake.emitMessage(withFiles(harness, [{ fileKey: 'fk_n', fileName: hostile, bytes: 'x' }]))
    await consumed(harness, 0, 1)

    expect((await landedFiles(workspace))[0]!.split('/').pop()).toBe(expected)
    await harness.dispose()
  })
})

describe('file transfer · send_file cannot aim anywhere else', () => {
  // The tool sends to the agent's own chat. Accepting a target chat would make
  // "which room does this leave to" a model decision, which is exactly what the
  // group gate exists to keep out of the model's hands.
  it('declares one parameter, and it is the path', async () => {
    const workspace = createWorkspace()
    const harness = await mountChannel({ cwd: workspace })
    await harness.fake.emitMessage(fakeMessage())
    const created = await vi.waitFor(() => {
      expect(harness.agents.created).toHaveLength(1)
      return harness.agents.created[0]!
    })

    const definition = created.registeredTools.find((tool) => tool.name === SEND_FILE_TOOL) as unknown as {
      parameters: { properties: Record<string, unknown>; required: string[] }
    }
    expect(Object.keys(definition.parameters.properties)).toEqual(['path'])
    expect(definition.parameters.required).toEqual(['path'])
    await harness.dispose()
  })
})
