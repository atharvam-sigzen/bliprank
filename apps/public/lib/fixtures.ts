/**
 * Fixture data for the Grader scaffold. NOT collected data — G0 has not run and
 * no real answers exist. No provider is called on any path in this app.
 *
 * Shaped to exercise every state the head-to-head can render, including the ones
 * that are easy to get wrong. The only fixture module now (apps/web, which had a
 * sibling, was retired 2026-09-07).
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
 * The free scan: 20 prompts × 5 engines, one run each.
 *
 * ⚠️ THIS IS A PRODUCT CONSTRAINT, NOT A FIXTURE CHOICE — PHASES.md 3.3.
 *
 * `compare()` refuses any pair below `MIN_N_FOR_COMPARISON`, so a free scan
 * under that floor renders a head-to-head in which every verdict is "not enough
 * data". That is the honest output at that size, and it is also useless: the
 * comparison is the reason the chart exists. The scaffold sat at n=15 and said
 * nothing at all.
 *
 * The size is set by the DEGRADED case, not the nominal one. Engines go dark —
 * the G0 pilot got HTTP 403 from all five at once — and prompts return
 * unparseable answers, so the number that matters is what survives: 20 prompts
 * across 3 surviving engines at 80% yield is still 48, comfortably clear. At 12
 * prompts the same degradation lands on 28.8 and the chart goes silent on
 * exactly the bad day a customer is most likely to be looking.
 *
 * Breadth, not depth: the n comes from distinct prompts at one run each rather
 * than repeated runs of fewer prompts. Repetition within a cell is what the
 * design effect charges for — n_eff = n / DEFF, and DEFF grows with runs per
 * cell, not with prompt count — so 20×5×1 buys far more effective sample than
 * 4×5×5 for the same money and the same wall-clock.
 *
 * `MIN_N_FOR_COMPARISON` is itself provisional pending G0's measured design
 * effect, so this size is downstream of a number that will move. It is never
 * compared against a literal here: `head-to-head.test.ts` imports the constant
 * and fails if the scan stops clearing it, which is what makes the floor cheap
 * to change later.
 */
export const GRADER_SCAN = { prompts: 20, engines: 5, runsPerCell: 1, successes: 23 } as const

/** Nominal answers in a clean scan. The degraded case is asserted in the tests. */
export const GRADER_SCAN_N = GRADER_SCAN.prompts * GRADER_SCAN.engines * GRADER_SCAN.runsPerCell

/** The graded domain's own result. */
export const SUBJECT_METRIC: Metric = metric(GRADER_SCAN.successes, GRADER_SCAN_N)

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
  { label: 'Salesforce', metric: metric(60, GRADER_SCAN_N) },
  // Overlaps the subject from above. The point estimate is higher and the
  // verdict is still "cannot be separated": this is the row that proves the
  // ordering is not a ranking.
  { label: 'HubSpot', metric: metric(30, GRADER_SCAN_N) },
  // Overlaps from below, for the same reason in the other direction.
  { label: 'Pipedrive', metric: metric(18, GRADER_SCAN_N) },
  // Separated below.
  { label: 'Freshsales', metric: metric(4, GRADER_SCAN_N) },
  // Added to the category registry part-way through the window, so only part of
  // the scan was scored against it. Below the comparison floor, so it is drawn
  // with its interval and explicitly not compared.
  { label: 'Attio', metric: metric(5, 20) },
  // Absent from two engines in this locale, so its denominator is a different
  // shape. Separated intervals here would render a composition difference as a
  // competitive gap — the exact error `comparison_basis` exists to catch.
  { label: 'Zoho', metric: metric(35, 60, 'grader|engines=chatgpt,gemini,copilot|en-GB|GB|auto-bank|1cycle') },
] as const
