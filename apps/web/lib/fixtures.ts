/**
 * Mock data for the UI scaffold. NOT collected data — G0 has not run and no
 * real answers exist. Numbers here are shaped to exercise the components,
 * including the cases that are easy to get wrong.
 */

import { wilson, type Metric } from '@bliprank/stats'

const metric = (k: number, n: number): Metric => {
  const w = wilson(k, n)
  return { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-1', collection_path: 'third-party-grounded' }
}

export const ENGINES = ['ChatGPT', 'Google Gemini', 'Microsoft Copilot', 'Google AI Mode', 'Google AI Overviews'] as const

/** Headline cards. The pairs are chosen to show both verdicts side by side. */
export const HEADLINE = {
  // 37/150 -> 44/150: looks like a rise, interval says it is not one.
  mentionRate: { current: metric(44, 150), previous: metric(37, 150) },
  // A genuinely separated pair.
  citationRate: { current: metric(90, 150), previous: metric(30, 150) },
  // A thin cell: wide interval, must not invite a conclusion.
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
]

/** Source mix from the ADR-0005 classifier, as the corpus would report it. */
export const SOURCE_MIX = [
  { label: 'Community', share: 0.31 },
  { label: 'Earned media', share: 0.24 },
  { label: 'Review', share: 0.18 },
  { label: 'Video', share: 0.11 },
  { label: 'Owned', share: 0.09 },
  { label: 'Reference', share: 0.04 },
  { label: 'Other', share: 0.03 },
]
