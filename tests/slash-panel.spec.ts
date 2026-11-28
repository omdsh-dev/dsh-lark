import { describe, expect, it } from 'vitest'
import { syncSlashPanel } from '../src/slash-panel.ts'
import type { PanelCommand, SlashPanelPort } from '../src/slash-panel.ts'

/**
 * A panel that keeps its entries in memory about as well as the platform does:
 * a create is the only way to set a description, and a delete removes both the
 * entry and its text. There is no update route, which is the whole reason the
 * reconciliation has to replace an entry to restate it.
 */
function fakePanel(entries: { command: string; description?: string }[] = [], options: {
  failList?: boolean
  failDelete?: string
  failCreate?: string
} = {}) {
  const rows = entries.map((entry, index) => ({ commandId: `cmd_${index}`, ...entry }))
  const created: { command: string; description: string }[] = []
  const deleted: string[] = []
  const port: SlashPanelPort = {
    async listSlashCommands(): Promise<PanelCommand[]> {
      if (options.failList === true) throw new Error('no permission to list commands')
      return rows.map(row => ({
        command: row.command,
        commandId: row.commandId,
        ...row.description === undefined ? {} : { description: row.description },
      }))
    },
    async createSlashCommand(command, description) {
      if (options.failCreate === command) throw new Error('that name is taken')
      created.push({ command, description })
      rows.push({ commandId: `cmd_new_${rows.length}`, command, description })
    },
    async deleteSlashCommand(commandId) {
      const index = rows.findIndex(row => row.commandId === commandId)
      if (index < 0) return
      if (options.failDelete === rows[index]!.command) throw new Error('cannot remove that command')
      deleted.push(rows[index]!.command)
      rows.splice(index, 1)
    },
  }
  return { port, rows, created, deleted }
}

describe('the slash-command panel sync', () => {
  it('registers what the panel is missing, under the text this channel wants', async () => {
    const panel = fakePanel()
    const notices: string[] = []
    const sync = await syncSlashPanel(panel.port, [
      { name: 'permission', description: '查看或切换本会话的权限预设（沙箱范围 + 审批策略）' },
    ], line => notices.push(line))
    expect(sync).toEqual({ added: ['permission'], updated: [], removed: [] })
    expect(panel.created).toEqual([
      { command: 'permission', description: '查看或切换本会话的权限预设（沙箱范围 + 审批策略）' },
    ])
    expect(notices).toEqual([])
  })

  it('replaces an entry whose description no longer matches', async () => {
    // The regression: a command registered months ago still shows the text it
    // was created with, so a fixed command goes on advertising the old summary
    // to everyone who opens the `/` menu. The platform cannot patch a
    // description, so the entry is removed and registered again.
    const panel = fakePanel([{ command: 'permission', description: 'Switch the permission preset (sandbox mode + approval policy)' }])
    const sync = await syncSlashPanel(panel.port, [
      { name: 'permission', description: '查看或切换本会话的权限预设（沙箱范围 + 审批策略）' },
    ], () => {})
    expect(sync).toEqual({ added: [], updated: ['permission'], removed: [] })
    expect(panel.deleted).toEqual(['permission'])
    expect(panel.created).toEqual([
      { command: 'permission', description: '查看或切换本会话的权限预设（沙箱范围 + 审批策略）' },
    ])
    expect(panel.rows).toHaveLength(1)
  })

  it('leaves an entry alone when its text already matches', async () => {
    const panel = fakePanel([{ command: 'permission', description: '同样的文字' }])
    const sync = await syncSlashPanel(panel.port, [{ name: 'permission', description: '同样的文字' }], () => {})
    expect(sync).toEqual({ added: [], updated: [], removed: [] })
    expect(panel.deleted).toEqual([])
    expect(panel.created).toEqual([])
  })

  it('leaves an entry alone when the platform reported no description to compare', async () => {
    // A name with no text is "cannot tell", not "different". Rewriting it would
    // trade a stale description for a lost one on every start.
    const panel = fakePanel([{ command: 'permission' }])
    const sync = await syncSlashPanel(panel.port, [{ name: 'permission', description: '新文字' }], () => {})
    expect(sync).toEqual({ added: [], updated: [], removed: [] })
    expect(panel.deleted).toEqual([])
  })

  it('says when a refresh lost the entry, instead of reporting success', async () => {
    // Replace is two calls. A delete that lands and a create that does not
    // leaves the menu WITHOUT the command — silence there would hide a worse
    // state than the stale text it was fixing.
    const panel = fakePanel(
      [{ command: 'permission', description: 'old text' }],
      { failCreate: 'permission' },
    )
    const notices: string[] = []
    const sync = await syncSlashPanel(panel.port, [{ name: 'permission', description: 'new text' }], line => notices.push(line))
    expect(sync).toEqual({ added: [], updated: [], removed: [] })
    expect(panel.rows).toEqual([])
    expect(notices.some(line => line.includes('could not register it again'))).toBe(true)
  })

  it('keeps a stale entry rather than removing it when the refresh cannot start', async () => {
    const panel = fakePanel(
      [{ command: 'permission', description: 'old text' }],
      { failDelete: 'permission' },
    )
    const notices: string[] = []
    const sync = await syncSlashPanel(panel.port, [{ name: 'permission', description: 'new text' }], line => notices.push(line))
    expect(sync).toEqual({ added: [], updated: [], removed: [] })
    expect(panel.rows.map(row => row.command)).toEqual(['permission'])
    expect(notices.some(line => line.includes('could not refresh /permission'))).toBe(true)
  })

  it('still removes what the channel no longer offers', async () => {
    const panel = fakePanel([{ command: 'permission', description: 'text' }, { command: 'retired' }])
    const sync = await syncSlashPanel(panel.port, [{ name: 'permission', description: 'text' }], () => {})
    expect(sync).toEqual({ added: [], updated: [], removed: ['retired'] })
    expect(panel.rows.map(row => row.command)).toEqual(['permission'])
  })

  it('claims nothing when the panel cannot be read', async () => {
    const panel = fakePanel([], { failList: true })
    const notices: string[] = []
    const sync = await syncSlashPanel(panel.port, [{ name: 'permission', description: 'text' }], line => notices.push(line))
    expect(sync).toEqual({ added: [], updated: [], removed: [] })
    expect(panel.created).toEqual([])
    expect(notices.some(line => line.includes('panel not synced'))).toBe(true)
  })
})
