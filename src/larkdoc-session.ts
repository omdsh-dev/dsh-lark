/**
 * Conversation-local document state shared by inbound reads and document tools.
 * @module dsh-lark-channel/larkdoc-session
 */

/** Trusted landing facts retained for a document this session read successfully. */
export interface ReadLarkDocumentReference {
  /** The exact snapshot path produced by the inbound collector. */
  readonly path: string
  /** The unsanitized document title used to derive sibling snapshot names. */
  readonly title: string
  /** Stable sibling path reserved for the comment-aware XML snapshot. */
  readonly anchorsPath?: string | undefined
  /** Identity fixed by the first successful anchors write. */
  readonly anchorsIdentity?: LarkDocumentFileIdentity | undefined
}

/** Stable filesystem identity used to reject same-size path replacement. */
export interface LarkDocumentFileIdentity {
  readonly device: bigint
  readonly inode: bigint
  /** File generation marker that changes when a filesystem reuses an inode. */
  readonly birthtimeNanoseconds: bigint
}

/** Whether two observations identify the same filesystem object generation. */
export function isSameLarkDocumentFileIdentity(
  left: LarkDocumentFileIdentity,
  right: LarkDocumentFileIdentity,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNanoseconds === right.birthtimeNanoseconds
}

/** Result of reserving the one anchors file a session/document pair may own. */
export interface LarkDocumentAnchorsReservation {
  readonly path: string
  /** True only for the caller that chose and recorded this path. */
  readonly newlyReserved: boolean
  /** Present after the first successfully validated and written file. */
  readonly identity?: LarkDocumentFileIdentity | undefined
}

/** A session-scoped allow-list shared by read, append, and comment operations. */
export class ReadLarkDocumentSessions {
  readonly #bySession = new Map<string, Map<string, ReadLarkDocumentReference | undefined>>()

  /** Record a file token only after its snapshot was committed successfully. */
  remember(sessionId: string, fileToken: string, reference?: ReadLarkDocumentReference): void {
    let read = this.#bySession.get(sessionId)
    if (read === undefined) {
      read = new Map<string, ReadLarkDocumentReference | undefined>()
      this.#bySession.set(sessionId, read)
    }
    // A bare remember remains useful to append-only callers and tests. It must
    // not erase landing facts captured by the collector, because anchor reads
    // need the original message directory rather than a model-supplied path.
    read.set(fileToken, reference ?? read.get(fileToken))
  }

  /** Whether this exact session has read this file token. */
  has(sessionId: string, fileToken: string): boolean {
    return this.#bySession.get(sessionId)?.has(fileToken) === true
  }

  /** Trusted snapshot landing facts, absent for a token remembered without them. */
  reference(sessionId: string, fileToken: string): ReadLarkDocumentReference | undefined {
    return this.#bySession.get(sessionId)?.get(fileToken)
  }

  /**
   * Reserve one stable anchors path without crossing session boundaries.
   * The first caller supplies a safely claimed candidate; every later refresh
   * receives that exact path instead of minting `-2`, `-3`, and so on.
   */
  reserveAnchorsPath(
    sessionId: string,
    fileToken: string,
    candidate: string,
  ): LarkDocumentAnchorsReservation | undefined {
    const read = this.#bySession.get(sessionId)
    const reference = read?.get(fileToken)
    if (read === undefined || reference === undefined) return undefined
    if (reference.anchorsPath !== undefined) {
      return {
        path: reference.anchorsPath,
        newlyReserved: false,
        ...reference.anchorsIdentity === undefined ? {} : { identity: reference.anchorsIdentity },
      }
    }
    read.set(fileToken, { ...reference, anchorsPath: candidate })
    return { path: candidate, newlyReserved: true }
  }

  /** Commit the identity only if this exact reservation still belongs to the document. */
  commitAnchorsIdentity(
    sessionId: string,
    fileToken: string,
    path: string,
    identity: LarkDocumentFileIdentity,
  ): boolean {
    const read = this.#bySession.get(sessionId)
    const reference = read?.get(fileToken)
    if (read === undefined || reference?.anchorsPath !== path) return false
    if (reference.anchorsIdentity !== undefined
      && !isSameLarkDocumentFileIdentity(reference.anchorsIdentity, identity)) return false
    read.set(fileToken, { ...reference, anchorsIdentity: identity })
    return true
  }

  /** Release a first reservation whose exclusive filesystem claim lost a race. */
  releaseAnchorsPath(sessionId: string, fileToken: string, expectedPath: string): void {
    const read = this.#bySession.get(sessionId)
    const reference = read?.get(fileToken)
    if (read === undefined || reference?.anchorsPath !== expectedPath) return
    const { anchorsPath: _anchorsPath, ...withoutAnchorsPath } = reference
    read.set(fileToken, withoutAnchorsPath)
  }

  /** Immutable copy for diagnostics and future tool constraints. */
  tokens(sessionId: string): ReadonlySet<string> {
    return new Set(this.#bySession.get(sessionId)?.keys() ?? [])
  }

  /** Forget what one reset session had read; other conversations are untouched. */
  clear(sessionId: string): void {
    this.#bySession.delete(sessionId)
  }

  /** Release every in-memory session on bridge disposal. */
  clearAll(): void {
    this.#bySession.clear()
  }
}
