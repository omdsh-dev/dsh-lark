/**
 * One-command deployment for a standalone bot. `dsh plugin`, profiles, and unit
 * files are host or operating-system vocabulary, and someone who only wants a
 * chat bot should not have to learn any of it: `start` provisions a dedicated
 * profile, hands it to the platform supervisor, and streams the first run to the
 * terminal so the QR code is scanned where a person is actually looking. Once
 * the scan lands, the command returns and the bot keeps running.
 *
 * Backgrounding from the first moment — rather than running in the foreground
 * and migrating later — is what makes that one command. There is no second step
 * to forget, and the process the operator scanned into is the same one that
 * survives the terminal closing. Where no supervisor exists (Windows, a Linux
 * without systemd), `start` degrades to a foreground run instead of a dead end.
 *
 * The profile stays an ordinary profile rather than a hidden invention. `dsh
 * --profile <name>` keeps working on it, and everything the host documents about
 * composition, settings, and credentials still applies.
 *
 * Unit files carry no model key — that always resolves inside the host through
 * `ctx.credentials` — and no Lark secret either, with one exception: an operator
 * who supplies `LARK_APP_ID`/`LARK_APP_SECRET` through the environment gets them
 * copied into the unit, because a supervisor starts the process with no shell
 * environment and the shipped patch reads exactly those variables. Units are
 * written user-only (0600) for that reason.
 * @module dsh-lark-channel/provision
 */

import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ownVersion } from './version.ts'
import { instanceIdentity, refuseInstanceName } from './instance.ts'

/** Profile created when the operator names none. */
export const DEFAULT_PROFILE = 'lark'

/** Reverse-DNS label shared by the launchd job and the systemd unit. */
export const SERVICE_LABEL = 'dev.omdsh.dsh-lark'

/** Composition row id this plugin owns, and its section name in the settings document. */
export const ROW_ID = 'lark-channel'

/** How long `start` watches for a scan before leaving the operator to it. */
export const ONBOARDING_WATCH_MS = 10 * 60 * 1000

/** Log size past which `start` truncates it, since no supervisor rotates it. */
export const LOG_TRUNCATE_BYTES = 10 * 1024 * 1024

/**
 * pnpm policy a standalone profile needs before its first dependency install.
 *
 * The first four lines mirror the profile template DSH itself writes (see
 * `initProfile` in `@deepseek-ai/dsh-app-boot`); keep them in step when the
 * host changes its own. Because this file is written first, DSH's writer —
 * which only fills in an absent file — never runs on these profiles.
 */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

strictDepBuilds: false

allowBuilds:
  protobufjs: false
`

/** The value pnpm parks under `allowBuilds` for a script nobody has judged yet. */
const PNPM_BUILD_PLACEHOLDER = 'set this to true or false'

/** A top-level key line, which is also where any `allowBuilds` block ends. */
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*)\s*:(.*)$/

/** One package's decision inside an `allowBuilds` block. */
const ALLOW_BUILDS_ENTRY = /^(\s+protobufjs\s*:\s*)(.*)$/

/** What the operator asked for, after argument parsing. */
export type Command =
  | { readonly kind: 'start'; readonly profile: string; readonly workspace: string }
  | { readonly kind: 'add' | 'remove'; readonly profile?: string; readonly name: string }
  | { readonly kind: 'upgrade'; readonly profile?: string; readonly workspace?: string }
  | { readonly kind: 'stop' | 'restart' | 'status' }
  | { readonly kind: 'logs'; readonly follow: boolean }
  | { readonly kind: 'help' }

/** App credentials the operator supplied through the environment. */
export interface EnvCredentials {
  readonly appId: string
  readonly appSecret: string
}

/** Everything a unit file needs, resolved once so both writers agree. */
export interface ServiceSpec {
  /** Absolute path to `dsh`: a supervisor inherits no PATH worth trusting. */
  readonly dsh: string
  /** Profile to boot. */
  readonly profile: string
  /** Directory the host treats as the default workspace root. */
  readonly workspace: string
  /** `$DSH_HOME` when the operator set one, so the service reads the same home. */
  readonly dshHome?: string | undefined
  /** Environment-supplied app credentials, forwarded so the service sees them too. */
  readonly credentials?: EnvCredentials | undefined
}

/** Usage text, printed for `help`. */
/**
 * How to spell this command back to the person running it.
 *
 * Run through `npx`, the binary lives in a throwaway cache and no bare
 * `dsh-lark-channel` exists on the PATH — so telling that person to run one is
 * telling them to run something that does not work. Told the form they
 * actually used, both kinds of user can copy what they read.
 *
 * The alternative — installing ourselves globally so the bare name always
 * works — is a machine-wide change nobody asked for, with its own permission
 * and version-manager failures, made in service of a shorter string.
 * @param scriptPath - the running script; defaults to this process's.
 * @returns the command prefix to print.
 */
export function invocation(scriptPath: string = process.argv[1] ?? ''): string {
  return scriptPath.includes(`${sep}_npx${sep}`) ? 'npx dsh-lark-channel@latest' : 'dsh-lark-channel'
}

/** Usage text, spelled for the way this process was started. */
export function usage(self: string = invocation()): string {
  return USAGE.replaceAll('dsh-lark-channel ', `${self} `)
}

const USAGE = `dsh-lark-channel — Lark/Feishu IM bot channel for DeepSeek Harness

  dsh-lark-channel start [--profile <name>] [--workspace <dir>]
      Provision a profile, run it in the background under launchd or
      systemd --user, and show the first-run QR code here until it is
      scanned. Re-running start applies updates by restarting the bot.

  dsh-lark-channel add <name>
      Add another bot: writes its row, restarts, and shows its QR code here
      until it is scanned. The new bot keeps its own settings, credential,
      and sessions, so two bots in one group never share an agent.

  dsh-lark-channel remove <name>
      Take that bot out again. Its credential and settings stay, so adding
      the same name back reaches the same bot.

  dsh-lark-channel upgrade
      Install the newest CLI globally and restart the bot on it. Through
      npx there is nothing to install: start already runs the newest.

  dsh-lark-channel stop        Stop the bot and remove it from the supervisor;
                               the profile and its credentials stay.
  dsh-lark-channel restart     Restart the running bot.
  dsh-lark-channel status      Report what the supervisor is running.
  dsh-lark-channel logs [-f]   Print the bot's recent console output; -f follows.

