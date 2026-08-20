/**
 * The Engine Adapter contract — ADR-0001.
 *
 * Every answer surface is collected through an implementation of this
 * interface. Application code never calls a provider directly (CLAUDE.md §6).
 * Only the *runner* changes when collection moves hosts (ADR-0002); everything
 * that implements this contract is portable.
 *
 * Hand-written on purpose (PHASES.md 0.3). Change it deliberately.
 */

import type { CacheCell } from './cache-key.js'
import type { EngineId } from './engines.js'

/**
 * How a surface is reached. ADR-0001 §3: required on every adapter and
 * published per engine in docs/METHODOLOGY.md. Not cosmetic — no metric may be
 * shown without its collection path visible.
 *
 * - `official-api`          first-party API of the engine vendor
 * - `third-party-grounded`  a third party's web-grounded / scraping infrastructure
 */
export type CollectionPath = 'official-api' | 'third-party-grounded'

export interface CollectRequest {
  /** The cell being collected — cache key parts plus the key itself. */
  readonly cell: CacheCell
  /**
   * The prompt exactly as it is sent to the engine. This is the raw, authored
   * prompt, NOT `cell.normalisedPrompt`: normalisation exists for keying and
   * dedupe, and what was actually sent must be recorded verbatim.
   */
  readonly prompt: string
  /** 0-based repeat index within the cell (n runs per cell). */
  readonly run: number
  /** The runner owns the deadline. Adapters must abort promptly when signalled. */
  readonly signal?: AbortSignal
}

/**
 * Structured hints a provider supplies about a cited source, preserved verbatim
 * through `normalise` for the deterministic source classifier (ADR-0005).
 * `normalise` must NOT flatten a citation to its top-level domain — a video's
 * timestamp/chapter or a community thread id cannot be recovered downstream once
 * dropped. Keys are provider-agnostic where a common meaning exists; unknown
 * provider fields are carried under their own name. Absent when the provider
 * gives nothing beyond the URL.
 */
export interface CitationMeta {
  /** Publisher / outlet name (earned-media, review and reference classification). */
  readonly publisher?: string
  /** Provider's own source/host label, when distinct from the URL host. */
  readonly source?: string
  /** Publication date as the provider stated it (not normalised). */
  readonly date?: string
  /** Snippet / excerpt the provider attached to the citation. */
  readonly snippet?: string
  /** Video timestamp or chapter marker (seconds, or the provider's raw marker). */
  readonly timestamp?: string | number
  /** Community thread / post id. */
  readonly threadId?: string
  /** Any other provider field, carried through rather than dropped. */
  readonly [key: string]: string | number | undefined
}

export interface Citation {
  readonly url: string
  readonly title?: string
  /** 0-based position in the engine's own citation/reference list. */
  readonly position: number
  /**
   * Provider-supplied structured hints preserved for source classification
   * (ADR-0005). Set only when the provider gave more than a bare URL.
   */
  readonly meta?: CitationMeta
}

/** The provider-agnostic body of an answer: what the deterministic scorer reads. */
export interface AnswerBody {
  /** Answer text with markup stripped. Empty string if the engine returned no answer. */
  readonly text: string
  readonly citations: readonly Citation[]
}

/**
 * One collected run. Self-describing on purpose: an object read back from R2 a
 * year later must be reproducible and attributable without any other table.
 */
export interface RawAnswer extends AnswerBody {
  readonly cell: CacheCell
  readonly prompt: string
  readonly run: number
  /** `EngineAdapter.id` of the adapter that produced this run. */
  readonly adapter: string
  readonly collectionPath: CollectionPath
  /** ISO 8601, UTC. */
  readonly collectedAt: string
  readonly latencyMs: number
  /**
   * HTTP calls actually made to the provider for this run — normally 1. The
   * rate budget and /cost-audit debit this number, not `collect()` invocations,
   * so an adapter that must chain calls (e.g. a SERP fetch plus an AI Overviews
   * fetch) is charged for what it really spent.
   */
  readonly providerCalls: number
  /**
   * The provider's response, verbatim and unmodified. Stored in R2 in the
   * `prompt × engine × day` object; never written to Postgres (rule R4).
   */
  readonly payload: unknown
}

export interface RateLimit {
  /** Sustained requests per second permitted on this adapter's `provider` bucket. */
  readonly rps: number
  /** Burst allowance above `rps`. */
  readonly burst: number
}

export type AdapterErrorKind =
  | 'rate-limited' // provider said slow down; retryable after backoff
  | 'timeout' // deadline hit; retryable
  | 'provider' // 5xx or provider-side failure; retryable
  | 'unparseable' // response received but `normalise` could not read it; NOT retryable — fixture it
  | 'rejected' // 4xx, auth, quota, disallowed prompt; NOT retryable

/**
 * The only error an adapter may throw from `collect`. The runner's retry /
 * dead-letter policy (human-owned) keys off `kind` and `retryable`; every retry
 * spends money, so an adapter that mislabels an error is a cost bug.
 */
export class AdapterError extends Error {
  override readonly name = 'AdapterError'
  constructor(
    readonly kind: AdapterErrorKind,
    message: string,
    readonly retryable: boolean,
    /** Provider-supplied hint (e.g. Retry-After), milliseconds. */
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * One adapter = one provider × one engine. Convention: `id` is
 * `${provider}:${engine}`, e.g. `openwebninja:chatgpt`.
 */
export interface EngineAdapter {
  /** Stable, lowercase, unique across the registry. Recorded on every RawAnswer. */
  readonly id: string
  /** Rate-budget bucket. All adapters sharing a provider key share one bucket. */
  readonly provider: string
  readonly engine: EngineId
  /** Required (ADR-0001). Published in docs/METHODOLOGY.md. */
  readonly collectionPath: CollectionPath

  /**
   * Perform exactly one run — normally one provider call; report the true
   * count in `RawAnswer.providerCalls` — and return the normalised answer with
   * the verbatim payload attached. Must honour `req.signal`. Throws
   * `AdapterError` only. Never retries internally — retries belong to the
   * runner, where they are budgeted (rule R3).
   */
  collect(req: CollectRequest): Promise<RawAnswer>

  /**
   * Turn a verbatim provider payload into an `AnswerBody`. Pure and
   * synchronous so it can be exercised from fixtures with zero network — this
   * is what the standing contract test suite calls. Throws
   * `AdapterError('unparseable')` on shape it does not understand.
   */
  normalise(payload: unknown): AnswerBody

  /** The provider ceiling this adapter is allowed to consume. */
  rateLimit(): RateLimit
}
