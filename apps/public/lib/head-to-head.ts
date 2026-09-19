/**
 * PHASES 3.4 — head-to-head comparison, the arithmetic and the verdicts.
 *
 * Kept out of the component on purpose (CLAUDE.md §8: pure functions, side
 * effects at the edges). Everything here is testable without a DOM, which is
 * why this file has tests and the SVG below it is a thin renderer over them.
 *
 * WHY A DOT-AND-RANGE PLOT AND NOT A BAND.
 *
 * `CiTrendChart` draws a band because its x-axis is time and the space between
 * two cycles is real — a reader is entitled to interpolate across it. Brands are
 * categorical. A band across brands would draw a continuum between Acme and
 * Zoho, which does not exist. The correct form for several estimates compared
 * side by side is one interval per row with a marker at the point estimate, and
 * that form has the property this feature needs: the interval is drawn at the
 * same visual weight as the estimate, so it cannot be read past.
 *
 * WHY A BAR CHART WOULD BE WRONG HERE.
 *
 * A bar encodes magnitude by length from zero, which puts all the ink on the
 * point estimate and turns the interval into a whisker decorating it. On the one
 * surface most likely to be screenshotted next to a competitor's tool, that is
 * the wrong emphasis: the whole claim is that at a free sample size these brands
 * mostly cannot be ranked.
 */

import { compare, type Comparison, type Metric } from '@bliprank/stats'

export interface Contender {
  /** Display name. Short — the SVG label column is fixed width. */
  readonly label: string
  readonly metric: Metric
}

export type Verdict = 'you' | 'ahead' | 'behind' | 'indistinguishable' | 'insufficient-data' | 'not-comparable'

export interface HeadToHeadRow {
  readonly label: string
  readonly metric: Metric
  readonly isSubject: boolean
  /** `null` for the subject: comparing a measurement with itself is not a claim. */
  readonly comparison: Comparison | null
  readonly verdict: Verdict
}

export interface HeadToHead {
  readonly rows: readonly HeadToHeadRow[]
  readonly subject: HeadToHeadRow
  /**
   * How many competitors `compare()` actually compared with the subject: ahead,
   * behind, or indistinguishable. The rest were REFUSED a comparison (too few
   * answers, or a pair too unlike in precision), which is a different fact
   * from "compared, and no difference found" (MVP_PLAN C3r item 4).
   */
  readonly compared: number
  /**
   * True when at least one competitor WAS compared and not one of those could
   * be separated from the subject.
   *
   * This is the expected result on a free-tier sample and the page says so out
   * loud rather than rendering a chart that looks like a ranking and hoping the
   * reader checks the overlaps. It is a fact about the sample, not a failure.
   *
   * ⚠️ It used to be true whenever nothing was ahead and nothing behind, which
   * includes the case where NO comparison was possible at all: a short set of
   * a person's own questions puts every row under the floor on n, and the page
   * then said "not one brand can be told apart from you", a finding, over a
   * chart on which nothing had been compared.
   */
  readonly allIndistinguishable: boolean
}

/**
 * The verdicts, derived — never assigned by the caller.
 *
 * Every guard comes from `compare()` rather than being re-implemented here, and
 * that matters more than it looks. `compare()` already refuses across an
 * algorithm bump, a collection path change, a changed `comparison_basis`, a
 * sample under `MIN_N_FOR_COMPARISON`, and a pair whose precisions differ enough
 * that interval separation would be an ordinary 95% test wearing a 99.4% badge.
 * Every one of those applies to brand-vs-brand exactly as it applies to
 * week-on-week — a competitor measured over a different engine set is not a
 * competitor you can rank yourself against — and re-deriving them here would be
 * a second implementation to keep in step with a HUMAN-OWNED file.
 *
 * `compare(contender, subject)` reads "is the contender higher than you", so
 * `higher` means the contender is ahead. The direction is asserted in the tests
 * because getting it backwards is silent and catastrophic.
 */
function verdictOf(c: Comparison): Verdict {
  switch (c.significance) {
    case 'higher':
      return 'ahead'
    case 'lower':
      return 'behind'
    case 'no-significant-change':
      return 'indistinguishable'
    case 'insufficient-data':
      return 'insufficient-data'
    case 'not-comparable':
      return 'not-comparable'
  }
}

/**
 * Build the rows, ordered by point estimate, subject included in the ordering.
 *
 * ORDERING IS A DELIBERATE RISK, TAKEN WITH A MITIGATION. Sorting draws a
 * ranking, and the intervals are precisely what refuses to support one. The
 * alternative — pinning the subject to the top and leaving competitors
 * unordered — reads as "you are winning" and is worse. So everyone is sorted
 * together on the point estimate, and the chart draws the subject's own interval
 * as a band across every row, so a reader sees which neighbours it touches
 * before they finish reading the order. Ties break on label so the output is
 * deterministic for a given input.
 */