Options
  --profile <name>    Profile to create and boot. Default: ${DEFAULT_PROFILE}
  --workspace <dir>   Workspace root handed to the host. Default: the current directory

Where neither launchd nor systemd exists, start runs in the foreground instead.
`

// Provisioning pins the plugin to the CLI's own version, so the profile gets
// the build that matches the command the operator just ran.
export { ownVersion }

/**
 * Parse argv into one command, defaulting a bare invocation to `start` so
 * `npx dsh-lark-channel` on its own does the useful thing.
 * @param argv - arguments after the node executable and the script path.
 * @returns the parsed command.
 * @throws when a verb or flag is unknown, or a flag's value is missing.
 */
export function parseArguments(argv: readonly string[]): Command {
  const verb = argv[0]
  if (verb === 'help' || verb === '--help' || verb === '-h') return { kind: 'help' }
  if (verb === 'upgrade') {
    const rest = argv.slice(1)
    // Absent means "whatever is installed", resolved when the command runs.
    let profile: string | undefined
    let workspace: string | undefined
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index]
      const value = rest[index + 1]
      if (flag === '--profile') {
        if (value === undefined) throw new Error('--profile needs a name')
        profile = value
        index += 1
      } else if (flag === '--workspace') {
        if (value === undefined) throw new Error('--workspace needs a directory')
        workspace = resolve(value)
        index += 1
      } else if (flag !== undefined) {
        throw new Error(`unknown option ${flag}`)
      }
    }
    return {
      kind: 'upgrade',
      ...profile === undefined ? {} : { profile },
      ...workspace === undefined ? {} : { workspace },
    }
  }
  if (verb === 'stop' || verb === 'restart' || verb === 'status') {
    if (argv.length > 1) throw new Error(`${verb} takes no options`)
    return { kind: verb }
  }
  if (verb === 'add' || verb === 'remove') {
    const rest = argv.slice(1)
    let profile: string | undefined
    const names: string[] = []
    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index]
      if (argument === '--profile') {
        const value = rest[index + 1]
        if (value === undefined) throw new Error('--profile needs a name')
        profile = value
        index += 1
      } else if (argument !== undefined && argument.startsWith('-')) {
        throw new Error(`unknown option ${argument}`)
      } else if (argument !== undefined) {
        names.push(argument)
      }
    }
    const name = names[0]
    if (name === undefined || names.length > 1) throw new Error(`${verb} takes one bot name, e.g. \`${invocation()} ${verb} support\``)
    return { kind: verb, name, ...profile === undefined ? {} : { profile } }
  }
  if (verb === 'logs') {
    const follow = argv[1] === '-f' || argv[1] === '--follow'
    if (argv.length > (follow ? 2 : 1)) throw new Error('logs takes only -f')
    return { kind: 'logs', follow }
  }
  if (verb !== undefined && verb !== 'start' && !verb.startsWith('-')) {
    throw new Error(`unknown command ${verb}`)
  }

  const options = verb === 'start' ? argv.slice(1) : argv
  let profile = DEFAULT_PROFILE
  let workspace = process.cwd()
  for (let index = 0; index < options.length; index += 1) {
    const flag = options[index]
    const value = options[index + 1]
    if (flag === '--profile') {
      if (value === undefined) throw new Error('--profile needs a name')
      profile = value
      index += 1
    } else if (flag === '--workspace') {
      if (value === undefined) throw new Error('--workspace needs a directory')
      workspace = resolve(value)
      index += 1
    } else {
      throw new Error(`unknown option ${String(flag)}`)
    }
  }
  return { kind: 'start', profile, workspace }
}

/**
 * Locate an executable on PATH without shelling out, so the answer is an
 * absolute path a supervisor can use.
 * @param name - executable name, without a platform extension.
 * @param path - PATH to search; defaults to this process's.
 * @returns the absolute path, or undefined when no entry holds that executable.
 */
export function whichSync(name: string, path = process.env.PATH ?? ''): string | undefined {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined
}

/**
 * Which supervisor this system offers, when it offers one. Linux is only
 * supervised when systemctl exists: a WSL or container without systemd should
 * degrade to a foreground run, not fail on a missing binary.
 * @param platform - platform to answer for; defaults to this process's.
 * @returns the supervisor kind, or undefined when the system has none.
 */
export function supervisorKind(platform: NodeJS.Platform = process.platform): 'launchd' | 'systemd' | undefined {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'linux' && whichSync('systemctl') !== undefined) return 'systemd'
  return undefined
}

/** The harness home the supervised process will read. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Where a supervised run writes its console output. */
export function logPath(): string {
  return join(homedir(), '.dsh-lark-channel.log')
}

/** Absolute path of the unit file this platform uses. */
export function unitPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    : join(homedir(), '.config', 'systemd', 'user', 'dsh-lark.service')
}

/**
 * Whether the settings document already carries this plugin's section, which is
 * where a completed scan persists its credentials. A top-level key is enough to
 * decide, so no YAML parser — and no dependency on one — is needed.
 * @param document - contents of the settings document.
 * @returns true when the section is present.
 */
export function hasCredentialSection(document: string, namespace: string = ROW_ID): boolean {
  return new RegExp(`^${namespace}\\s*:`, 'm').test(document)
}

/**
 * App credentials from the environment, when the operator supplied a complete
 * pair. These must reach the unit file: the CLI seeing them proves nothing
 * about the supervised process, which inherits no shell environment.
 * @param environment - environment to read; defaults to this process's.
 * @returns the pair, or undefined when either half is missing or empty.
 */
export function envCredentials(environment: NodeJS.ProcessEnv = process.env): EnvCredentials | undefined {
  const { LARK_APP_ID: appId, LARK_APP_SECRET: appSecret } = environment
  if (appId === undefined || appId === '' || appSecret === undefined || appSecret === '') return undefined
  return { appId, appSecret }
}

/**
 * Whether a scan is still needed: credentials exist in the environment (the
 * unit forwards them) or a previous scan persisted them through the host
 * settings service.
 * @returns true when the bot already has credentials to connect with.
 */
