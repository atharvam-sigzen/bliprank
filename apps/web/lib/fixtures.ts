/**
 * Mock data for the UI scaffold. NOT collected data — G0 has not run and no
 * real answers exist. Numbers here are shaped to exercise the components,
 * including the cases that are easy to get wrong.
 *
 * ⚠️ EVERY PER-ANSWER FIGURE DERIVES FROM ONE CYCLE SHAPE. It did not, and the
 * page made three claims that contradicted each other:
 *
 *   - the masthead said 30 × 5 × 5 = 750 answers while the headline card
 *     carried n = 150;
 *   - the five engines carried n = 150 each, summing to 620 (one was 20), which
 *     matched neither;
 *   - the trend's 2026-08-01 point was 41/150 while the headline's "previous"
 *     was 37/150, under a masthead saying those were the two cycles compared.
 *
 * None of it was visible in a source read and none of it was reachable by a
 * test, because apps/web had no render coverage — see the note in
 * vitest.config.ts about `@/` resolving into the wrong app. A fixture is the
 * one place a product about reconcilable numbers cannot afford numbers that do
 * not reconcile: it is the scaffold that demonstrates the rule.
 *
 * So the shape is declared once, the per-engine counts are the only hand-chosen
 * figures, and the headline, the trend tail and the masthead all derive.
 * apps/web/app/page.render.test.tsx asserts the arithmetic holds.
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

/* ── the cycle's shape, and the only three numbers the rest is built from ── */

const PROMPTS = 30
const RUNS = 5

/** Answers one engine contributes: every prompt, every run. */
const PER_ENGINE_ANSWERS = PROMPTS * RUNS

/** Every scored answer in one cycle. The masthead states this arithmetic and
 *  the headline card is measured over exactly it. */
const CYCLE_ANSWERS = PER_ENGINE_ANSWERS * ENGINES.length

/** Rendered by the masthead, so the sentence a reader multiplies out cannot
 *  drift from the denominator underneath the cards. */
export const CYCLE_SHAPE = { prompts: PROMPTS, runs: RUNS, engines: ENGINES.length, answers: CYCLE_ANSWERS } as const

/**
 * The only hand-chosen per-answer figures on this page: mentions per engine,
 * this cycle and the one before. Everything per-answer below is a sum of these.
 *
 * Chosen to tell one story the product exists to tell — FOUR ENGINES ROSE AND
 * ONE FELL HARD, the aggregate rose 4.6 points, and the aggregate rise is still
 * not a finding. Copilot's fall IS one. A reader who takes the headline as a
 * win and the Copilot column as noise has it exactly backwards, which is the
 * lesson.
 */
const MENTIONS: Record<(typeof ENGINES)[number], { current: number; previous: number }> = {
  ChatGPT: { current: 78, previous: 55 },
  'Google Gemini': { current: 38, previous: 26 },
  'Microsoft Copilot': { current: 15, previous: 42 },
  'Google AI Mode': { current: 55, previous: 41 },
  'Google AI Overviews': { current: 34, previous: 21 },
}

const cycleMentions = (which: 'current' | 'previous') => ENGINES.reduce((total, e) => total + MENTIONS[e][which], 0)

/* ── the trend, which OWNS the dated cycles ──────────────────────────────── */

/**
 * Mentions per cycle. The last two are the pair every "vs previous" on the page
 * refers to, so they are not written here — they are the per-engine sums, and
 * the headline card reads them back off this array. One number, one place.
 */
const TREND_MENTIONS: readonly { readonly cycle: string; readonly mentions: number }[] = [
  { cycle: '2026-06-01', mentions: 150 },
  { cycle: '2026-06-15', mentions: 165 },
  { cycle: '2026-07-01', mentions: 155 },
  { cycle: '2026-07-15', mentions: 195 },
  { cycle: '2026-08-01', mentions: cycleMentions('previous') },
  { cycle: '2026-08-15', mentions: cycleMentions('current') },
]

