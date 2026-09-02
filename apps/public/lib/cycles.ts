/**
 * Cycles of one domain, as the client sees them — and the trend over them.
 *
 * A cycle is one scan on one UTC day (`services/grader/src/cycles.ts`). The
 * registry in `scan-result.ts` may hold several for a domain: the bundled
 * reference scan, and every cycle this browser collected through `/api/scan`.
 * This module orders them, points a chart at them, and applies `compare()`
 * between neighbours so a movement inside the interval reads as "no
 * significant change" here exactly as it does everywhere else (R8).
 *
 * ⚠️ NOTHING HERE IS INVENTED. One cycle is one point, and `trendOf` returns
 * one point — the chart component then draws one dot and no line, and the
 * record keeps refusing a trend in words until a second cycle exists. A
 * synthetic second point, a "projected" line, a dashed continuation: none of
 * those is a measurement, and the whole reason this exists is that the trend
 * used to be demonstrated only on fixtures.
 */

import { compare, type Comparison, type Metric } from '@bliprank/stats'
import { runInfoOf, scans, subjectOf, normaliseTyped, type ScanResultFile } from './scan-result'

/** What the trend chart draws: one cycle, one metric. Same shape the worked example uses. */
export interface TrendPoint {
  readonly cycle: string
  readonly metric: Metric
}

/** The day a scan's answers were bought, or '' when the file does not say. */
export const cycleDayOf = (scan: ScanResultFile): string => runInfoOf(scan).day || ''

/** Every dated, finished cycle of a domain, oldest first, one per day, whatever it was measured against. */
function datedCycles(domain: string): readonly ScanResultFile[] {
  const typed = normaliseTyped(domain)
  const byDay = new Map<string, ScanResultFile>()
  for (const s of scans()) {
    if (s.status !== 'scanned' || normaliseTyped(s.domain) !== typed) continue
    const day = cycleDayOf(s)
    // First writer wins for a day: scans() lists bundled before session, so a
    // committed reference cycle is never shadowed by a session copy of itself.
    if (day && !byDay.has(day)) byDay.set(day, s)
  }
  return [...byDay.values()].sort((a, b) => cycleDayOf(a).localeCompare(cycleDayOf(b)))
}

/**
 * The cycles a trend may span: every finished cycle of the domain measured
 * under the SAME CATEGORY as its latest, oldest first, one per day.
 *
 * ⚠️ A CHANGED CATEGORY IS A CHANGED QUESTION. A domain's record can move by a
 * deliberate act (sigzen.com went from general-business-software to
 * erp-software), and `/api/scan`'s plain path then collects a fresh cycle under
 * the new category and files it beside the old one. Those two files are both
 * real, and they are not two points of one trend: R5 forbids reading a number
 * under a different question's name, and a line between them would do exactly
 * that. So the trend is the latest cycle's category and nothing else; earlier
 * cycles under another category are counted by `earlierCategoryCycles` so the
 * record can say they exist without drawing them.
 *
 * A file with no day cannot be placed on a time axis and is left out rather
 * than sorted to an end it does not belong at.
 */
export function cyclesFor(domain: string): readonly ScanResultFile[] {
  const all = datedCycles(domain)
  const latest = all[all.length - 1]
  if (!latest) return []
  return all.filter((s) => s.category === latest.category)
}

/** Dated cycles of the domain that `cyclesFor` leaves off the trend: measured under an earlier category. */
export function earlierCategoryCycles(domain: string): number {
  return datedCycles(domain).length - cyclesFor(domain).length
}

/** The subject's mention rate per cycle, in cycle order. */
export function trendOf(cycles: readonly ScanResultFile[]): readonly TrendPoint[] {
  return cycles.map((s) => ({ cycle: cycleDayOf(s), metric: subjectOf(s).metric }))
}

/**
 * The verdict between the newest cycle and the one before it, or null with
 * fewer than two. The verdict is `compare()`'s — never assigned here — so a
 * scoring bump, a changed basis or a thin sample refuses the comparison in the
 * same words the methodology page uses.
 */
export function latestMovement(cycles: readonly ScanResultFile[]): { readonly current: string; readonly previous: string; readonly verdict: Comparison } | null {
  if (cycles.length < 2) return null
  const current = cycles[cycles.length - 1]!
  const previous = cycles[cycles.length - 2]!
  return { current: cycleDayOf(current), previous: cycleDayOf(previous), verdict: compare(subjectOf(current).metric, subjectOf(previous).metric) }
}

/**
 * Is a new cycle for this domain possible TODAY, on this client's knowledge?
 *
 * The cache key is per UTC day, so a second scan on the day of the latest
 * cycle would read every cell back from the store and produce the same
 * measurement again: nothing bought, nothing new. The server refuses that too
 * (`/api/scan`, `cycle-exists`); this lets the record say so before the
 * button is pressed, with the day it becomes possible.
 */
export function nextCycleDay(cycles: readonly ScanResultFile[], today: string): { readonly possible: boolean; readonly from: string } {
  const latest = cycles[cycles.length - 1]
  const latestDay = latest ? cycleDayOf(latest) : ''
  if (!latestDay || latestDay < today) return { possible: true, from: today }
  const next = new Date(`${latestDay}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return { possible: false, from: next.toISOString().slice(0, 10) }
}