export function isOnboarded(instance?: string): boolean {
  // The environment pair belongs to the unnamed row; a named one has its own
  // credential and its own settings section, so it is never onboarded by it.
  if (instance === undefined && envCredentials() !== undefined) return true
  try {
    const document = readFileSync(join(dshHome(), 'settings.yaml'), 'utf8')
    return hasCredentialSection(document, instanceIdentity(instance).settingsNamespace)
  } catch {
    return false
  }
}

/**
 * PATH for the supervised process. A supervisor starts it with a stunted PATH,
 * and two things break on that: `dsh` is a `#!/usr/bin/env node` script, so a
 * PATH without its interpreter crash-loops the service before it prints
 * anything; and the agent this bot drives runs shell commands, which expect the
 * tools the operator has. So the interpreter's directory and `dsh`'s own lead,
 * and the PATH in force at install time follows — a snapshot of the environment
 * the operator would have started it in by hand.
 * @param dsh - absolute path to the `dsh` executable.
 * @param execPath - the interpreter running this CLI.
 * @param inherited - PATH to append; defaults to this process's.
 * @returns a PATH value for the unit file.
 */
export function servicePath(dsh: string, execPath = process.execPath, inherited = process.env.PATH ?? ''): string {
  const entries = [dirname(dsh), dirname(execPath), ...inherited.split(delimiter), '/usr/bin', '/bin']
  return [...new Set(entries.filter((entry) => entry !== ''))].join(delimiter)
}

/** Environment every unit sets, in a stable order so a rewrite is a no-op. */
function serviceEnvironment(spec: ServiceSpec): ReadonlyArray<readonly [string, string]> {
  const variables: Array<readonly [string, string]> = [['PATH', servicePath(spec.dsh)]]
  if (spec.dshHome !== undefined) variables.push(['DSH_HOME', spec.dshHome])
  if (spec.credentials !== undefined) {
    variables.push(['LARK_APP_ID', spec.credentials.appId], ['LARK_APP_SECRET', spec.credentials.appSecret])
  }
  return variables
}

/** Escape a value for a plist text node, where a bare `&` or `<` breaks the XML. */
function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Quote a value for a systemd unit. `Environment=` takes a space-separated list
 * of assignments — a PATH with a space in it (Visual Studio Code's directory,
 * routinely) shears apart without this — and `ExecStart` tokenizes the same way.
 */
function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * launchd job description for one profile.
 * @param spec - the resolved service description.
 * @returns plist XML.
 */
export function launchdPlist(spec: ServiceSpec): string {
  const pairs = serviceEnvironment(spec)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(spec.dsh)}</string>
    <string>--profile</string>
    <string>${xmlEscape(spec.profile)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(spec.workspace)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${pairs}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath())}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath())}</string>
</dict>
</plist>
`
}

/**
 * systemd user unit for one profile. Output goes to the same file launchd
 * uses, not the journal: `start` relays that file to the terminal for the
 * first-run QR code, and `logs` reads it, so the journal swallowing stdout
 * would break both.
 * @param spec - the resolved service description.
 * @returns unit file contents.
 */
export function systemdUnit(spec: ServiceSpec): string {
  const environment = serviceEnvironment(spec)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}\n`)
    .join('')
  return `[Unit]
Description=dsh-lark-channel (profile ${spec.profile})
After=network-online.target

[Service]
ExecStart=${systemdQuote(spec.dsh)} --profile ${systemdQuote(spec.profile)}
WorkingDirectory=${spec.workspace}
${environment}StandardOutput=append:${logPath()}
StandardError=append:${logPath()}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

/** Run one command with the operator watching, and fail the CLI when it fails. */
function must(argv: readonly string[], cwd?: string): void {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('empty command')
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? 'by signal'}`)
}

/** Run one command with the operator watching and report its exit code instead of throwing. */
function passthrough(argv: readonly string[], cwd?: string): number {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('empty command')
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

/** Run one command and swallow both its output and its failure. */
function quiet(argv: readonly string[]): void {
  const [command, ...args] = argv
  if (command !== undefined) spawnSync(command, args, { stdio: 'ignore' })
}

/** The launchd domain target for the invoking user. */
function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`
}

/** The supervisor, for commands that manage one and cannot degrade. */
function requireSupervisor(): 'launchd' | 'systemd' {
  const kind = supervisorKind()
  if (kind === undefined) {
    throw new Error(`no launchd or systemd on this system — the bot runs in the foreground via \`${invocation()} start\``)
  }
  return kind
}

/**
 * The `dsh` a unit file can name. npx would be wrong even for the foreground
 * fallback: provisioning and the unit must agree on one executable that exists
 * offline at boot.
 * @returns the absolute path to `dsh`.
 * @throws when PATH holds none, naming the install command that fixes it.
 */
function requireDsh(): string {
  const found = whichSync('dsh')
  if (found === undefined) {
    throw new Error('dsh is not on PATH — install it with `npm i -g @deepseek-ai/dsh`, then run this again')
  }
  return found
}

/**
 * Refuse a profile name that would place the workspace file outside the home.
 *
 * This function writes before any `dsh` process runs, so it is the first thing
 * to touch disk for a named profile — ahead of the host's own check. The rule
 * is the host's rule (`resolveProfileDir`), not a stricter one, so a name DSH
 * accepts is never rejected here.
 * @param name - the requested profile name.
 * @returns the refusal to report, or undefined when the name is usable.
 */
function refuseProfileName(name: string): string | undefined {
  const reserved = name === '' || name === '.' || name === '..' || name === 'node_modules'
  return reserved || name.includes('/') || name.includes('\\')
    ? `invalid profile name ${JSON.stringify(name)}`
    : undefined
}

/** The key a top-level line declares, or undefined when the line declares none. */
function topLevelKey(line: string): string | undefined {
  return TOP_LEVEL_KEY.exec(line)?.[1]
}

