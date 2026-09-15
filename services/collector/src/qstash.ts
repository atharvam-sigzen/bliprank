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
import type { CollectionHeartbeat } from './collection-heartbeat.js'
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

/** A schedule as `GET /v2/schedules` reports it (the fields this repo reads; QStash sends more). */
export interface QStashSchedule {
  readonly scheduleId: string
  readonly cron: string
  readonly destination: string
  readonly createdAt?: number
  readonly isPaused?: boolean
  readonly body?: string
  readonly retries?: number
  readonly lastScheduleTime?: number
  readonly nextScheduleTime?: number
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
   * Publish one JSON body to the destination. The general form every job on
   * this transport takes: the per-cell runner's `publish` below and the daily
   * fan-out's domain jobs (ADR-0018 D3). `deduplicationId` is QStash's own
   * guard against the same message twice ("The deduplication window is 10
   * minutes"); `timeoutSec` bounds how long QStash waits on the destination
   * before it counts the delivery failed and retries, so a caller sets it to
   * the destination's own maxDuration. A duplicate is accepted by QStash with
   * the existing message's id and `deduplicated: true`.
   */
  async publishJson(body: unknown, opts: { readonly deduplicationId?: string; readonly delaySec?: number; readonly timeoutSec?: number } = {}): Promise<{ messageId: string; deduplicated: boolean }> {
    const url = `${this.base}/v2/publish/${encodeURIComponent(this.cfg.destination)}`
    const res = await this.f(url, {
      method: 'POST',
      headers: this.headers({
        ...(opts.deduplicationId ? { 'upstash-deduplication-id': opts.deduplicationId } : {}),
        ...(opts.delaySec ? { 'upstash-delay': `${opts.delaySec}s` } : {}),
        ...(opts.timeoutSec ? { 'upstash-timeout': `${opts.timeoutSec}s` } : {}),
      }),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new QStashError(res.status, await res.text().catch(() => ''))
    const out = (await res.json().catch(() => ({}))) as { messageId?: string; deduplicated?: boolean }
    return { messageId: out.messageId ?? '', deduplicated: out.deduplicated === true }
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
    const { messageId } = await this.publishJson(job, { deduplicationId: `${r2KeyFor(job.cell, job.adapterId)}:${job.runs}`, ...(opts.delaySec ? { delaySec: opts.delaySec } : {}) })
    return { messageId }
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

  /**
   * Register a recurring publish. `cron` is standard 5-field, evaluated in UTC
   * by QStash unless prefixed `CRON_TZ=<zone>`. A caller-chosen `scheduleId`
   * makes a second registration an UPDATE of the same schedule rather than a
   * second schedule (QStash: "If a schedule with the provided ID exists, the
   * settings of the existing schedule will be updated with the new
   * settings"), which is what lets a deployment have exactly one daily tick
   * (ADR-0018 D8). `retries` overrides the client's default for this
   * schedule's deliveries; `timeoutSec` is the destination's own maxDuration.
   */
  async schedule(cron: string, body: unknown, opts: { readonly scheduleId?: string; readonly retries?: number; readonly timeoutSec?: number } = {}): Promise<{ scheduleId: string }> {
    const url = `${this.base}/v2/schedules/${encodeURIComponent(this.cfg.destination)}`
    const res = await this.f(url, {
      method: 'POST',
      headers: this.headers({
        'upstash-cron': cron,
        ...(opts.scheduleId ? { 'upstash-schedule-id': opts.scheduleId } : {}),
        ...(opts.retries !== undefined ? { 'upstash-retries': String(opts.retries) } : {}),
        ...(opts.timeoutSec ? { 'upstash-timeout': `${opts.timeoutSec}s` } : {}),
      }),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new QStashError(res.status, await res.text().catch(() => ''))
    const out = (await res.json().catch(() => ({}))) as { scheduleId?: string }
    return { scheduleId: out.scheduleId ?? '' }
  }

  /** Every schedule this token holds, as QStash reports them (`GET /v2/schedules`). */
  async listSchedules(): Promise<readonly QStashSchedule[]> {
    const res = await this.f(`${this.base}/v2/schedules`, { method: 'GET', headers: { authorization: `Bearer ${this.cfg.token}` } })
    if (!res.ok) throw new QStashError(res.status, await res.text().catch(() => ''))
    const out = (await res.json().catch(() => [])) as unknown
    return Array.isArray(out) ? (out as QStashSchedule[]) : []
  }

  /** `POST /v2/schedules/{id}/pause`: "the cron trigger will simply be ignored" until resumed. The reversible stop. */
  pauseSchedule(scheduleId: string): Promise<void> {
    return this.scheduleAction(scheduleId, 'pause')
  }

  resumeSchedule(scheduleId: string): Promise<void> {
    return this.scheduleAction(scheduleId, 'resume')
  }

  /** `DELETE /v2/schedules/{id}`: the schedule is gone; a later `schedule()` with the same id creates it afresh. */
  deleteSchedule(scheduleId: string): Promise<void> {
    return this.scheduleAction(scheduleId, null)
  }

  private async scheduleAction(scheduleId: string, action: 'pause' | 'resume' | null): Promise<void> {
    const url = `${this.base}/v2/schedules/${encodeURIComponent(scheduleId)}${action ? `/${action}` : ''}`
    const res = await this.f(url, { method: action ? 'POST' : 'DELETE', headers: { authorization: `Bearer ${this.cfg.token}` } })
    if (!res.ok) throw new QStashError(res.status, await res.text().catch(() => ''))
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
  /**
   * Records successful collections so an outage that fails closed - the shape
   * both transports are designed to have - is visible as silence rather than
   * invisible as an absence of errors.
   */
  readonly heartbeat?: CollectionHeartbeat
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
    // Any outcome that leaves the cell short of `runs` gets a durable record.
    // Reviewers found two holes here. First, only 'failed' was recorded, so a
    // cycle that exhausted its budget mid-morning returned ok:true for every
    // remaining cell and the day's coverage shrank with no signal anywhere -
    // an R8 problem, since `n` is part of every published number. Second, the
    // 'failed' entry duplicated what collect-cell already records per run, with
    // a wrong attempt count. So: record a single shortfall entry, only for the
    // outcomes collect-cell does not already dead-letter itself.
    // Only a real collection counts: a cache hit proves the cache works, not
    // that collection does, so counting it would mask a total provider outage.
    if (outcome.status === 'collected' && d.heartbeat) {
      await d.heartbeat.recordCollected(1).catch(() => undefined) // never fail a paid job on telemetry
    }

    const shortfall = outcome.status === 'budget-exhausted' || outcome.status === 'allowance-exhausted' || outcome.status === 'aborted'
    if (shortfall) {
      const got = 'answers' in outcome ? outcome.answers.length : 0
      d.deadLetter.record({
        engine: job.cell.engine,
        cellKey: job.cell.key,
        prompt: job.prompt,
        run: got,
        kind: outcome.status === 'aborted' ? 'timeout' : 'rate-limited',
        message: `cell left short: ${got} of ${job.runs} runs (${outcome.status})`,
        attempts: outcome.providerCalls,
        at: (d.now?.() ?? new Date()).toISOString(),
      })
    }
    const complete = outcome.status === 'collected' || outcome.status === 'cache-hit' || outcome.status === 'claimed-elsewhere'
    return { status: 200, body: { ok: complete, outcome: outcome.status, providerCalls: outcome.providerCalls } }
  } catch (e) {
    // Reached only for a refusal *before* any call - the R3 gate, or a broken
    // dependency. Nothing was spent, so a retry is safe and 503 asks for one.
    return { status: 503, body: { ok: false, error: (e as Error).message } }
  }
}
