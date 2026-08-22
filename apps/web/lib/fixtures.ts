/**
 * Mock data for the UI scaffold. NOT collected data — G0 has not run and no
 * real answers exist. Numbers here are shaped to exercise the components,
 * including the cases that are easy to get wrong.
 */

import { wilson, type Metric } from '@bliprank/stats'

/** What these numbers are a measurement of. Two metrics may only be compared
 *  when this matches — see Metric.comparison_basis. */
const BASIS = 'engines=chatgpt,gemini,copilot,ai-mode,aio|en-US|US|bank-crm-1|14d'

const metric = (k: number, n: number): Metric => {
  const w = wilson(k, n)
  return { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-1', collection_path: 'third-party-grounded', comparison_basis: BASIS }
}

export const ENGINES = ['ChatGPT', 'Google Gemini', 'Microsoft Copilot', 'Google AI Mode', 'Google AI Overviews'] as const

/** Headline cards. The pairs are chosen to show both verdicts side by side. */
export const HEADLINE = {
  // 37/150 -> 44/150: looks like a rise, interval says it is not one.
  mentionRate: { current: metric(44, 150), previous: metric(37, 150) },
  // A genuinely separated pair.
  citationRate: { current: metric(90, 150), previous: metric(30, 150) },
  // A thin cell: below the minimum n, so the comparison is refused outright
  // rather than reported as "no change" - a different and more honest statement.
  shareOfVoice: { current: metric(2, 5), previous: metric(1, 5) },
}

export const TREND = [
  { cycle: '2026-06-01', metric: metric(30, 150) },
  { cycle: '2026-06-15', metric: metric(33, 150) },
  { cycle: '2026-07-01', metric: metric(31, 150) },
  { cycle: '2026-07-15', metric: metric(39, 150) },
  { cycle: '2026-08-01', metric: metric(41, 150) },
  { cycle: '2026-08-15', metric: metric(44, 150) },
]

export const BY_ENGINE = [
  { engine: 'ChatGPT', current: metric(48, 150), previous: metric(41, 150) },
  { engine: 'Google Gemini', current: metric(21, 150), previous: metric(19, 150) },
  { engine: 'Microsoft Copilot', current: metric(12, 150), previous: metric(31, 150) },
  { engine: 'Google AI Mode', current: metric(35, 150), previous: metric(33, 150) },
  { engine: 'Google AI Overviews', current: metric(3, 20), previous: metric(2, 20) },
  // Previous cycle scored by an older algorithm: comparing across the bump
  // would attribute a definition change to the brand, so compare() refuses.
  { engine: 'ChatGPT (pre-v2 scoring)', current: metric(48, 150), previous: { ...metric(20, 150), algo_version: 'det-0' } },
  // Previous cycle covered a different engine set, so the denominator changed
  // shape. Separated intervals here would render a composition change as a rise.
  { engine: 'All engines (set changed)', current: metric(360, 1200), previous: { ...metric(375, 1500), comparison_basis: 'engines=4|en-US|US|bank-crm-1|14d' } },
]

/**
 * Source mix from the ADR-0005 classifier.
 *
 * These are Metrics, not bare shares. The first draft of this file had them as
 * `{label, share}` and the page rendered `31%` directly — which is exactly the
 * bare point estimate R8 exists to forbid, shipped in the scaffold that is
 * supposed to demonstrate the rule. Classification being deterministic does not
 * make the share certain: the corpus is a sample of answers, so the proportion
 * of citations in a class carries the same sampling uncertainty as any other
 * proportion, and R8 lists no exemption for "deterministic".
 */
const CITATIONS_OBSERVED = 412

export const SOURCE_MIX = [
  { label: 'Community', metric: metric(128, CITATIONS_OBSERVED) },
  { label: 'Earned media', metric: metric(99, CITATIONS_OBSERVED) },
  { label: 'Review', metric: metric(74, CITATIONS_OBSERVED) },
  { label: 'Video', metric: metric(45, CITATIONS_OBSERVED) },
  { label: 'Owned', metric: metric(37, CITATIONS_OBSERVED) },
  { label: 'Reference', metric: metric(17, CITATIONS_OBSERVED) },
  { label: 'Other', metric: metric(12, CITATIONS_OBSERVED) },
]
