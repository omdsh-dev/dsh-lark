import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFILE,
  ROW_ID,
  SERVICE_LABEL,
  dshHome,
  envCredentials,
  ensureProfileBuildPolicy,
  hasCredentialSection,
  isOnboarded,
  launchdPlist,
  ownVersion,
  parseArguments,
  servicePath,
  supervisorKind,
  systemdUnit,
  whichSync,
  filterConsole,
  installedPluginVersion,
  invocation,
  isNewer,
  latestVersion,
  readInstalledService,
  usage,
  newConsoleFilter,
  withInstanceRow,
  withoutInstanceRow,
} from '../src/provision.ts'
import type { ServiceSpec } from '../src/provision.ts'

/** A spec with every field set, so a writer that drops one is visible. */
const spec: ServiceSpec = {
  dsh: '/usr/local/bin/dsh',
  profile: 'lark',
  workspace: '/srv/work',
  dshHome: '/srv/home',
}

/** Environment keys these tests move, restored after each case. */
const owned = ['DSH_HOME', 'LARK_APP_ID', 'LARK_APP_SECRET'] as const
const saved = new Map(owned.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of owned) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('parseArguments', () => {
  it('defaults a bare invocation to start on the default profile', () => {
    expect(parseArguments([])).toMatchObject({ kind: 'start', profile: DEFAULT_PROFILE })
  })

  it('treats a leading option as start, so flags need no verb', () => {
    expect(parseArguments(['--profile', 'bot'])).toMatchObject({ kind: 'start', profile: 'bot' })
  })

  it('reads the profile and workspace of an explicit start', () => {
    expect(parseArguments(['start', '--profile', 'bot', '--workspace', '/srv/work']))
      .toMatchObject({ kind: 'start', profile: 'bot', workspace: '/srv/work' })
  })

  it('resolves a relative workspace against the invoking directory', () => {
    expect(parseArguments(['start', '--workspace', '.'])).toMatchObject({ workspace: process.cwd() })
  })

  it.each(['stop', 'restart', 'status'] as const)('reads the %s verb', (verb) => {
    expect(parseArguments([verb])).toEqual({ kind: verb })
  })

  it('rejects options on a verb that takes none, rather than ignoring them', () => {
    expect(() => parseArguments(['stop', '--profile', 'bot'])).toThrow(/takes no options/)
  })

  it('reads logs with and without follow, and rejects anything else', () => {
    expect(parseArguments(['logs'])).toEqual({ kind: 'logs', follow: false })
    expect(parseArguments(['logs', '-f'])).toEqual({ kind: 'logs', follow: true })
    expect(parseArguments(['logs', '--follow'])).toEqual({ kind: 'logs', follow: true })
    expect(() => parseArguments(['logs', '-n', '50'])).toThrow(/logs takes only -f/)
  })

  it.each([['help'], ['--help'], ['-h']])('answers %s with the help command', (flag) => {
    expect(parseArguments([flag])).toEqual({ kind: 'help' })
  })

  it('rejects an unknown command or option', () => {
    expect(() => parseArguments(['launch'])).toThrow(/unknown command/)
    expect(() => parseArguments(['start', '--colour'])).toThrow(/unknown option/)
  })

  it('rejects a flag whose value is missing', () => {
    expect(() => parseArguments(['start', '--profile'])).toThrow(/--profile needs a name/)
    expect(() => parseArguments(['start', '--workspace'])).toThrow(/--workspace needs a directory/)
  })
})

describe('whichSync', () => {
  it('returns the absolute path of an executable on the searched PATH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'which-'))
    const executable = join(directory, 'dsh')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    expect(whichSync('dsh', directory)).toBe(executable)
  })

  it('skips empty entries and directories holding no such executable', () => {
    const empty = mkdtempSync(join(tmpdir(), 'which-'))
    const holder = mkdtempSync(join(tmpdir(), 'which-'))
    const executable = join(holder, 'dsh')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    expect(whichSync('dsh', ['', empty, holder].join(delimiter))).toBe(executable)
  })

  it('returns undefined when nothing on PATH matches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'which-'))
    mkdirSync(join(directory, 'dsh'))
    expect(whichSync('no-such-executable', directory)).toBeUndefined()
  })
})

