/**
 * Durable generations for document-comment conversations.
 *
 * This mirrors {@link ChatEpochs}: the first generation preserves the legacy
 * session id, while each manual reset advances a small managed value through
 * the host settings scope. LRU release never advances it.
 * @module dsh-lark-channel/document-generation
 */

/** Construction options for {@link DocumentGenerations}. */
export interface DocumentGenerationsOptions {
  /** Canonical document key to serialized generation. */
  readonly entries?: Record<string, string> | undefined
  /** Deep-merge one patch into the plugin settings section. */
  readonly persist?: ((patch: { documentGenerations: Record<string, string> }) => Promise<boolean>) | undefined
  /** Operator-console reporting. */
  readonly report?: ((line: string) => void) | undefined
}

/** Result of advancing one document conversation. */
export interface DocumentGenerationChange {
  readonly generation: number
  readonly durable: boolean
}

/** Managed document reset generations, using the same persistence seam as chat epochs. */
export class DocumentGenerations {
  private readonly entries: Map<string, string>
  private readonly persist: (patch: { documentGenerations: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  private warnedNotDurable = false

  constructor(options: DocumentGenerationsOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}))
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
  }

  /** Read one canonical document's current generation; malformed state safely means zero. */
  generationOf(key: string): number {
    const entry = this.entries.get(key)
    if (entry === undefined || entry === '') return 0
    const parsed = Number.parseInt(entry, 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }

  /** Advance one document and persist the exact deep-merge patch. */
  async startNew(key: string): Promise<DocumentGenerationChange> {
    const generation = this.generationOf(key) + 1
    this.entries.set(key, String(generation))
    const durable = await this.persist({ documentGenerations: { [key]: String(generation) } })
      .catch((error: unknown) => {
        this.report(`lark-channel: persisting the document reset failed: ${String(error)}`)
        return false
      })
    if (!durable && !this.warnedNotDurable) {
      this.warnedNotDurable = true
      this.report('lark-channel: document resets are in-memory only (no settings service); they reset on restart')
    }
    return { generation, durable }
  }
}
