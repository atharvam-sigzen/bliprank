/**
 * QStash production runner — PHASES.md 1.1. The always-on replacement for the
 * manual pilot script.
 *
 * Shape: a scheduled QStash cron fans one collection cycle out into one message
 * per cell; QStash delivers each to our HTTP endpoint; the endpoint verifies the
 * signature and hands the cell to `CollectionOrchestrator`. QStash owns delivery
 * and backoff; the orchestrator owns cache-checking, spend and dedupe. Neither
 * duplicates the other.
 *
 * THE SPEND RULE THAT SHAPES THE HANDLER (R3): QStash retries on any non-2xx.
 * A retry re-enters collection and can spend again. So a non-2xx must mean
 * "nothing was spent and trying again is safe", and everything else - including
 * a job that failed after burning its attempts - returns 2xx with the outcome in
 * the body. Returning 500 on an exhausted job would turn one dead cell into a
 * retry loop that bills for every pass. This is the opposite of the usual HTTP
 * instinct and is deliberate.
 */

import type { CacheCell, EngineAdapter } from '@bliprank/contracts'
import type { CollectionOrchestrator, CollectOutcome } from './collect-cell.js'
import type { DeadLetter } from './dead-letter.js'
import { r2KeyFor } from './cache-index.js'
import { verifyQStashRequest } from './qstash-verify.js'

/** One unit of scheduled work: collect this cell to this depth. */
export interface CollectJob {
  /** Envelope version, so an in-flight queue survives a shape change. */
  readonly v: 1
  readonly cell: CacheCell
  /** The raw authored prompt, as sent to the engine (never the normalised form). */
  readonly prompt: string
  readonly runs: number
  /** Resolved against the adapter registry on the worker side. */
  readonly adapterId: string
}