describe('supervisorKind', () => {
  it('names launchd on macOS and no supervisor on Windows', () => {
    expect(supervisorKind('darwin')).toBe('launchd')
    expect(supervisorKind('win32')).toBeUndefined()
  })
})

describe('profile build policy', () => {
  /** Seed a profile directory with the workspace document a test starts from. */
  const seedProfile = (document?: string): string => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    if (document !== undefined) {
      mkdirSync(join(home, 'profiles', 'lark'), { recursive: true })
      writeFileSync(join(home, 'profiles', 'lark', 'pnpm-workspace.yaml'), document)
    }
    return home
  }

  /** The profile's workspace document as it stands on disk. */
  const readWorkspace = (home: string): string =>
    readFileSync(join(home, 'profiles', 'lark', 'pnpm-workspace.yaml'), 'utf8')

  /** The template DSH writes when it initializes a profile of its own. */
  const DSH_TEMPLATE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

  it('pre-seeds a fresh profile before its first pnpm install', () => {
    const home = seedProfile()

    ensureProfileBuildPolicy('lark', home)

    const document = readWorkspace(home)
    expect(document).toContain('nodeLinker: hoisted')
    expect(document).toContain('strictDepBuilds: false')
    expect(document).toContain('protobufjs: false')
  })

  it('adds both halves to a profile built before this policy existed', () => {
    const home = seedProfile(DSH_TEMPLATE)

    ensureProfileBuildPolicy('lark', home)

    const document = readWorkspace(home)
    expect(document).toContain(DSH_TEMPLATE.trimEnd())
    expect(document).toContain('strictDepBuilds: false')
    expect(document).toContain('allowBuilds:\n  protobufjs: false')
  })

  it('repairs the placeholder pnpm leaves after ERR_PNPM_IGNORED_BUILDS', () => {
    const home = seedProfile('packages:\n  - .\nallowBuilds:\n  protobufjs: set this to true or false\n')

    ensureProfileBuildPolicy('lark', home)

    expect(readWorkspace(home)).toContain('  protobufjs: false')
  })

  it('preserves an operator choice to run protobufjs postinstall', () => {
    const home = seedProfile('allowBuilds:\n  protobufjs: true\n')

    ensureProfileBuildPolicy('lark', home)

    const document = readWorkspace(home)
    expect(document).toContain('protobufjs: true')
    expect(document).not.toContain('protobufjs: false')
    expect(document).toContain('strictDepBuilds: false')
  })

  it('preserves an operator choice to keep the strict gate on', () => {
    const home = seedProfile('strictDepBuilds: true\n')

    ensureProfileBuildPolicy('lark', home)

    const document = readWorkspace(home)
    expect(document).toContain('strictDepBuilds: true')
    expect(document).not.toContain('strictDepBuilds: false')
    // The named decision is what carries a profile that keeps the gate on,
    // since only an undecided build script trips it.
    expect(document).toContain('  protobufjs: false')
  })

  it('never writes a second allowBuilds key, whatever shape the first one has', () => {
    for (const existing of ['allowBuilds: {}\n', 'allowBuilds: # decided per package\n', 'allowBuilds: {esbuild: true}\n']) {
      const home = seedProfile(`packages:\n  - .\n${existing}`)

      ensureProfileBuildPolicy('lark', home)

      const document = readWorkspace(home)
      expect(document.match(/^allowBuilds\s*:/gm)).toHaveLength(1)
      expect(document).toContain('strictDepBuilds: false')
    }
  })

  it('leaves a protobufjs entry spelled a way it does not edit', () => {
    const home = seedProfile('allowBuilds:\n  "protobufjs": false\n')

    ensureProfileBuildPolicy('lark', home)

    const document = readWorkspace(home)
    expect(document.match(/protobufjs/g)).toHaveLength(1)
    expect(document).toContain('strictDepBuilds: false')
  })

  it('keeps a comment on the allowBuilds line it opens up', () => {
    const home = seedProfile('allowBuilds: {} # decided per package\n')

    ensureProfileBuildPolicy('lark', home)

    expect(readWorkspace(home)).toContain('allowBuilds: # decided per package\n  protobufjs: false')
  })

  it('leaves an allowBuilds block it cannot extend to the strict gate instead', () => {
    const home = seedProfile('allowBuilds: {esbuild: true}\n')

    ensureProfileBuildPolicy('lark', home)

    const document = readWorkspace(home)
    expect(document).toContain('allowBuilds: {esbuild: true}')
    expect(document).not.toContain('protobufjs')
  })

  it('keeps other packages\' decisions when it records this one', () => {
    const home = seedProfile('allowBuilds:\n  esbuild: true\n\nnodeLinker: hoisted\n')

    ensureProfileBuildPolicy('lark', home)

    const document = readWorkspace(home)
    expect(document).toContain('  esbuild: true')
    expect(document).toContain('  protobufjs: false')
    expect(document).toContain('nodeLinker: hoisted')
  })

  it('indents its entry the way the block it joins is indented', () => {
    const home = seedProfile('allowBuilds:\n    esbuild: true\n')

    ensureProfileBuildPolicy('lark', home)

    expect(readWorkspace(home)).toContain('allowBuilds:\n    protobufjs: false\n    esbuild: true')
  })

  it('reads a document written with CRLF endings', () => {
    const home = seedProfile('packages:\r\n  - .\r\nallowBuilds:\r\n  protobufjs: set this to true or false\r\n')

    ensureProfileBuildPolicy('lark', home)

    const document = readWorkspace(home)
    expect(document.match(/^allowBuilds\s*:/gm)).toHaveLength(1)
    expect(document).toContain('  protobufjs: false')
    expect(document).not.toContain('\r')
  })

  it('settles in one pass, so a second run rewrites nothing', () => {
    const seeds = [
      undefined,
      DSH_TEMPLATE,
      'allowBuilds:\n  protobufjs: set this to true or false\n',
      'allowBuilds: {}\n',
      'allowBuilds: {esbuild: true}\n',
      'allowBuilds:\n    esbuild: true\n',
      'strictDepBuilds: true\n',
      'packages:\r\n  - .\r\n',
    ]
    for (const seed of seeds) {
      const home = seedProfile(seed)
      ensureProfileBuildPolicy('lark', home)
      const settled = readWorkspace(home)

      ensureProfileBuildPolicy('lark', home)

      expect(readWorkspace(home)).toBe(settled)
    }
  })

  it('refuses a profile name that would write outside the harness home', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    for (const name of ['..', '../escape', 'nested/profile', '']) {
      expect(() => ensureProfileBuildPolicy(name, home)).toThrow(/invalid profile name/)
    }
  })
})