/** A line's content with any trailing comment removed. */
function withoutComment(text: string): string {
  return text.replace(/#.*$/, '').trim()
}

/**
 * The indentation a block already gives its entries, so an added one lines up.
 * A mapping whose entries disagree on depth is not a document pnpm can read.
 * @param block - the lines between a top-level key and the next one.
 * @returns the existing indentation, or the two spaces a new block takes.
 */
function blockIndent(block: readonly string[]): string {
  for (const line of block) {
    const indent = /^(\s+)[^\s#]/.exec(line)?.[1]
    if (indent !== undefined) return indent
  }
  return '  '
}

/**
 * Turn off the strict gate, unless the operator has already ruled on it.
 *
 * This is the half that survives the next dependency. pnpm 11 defaults
 * `strictDepBuilds` to true, which turns any unapproved build script — in a
 * package nobody here has heard of yet — into a failed install. False returns
 * pnpm to warning and skipping, which is what an unattended bot needs.
 * @param lines - the workspace document, split into lines.
 * @returns the lines, with the setting appended when it was absent.
 */
function settleStrictDepBuilds(lines: readonly string[]): readonly string[] {
  if (lines.some(line => topLevelKey(line) === 'strictDepBuilds')) return lines
  return [...lines, '', 'strictDepBuilds: false']
}

/**
 * Record the protobufjs decision: this build script is skipped on purpose.
 *
 * Its postinstall only prints a notice, so the choice is worth naming rather
 * than leaving to the blanket gate — and an operator who keeps
 * `strictDepBuilds` on needs the named decision to install at all, since only
 * an undecided script trips that gate. Editing is best-effort: an `allowBuilds`
 * block this cannot extend without guessing is left exactly as it is, never
 * duplicated — a second `allowBuilds` key makes the document unparseable and
 * takes the profile down harder than the problem being fixed.
 * {@link settleStrictDepBuilds} keeps the install passing in that case.
 * @param lines - the workspace document, split into lines.
 * @returns the lines, with the decision recorded where that was safe.
 */
function settleProtobufjs(lines: readonly string[]): readonly string[] {
  const start = lines.findIndex(line => topLevelKey(line) === 'allowBuilds')
  if (start === -1) return [...lines, '', 'allowBuilds:', '  protobufjs: false']

  const following = lines.slice(start + 1).findIndex(line => topLevelKey(line) !== undefined)
  const end = following === -1 ? lines.length : start + 1 + following
  const block = lines.slice(start + 1, end)
  const entry = block.findIndex(line => ALLOW_BUILDS_ENTRY.test(line))
  if (entry !== -1) return replacePlaceholder(lines, start + 1 + entry)

  // Named in a spelling this does not edit — quoted, say. Adding an entry
  // beside it would be the duplicate key all over again, one level down.
  if (block.some(line => withoutComment(line).includes('protobufjs'))) return lines

  // A block mapping takes an indented entry; an empty `{}` is emptied into one
  // first, comment kept. Any other shape is left alone.
  const declaration = lines[start] ?? ''
  const value = withoutComment(TOP_LEVEL_KEY.exec(declaration)?.[2] ?? '')
  if (value !== '' && value !== '{}') return lines
  return [
    ...lines.slice(0, start),
    declaration.replace(/:\s*\{\s*\}/, ':'),
    `${blockIndent(block)}protobufjs: false`,
    ...lines.slice(start + 1),
  ]
}

/**
 * Settle the placeholder pnpm parks in a profile it could not finish.
 * @param lines - the workspace document, split into lines.
 * @param index - line holding the protobufjs entry.
 * @returns the lines, with a placeholder resolved and any real choice kept.
 */
function replacePlaceholder(lines: readonly string[], index: number): readonly string[] {
  const parts = ALLOW_BUILDS_ENTRY.exec(lines[index] ?? '')
  const prefix = parts?.[1]
  if (prefix === undefined || withoutComment(parts?.[2] ?? '') !== PNPM_BUILD_PLACEHOLDER) return lines
  return lines.with(index, `${prefix}false`)
}

/**
 * Settle the build-script policy of a workspace document that already exists.
 *
 * Lines are split on either ending and rejoined on `\n`: a CRLF document whose
 * keys went unrecognized would have policy appended a second time, and a second
 * `allowBuilds` key is the unparseable file this exists to avoid.
 * @param document - contents of the profile's `pnpm-workspace.yaml`.
 * @returns the document to write, identical when nothing needed settling.
 */
function settleBuildPolicy(document: string): string {
  const lines = settleProtobufjs(settleStrictDepBuilds(document.trimEnd().split(/\r?\n/)))
  return `${lines.join('\n')}\n`
}

/**
 * Make unapproved dependency build scripts a decided matter before pnpm runs.
 *
 * DSH creates a profile and installs its first plugin in one command. Under
 * pnpm 11 that first install stops at ERR_PNPM_IGNORED_BUILDS — today over
 * protobufjs, tomorrow over whatever a transitive dependency brings with it —
 * after parking a placeholder decision in the profile. So the policy is two
 * halves: `strictDepBuilds: false` so an unapproved script is warned about and
 * skipped rather than fatal, and an explicit protobufjs entry saying this one
 * was considered. Both are written before the first install, and a profile a
 * previous CLI left mid-failure is repaired the same way. An operator's own
 * choice, on either half, is never overwritten.
 * @param profile - profile whose package-manager policy should be ready.
 * @param home - harness home; injectable for tests.
 * @throws {Error} when the profile name would write outside the home.
 */
export function ensureProfileBuildPolicy(profile: string, home: string = dshHome()): void {
  const refusal = refuseProfileName(profile)
  if (refusal !== undefined) throw new Error(refusal)

  const path = join(home, 'profiles', profile, 'pnpm-workspace.yaml')
  const document = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (document === undefined || document.trim() === '') {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, PROFILE_PNPM_WORKSPACE)
    return
  }

  const settled = settleBuildPolicy(document)
  if (settled !== document) writeFileSync(path, settled)
}

/** Create the profile when absent, then install the matching plugin version into it. */
function provision(dsh: string, profile: string, workspace: string): void {
  const installed = installedPluginVersion(profile)
  if (installed !== undefined && isNewer(installed, ownVersion())) {
    throw new Error(
      `profile ${profile} runs ${installed}, newer than this CLI (${ownVersion()}) — `
      + 'upgrade the CLI first (`npm i -g dsh-lark-channel@latest`) rather than downgrading the bot',
    )
  }
  process.stderr.write(`dsh-lark-channel: provisioning profile ${profile}\n`)
  ensureProfileBuildPolicy(profile)
  must([dsh, 'plugin', '--profile', profile, 'add', `dsh-lark-channel@${ownVersion()}`], workspace)
}

/** Whether launchd currently holds the job in this user's domain. */
function isLoaded(): boolean {
  return spawnSync('launchctl', ['print', `${guiDomain()}/${SERVICE_LABEL}`], { stdio: 'ignore' }).status === 0
}

/**
 * Remove the job and wait for it to be gone. `bootout` returns before launchd
 * has finished, and bootstrapping over a job still being torn down fails with a
 * bare I/O error, so replacing a running service has to wait for the removal.
 */
async function bootoutAndWait(): Promise<void> {
  quiet(['launchctl', 'bootout', `${guiDomain()}/${SERVICE_LABEL}`])
  for (let attempt = 0; attempt < 40 && isLoaded(); attempt += 1) await delay(250)
}

/** Write a unit readable by its owner alone, since it may carry forwarded credentials. */
function writeUnit(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  chmodSync(path, 0o600)
}

/**
 * Write and load the platform's unit, replacing any previous one. Both branches
 * end in a restart on purpose: `start` is also the upgrade path, and a service
 * left running would keep executing the version from before the provision.
 */
async function superviseService(kind: 'launchd' | 'systemd', spec: ServiceSpec): Promise<void> {
  const path = unitPath()
  if (kind === 'launchd') {
    writeUnit(path, launchdPlist(spec))
    await bootoutAndWait()
    must(['launchctl', 'bootstrap', guiDomain(), path])
  } else {
    writeUnit(path, systemdUnit(spec))
    must(['systemctl', '--user', 'daemon-reload'])
    must(['systemctl', '--user', 'enable', 'dsh-lark.service'])
    must(['systemctl', '--user', 'restart', 'dsh-lark.service'])
  }
}

/**
 * A systemd user service stops at logout unless the user lingers, and the whole
 * point of supervising a bot is surviving exactly that. Enabling lingering for
 * oneself usually needs no privilege; when it stays off, say so rather than
 * letting the promise break silently at the next logout.
 */
function ensureLinger(): void {
  quiet(['loginctl', 'enable-linger'])
  const user = userInfo().username
  const check = spawnSync('loginctl', ['show-user', user, '--property=Linger', '--value'], { encoding: 'utf8' })
  if (check.status === 0 && check.stdout.trim() === 'no') {
    process.stderr.write(`dsh-lark-channel: lingering is off, so the bot stops when you log out — enable it with \`sudo loginctl enable-linger ${user}\`\n`)
  }
}

/** Byte length of the log, or zero when the supervisor has not written one yet. */
function logSize(): number {
  try {
    return statSync(logPath()).size
  } catch {
    return 0
  }
}

/**
 * Copy any log growth past `offset` to this terminal.
 * @param offset - byte offset the previous relay ended at.
 * @returns the offset the next relay should start at.
 */
/** What a console filter remembers between two chunks of the log. */
export interface ConsoleFilter {
  /** Inside a host-library log block whose remaining lines are noise. */
  suppressing: boolean
  /** A line the previous chunk ended mid-way through. */
  partial: string
}

/** A fresh filter state, for one relay session. */
export function newConsoleFilter(): ConsoleFilter {
  return { suppressing: false, partial: '' }
}

/** A line this plugin wrote: the console stamps every one of them. */
const OWN_LINE = /^\[\d{4}-\d{2}-\d{2} /

/** A line the transport library wrote, which opens a block of its own. */
const LIBRARY_LINE = /^\[(?:info|warn|error|debug|trace)\]/

/**
 * Keep this channel's own console lines and drop the transport library's.
 *
 * A scan is watched by relaying the supervised process's log, and that log
 * carries the Feishu SDK's own chatter — connection notices, a paragraph about
 * developer-console settings — which buried the QR code it was printed to
 * show. The library's blocks span several lines, so suppression runs until the
 * next stamped line rather than to the end of the one that opened it. The log
 * FILE keeps everything: a dropped `[ws]` line is exactly what diagnosing a
 * dead connection needs.
 * @param chunk - newly appended log bytes, decoded.
 * @param state - carried between chunks; mutated.
 * @returns the text worth showing, possibly empty.
 */
export function filterConsole(chunk: string, state: ConsoleFilter): string {
  const text = state.partial + chunk
  const lines = text.split('\n')
  // A chunk rarely ends on a line boundary; the tail waits for its rest.
  state.partial = lines.pop() ?? ''
  const kept: string[] = []
  for (const line of lines) {
    if (LIBRARY_LINE.test(line)) {
      state.suppressing = true
      continue
    }
    if (OWN_LINE.test(line)) state.suppressing = false
    if (!state.suppressing) kept.push(line)
  }
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`
}

async function relayNewOutput(offset: number, filter?: ConsoleFilter): Promise<number> {
  const size = logSize()
  let from = offset
  if (size < from) from = 0 // The log was truncated or replaced.
  if (size === from) return from
  const handle = await open(logPath(), 'r')
  try {
    const buffer = Buffer.alloc(size - from)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    process.stdout.write(filter === undefined ? text : filterConsole(text, filter))
    return from + bytesRead
  } finally {
    await handle.close()
  }
}

/**
 * Relay the supervised process's console to this terminal until it has been
 * onboarded, so the QR code is scanned where a person is looking rather than
 * dug out of a log file.
 * @param from - byte offset to start relaying at, so earlier runs stay hidden.
 * @param deadline - epoch milliseconds after which to stop waiting.
 * @returns true when a scan landed, false when the deadline passed first.
 */
async function relayUntilOnboarded(from: number, deadline: number, instance?: string): Promise<boolean> {
  let offset = from
  // Only this channel's own lines: the QR code was being buried by the
  // transport library's connection chatter.
  const filter = newConsoleFilter()
  while (Date.now() < deadline) {
    offset = await relayNewOutput(offset, filter)
    if (isOnboarded(instance)) {
      // Give the host a beat to print its connected line, then drain it too.
      await delay(750)
      await relayNewOutput(offset, filter)
      return true
    }
    await delay(500)
  }
  return false
}

/** The profile's own patch layer, where a deployment's extra rows live. */
export function patchPath(profile: string): string {
  return join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
}

/** Marks a row this CLI wrote, so `remove` can take back exactly what `add` put. */
const INSTANCE_MARKER = '# dsh-lark-channel bot:'

/**
 * The patch entry one extra bot needs: its own row of this plugin, named.
 * @param name - the instance name.
 * @returns the YAML entry, marker line included.
 */
export function instanceRow(name: string): string {
  return `${INSTANCE_MARKER} ${name}\n`
    + '- insert:\n'
    + `    - id: lark-channel-${name}\n`
    + "      name: 'dsh-lark-channel'\n"
    + '      config:\n'
    + `        instance: ${name}\n`
}

/**
 * Add one bot's row to a patch layer.
 *
 * The empty layer a fresh profile ships is the literal `[]`, which cannot hold
 * a list item — so the first row REPLACES it and every later one appends.
 * @param document - the current patch layer.
 * @param name - the instance name.
 * @returns the layer with the row, or undefined when it already had it.
 */
export function withInstanceRow(document: string, name: string): string | undefined {
  if (document.includes(`${INSTANCE_MARKER} ${name}\n`)) return undefined
  const emptied = document.replace(/^\[\]\s*$/m, '')
  return `${emptied.replace(/\s*$/, '')}\n${emptied.trim() === '' ? '' : '\n'}${instanceRow(name)}`.replace(/^\n/, '')
}

/**
 * Take one bot's row back out, from its marker to the next top-level entry.
 * @param document - the current patch layer.
 * @param name - the instance name.
 * @returns the layer without the row, or undefined when it had no such row.
 */
export function withoutInstanceRow(document: string, name: string): string | undefined {
  const marker = `${INSTANCE_MARKER} ${name}`
  const lines = document.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === marker)
  if (start < 0) return undefined
  // The marker's own entry, then everything indented under it: a line back at
  // column zero belongs to whoever wrote it, not to this row.
  let end = start + 1
  if (lines[end]?.startsWith('- ') === true) {
    end += 1
    while (end < lines.length && (lines[end] === '' || lines[end]?.startsWith(' ') === true)) end += 1
  }
  const remaining = [...lines.slice(0, start), ...lines.slice(end)].join('\n')
  // A layer with nothing left has to say so in YAML, not by being blank.
  const empty = remaining.trimEnd().split('\n')
    .every(line => line.trim() === '' || line.trimStart().startsWith('#'))
  return empty ? `${remaining.trimEnd()}\n[]\n` : remaining
}

/**
 * Add a second (third, …) bot: write its row, restart, and stay attached for
 * the scan, so one command covers everything a new bot needs.
 * @param profile - the profile whose patch layer takes the row.
 * @param name - the instance name.
 */
async function addBot(requested: string | undefined, name: string): Promise<void> {
  const refusal = refuseInstanceName(name)
  if (refusal !== undefined) throw new Error(refusal)
  const profile = requested ?? installedService().profile ?? DEFAULT_PROFILE
  const path = patchPath(profile)
  if (!existsSync(path)) {
    throw new Error(`no profile at ${dirname(path)} — run \`${invocation()} start\` first`)
  }
  // The row about to be written names an `instance`, which only a plugin new
  // enough to have that option understands — an older one rejects the whole
  // row and takes the bot down with it. So the profile is brought to this
  // CLI's exact version FIRST, which is what `start` does for the same reason.
  alignPluginVersion(profile)
  const added = withInstanceRow(readFileSync(path, 'utf8'), name)
  if (added === undefined) process.stderr.write(`dsh-lark-channel: bot ${name} is already configured — restarting to finish it\n`)
  else writeFileSync(path, added)

  const from = logSize()
  await restart()
  if (isOnboarded(name)) {
    process.stderr.write(`dsh-lark-channel: bot ${name} is live — DM it or @-mention it in a group\n`)
    return
  }
  process.stderr.write(`dsh-lark-channel: scan the QR code below in Feishu to create bot ${name}; Ctrl-C leaves it running\n\n`)
  const scanned = await relayUntilOnboarded(from, Date.now() + ONBOARDING_WATCH_MS, name)
  process.stderr.write(scanned
    ? `\ndsh-lark-channel: bot ${name} is live — it has its own settings, credential, and sessions\n`
    : `\ndsh-lark-channel: still waiting for a scan; the bot keeps issuing codes, follow ${logPath()}\n`)
}

