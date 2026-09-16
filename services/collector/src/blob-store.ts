/**
 * Raw-answer blob store — PHASES.md 1.5, rule R4.
 *
 * Raw payloads live in object storage (Cloudflare R2), never Postgres, batched
 * one object per cell (ADR-0003 R2 object unit). The collection orchestrator
 * writes one blob holding all runs of a cell; Postgres gets only extracted rows.
 *
 * Behind a two-method interface so the orchestrator and its tests don't depend
 * on a live bucket. MemoryBlobStore backs the tests; R2BlobStore is the
 * production impl, speaking R2's S3-compatible REST API with hand-rolled SigV4
 * (see sigv4.ts) and an injectable fetch, so it is exercised offline.
 */

import { signRequest } from './sigv4.js'

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
  /** Injected in tests; defaults to global fetch. */
  readonly fetch?: typeof fetch
  /** Injected in tests; SigV4 signatures are clock-bound. */
  readonly now?: () => Date
  /** Override for a non-default endpoint (tests, or an S3-compatible stand-in). */
  readonly endpoint?: string
}

/**
 * Keys that survive URL parsing unchanged.
 *
 * `new URL()` resolves `.` and `..` segments before a request is ever signed,
 * so such a key would be signed AND sent for a *different* object - the same
 * wrong object both times, which means it succeeds silently rather than
 * failing. For a store whose contents are the audit trail, reading back the
 * wrong object without an error is the worst available outcome, so these keys
 * are refused at the door rather than sanitised into something plausible.
 *
 * Our own keys (`answers/<day>/<engine>/<cellkey>__<adapter>.json`, ADR-0003)
 * can never contain these; the guard exists for whatever writes keys next.
 */
export function assertSafeKey(key: string): void {
  if (key === '') throw new Error('R2 key is empty')
  if (key.startsWith('/')) throw new Error(`R2 key must not start with "/": ${key}`)
  if (key.includes('//')) throw new Error(`R2 key must not contain an empty path segment: ${key}`)
  if (key.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw new Error(`R2 key must not contain a "." or ".." segment (URL parsing would silently resolve it): ${key}`)
  }
  if (/[\x00-\x1f\x7f]/.test(key)) throw new Error(`R2 key contains a control character: ${JSON.stringify(key)}`)
}

/** An R2 response that was not 2xx and not an expected 404. */
export class BlobStoreError extends Error {
  override readonly name = 'BlobStoreError'
  constructor(readonly status: number, readonly op: string, readonly key: string, body: string) {
    super(`R2 ${op} ${key} failed: HTTP ${status} ${body.slice(0, 200)}`)
  }
}

/**
 * Cloudflare R2 over its S3-compatible API, path-style addressing:
 * `https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>`, region `auto`.
 *
 * Construction performs no I/O. No retry loop here on purpose: a blob failure
 * is not a paid provider call, and the caller (the orchestrator) already owns
 * the retry/dead-letter policy - a second one nested inside would multiply
 * attempts invisibly.
 */
export class R2BlobStore implements BlobStore {
  private readonly f: typeof fetch
  private readonly now: () => Date
  private readonly base: string

  constructor(private readonly cfg: R2Config) {
    this.f = cfg.fetch ?? fetch
    this.now = cfg.now ?? (() => new Date())
    this.base = (cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '')
  }

  private url(key: string): string {
    assertSafeKey(key)
    const path = key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
    return `${this.base}/${encodeURIComponent(this.cfg.bucket)}/${path}`
  }

  private async send(method: string, key: string, body?: string): Promise<Response> {
    const url = this.url(key)
    const signed = signRequest(
      {
        method,
        url,
        ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
        signPayloadHeader: true,
      },
      { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, region: 'auto', service: 's3' },
      this.now(),
    )
    const init: RequestInit = { method, headers: signed.headers }
    if (body !== undefined) init.body = body
    return this.f(url, init)
  }

  async has(key: string): Promise<boolean> {
    const res = await this.send('HEAD', key)
    if (res.status === 404) return false
    if (!res.ok) throw new BlobStoreError(res.status, 'HEAD', key, '')
    return true
  }

  async get(key: string): Promise<string | null> {
    const res = await this.send('GET', key)
    if (res.status === 404) return null
    if (!res.ok) throw new BlobStoreError(res.status, 'GET', key, await res.text().catch(() => ''))
    return res.text()
  }

  async put(key: string, body: string): Promise<void> {
    const res = await this.send('PUT', key, body)
    if (!res.ok) throw new BlobStoreError(res.status, 'PUT', key, await res.text().catch(() => ''))
  }
}