describe('onboarding detection', () => {
  it('recognizes this plugin\'s section, and only at the top level', () => {
    expect(hasCredentialSection(`${ROW_ID}:\n  appId: cli_x\n`)).toBe(true)
    expect(hasCredentialSection(`llm-deepseek:\n  thinking: enabled\n${ROW_ID}:\n`)).toBe(true)
    expect(hasCredentialSection('llm-deepseek:\n  note: lark-channel is not configured\n')).toBe(false)
    expect(hasCredentialSection('')).toBe(false)
  })

  it('yields environment credentials only as a complete, non-empty pair', () => {
    expect(envCredentials({})).toBeUndefined()
    expect(envCredentials({ LARK_APP_ID: 'cli_x' })).toBeUndefined()
    expect(envCredentials({ LARK_APP_ID: 'cli_x', LARK_APP_SECRET: '' })).toBeUndefined()
    expect(envCredentials({ LARK_APP_ID: 'cli_x', LARK_APP_SECRET: 's' })).toEqual({ appId: 'cli_x', appSecret: 's' })
  })

  it('treats environment credentials as onboarded, since the unit forwards them', () => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'home-'))
    expect(isOnboarded()).toBe(false)
    process.env.LARK_APP_ID = 'cli_x'
    expect(isOnboarded()).toBe(false)
    process.env.LARK_APP_SECRET = 'secret'
    expect(isOnboarded()).toBe(true)
  })

  it('reads the settings document under the configured home', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    delete process.env.LARK_APP_ID
    delete process.env.LARK_APP_SECRET
    process.env.DSH_HOME = home
    expect(dshHome()).toBe(home)
    expect(isOnboarded()).toBe(false)
    writeFileSync(join(home, 'settings.yaml'), `${ROW_ID}:\n  appId: cli_x\n`)
    expect(isOnboarded()).toBe(true)
  })
})

