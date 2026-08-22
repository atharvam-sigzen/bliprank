/**
 * Collection heartbeat — the "has collection gone dark?" alarm.
 *
 * WHY: both transports fail CLOSED, which is correct and is exactly what makes
 * this necessary. If Upstash's real signing key shape differs from ours, every
 * QStash delivery 401s: nothing spends, nothing is corrupted, and nothing
 * collects — silently, because a 401 is an unremarkable line in a log. Same for
 * an expired R2 credential, a paused schedule, or a provider that starts
 * refusing every request. The failure modes we designed for all look identical
 * from the outside: quiet.
 *
 * So the alarm is on the ABSENCE of success, not the presence of errors. An
 * error-rate alert cannot see a queue that stopped being delivered; only "when
 * did a cell last land?" can.
 *
 * Deliberately not a counter of failures. Counting failures tells you about the
 * requests that arrived; this tells you about the ones that never did.
 */

import type { KV } from './cache-index.js'

export type CollectionHealth = 'healthy' | 'stale' | 'dark' | 'never-collected'

export interface HeartbeatStatus {
  readonly health: CollectionHealth
  /** ISO timestamp of the last successful collection, or null if there has never been one. */
  readonly lastCollectedAt: string | null
  readonly hoursSince: number | null
  /** Cells collected in the current window, for context in the alert. */
  readonly collectedInWindow: number
  readonly message: string
  /** True when someone should be woken up. */
  readonly shouldAlert: boolean
}

export interface HeartbeatOptions {
  readonly kv: KV
  readonly keyPrefix?: string
  /** Hours of silence before the state is `stale`. */
  readonly staleAfterHours?: number
  /** Hours of silence before the state is `dark` — the page-someone threshold. */
  readonly darkAfterHours?: number
  readonly now?: () => Date
  /**
   * Expected quiet periods. Collection runs on a cycle, not continuously, so a
   * gap between cycles is not an outage. Returns true when silence right now is
   * normal — e.g. a 12-hour window that has not opened yet.
   */
  readonly isExpectedQuiet?: (now: Date) => boolean
  readonly ttlSec?: number
}

const HOUR_MS = 3_600_000

/**
 * Records successes and reports how long it has been since the last one.
 *
 * Two keys, both cheap: a last-seen timestamp and a rolling count. The write
 * happens on the success path, so it costs one KV op per collected cell and
 * nothing at all when collection is broken — which is the state it exists to
 * detect, and the state in which we least want extra moving parts.
 */
export class CollectionHeartbeat {
  private readonly prefix: string
  private readonly now: () => Date
  private readonly staleAfter: number
  private readonly darkAfter: number
  private readonly ttl: number

  constructor(private readonly o: HeartbeatOptions) {
    this.prefix = o.keyPrefix ?? 'heartbeat:collection'
    this.now = o.now ?? (() => new Date())
    this.staleAfter = o.staleAfterHours ?? 6
    this.darkAfter = o.darkAfterHours ?? 24
    this.ttl = o.ttlSec ?? 30 * 86_400
    if (this.staleAfter > this.darkAfter) {
      throw new RangeError(`staleAfterHours (${this.staleAfter}) must not exceed darkAfterHours (${this.darkAfter})`)
    }
  }

  private get lastKey(): string {
    return `${this.prefix}:last`
  }
  private countKey(day: string): string {
    return `${this.prefix}:count:${day}`
  }

  /** Call on every genuinely collected cell. Not on a cache hit: a cache hit
   *  proves the cache works, not that collection does. */
  async recordCollected(cells = 1): Promise<void> {
    const now = this.now()
    const day = now.toISOString().slice(0, 10)
    // Concurrent, not sequential: two ops per collected cell is ~6.8M extra
    // round-trips/month at target scale (~$14/mo — immaterial in money, but
    // there is no reason to pay the latency serially).
    await Promise.all([
      this.o.kv.set(this.lastKey, now.toISOString(), { ttlSec: this.ttl }),
      this.o.kv.incrByFloat(this.countKey(day), cells, { ttlSec: this.ttl }),
    ])
  }

  async status(): Promise<HeartbeatStatus> {
    const now = this.now()
    const day = now.toISOString().slice(0, 10)
    const [lastRaw, countRaw] = await this.o.kv.mget([this.lastKey, this.countKey(day)])
    const collectedInWindow = Number(countRaw ?? 0)

    if (!lastRaw) {
      return {
        health: 'never-collected',
        lastCollectedAt: null,
        hoursSince: null,
        collectedInWindow,
        // Not an alert: a fresh deployment has never collected, and paging on
        // that would train everyone to ignore this alarm on day one.
        shouldAlert: false,
        message: 'no cell has ever been collected through this heartbeat — expected on a new deployment, an outage on an established one',
      }
    }

    const hoursSince = (now.getTime() - Date.parse(lastRaw)) / HOUR_MS
    const quiet = this.o.isExpectedQuiet?.(now) ?? false

    if (hoursSince >= this.darkAfter) {
      return {
        health: 'dark',
        lastCollectedAt: lastRaw,
        hoursSince,
        collectedInWindow,
        shouldAlert: true,
        message:
          `collection is DARK: nothing collected for ${hoursSince.toFixed(1)}h (last ${lastRaw}). ` +
          `Both transports fail closed, so check for silent refusals first — QStash signature verification, an expired R2 credential, a paused schedule, or a provider rejecting every request.`,
      }
    }

    if (hoursSince >= this.staleAfter) {
      return {
        health: 'stale',
        lastCollectedAt: lastRaw,
        hoursSince,
        collectedInWindow,
        // A scheduled gap is not an outage. Suppressing here rather than
        // widening the threshold keeps the dark alarm sharp.
        shouldAlert: !quiet,
        message: quiet
          ? `no collection for ${hoursSince.toFixed(1)}h, but the current period is a scheduled quiet window`
          : `collection is STALE: nothing collected for ${hoursSince.toFixed(1)}h (last ${lastRaw})`,
      }
    }

    return {
      health: 'healthy',
      lastCollectedAt: lastRaw,
      hoursSince,
      collectedInWindow,
      shouldAlert: false,
      message: `last collected ${hoursSince.toFixed(1)}h ago; ${collectedInWindow} cells today`,
    }
  }
}