export const TREND = TREND_MENTIONS.map((p) => ({ cycle: p.cycle, metric: metric(p.mentions, CYCLE_ANSWERS) }))

/** The two cycles the masthead names, taken from the trend rather than typed
 *  beside it — they were a fortnight apart and disagreed by four mentions. */
export const CYCLE_DATES = {
  current: TREND_MENTIONS[TREND_MENTIONS.length - 1]!.cycle,
  previous: TREND_MENTIONS[TREND_MENTIONS.length - 2]!.cycle,
} as const

/* ── the cards ───────────────────────────────────────────────────────────── */

/**
 * Share of voice is NOT a per-answer rate and does not share the cycle's
 * denominator: it is your share of the brand mentions the engines made, so its
 * base is total brand mentions, not total answers. Stated here because a
 * denominator that differs for a reason is fine and a denominator that differs
 * by accident is the defect above.
 */
const BRAND_MENTIONS = { current: 665, previous: 640 }

/**
 * Headline cards, chosen so the three verdicts a reader must learn to tell
 * apart all appear at once.
 *
 * mention rate  — up 4.6 points and NOT a significant change. The one the
 *                 product exists to refuse: every competitor draws a green
 *                 arrow here.
 * citation rate — genuinely separated, so it is reported as a rise.
 * share of voice— genuinely separated DOWNWARD, and the honest reading of the
 *                 page: mentioned more often, yet a smaller share of what the
 *                 engines said, because rivals were named more still.
 */
export const HEADLINE = {
  mentionRate: {
    current: TREND[TREND.length - 1]!.metric,
    previous: TREND[TREND.length - 2]!.metric,
  },
  citationRate: { current: metric(450, CYCLE_ANSWERS), previous: metric(150, CYCLE_ANSWERS) },
  shareOfVoice: { current: metric(150, BRAND_MENTIONS.current), previous: metric(230, BRAND_MENTIONS.previous) },
}

/* ── by engine ───────────────────────────────────────────────────────────── */

/**
 * The five real engines, derived; then three teaching rows that are NOT in
 * ENGINES and so are excluded from every aggregate. Each demonstrates a verdict
 * the five cannot: a refused comparison across a scoring bump, a refused
 * comparison across a changed engine set, and a cell too thin to compare at all.
 */
export const BY_ENGINE = [
  ...ENGINES.map((engine) => ({
    engine: engine as string,
    current: metric(MENTIONS[engine].current, PER_ENGINE_ANSWERS),
    previous: metric(MENTIONS[engine].previous, PER_ENGINE_ANSWERS),
  })),
  // Previous cycle scored by an older algorithm: comparing across the bump
  // would attribute a definition change to the brand, so compare() refuses.
  {
    engine: 'ChatGPT (pre-v2 scoring)',
    current: metric(MENTIONS.ChatGPT.current, PER_ENGINE_ANSWERS),
    previous: { ...metric(20, PER_ENGINE_ANSWERS), algo_version: 'det-0' },
  },
  // Previous cycle covered a different engine set, so the denominator changed
  // shape. Separated intervals here would render a composition change as a rise.
  {
    engine: 'All engines (set changed)',
    current: metric(cycleMentions('current'), CYCLE_ANSWERS),
    previous: { ...metric(375, 1500), comparison_basis: 'engines=4|en-US|US|bank-crm-1|14d' },
  },
  // A surface that answered a handful of prompts before the cycle ended. Below
  // MIN_N_FOR_COMPARISON, so the comparison is REFUSED outright rather than
  // reported as "no change" — a different and more honest statement, and the
  // one verdict no full engine row can demonstrate.
  { engine: 'Perplexity (partial cycle)', current: metric(2, 12), previous: metric(1, 11) },
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
 *
 * Its base is CITATIONS, not answers — a third legitimate denominator, and the
 * page says so where it prints it.
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
