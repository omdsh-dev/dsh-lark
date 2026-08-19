/**
 * First-boot credential acquisition through the official Lark QR device-code
 * flow (`registerApp`): a scannable code is shown on the console, the scanning
 * user confirms app creation in Feishu (event subscription is configured by
 * that flow), and the resulting credentials are handed back for persistence and
 * connection.
 *
 * A code expires after a window the platform states when it issues one. Nobody
 * scanning inside that window is the ordinary case — an operator installs the
 * plugin, the process starts, and they get to it later — so an expired code is
 * re-issued rather than reported as a failure. Every other rejection stops: a
 * refused authorization or a rejected request needs a human decision, and a new
 * code would not supply one.
 * @module dsh-lark-channel/onboarding
 */

import qrcode from 'qrcode-terminal'
import type { Context } from '@deepseek-ai/cordis'

/** One Lark app credential pair produced by registration or configuration. */
export interface LarkCredentials {
  appId: string
  appSecret: string
}

/** What a completed scan establishes: the credentials, plus who registered them. */
export interface OnboardedApp extends LarkCredentials {
  /**
   * Open id of the user who scanned, reported so an operator who later wants to
   * narrow `senderAllowlist` or `approvers` has it to hand. It authorizes
   * nothing by itself: who may reach the bot is the app's visibility scope.
   */
  registeredBy?: string
}

/** The registration request this plugin sends through {@link RegisterAppPort}. */
export interface RegisterAppRequest {
  /** Caller tag carried on the QR URL as `source/<name>`. */
  source: string
  /**
   * An existing app to authorize instead of creating one, when the deployment
   * configured its id but not its secret. The confirm page asks the user to
   * re-authorize that app explicitly.
   */
  appId?: string
  /** Pre-filled name/description shown on the app-creation page. */
  appPreset?: { name: string; desc: string }
  /** Incremental application-identity scopes for on-demand re-authorization. */
  addons?: {
    scopes: { tenant: string[] }
    events?: { items: { tenant: string[] } }
  }
  /** Aborting withdraws the pending scan. */
  signal: AbortSignal
  /** Called once the QR URL is ready to show. */
  onQRCodeReady(info: { url: string; expireIn: number }): void
}

/**
 * The QR-registration surface the onboarding flow drives. The official
 * `registerApp` from `@larksuite/channel` satisfies it; tests substitute a fake.
 */
export type RegisterAppPort = (
  options: RegisterAppRequest,
) => Promise<{
  client_id: string
  client_secret: string
  /** The scanning user; their open id is this channel's owner by construction. */
  user_info?: { open_id?: string }
}>

/**
 * What the app-creation page is pre-filled with.
 *
 * Everything here rides on the QR URL, so it carries as little as possible: no
 * `addons`, because the platform's own base template already grants the bot
 * capability and the message scopes and event subscription this channel needs —
 * additive increments only lengthened the URL. No `createOnly` either, so
 * selecting an existing app stays available; that page shows the config diff
 * and asks the user to re-authorize explicitly.
 */
const REGISTRATION_PRESET: Pick<RegisterAppRequest, 'source' | 'appPreset'> = {
  source: 'dsh-lark-channel',
  appPreset: {
    name: 'DSH Agent',
    desc: 'DSH 会话机器人',
  },
}

/**
 * The name and description the app-creation page opens with.
 *
 * A named row asks for a named app. Every row filling in the SAME name is how
 * a second bot's QR page ends up looking exactly like the first bot's — two
 * identical `DSH Agent` entries in the console, and a scan that reads as
 * re-registering the bot you already have rather than creating another one.
 * @param instance - the row's instance name, absent for the original row.
 * @returns the registration preset for this row.
 */
function presetFor(instance?: string): Pick<RegisterAppRequest, 'source' | 'appPreset'> {
  if (instance === undefined || instance === '') return REGISTRATION_PRESET
  return {
    source: REGISTRATION_PRESET.source,
    appPreset: {
      name: `DSH Agent (${instance})`,
      desc: `DSH 会话机器人（${instance}）`,
    },
  }
}

/** The rejection code the flow reports when nobody scanned before the code expired. */
const EXPIRED_CODE = 'expired_token'

/**
 * Shortest gap between two issued codes.
 *
 * A code that ran its course already took its full validity window, so this
 * never delays a real re-issue. It bounds the one case that would otherwise
 * spin: a platform that reports a code expired the moment it is issued.
 */
const REISSUE_FLOOR_MS = 60_000

/**
 * The registration flow rejects with a plain `{ code, description }` object,
 * not an `Error` — stringifying one yields `[object Object]`, which is what an
 * operator saw in place of the reason.
 */
interface RegistrationRejection {
  readonly code?: unknown
  readonly description?: unknown
}

/**
 * Read the flow's own rejection code.
 * @param error - the rejection value, of any shape.
 * @returns the code, or undefined for a rejection that carries none.
 */
function rejectionCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const { code } = error as RegistrationRejection
  return typeof code === 'string' ? code : undefined
}

/**
 * Render one rejection as an operator-readable reason.
 * @param error - the rejection value, which is usually neither an `Error` nor a string.
 * @returns the message, the `code: description` pair, or the stringified value.
 */
function rejectionDetail(error: unknown): string {
  if (error instanceof Error) return error.message
  const code = rejectionCode(error)
  if (code === undefined) return String(error)
  const { description } = (error as RegistrationRejection)
  return typeof description === 'string' ? `${code}: ${description}` : code
}

