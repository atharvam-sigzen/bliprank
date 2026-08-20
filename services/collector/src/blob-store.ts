/**
 * Raw-answer blob store — PHASES.md 1.5, rule R4.
 *
 * Raw payloads live in object storage (Cloudflare R2), never Postgres, batched
 * one object per cell (ADR-0003 R2 object unit). The collection orchestrator
 * writes one blob holding all runs of a cell; Postgres gets only extracted rows.
 *
 * Behind a two-method interface so the orchestrator and its tests don't depend
 * on a live bucket. MemoryBlobStore backs the tests; R2BlobStore (S3-compatible
 * REST, injected fetch) is the production impl — its wire calls are the P1.5
 * follow-up and are intentionally thin here.
 */

export interface BlobStore {
  /** Whether an object exists at `key` (a cheap HEAD in production). */
  has(key: string): Promise<boolean>
  get(key: string): Promise<string | null>
  /** Write (overwrite) the object. One call per cell — never per answer (R4). */
  put(key: string, body: string): Promise<void>
}

export class MemoryBlobStore implements BlobStore {
  private readonly m = new Map<string, string>()
  async has(key: string): Promise<boolean> {
    return this.m.has(key)
  }
  async get(key: string): Promise<string | null> {
    return this.m.get(key) ?? null
  }
  async put(key: string, body: string): Promise<void> {
    this.m.set(key, body)
  }
  /** Test helper: how many distinct objects exist (batching check — one per cell). */
  get size(): number {
    return this.m.size
  }
}

export interface R2Config {
  readonly accountId: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly fetch?: typeof fetch
}

/**
 * Cloudflare R2 over its S3-compatible API. Construction performs no I/O.
 * ponytail: the SigV4 signing + REST calls are the P1.5 production task; kept a
 * single well-marked stub rather than a half-signed client that looks done.
 */
export class R2BlobStore implements BlobStore {
  constructor(private readonly cfg: R2Config) {}
  private notReady(): never {
    throw new Error('R2BlobStore: S3 REST transport not implemented yet (PHASES 1.5). Use MemoryBlobStore in tests; wire SigV4 before production.')
  }
  async has(_key: string): Promise<boolean> {
    return this.notReady()
  }
  async get(_key: string): Promise<string | null> {
    return this.notReady()
  }
  async put(_key: string, _body: string): Promise<void> {
    return this.notReady()
  }
}
