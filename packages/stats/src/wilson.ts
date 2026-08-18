/**
 * Wilson score interval for a binomial proportion — CLAUDE.md rule R8.
 *
 * HUMAN-OWNED (CLAUDE.md §4). Verified against
 * statsmodels.stats.proportion.proportion_confint(method='wilson') to 1e-9;
 * see ../reference/. The arithmetic below deliberately mirrors statsmodels'
 * operation order so the agreement is exact rather than approximate.
 *
 * Why Wilson and not Wald: see .claude/skills/measurement-methodology.
 *
 * Assumes `trials` independent, identically distributed Bernoulli draws. Runs
 * of one prompt against a caching, non-stationary engine are positively
 * correlated, and prompts within a brand are clustered, so a naive aggregate n
 * overstates precision by roughly √DEFF. Callers must pass an *effective* n
 * (n / design effect) once the pilot has measured the design effect (gate G0).
 */

/** Two-sided 95%: scipy.stats.norm.isf(0.025), the constant statsmodels uses. */
export const Z_95 = 1.9599639845400545

/** The interval shape every metric carries (rule R8). `algo_version` is added by the scorer. */
export interface Interval {
  /** Point estimate p̂ = successes / trials. */
  readonly value: number
  readonly ci_low: number
  readonly ci_high: number
  /** Trials behind the estimate. Never omitted, never zero. */
  readonly n: number
}

/**
 * @param successes  0 ≤ successes ≤ trials. Non-integers are accepted (the
 *                   verification grid uses p̂ · n) but real data is integer.
 * @param trials     > 0. There is no interval on nothing: n = 0 throws rather
 *                   than returning [0, 1], because "no metric without its n".
 * @param z          Critical value; default is the 95% two-sided constant.
 */
export function wilson(successes: number, trials: number, z: number = Z_95): Interval {
  if (!Number.isFinite(trials) || trials <= 0) {
    throw new RangeError(`wilson: trials must be a positive number, got ${trials}`)
  }
  if (!Number.isFinite(successes) || successes < 0 || successes > trials) {
    throw new RangeError(`wilson: successes must be in [0, trials], got ${successes} of ${trials}`)
  }
  if (!Number.isFinite(z) || z <= 0) {
    throw new RangeError(`wilson: z must be a positive number, got ${z}`)
  }

  const p = successes / trials
  const z2 = z * z
  const denom = 1 + z2 / trials
  const centre = (p + z2 / (2 * trials)) / denom
  let spread = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))
  spread /= denom

  // At k = 0 the lower bound is exactly 0 and at k = n the upper bound is
  // exactly 1 (centre and spread cancel algebraically); floating point leaves
  // ~1e-19 of noise there (statsmodels itself returns 1.0000000000000002 at
  // n=150, k=n), so return the exact value. Nothing else is clipped; away from
  // the boundaries the result matches statsmodels to the last ulp or two.
  return {
    value: p,
    ci_low: successes === 0 ? 0 : centre - spread,
    ci_high: successes === trials ? 1 : centre + spread,
    n: trials,
  }
}