describe('servicePath', () => {
  it('leads with the interpreter that can run a `#!/usr/bin/env node` dsh', () => {
    const path = servicePath('/opt/nvm/v22/bin/dsh', '/opt/nvm/v22/bin/node', '/usr/bin')
    expect(path.split(delimiter)[0]).toBe('/opt/nvm/v22/bin')
  })

  it('keeps a separately installed interpreter as well as dsh\'s own directory', () => {
    const entries = servicePath('/opt/prefix/bin/dsh', '/opt/nvm/v22/bin/node', '/usr/bin').split(delimiter)
    expect(entries).toContain('/opt/prefix/bin')
    expect(entries).toContain('/opt/nvm/v22/bin')
  })

  it('carries the operator\'s PATH through, so the agent still finds its tools', () => {
    const entries = servicePath('/opt/bin/dsh', '/opt/bin/node', '/opt/homebrew/bin:/usr/bin').split(delimiter)
    expect(entries).toContain('/opt/homebrew/bin')
  })

  it('dedupes and drops empty entries, and always ends up with the system ones', () => {
    const entries = servicePath('/opt/bin/dsh', '/opt/bin/node', '/opt/bin::/usr/bin').split(delimiter)
    expect(entries.filter((entry) => entry === '/opt/bin')).toHaveLength(1)
    expect(entries).not.toContain('')
    expect(entries).toContain('/usr/bin')
    expect(entries).toContain('/bin')
  })
})

