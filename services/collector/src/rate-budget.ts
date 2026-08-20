/**
 * Rate-limit budget manager — PHASES.md 1.6, ARCHITECTURE §4.
 *
 * HUMAN-OWNED (CLAUDE.md §4: rate-limit logic). The interface is the point:
 * the P0–P3 runner uses the in-process implementation below; the P5 Hetzner
 * fleet swaps in an implementation where each worker holds a static slice of
 * the same budget. Callers depend on `RateBudget` only, so the migration is a
 * swap, not a rewrite (ADR-0002).
 *
 * Model: one bucket per provider API (e.g. `openwebninja:chatgpt`), each with
 * a sustained rps, a burst allowance, one or more API-key shards (the provider
 * limit is per key — sharding multiplies throughput), and an optional UTC
 * collection window outside which acquisition simply waits.
 */

export interface WindowConfig {
  /** Hour of day, UTC, when the collection window opens (0–23). */
  readonly utcStartHour: number
  /** Window length in hours (1–24; 24 = always open). */
  readonly hours: number
}

export interface BucketConfig {
  /** Sustained requests per second per key shard. */
  readonly rps: number
  /** Extra requests permitted immediately after idle, per key shard. */
  readonly burst: number
  /** API-key shard ids. One entry = one provider key. Default: one anonymous shard. */
  readonly keys?: readonly string[]
  readonly window?: WindowConfig
}

export interface Acquisition {
  /** Which key shard the caller must use for this request (null for the anonymous shard). */
  readonly key: string | null
  /** How long the acquisition waited, for observability. */
  readonly waitedMs: number
}

export interface BucketState {
  readonly rps: number
  readonly burst: number
  readonly keys: number
  /** Whole-bucket sustained ceiling (rps × keys). */
  readonly totalRps: number
  readonly windowOpen: boolean
}

/** What the collector depends on. Implementations: LocalRateBudget (P0–P3); a static-slice fleet version at P5. */
export interface RateBudget {
  /** Resolve when one request slot in `bucket` is available. Honours `signal`. */
  acquire(bucket: string, signal?: AbortSignal): Promise<Acquisition>
  state(bucket: string): BucketState
  /**
   * Feed a provider-observed rate-limit back into the bucket: drain a shard's
   * tokens for `ms` so sibling workers slow down too, not just the job that was
   * throttled. `key` targets one shard (a suspended key); omitted drains all.
   * The P5 fleet implements this locally against its own slice — no interface
   * break, which is the point (ADR-0002).
   */
  penalize(bucket: string, ms: number, key?: string | null): void
}

interface Shard {
  key: string | null
  /** Continuous token bucket: tokens at `at` (ms epoch). */
  tokens: number
  at: number
}

export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(t)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
}

function abortError(): Error {
  const e = new Error('acquisition aborted')
  e.name = 'AbortError'
  return e
}

/** ms until the window is open at `now`; 0 when already open. */
export function msUntilWindowOpen(w: WindowConfig | undefined, nowMs: number): number {
  if (!w || w.hours >= 24) return 0
  const DAY = 86_400_000
  const startToday = Math.floor(nowMs / DAY) * DAY + w.utcStartHour * 3_600_000
  const end = startToday + w.hours * 3_600_000
  if (nowMs >= startToday && nowMs < end) return 0
  if (nowMs < startToday) return startToday - nowMs
  return startToday + DAY - nowMs
}

export class LocalRateBudget implements RateBudget {
  private readonly buckets = new Map<string, { cfg: BucketConfig; shards: Shard[]; rr: number }>()

  constructor(
    buckets: Record<string, BucketConfig>,
    private readonly clock: Clock = realClock,
  ) {
    for (const [name, cfg] of Object.entries(buckets)) {
      if (!(cfg.rps > 0)) throw new RangeError(`bucket ${name}: rps must be > 0`)
      if (!(cfg.burst >= 1)) throw new RangeError(`bucket ${name}: burst must be >= 1`)
      const keys = cfg.keys?.length ? [...cfg.keys] : [null]
      const now = this.clock.now()
      this.buckets.set(name, {
        cfg,
        shards: keys.map((key) => ({ key, tokens: cfg.burst, at: now })),
        rr: 0,
      })
    }
  }

  state(bucket: string): BucketState {
    const b = this.mustGet(bucket)
    return {
      rps: b.cfg.rps,
      burst: b.cfg.burst,
      keys: b.shards.length,
      totalRps: b.cfg.rps * b.shards.length,
      windowOpen: msUntilWindowOpen(b.cfg.window, this.clock.now()) === 0,
    }
  }

  async acquire(bucket: string, signal?: AbortSignal): Promise<Acquisition> {
    const b = this.mustGet(bucket)
    const started = this.clock.now()
    for (;;) {
      if (signal?.aborted) throw abortError()
      const now = this.clock.now()
      const windowWait = msUntilWindowOpen(b.cfg.window, now)
      if (windowWait > 0) {
        await this.clock.sleep(windowWait, signal)
        continue
      }
      // Refill all shards to `now`, then take from the fullest (round-robin on ties
      // via a rotating start index so shards share load evenly).
      let best: Shard | null = null
      for (let i = 0; i < b.shards.length; i++) {
        const s = b.shards[(i + b.rr) % b.shards.length]!
        s.tokens = Math.min(b.cfg.burst, s.tokens + (Math.max(0, now - s.at) / 1000) * b.cfg.rps)
        s.at = now
        if (!best || s.tokens > best.tokens) best = s
      }
      b.rr = (b.rr + 1) % b.shards.length
      if (best!.tokens >= 1) {
        best!.tokens -= 1
        return { key: best!.key, waitedMs: this.clock.now() - started }
      }
      // Not enough anywhere: wait until the fullest shard has one whole token.
      const deficit = 1 - best!.tokens
      await this.clock.sleep(Math.max(1, Math.ceil((deficit / b.cfg.rps) * 1000)), signal)
    }
  }

  penalize(bucket: string, ms: number, key?: string | null): void {
    const b = this.mustGet(bucket)
    const now = this.clock.now()
    // Zero the shard and push its refill clock forward by `ms`: it earns no
    // tokens until the penalty elapses.
    for (const s of b.shards) {
      if (key !== undefined && s.key !== key) continue
      s.tokens = 0
      s.at = now + Math.max(0, ms)
    }
  }

  private mustGet(bucket: string) {
    const b = this.buckets.get(bucket)
    if (!b) throw new RangeError(`unknown rate bucket: ${bucket}`)
    return b
  }
}
