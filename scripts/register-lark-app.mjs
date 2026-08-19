/**
 * Standalone Lark/Feishu app registration via QR scan, for deployments that
 * prefer credentials as environment variables over the plugin's first-boot
 * onboarding (which runs this same flow automatically when appId/appSecret
 * are absent). Prints the QR URL; the scanning user confirms creation in
 * Feishu — the platform's base template already grants the bot capability,
 * message scopes, and event subscription — and the resulting credentials are
 * printed as LARK_APP_ID / LARK_APP_SECRET lines.
 */
import { registerApp } from '@larksuite/channel'

const result = await registerApp({
  source: 'dsh-lark-channel',
  appPreset: {
    name: 'DSH Agent',
    desc: 'DSH 会话机器人',
  },
  onQRCodeReady({ url, expireIn }) {
    console.log(`\n用飞书扫码（或在已登录飞书的浏览器打开）创建应用，${Math.round(expireIn / 60)} 分钟内有效：\n`)
    console.log(`  ${url}\n`)
    console.log('等待扫码确认…')
  },
  onStatusChange({ status }) {
    if (status !== 'polling') console.error(`[register] ${status}`)
  },
})

console.log('\n应用创建成功，把凭证导出为环境变量：\n')
console.log(`  export LARK_APP_ID=${result.client_id}`)
console.log(`  export LARK_APP_SECRET=${result.client_secret}`)
const owner = result.user_info?.open_id
console.log(owner === undefined
  ? '\n扫码流程未返回扫码用户，请把可使用本机器人的 open id 配置到 lark-channel 的 owner/senderAllowlist。'
  : `\n扫码用户（配置为 owner）：${owner}`)
