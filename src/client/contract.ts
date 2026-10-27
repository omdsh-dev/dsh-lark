/**
 * Declarations this channel's browser half contributes to the shared Client
 * services.
 *
 * The locale namespace is the only one it needs: the panel claims no
 * pending-interaction domain of its own (it renders the request the Client
 * already projects) and retains no Session reference (it borrows the
 * conversation's live binding). Adding a key to a map the owning package
 * documents as consumer-owned is how a plugin joins that service rather than
 * how it changes it.
 * @module dsh-lark-channel/client/contract
 */

// Type-only: loads the module the augmentation below targets, so the merged
// interface is declared against a module TypeScript has actually resolved.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ApprovalKey } from './locales.ts'
import type { QuestionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Lark approval panel's copy. */
    larkApproval: ApprovalKey
    /** The Lark question panel's copy. */
    larkQuestion: QuestionKey
  }
}