/**
 * Draw one URL as a QR code for the console.
 *
 * Rendered unconditionally rather than only for an interactive terminal: a
 * deployment whose console is a log file is exactly the one whose operator
 * cannot browse the URL on the host, and block characters survive being read
 * back out of that file.
 * @param url - the registration URL to encode.
 * @returns the drawn code, or undefined when it could not be drawn.
 */
async function drawQrCode(url: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    try {
      qrcode.generate(url, { small: true }, (drawn: string) => { resolve(drawn) })
    } catch {
      // Showing the URL alone still completes registration; the drawing is a
      // convenience for whoever has a phone rather than a logged-in browser.
      resolve(undefined)
    }
  })
}

/** Sleep, resolving early when the flow unwinds. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** What {@link beginOnboarding} needs to run and to report. */
export interface OnboardingRun {
  /** Scoped plugin context; owns the abort lifetime and logging. */
  readonly ctx: Context
  /** The QR-registration surface to drive. */
  readonly register: RegisterAppPort
  /** Operator console line (the default profile composes no logger printer). */
  readonly notify: (line: string) => void
  /** Store the credentials durably; resolves false when no store exists. */
  readonly persist: (app: OnboardedApp) => Promise<boolean>
  /** Continue with live credentials (connect the channel). */
  readonly onCredentials: (app: OnboardedApp) => void
  /** An existing app to re-authorize, when the deployment configured an id but no secret. */
  readonly appId?: string | undefined
  /** This row's instance name, which names the app it creates. */
  readonly instance?: string | undefined
  /** Overrides {@link REISSUE_FLOOR_MS}, so a test need not wait out a real one. */
  readonly reissueFloorMs?: number
}

/**
 * Start the QR onboarding flow as a fiber-owned effect. The pending scan is
 * withdrawn on disposal; a completed scan persists first, then hands the
 * credentials to `onCredentials` unless the fiber already unwound. An expired
 * code is replaced by a fresh one for as long as this fiber lives.
 * @param run - the surfaces to drive and the sinks to report through.
 */
export function beginOnboarding(run: OnboardingRun): void {
  const { ctx, register, notify, persist, onCredentials, appId } = run
  const floorMs = run.reissueFloorMs ?? REISSUE_FLOOR_MS
  const announce = (line: string): void => {
    notify(line)
    ctx.logger.info(line)
  }

  ctx.effect(() => {
    const controller = new AbortController()
    const { signal } = controller

    /** Drive one code to a scan, or to the reason it produced none. */
    const issue = async (round: number): Promise<Awaited<ReturnType<RegisterAppPort>>> =>
      register({
        ...presetFor(run.instance),
        ...appId === undefined || appId === '' ? {} : { appId },
        signal,
        onQRCodeReady({ url, expireIn }) {
          const minutes = String(Math.round(expireIn / 60))
          announce(
            round === 0
              ? `lark-channel: 未配置应用凭证。用飞书扫下面的二维码创建应用（或在已登录飞书的浏览器打开链接），${minutes} 分钟内有效：`
              : `lark-channel: 上一个二维码已过期，这是第 ${String(round + 1)} 个，同样 ${minutes} 分钟内有效：`,
          )
          void drawQrCode(url).then((drawn) => {
            if (signal.aborted) return
            // The drawing goes to the console alone: it is 29 lines of block
            // characters, and the logger already carries the URL that identifies
            // this code.
            if (drawn !== undefined) notify(`\n${drawn}`)
            announce(`  ${url}\n`)
          })
        },
      })

    void (async () => {
      for (let round = 0; !signal.aborted; round++) {
        const startedAt = Date.now()
        let result: Awaited<ReturnType<RegisterAppPort>>
        try {
          result = await issue(round)
        } catch (error: unknown) {
          if (signal.aborted) return
          if (rejectionCode(error) !== EXPIRED_CODE) {
            announce(`lark-channel: 应用注册失败：${rejectionDetail(error)}（重启进程可重新发起）`)
            return
          }
          await delay(floorMs - (Date.now() - startedAt), signal)
          continue
        }
        if (signal.aborted) return
        const scanned = result.user_info?.open_id
        const credentials: OnboardedApp = {
          appId: result.client_id,
          appSecret: result.client_secret,
          ...scanned === undefined || scanned === '' ? {} : { registeredBy: scanned },
        }
        const persisted = await persist(credentials).catch((error: unknown) => {
          announce(`lark-channel: 凭证持久化失败：${rejectionDetail(error)}`)
          return false
        })
        if (signal.aborted) return
        announce(persisted
          ? `lark-channel: 应用 ${credentials.appId} 注册成功，密钥已存入凭据存储，设置里只保留引用。`
            + (credentials.registeredBy === undefined
              ? ''
              : ` 注册者：${credentials.registeredBy}（需要收窄时可填入 senderAllowlist / approvers）。`)
          : `lark-channel: 应用 ${credentials.appId} 注册成功，但当前组合没有 settings 存储——`
            + '凭证仅本次进程有效。要跨重启保留，请设置 LARK_APP_ID/LARK_APP_SECRET。')
        onCredentials(credentials)
        return
      }
    })().catch((error: unknown) => {
      if (signal.aborted) return
      announce(`lark-channel: 应用注册失败：${rejectionDetail(error)}（重启进程可重新发起）`)
    })

    return () => { controller.abort() }
  }, 'lark:onboarding')
}
