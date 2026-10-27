/**
 * Approval panel copy, owned by this plugin.
 *
 * The panel appears where the shipped approval presentation would, so its
 * wording stays deliberately close to that one: a reader who meets this surface
 * after the ordinary one should recognize it immediately.
 *
 * `decidedElsewhere` names the state the shipped panel cannot reach — a request
 * the log shows another surface already settled. It is deliberately NOT tied to
 * the Lark chat: the same state appears whenever any other surface answered
 * first, including a second browser tab.
 */

/**
 * Question panel copy, owned by this plugin.
 *
 * The panel appears where the shipped question composer would, so its wording
 * stays deliberately close to that one: a reader who meets this surface after
 * the ordinary one should recognize it immediately.
 *
 * `answeredElsewhere` names the state the shipped panel cannot reach — a request
 * the log shows another surface already answered. It is deliberately NOT tied to
 * the Lark chat: the same state appears whenever any other surface answered
 * first, including a second browser tab.
 */

/**
 * Simplified Chinese question dictionary and key-set source of truth.
 *
 * The wizard flow mirrors the shipped question composer, so the key set
 * mirrors that one's `question` namespace (plus `submit`/`submitting` and the
 * Markdown chrome the shipped copy takes from the shared common vocabulary,
 * declared here so this plugin never depends on that vocabulary's contents).
 */
export const zhQuestion = {
  answeredElsewhere: '已在别处作答',
  submit: '提交',
  submitting: '提交中…',
  'error.incomplete': '请先完成这道问题。',
  'error.unanswered': '请选择一个选项或填写自定义答案。',
  'error.unavailable': '当前无法提交，请稍候再试。',
  'error.resubmit': '回答未送达，工作已继续，请再提交一次。',
  'status.sent': '回答已发送；面板未能关闭。',
  'wait.takeTime': '慢慢回答',
  'wait.countdown': '{seconds} 秒后继续工作',
  'wait.paused': '已暂停 · 剩余 {seconds} 秒',
  'wait.held': '会一直等你回答',
  'wait.continued': '已继续工作，仍可回答',
  'review.status': '已回答',
  'review.skipped': '这道问题当时被跳过。',
  'nav.prev': '上一题',
  'nav.next': '下一题',
  'nav.minimize': '收起问题卡片',
  'nav.maximize': '展开问题卡片',
  'nav.cancel': '放弃整组问题',
  'nav.close': '收起问题面板，可从工具调用重新打开',
  'option.recommended': '推荐',
  'custom.placeholder': '输入你的答案',
  'action.skip': '跳过本题',
  'action.next': '下一题',
  copy: '复制',
  copied: '已复制',
  'markdown.footnotes': '脚注',
  'codeBlock.title': '代码块',
  'codeBlock.wrap': '自动换行',
  'codeBlock.unwrap': '取消自动换行',
} satisfies Record<string, string>

/** Lark question panel dictionary key union. */
export type QuestionKey = keyof typeof zhQuestion

/** English question dictionary, checked against the Chinese key set. */
export const enQuestion = {
  answeredElsewhere: 'Answered elsewhere',
  submit: 'Submit',
  submitting: 'Submitting…',
  'error.incomplete': 'Please complete this question first.',
  'error.unanswered': 'Please select an option or enter a custom answer.',
  'error.unavailable': 'Cannot submit right now; try again in a moment.',
  'error.resubmit': 'The answer did not arrive before work continued; submit it again.',
  'status.sent': 'Reply sent; the panel could not close.',
  'wait.takeTime': 'Take time',
  'wait.countdown': 'Continuing in {seconds}s',
  'wait.paused': 'Paused · {seconds}s remaining',
  'wait.held': 'Waiting until you answer',
  'wait.continued': 'Work continued — you can still answer',
  'review.status': 'Answered',
  'review.skipped': 'This question was skipped.',
  'nav.prev': 'Previous question',
  'nav.next': 'Next question',
  'nav.minimize': 'Collapse the question card',
  'nav.maximize': 'Expand the question card',
  'nav.cancel': 'Dismiss all questions',
  'nav.close': 'Close the panel — reopen it from the tool call',
  'option.recommended': 'Recommended',
  'custom.placeholder': 'Type your answer',
  'action.skip': 'Skip this question',
  'action.next': 'Next',
  copy: 'Copy',
  copied: 'Copied',
  'markdown.footnotes': 'Footnotes',
  'codeBlock.title': 'Code block',
  'codeBlock.wrap': 'Wrap lines',
  'codeBlock.unwrap': 'Do not wrap lines',
} satisfies Record<QuestionKey, string>

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  decidedElsewhere: '已在别处决定',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allowOnce: '允许一次',
} satisfies Record<string, string>

/** Lark approval panel dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  decidedElsewhere: 'Decided elsewhere',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
} satisfies Record<ApprovalKey, string>
