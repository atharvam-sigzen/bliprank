/**
 * Fixture data for the Grader scaffold. NOT collected data — G0 has not run and
 * no real answers exist. No provider is called on any path in this app.
 *
 * Shaped to exercise every state the head-to-head can render, including the ones
 * that are easy to get wrong. Same convention as `apps/web/lib/fixtures.ts`.
 */

import { wilson, type Metric } from '@bliprank/stats'

/**
 * What every number below is a measurement OF. Two metrics may only be compared
 * when this matches (see `Metric.comparison_basis`), and on a head-to-head that
 * guard is doing more work than on a trend: a competitor measured over a
 * different engine set is not a competitor you can rank yourself against.
 */
export const SCAN_BASIS = 'grader|engines=chatgpt,gemini,copilot,ai-mode,aio|en-GB|GB|auto-bank|1cycle'

const metric = (k: number, n: number, basis: string = SCAN_BASIS): Metric => {
  const w = wilson(k, n)
  return { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-1', collection_path: 'third-party-grounded', comparison_basis: basis }
}

/**
 * The free scan: 12 prompts × 5 engines, one run each.
 *
 * ⚠️ THIS SIZE IS NOW A PRODUCT CONSTRAINT, NOT A COSMETIC FIXTURE CHOICE.
 *
 * The scaffold previously used n=15. `compare()` refuses any pair below
 * `MIN_N_FOR_COMPARISON` (30), so at n=15 every head-to-head verdict is "not
 * enough data" and the chart states nothing at all. That is the honest output at
 * that sample — which is the finding: a free scan under 30 answers cannot
 * support a competitor comparison, so either the free tier collects at least
 * that many or 3.4 does not ship on the free surface.
 *
 * 60 is the smallest round figure comfortably above the floor. It is provisional
 * in the same way `MIN_N_FOR_COMPARISON` is: the real number falls out of G0,
 * because the floor itself is pending the measured design effect.
 */
export const GRADER_SCAN = { successes: 14, answers: 60 } as const

/** The graded domain's own result. */
export const SUBJECT_METRIC: Metric = metric(GRADER_SCAN.successes, GRADER_SCAN.answers)

/**
 * The competitor set, as the category registry would return it.
 *
 * The first four share the scan's denominator, which is what really happens: one
 * pass over the prompt bank scores every detected brand against the same
 * answers. The last two stand in for the two cases that break that assumption in
 * production, and both are refused rather than ranked.
 */
export const COMPETITORS = [
  // Separated above the subject — a genuinely different result.
  { label: 'Salesforce', metric: metric(36, 60) },
  // Overlaps the subject from above. The point estimate is higher and the
  // verdict is still "cannot be separated": this is the row that proves the
  // ordering is not a ranking.
  { label: 'HubSpot', metric: metric(18, 60) },
  // Overlaps from below, for the same reason in the other direction.
  { label: 'Pipedrive', metric: metric(11, 60) },
  // Separated below.
  { label: 'Freshsales', metric: metric(2, 60) },
  // Added to the category registry part-way through the window, so only part of
  // the scan was scored against it. Below the comparison floor, so it is drawn
  // with its interval and explicitly not compared.
  { label: 'Attio', metric: metric(5, 20) },
  // Absent from two engines in this locale, so its denominator is a different
  // shape. Separated intervals here would render a composition difference as a
  // competitive gap — the exact error `comparison_basis` exists to catch.
  { label: 'Zoho', metric: metric(21, 36, 'grader|engines=chatgpt,gemini,copilot|en-GB|GB|auto-bank|1cycle') },
] as const