describe('unit files', () => {
  it('runs the resolved dsh against the named profile from the workspace', () => {
    const plist = launchdPlist(spec)
    expect(plist).toContain(`<string>${spec.dsh}</string>`)
    expect(plist).toContain(`<string>${spec.profile}</string>`)
    expect(plist).toContain(`<key>WorkingDirectory</key><string>${spec.workspace}</string>`)
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`)

    const unit = systemdUnit(spec)
    expect(unit).toContain(`ExecStart="${spec.dsh}" --profile "${spec.profile}"`)
    expect(unit).toContain(`WorkingDirectory=${spec.workspace}`)
  })

  it('asks the supervisor to keep the bot up', () => {
    expect(launchdPlist(spec)).toContain('<key>KeepAlive</key><true/>')
    expect(launchdPlist(spec)).toContain('<key>RunAtLoad</key><true/>')
    expect(systemdUnit(spec)).toContain('Restart=always')
    expect(systemdUnit(spec)).toContain('WantedBy=default.target')
  })

  it('points both supervisors\' console at the same log file the CLI relays', () => {
    const unit = systemdUnit(spec)
    expect(unit).toContain('StandardOutput=append:')
    expect(unit).toContain('StandardError=append:')
    expect(launchdPlist(spec)).toContain('<key>StandardOutPath</key>')
  })

  it('always carries a PATH, since a supervisor supplies almost none', () => {
    expect(launchdPlist(spec)).toContain('<key>PATH</key>')
    expect(systemdUnit(spec)).toContain('Environment="PATH=')

    const { dshHome: _omitted, ...bare } = spec
    expect(launchdPlist(bare)).toContain('<key>PATH</key>')
    expect(systemdUnit(bare)).toContain('Environment="PATH=')
  })

  it('passes DSH_HOME through only when the operator set one', () => {
    expect(launchdPlist(spec)).toContain('<key>DSH_HOME</key>')
    expect(systemdUnit(spec)).toContain('Environment="DSH_HOME=/srv/home"')

    const { dshHome: _omitted, ...bare } = spec
    expect(launchdPlist(bare)).not.toContain('DSH_HOME')
    expect(systemdUnit(bare)).not.toContain('DSH_HOME')
  })

  it('escapes what each platform would misread', () => {
    const plist = launchdPlist({ ...spec, workspace: '/srv/R&D <lab>' })
    expect(plist).toContain('<key>WorkingDirectory</key><string>/srv/R&amp;D &lt;lab&gt;</string>')
    expect(plist).not.toContain('R&D')

    const unit = systemdUnit({ ...spec, dsh: '/opt/my tools/dsh' })
    expect(unit).toContain('ExecStart="/opt/my tools/dsh"')
  })

  it('forwards app credentials only when the environment supplied them', () => {
    expect(launchdPlist(spec)).not.toContain('LARK_APP_ID')
    expect(systemdUnit(spec)).not.toContain('LARK_APP_ID')

    const armed: ServiceSpec = { ...spec, credentials: { appId: 'cli_x', appSecret: 's&"t' } }
    expect(launchdPlist(armed)).toContain('<key>LARK_APP_ID</key><string>cli_x</string>')
    expect(launchdPlist(armed)).toContain('<key>LARK_APP_SECRET</key><string>s&amp;"t</string>')
    expect(systemdUnit(armed)).toContain('Environment="LARK_APP_SECRET=s&\\"t"')
  })

  it('never carries a model credential, because the host resolves that itself', () => {
    for (const contents of [launchdPlist(spec), systemdUnit(spec)]) {
      expect(contents).not.toContain('DEEPSEEK_API_KEY')
    }
  })
})

describe('ownVersion', () => {
  it('reads this package\'s version, so a profile gets the matching build', () => {
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('extra bots', () => {
  /** The empty patch layer a fresh profile ships with. */
  const EMPTY = '# Your patch layer for this dsh profile.\n[]\n'

  it('parses one bot name, and refuses anything else', () => {
    // No profile parsed means "whatever the installed unit runs", resolved at
    // execution — a default here would edit a profile nobody is running.
    expect(parseArguments(['add', 'support'])).toEqual({ kind: 'add', name: 'support' })
    expect(parseArguments(['remove', 'support', '--profile', 'work']))
      .toEqual({ kind: 'remove', profile: 'work', name: 'support' })
    expect(() => parseArguments(['add'])).toThrow('one bot name')
    expect(() => parseArguments(['add', 'a', 'b'])).toThrow('one bot name')
    expect(() => parseArguments(['add', 'support', '--nope'])).toThrow('unknown option')
  })

  it('replaces the empty layer with the first row, then appends', () => {
    const first = withInstanceRow(EMPTY, 'support')!
    // `[]` cannot hold a list item, so the first row has to take its place.
    expect(first).not.toContain('[]')
    expect(first).toContain('instance: support')
    expect(first).toContain('id: lark-channel-support')
    const second = withInstanceRow(first, 'sales')!
    expect(second).toContain('instance: support')
    expect(second).toContain('instance: sales')
    // Idempotent: adding a name already there changes nothing.
    expect(withInstanceRow(second, 'sales')).toBeUndefined()
  })

  it('takes back exactly what it added', () => {
    const both = withInstanceRow(withInstanceRow(EMPTY, 'support')!, 'sales')!
    const withoutSales = withoutInstanceRow(both, 'sales')!
    expect(withoutSales).toContain('instance: support')
    expect(withoutSales).not.toContain('instance: sales')
    // Emptied again, the layer says so in YAML rather than being blank.
    const emptied = withoutInstanceRow(withoutSales, 'support')!
    expect(emptied.trimEnd().endsWith('[]')).toBe(true)
    expect(withoutInstanceRow(emptied, 'support')).toBeUndefined()
  })

  it('leaves a hand-written row of the operator own alone', () => {
    const handWritten = '- insert:\n    - id: something-else\n      name: other-plugin\n'
    const added = withInstanceRow(handWritten, 'support')!
    const removed = withoutInstanceRow(added, 'support')!
    expect(removed).toContain('id: something-else')
    expect(removed).not.toContain('lark-channel-support')
  })
})

describe('scan console', () => {
  /** The log as it actually looked while a second bot was being added. */
  const LOG = [
    "[info]: [ '[ws]', 'ws client closed manually' ]",
    '[2026-08-15 18:55:55] lark-channel: direct messages: anyone the app is visible to',
    "[info]: [ 'client ready' ]",
    "[info]: [ 'event-dispatch is ready' ]",
    '[2026-08-15 18:55:55] lark-channel: 未配置应用凭证。用飞书扫下面的二维码创建应用，60 分钟内有效：',
    '[2026-08-15 18:55:55] ',
    '█ ▄▄▄▄▄ █▄█▀▄██ ▀█▀█▄▀▄▀ ▀██ ▄▀ ▄▀▀██▄ ▀▀ █ ▄▄▄▄▄ █',
    '█ █   █ █ ▄█  ██ █▀ ██▄▄▄ █▀▀█▄▀ ▄█ ▀  █ ▄█ █   █ █',
    '[2026-08-15 18:55:55]   https://open.feishu.cn/page/launcher?user_code=A5JD-RFKC',
    "[info]: [",
    "  '[ws]',",
    "  'receive events or callbacks through persistent connection only available in',",
    ']',
    "[info]: [ '[ws]', 'ws client ready' ]",
    '',
  ].join('\n')

  it('keeps the QR code and drops the library chatter around it', () => {
    const shown = filterConsole(LOG, newConsoleFilter())
    // The whole point: the code and the link a person has to act on.
    expect(shown).toContain('▄▄▄▄▄')
    expect(shown).toContain('https://open.feishu.cn/page/launcher')
    expect(shown).toContain('未配置应用凭证')
    // And none of the transport library's own output, including the block
    // that spans several lines — suppression runs to the next stamped line.
    expect(shown).not.toContain('ws client ready')
    expect(shown).not.toContain('event-dispatch')
    expect(shown).not.toContain('receive events or callbacks')
    // Including the line that merely closes the block.
    expect(shown.split('\n')).not.toContain(']')
  })

  it('holds a line that a chunk boundary split in half', () => {
    const state = newConsoleFilter()
    const first = filterConsole('[2026-08-15 18:55:55] lark-cha', state)
    expect(first).toBe('')
    const second = filterConsole('nnel: 已连接\n', state)
    expect(second).toBe('[2026-08-15 18:55:55] lark-channel: 已连接\n')
  })

  it('carries suppression across chunks, so half a block is not printed', () => {
    const state = newConsoleFilter()
    filterConsole("[info]: [\n  '[ws]',\n", state)
    expect(filterConsole("  'still inside the block',\n", state)).toBe('')
    expect(filterConsole('[2026-08-15 18:55:56] lark-channel: back\n', state))
      .toBe('[2026-08-15 18:55:56] lark-channel: back\n')
  })
})

describe('how the command spells itself', () => {
  it('answers with the form the caller actually used', () => {
    // Run through npx the binary lives in a throwaway cache, so telling that
    // caller to run a bare `dsh-lark-channel` is telling them to run nothing.
    expect(invocation('/home/dev/.npm/_npx/abc123/node_modules/dsh-lark-channel/lib/cli.js'))
      .toBe('npx dsh-lark-channel@latest')
    expect(invocation('/usr/local/lib/node_modules/dsh-lark-channel/lib/cli.js'))
      .toBe('dsh-lark-channel')
    // An unknown path is the installed form: the shorter, likelier one.
    expect(invocation('')).toBe('dsh-lark-channel')
  })

  it('spells every line of the usage text the same way', () => {
    const text = usage('npx dsh-lark-channel@latest')
    expect(text).toContain('npx dsh-lark-channel@latest start')
    expect(text).toContain('npx dsh-lark-channel@latest add <name>')
    expect(text).not.toMatch(/\n {2}dsh-lark-channel /)
  })
})

describe('upgrading', () => {
  it('parses the verb with the same options start takes', () => {
    // Bare `upgrade` carries neither: it must not move a service that was
    // installed with another profile or another workspace.
    expect(parseArguments(['upgrade'])).toEqual({ kind: 'upgrade' })
    expect(parseArguments(['upgrade', '--profile', 'work'])).toMatchObject({ kind: 'upgrade', profile: 'work' })
    expect(() => parseArguments(['upgrade', '--nope'])).toThrow('unknown option')
  })

  it('compares versions by their release numbers', () => {
    expect(isNewer('0.0.6', '0.0.5')).toBe(true)
    expect(isNewer('0.1.0', '0.0.9')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
    expect(isNewer('0.0.5', '0.0.5')).toBe(false)
    expect(isNewer('0.0.4', '0.0.5')).toBe(false)
    // A prerelease of the same numbers is not newer than the release.
    expect(isNewer('0.0.5-rc.1', '0.0.5')).toBe(false)
    // Missing parts read as zero rather than throwing.
    expect(isNewer('1', '0.9.9')).toBe(true)
  })

  it('answers nothing when the registry cannot be reached', async () => {
    // The check is a courtesy on top of whatever the caller actually ran, so
    // it must cost that command nothing when it fails.
    await expect(latestVersion(1)).resolves.toBeUndefined()
  })
})

describe('acting on the service that is installed', () => {
  it('reads the profile and workspace back out of a launchd unit', () => {
    const written = launchdPlist({ ...spec, profile: 'web', workspace: '/repo/with spaces' })
    expect(readInstalledService(written, 'darwin')).toEqual({
      profile: 'web',
      workspace: '/repo/with spaces',
    })
  })

  it('reads them back out of a systemd unit too', () => {
    const written = systemdUnit({ ...spec, profile: 'web', workspace: '/repo' })
    expect(readInstalledService(written, 'linux')).toEqual({ profile: 'web', workspace: '/repo' })
  })

  it('undoes the escaping the plist writer applied', () => {
    const written = launchdPlist({ ...spec, profile: 'a&b', workspace: '/repo/<odd>' })
    expect(readInstalledService(written, 'darwin')).toEqual({ profile: 'a&b', workspace: '/repo/<odd>' })
  })

  it('answers nothing for a document it cannot read', () => {
    // Nothing is guessed from a half-written or foreign unit: the caller then
    // falls back deliberately rather than silently moving the service.
    expect(readInstalledService('not a unit file', 'darwin')).toEqual({})
    expect(readInstalledService('[Service]\nExecStart=/bin/true\n', 'linux')).toEqual({})
  })
})

describe('never downgrading a profile', () => {
  it('reads the version a profile has installed', () => {
    // Absent for a profile that has no plugin yet, which is the ordinary
    // first-run state rather than a fault.
    expect(installedPluginVersion('a-profile-that-does-not-exist')).toBeUndefined()
  })

  it('treats a profile ahead of the CLI as newer', () => {
    // The comparison the guard makes: a bot already running 0.0.6 must not be
    // pushed back to 0.0.5, whose settings shape predates the credential
    // reference — it would run, find no credentials, and ask to be set up again.
    expect(isNewer('0.0.6', ownVersion().replace(/^0\.0\.\d+/, '0.0.5'))).toBe(true)
    expect(isNewer('0.0.5', '0.0.6')).toBe(false)
  })
})