export function isCollectJob(x: unknown): x is CollectJob {
  const j = x as CollectJob | null
  return (
    !!j &&
    j.v === 1 &&
    typeof j.prompt === 'string' &&
    typeof j.adapterId === 'string' &&
    Number.isInteger(j.runs) &&
    j.runs > 0 &&
    !!j.cell &&
    typeof j.cell.key === 'string' &&
    typeof j.cell.engine === 'string'
  )
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export interface QStashConfig {
  readonly token: string
  /** Absolute URL of our collection endpoint. QStash signs this as `sub`. */
  readonly destination: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  /**
   * QStash-side delivery retries. Low on purpose: the handler only returns a
   * retryable status when nothing was spent, so this covers infra blips, not
   * collection failures - the orchestrator already retries those under budget.
   */
  readonly retries?: number
}

export class QStashError extends Error {
  override readonly name = 'QStashError'
  constructor(readonly status: number, body: string) {
    super(`QStash rejected the request: HTTP ${status} ${body.slice(0, 200)}`)
  }
}

export class QStashClient {
  private readonly f: typeof fetch
  private readonly base: string

  constructor(private readonly cfg: QStashConfig) {
    this.f = cfg.fetch ?? fetch
    this.base = (cfg.baseUrl ?? 'https://qstash.upstash.io').replace(/\/$/, '')
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.token}`,
      'content-type': 'application/json',
      'upstash-retries': String(this.cfg.retries ?? 2),
      ...extra,
    }
  }

  /**
   * Enqueue one cell.
   *
   * Deduplicated on the path-qualified cache key (ADR-0003): if a cycle is
   * published twice, or two agency clients share a prompt, QStash collapses the
   * duplicates before they ever reach the orchestrator. The orchestrator's
   * atomic claim is still the real guard - this just stops us paying QStash to
   * deliver messages whose only outcome would be `claimed-elsewhere`.
   */
  async publish(job: CollectJob, opts: { delaySec?: number } = {}): Promise<{ messageId: string }> {
    const url = `${this.base}/v2/publish/${encodeURIComponent(this.cfg.destination)}`
    const res = await this.f(url, {
      method: 'POST',
      headers: this.headers({
        'upstash-deduplication-id': `${r2KeyFor(job.cell, job.adapterId)}:${job.runs}`,
        ...(opts.delaySec ? { 'upstash-delay': `${opts.delaySec}s` } : {}),
      }),
      body: JSON.stringify(job),
    })
    if (!res.ok) throw new QStashError(res.status, await res.text().catch(() => ''))
    const out = (await res.json().catch(() => ({}))) as { messageId?: string }
    return { messageId: out.messageId ?? '' }
  }

  /**
   * Publish a whole cycle. Sequential on purpose: QStash is not the bottleneck
   * (the 15 req/s provider ceiling is), and a burst of parallel publishes buys
   * nothing but a rate-limit response from Upstash.
   */
  async publishCycle(jobs: readonly CollectJob[]): Promise<{ published: number; failed: number }> {
    let published = 0
    let failed = 0
    for (const job of jobs) {
      try {
        await this.publish(job)
        published++
      } catch {
        failed++
      }
    }
    return { published, failed }
  }

  /** Register the recurring cycle. `cron` is standard 5-field UTC. */
  async schedule(cron: string, body: unknown): Promise<{ scheduleId: string }> {
    const url = `${this.base}/v2/schedules/${encodeURIComponent(this.cfg.destination)}`
    const res = await this.f(url, {
      method: 'POST',
      headers: this.headers({ 'upstash-cron': cron }),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new QStashError(res.status, await res.text().catch(() => ''))
    const out = (await res.json().catch(() => ({}))) as { scheduleId?: string }
    return { scheduleId: out.scheduleId ?? '' }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface HandlerDeps {
  readonly orchestrator: CollectionOrchestrator
  /** Resolves an adapter id to an adapter. Unknown id => job is undeliverable. */
  readonly adapters: (id: string) => EngineAdapter | undefined
  readonly deadLetter: DeadLetter
  readonly currentSigningKey: string
  readonly nextSigningKey?: string
  /** The absolute URL QStash delivers to; must match the token's `sub`. */
  readonly url: string
  readonly now?: () => Date
}

export interface IncomingRequest {
  readonly body: string
  readonly signature: string
}

export interface HandlerResponse {
  readonly status: number
  readonly body: { ok: boolean; outcome?: CollectOutcome['status']; providerCalls?: number; error?: string }
}

/**
 * Handle one delivered job. Never throws: every path returns a status, because
 * an unhandled throw becomes a 500 and a 500 becomes a paid retry.
 */
export async function handleCollectJob(req: IncomingRequest, d: HandlerDeps): Promise<HandlerResponse> {
  // 1. Provenance. 401 is safe to retry: nothing was spent.
  try {
    verifyQStashRequest({
      currentSigningKey: d.currentSigningKey,
      ...(d.nextSigningKey ? { nextSigningKey: d.nextSigningKey } : {}),
      url: d.url,
      body: req.body,
      signature: req.signature,
      ...(d.now ? { now: () => d.now!().getTime() } : {}),
    })
  } catch (e) {
    return { status: 401, body: { ok: false, error: (e as Error).message } }
  }

  // 2. Shape. A malformed job will never parse, so 400 - retrying is pointless.
  let job: unknown
  try {
    job = JSON.parse(req.body)
  } catch {
    return { status: 400, body: { ok: false, error: 'body is not JSON' } }
  }
  if (!isCollectJob(job)) return { status: 400, body: { ok: false, error: 'not a v1 collect job' } }

  const adapter = d.adapters(job.adapterId)
  if (!adapter) return { status: 400, body: { ok: false, error: `unknown adapter ${job.adapterId}` } }

  // 3. Collect. The orchestrator enforces R6/R3/R4 and has already retried and
  //    dead-lettered anything transient inside its own budget.
  try {
    const outcome = await d.orchestrator.collectCell({ cell: job.cell, prompt: job.prompt, runs: job.runs, adapter })
    if (outcome.status === 'failed') {
      // Attempts are spent. A QStash retry would spend more for the same result,
      // so this is reported as handled and left in the dead-letter for a human.
      d.deadLetter.record({
        engine: job.cell.engine,
        cellKey: job.cell.key,
        prompt: job.prompt,
        run: -1,
        kind: 'provider',
        message: 'collect job exhausted its attempts',
        attempts: job.runs,
        at: (d.now?.() ?? new Date()).toISOString(),
      })
    }
    return { status: 200, body: { ok: outcome.status !== 'failed', outcome: outcome.status, providerCalls: outcome.providerCalls } }
  } catch (e) {
    // Reached only for a refusal *before* any call - the R3 gate, or a broken
    // dependency. Nothing was spent, so a retry is safe and 503 asks for one.
    return { status: 503, body: { ok: false, error: (e as Error).message } }
  }
}