/**
 * Take one bot's row back out and restart. Its settings section and credential
 * stay where they are, so adding the same name back reaches the same bot.
 * @param profile - the profile whose patch layer holds the row.
 * @param name - the instance name.
 */
async function removeBot(requested: string | undefined, name: string): Promise<void> {
  const profile = requested ?? installedService().profile ?? DEFAULT_PROFILE
  const path = patchPath(profile)
  if (!existsSync(path)) throw new Error(`no profile at ${dirname(path)}`)
  const removed = withoutInstanceRow(readFileSync(path, 'utf8'), name)
  if (removed === undefined) throw new Error(`no bot named ${name} in ${path}`)
  writeFileSync(path, removed)
  await restart()
  process.stderr.write(`dsh-lark-channel: bot ${name} removed — its credential and settings stay, so adding it back reaches the same bot\n`)
}

/**
 * Bring one profile's plugin to this CLI's exact version.
 *
 * The two have to agree: the CLI writes configuration the plugin then reads,
 * and a profile still on an older build reads it with an older schema. Pinning
 * the exact version rather than a range is what makes "the CLI you just ran"
 * and "the code that will run" the same thing.
 * @param profile - the profile to align.
 */
function alignPluginVersion(profile: string): void {
  const dsh = requireDsh()
  const version = ownVersion()
  const installed = installedPluginVersion(profile)
  if (installed === version) return
  // Never backwards. A profile ahead of this CLI is a profile whose settings
  // may already be written in a shape this build cannot read — the credential
  // reference is exactly that — and installing over it produces a bot that
  // runs, finds no credentials, and quietly asks to be set up again.
  if (installed !== undefined && isNewer(installed, version)) {
    throw new Error(
      `profile ${profile} runs ${installed}, newer than this CLI (${version}) — `
      + 'upgrade the CLI first (`npm i -g dsh-lark-channel@latest`), or pass --profile for another one',
    )
  }
  process.stderr.write(
    installed === undefined
      ? `dsh-lark-channel: installing the plugin ${version} into profile ${profile}\n`
      : `dsh-lark-channel: profile ${profile} has ${installed}; bringing it to ${version}\n`,
  )
  ensureProfileBuildPolicy(profile)
  must([dsh, 'plugin', '--profile', profile, 'add', `dsh-lark-channel@${version}`])
}