export function buildHeadToHead(subject: Contender, competitors: readonly Contender[]): HeadToHead {
  if (competitors.some((c) => c.label === subject.label)) {
    throw new Error(`buildHeadToHead: "${subject.label}" appears in both the subject and the competitor set`)
  }
  const seen = new Set<string>()
  for (const c of competitors) {
    if (seen.has(c.label)) throw new Error(`buildHeadToHead: duplicate competitor label "${c.label}"`)
    seen.add(c.label)
  }

  const rows: HeadToHeadRow[] = [
    { label: subject.label, metric: subject.metric, isSubject: true, comparison: null, verdict: 'you' },
    ...competitors.map((c) => {
      const comparison = compare(c.metric, subject.metric)
      return { label: c.label, metric: c.metric, isSubject: false, comparison, verdict: verdictOf(comparison) }
    }),
  ]

  rows.sort((a, b) => b.metric.value - a.metric.value || a.label.localeCompare(b.label))

  const subjectRow = rows.find((r) => r.isSubject)
  /* c8 ignore next */
  if (!subjectRow) throw new Error('buildHeadToHead: unreachable — the subject row was just inserted')

  const rivals = rows.filter((r) => !r.isSubject)
  const compared = rivals.filter((r) => r.verdict === 'ahead' || r.verdict === 'behind' || r.verdict === 'indistinguishable')
  return {
    rows,
    subject: subjectRow,
    compared: compared.length,
    allIndistinguishable: compared.length > 0 && compared.every((r) => r.verdict === 'indistinguishable'),
  }
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export const CHART = {
  width: 600,
  rowHeight: 26,
  padTop: 22,
  padBottom: 30,
  /** Label column. Names longer than this are truncated; the full name is in the table. */
  padLeft: 108,
  /** Verdict glyph column. */
  padRight: 26,
} as const

export const chartHeight = (rowCount: number): number => CHART.padTop + rowCount * CHART.rowHeight + CHART.padBottom

/**
 * Value → x, on a scale fixed at 0–100% and never fitted to the data.
 *
 * Same rule as the trend chart and for the same reason: auto-fitting a
 * proportion axis magnifies a few points of difference into the full width of
 * the chart. On a head-to-head that failure is worse than on a trend, because
 * the reader is being asked to judge whether two ranges touch — and a fitted
 * axis makes every set of brands look dramatically separated regardless of what
 * the numbers say.
 */
export function xOf(value: number): number {
  const plotW = CHART.width - CHART.padLeft - CHART.padRight
  return CHART.padLeft + Math.min(1, Math.max(0, value)) * plotW
}

export const yOf = (index: number): number => CHART.padTop + index * CHART.rowHeight + CHART.rowHeight / 2

/** The glyph for a verdict. Never the only carrier of meaning — see the component. */
export const VERDICT_GLYPH: Readonly<Record<Verdict, string>> = {
  you: '▸',
  ahead: '▲',
  behind: '▼',
  indistinguishable: '≈',
  'insufficient-data': '–',
  'not-comparable': '≠',
}

/** Plain words for the same thing, for the table and the accessible name. */
export const VERDICT_WORDS: Readonly<Record<Verdict, string>> = {
  you: 'your domain',
  ahead: 'ahead of you',
  behind: 'behind you',
  indistinguishable: 'cannot be separated from you',
  'insufficient-data': 'not enough data to compare',
  'not-comparable': 'not comparable',
}

/**
 * WHY a row was not ranked, in the reader's words.
 *
 * `not-comparable` is the hardest verdict to render, because unlike every other
 * one it has no ordering to show and the honest answer is a sentence, not a
 * shape. Close is measured at 0.0% [0.0-4.3] in the collected result and its
 * interval is far tighter than the subject's, so `compare()` refuses on
 * precision divergence — the measurement is sound, the RANKING would not be.
 *
 * A reader who sees a dashed bar and a "≠" has been told that something was
 * refused but not what. This lives here, next to the verdicts, so the chart's
 * tooltip and the prose beneath it give the same reason rather than two.
 */
export function reasonFor(row: Pick<HeadToHeadRow, 'verdict' | 'comparison'>): string {
  if (row.verdict === 'insufficient-data') return 'too few answers to compare'
  const label = row.comparison?.label ?? ''
  if (label.includes('precision')) return 'its range is far tighter than yours'
  if (label.includes('engine set') || label.includes('locale') || label.includes('geo')) return 'measured over a different engine set'
  if (label.includes('scored by')) return 'scored by a different algorithm version'
  if (label.includes('collected via')) return 'collected by a different path'
  return 'measured on a different basis'
}
