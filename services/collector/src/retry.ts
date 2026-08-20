/**
 * Retry policy — pure decision function, no side effects. HUMAN-OWNED
 * (CLAUDE.md §4: retry logic). Every retry spends money, so the policy is a
 * small, testable object the runner consults, never ad-hoc branching.
 */

import type { AdapterError } from '@bliprank/contracts'

export interface RetryConfig {
  /** Total attempts including the first (≥ 1). */
  readonly maxAttempts: number
  readonly baseDelayMs: number
  /** Exponential factor between attempts. */
  readonly factor: number
  /** Ceiling for any single delay, provider Retry-After included. */
  readonly maxDelayMs: number
  /** Upper bound on the random jitter added to every delay. */
  readonly jitterMs: number
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  factor: 4,
  maxDelayMs: 60_000,
  jitterMs: 250,
}

export interface RetryDecision {
  readonly retry: boolean
  /** Delay before the next attempt (0 when retry is false). Jitter already applied. */
  readonly delayMs: number
  readonly reason: 'retryable' | 'non-retryable-kind' | 'attempts-exhausted'
}

/**
 * @param err      the failure of attempt `attempt`
 * @param attempt  1-based attempt number that just failed
 * @param rng      injectable for determinism in tests (default Math.random)
 */
export function retryDecision(err: AdapterError, attempt: number, cfg: RetryConfig = DEFAULT_RETRY, rng: () => number = Math.random): RetryDecision {
  if (!err.retryable) return { retry: false, delayMs: 0, reason: 'non-retryable-kind' }
  if (attempt >= cfg.maxAttempts) return { retry: false, delayMs: 0, reason: 'attempts-exhausted' }
  const backoff = err.retryAfterMs ?? cfg.baseDelayMs * cfg.factor ** (attempt - 1)
  const delayMs = Math.min(cfg.maxDelayMs, backoff) + Math.floor(rng() * cfg.jitterMs)
  return { retry: true, delayMs, reason: 'retryable' }
}
