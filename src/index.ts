/**
 * Lark/Feishu IM bot channel for DeepSeek Harness: each chat drives its own
 * agent, committed assistant output returns as chat messages, and approval
 * questions become interactive cards.
 * @module dsh-lark-channel
 */

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'lark-channel'

/** Services that must exist before the plugin is applied. */
export const inject: string[] = ['agents']

export { Config } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { apply } from './runtime.ts'
export type { ChannelConfig } from './runtime.ts'
export type { ChannelPort } from './bridge.ts'
export type { LarkCredentials, RegisterAppPort } from './onboarding.ts'