/**
 * The plugin version a profile currently has installed.
 * @param profile - the profile to inspect.
 * @returns the version, or undefined when the profile has no plugin yet.
 */
export function installedPluginVersion(profile: string): string | undefined {
  try {
    const manifest = join(dshHome(), 'profiles', profile, 'node_modules', 'dsh-lark-channel', 'package.json')
    const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** What the installed unit says this bot actually runs as. */
export interface InstalledService {
  readonly profile: string
  readonly workspace: string
}

/**
 * Read the profile and workspace out of the unit that is actually installed.
 *
 * Every command that touches a running bot has to act on the bot that is
 * running, not on a default. Guessing the profile from a constant and the
 * workspace from the current directory is how `upgrade` run in /tmp rewrote a
 * `--profile web --workspace /repo` service into `lark` and `/tmp` — the unit
 * file already holds both, so it is the only honest source.
 * @param document - the unit file's contents.
 * @param platform - which unit format to read.
 * @returns what the unit says, or undefined for a field it does not carry.
 */
export function readInstalledService(
  document: string,
  platform: NodeJS.Platform = process.platform,
): Partial<InstalledService> {
  if (platform === 'darwin') {
    const profile = /<string>--profile<\/string>\s*<string>([^<]*)<\/string>/.exec(document)?.[1]
    const workspace = /<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/.exec(document)?.[1]
    return {
      ...profile === undefined ? {} : { profile: xmlUnescape(profile) },
      ...workspace === undefined ? {} : { workspace: xmlUnescape(workspace) },
    }
  }
  // The writer quotes each argument, so the quotes come back off here.
  const profile = /^ExecStart=.*?--profile\s+["']?([^"'\s]+)["']?/m.exec(document)?.[1]
  const workspace = /^WorkingDirectory=(.*)$/m.exec(document)?.[1]
  return {
    ...profile === undefined ? {} : { profile },
    ...workspace === undefined ? {} : { workspace: workspace.trim() },
  }
}

/** Undo the escaping {@link launchdPlist} applies to a value. */
function xmlUnescape(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}

/**
 * What the running bot is, for a command that must not move it.
 * @returns the installed profile and workspace, each absent when unreadable.
 */
export function installedService(): Partial<InstalledService> {
  try {
    return readInstalledService(readFileSync(unitPath(), 'utf8'))
  } catch {
    return {}
  }
}

/** How long a version check may hold up a command before it is abandoned. */
const VERSION_CHECK_MS = 2500

/**
 * The newest published version, or undefined when the check cannot answer.
 *
 * Deliberately toothless: a registry that is slow, offline, or unreachable
 * must cost this command nothing, because every caller is doing something
 * else — starting a bot, reading a log — and a version notice is a courtesy.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the version string, or undefined.
 */
export async function latestVersion(timeoutMs: number = VERSION_CHECK_MS): Promise<string | undefined> {
  try {
    const response = await fetch('https://registry.npmjs.org/dsh-lark-channel/latest', {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) return undefined
    const body = await response.json() as { version?: unknown }
    return typeof body.version === 'string' ? body.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Compare two `major.minor.patch` versions, ignoring anything after them.
 * @param left - the version to judge.
 * @param right - the version to judge it against.
 * @returns true when `left` is strictly newer.
 */
export function isNewer(left: string, right: string): boolean {
  const parts = (version: string): number[] =>
    version.split('-')[0]?.split('.').map(part => Number.parseInt(part, 10) || 0) ?? []
  const [a, b] = [parts(left), parts(right)]
  for (let index = 0; index < 3; index += 1) {
    const [one, two] = [a[index] ?? 0, b[index] ?? 0]
    if (one !== two) return one > two
  }
  return false
}

/**
 * Tell the operator a newer release exists, once, without getting in the way.
 *
 * The trap this exists for is specific to a globally installed CLI: `start`
 * pins the plugin to the CLI's OWN version, so someone who upgrades by
 * re-running `start` alone re-pins the version they already had and sees
 * nothing to tell them so.
 * @param self - how this command spells itself.
 */
async function noteNewerRelease(self: string = invocation()): Promise<void> {
  const latest = await latestVersion()
  if (latest === undefined || !isNewer(latest, ownVersion())) return
  process.stderr.write(
    `dsh-lark-channel: ${latest} is out (running ${ownVersion()}) — upgrade with \`${self} upgrade\`\n`,
  )
}

/**
 * Upgrade the CLI and the plugin together, in one command.
 *
 * Explicitly, never as a side effect: installing globally touches a
 * machine-wide namespace, which is the caller's decision to make. Through
 * npx there is nothing to install — the next `start` already resolves the
 * newest — so it says that instead of pretending to work.
 */
async function upgrade(profile: string | undefined, workspace: string | undefined): Promise<void> {
  // The installed unit is what this bot IS; a default profile and the current
  // directory are what it would silently become.
  const installed = installedService()
  const target = {
    profile: profile ?? installed.profile ?? DEFAULT_PROFILE,
    workspace: workspace ?? installed.workspace ?? process.cwd(),
  }
  if (invocation() !== 'dsh-lark-channel') {
    process.stderr.write(
      'dsh-lark-channel: nothing to upgrade through npx — `npx dsh-lark-channel@latest start`'
      + ' already runs the newest, plugin included\n',
    )
    return
  }
  process.stderr.write('dsh-lark-channel: installing the newest CLI globally\n')
  must(['npm', 'install', '-g', 'dsh-lark-channel@latest'])
  // Re-exec rather than continue: the version that provisions the profile has
  // to be the version just installed, and this process is still the old one.
  process.stderr.write(
    `dsh-lark-channel: restarting the bot on the new version (profile ${target.profile}, workspace ${target.workspace})\n`,
  )
  const code = passthrough(['dsh-lark-channel', 'start', '--profile', target.profile, '--workspace', target.workspace])
  process.exitCode = code
}

/** Provision, supervise, and stay attached for the first-run scan. */
async function start(profile: string, workspace: string): Promise<void> {
  const dsh = requireDsh()
  const kind = supervisorKind()
  provision(dsh, profile, workspace)

  if (kind === undefined) {
    process.stderr.write('dsh-lark-channel: no launchd or systemd here — running in the foreground, keep this terminal open\n')
    process.exitCode = passthrough([dsh, '--profile', profile], workspace)
    return
  }

  const onboarded = isOnboarded()
  if (logSize() > LOG_TRUNCATE_BYTES) writeFileSync(logPath(), '')
  const from = logSize()
  await superviseService(kind, { dsh, profile, workspace, dshHome: process.env.DSH_HOME, credentials: envCredentials() })
  if (kind === 'systemd') ensureLinger()
  process.stderr.write(`dsh-lark-channel: running in the background, logs at ${logPath()}\n`)

  if (onboarded) {
    process.stderr.write('dsh-lark-channel: already onboarded — DM the bot or @-mention it in a group\n')
    // Last, and only for a bot that is already up: a version notice must
    // never stand between someone and their QR code.
    await noteNewerRelease()
    return
  }

  process.stderr.write('dsh-lark-channel: scan the QR code below in Feishu; Ctrl-C leaves the bot running\n\n')
  const scanned = await relayUntilOnboarded(from, Date.now() + ONBOARDING_WATCH_MS)
  process.stderr.write(scanned
    ? '\ndsh-lark-channel: bound — the bot is live; manage it with stop, restart, and status\n'
    : `\ndsh-lark-channel: still waiting for a scan; the bot keeps issuing codes, follow ${logPath()}\n`)
}

/**
 * Stop the bot and remove its unit. Removal is the point: a booted-out launchd
 * job whose plist stays in LaunchAgents comes back at the next login, which
 * would make "stopped" a lie. The profile and its credentials stay, so `start`
 * brings the same bot back.
 */
function stop(): void {
  const kind = requireSupervisor()
  if (kind === 'launchd') quiet(['launchctl', 'bootout', `${guiDomain()}/${SERVICE_LABEL}`])
  else quiet(['systemctl', '--user', 'disable', '--now', 'dsh-lark.service'])
  rmSync(unitPath(), { force: true })
  if (kind === 'systemd') quiet(['systemctl', '--user', 'daemon-reload'])
  process.stderr.write(`dsh-lark-channel: stopped — \`${invocation()} start\` brings it back\n`)
}

/**
 * Restart the supervised process, touching neither the profile nor credentials.
 * `kickstart -k` is launchd's own restart and avoids the unload/load race; it
 * needs a loaded job, so a job that is not running is bootstrapped from its
 * unit instead.
 */
async function restart(): Promise<void> {
  const kind = requireSupervisor()
  if (!existsSync(unitPath())) {
    throw new Error(`nothing is installed — run \`${invocation()} start\` first`)
  }
  if (kind === 'launchd') {
    const kicked = spawnSync('launchctl', ['kickstart', '-k', `${guiDomain()}/${SERVICE_LABEL}`], { stdio: 'ignore' })
    if (kicked.status !== 0) {
      await bootoutAndWait()
      must(['launchctl', 'bootstrap', guiDomain(), unitPath()])
    }
  } else {
    must(['systemctl', '--user', 'restart', 'dsh-lark.service'])
  }
  process.stderr.write('dsh-lark-channel: restarted\n')
}

/**
 * Print the tail of the supervised log — the file both unit writers point the
 * bot's console at — optionally following new output until interrupted.
 * @param follow - keep relaying as the file grows.
 */
async function logs(follow: boolean): Promise<void> {
  if (!existsSync(logPath())) {
    process.stderr.write(`dsh-lark-channel: no log yet at ${logPath()} — has \`${invocation()} start\` run?\n`)
    process.exitCode = 1
    return
  }
  const lines = readFileSync(logPath(), 'utf8').split('\n')
  process.stdout.write(lines.slice(Math.max(0, lines.length - 201)).join('\n'))
  if (!follow) return
  let offset = logSize()
  for (;;) {
    offset = await relayNewOutput(offset)
    await delay(500)
  }
}

/**
 * Report what the supervisor is running, passing its exit code through — a
 * stopped service is information, not a CLI failure.
 */
function status(): void {
  const kind = requireSupervisor()
  if (kind === 'launchd') {
    if (!isLoaded()) {
      process.stderr.write(`dsh-lark-channel: not running — \`${invocation()} start\` brings it up\n`)
      process.exitCode = 3
      return
    }
    process.exitCode = passthrough(['launchctl', 'print', `${guiDomain()}/${SERVICE_LABEL}`])
  } else {
    process.exitCode = passthrough(['systemctl', '--user', 'status', 'dsh-lark.service'])
  }
}

/**
 * Execute one parsed command.
 * @param command - what the operator asked for.
 */
export async function execute(command: Command): Promise<void> {
  if (command.kind === 'help') process.stdout.write(usage())
  else if (command.kind === 'start') await start(command.profile, command.workspace)
  else if (command.kind === 'upgrade') await upgrade(command.profile, command.workspace)
  else if (command.kind === 'add') await addBot(command.profile, command.name)
  else if (command.kind === 'remove') await removeBot(command.profile, command.name)
  else if (command.kind === 'stop') stop()
  else if (command.kind === 'restart') await restart()
  else if (command.kind === 'logs') await logs(command.follow)
  else {
    status()
    await noteNewerRelease()
  }
}

/**
 * Entry point: parse, execute, and turn any failure into a diagnosed nonzero exit.
 * @param argv - arguments after the node executable and the script path.
 */
export async function main(argv: readonly string[]): Promise<void> {
  try {
    await execute(parseArguments(argv))
  } catch (error) {
    process.stderr.write(`dsh-lark-channel: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
