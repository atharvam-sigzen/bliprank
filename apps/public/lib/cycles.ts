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
import { isScanResultFile, rememberScan, runInfoOf, scans, subjectOf, normaliseTyped, type ScanResultFile } from './scan-result'

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
export function latestMovement(
  cycles: readonly ScanResultFile[],
): { readonly current: string; readonly previous: string; readonly verdict: Comparison; readonly why: string | null } | null {
  if (cycles.length < 2) return null
  const current = cycles[cycles.length - 1]!
  const previous = cycles[cycles.length - 2]!
  const a = subjectOf(current).metric
  const b = subjectOf(previous).metric
  const verdict = compare(a, b)
  return { current: cycleDayOf(current), previous: cycleDayOf(previous), verdict, why: verdict.significance === 'not-comparable' ? whyNotComparable(a, b) : null }
}

/**
 * Which part of two measurements' provenance differs, in words a reader can
 * act on. `compare()` refuses across a scoring version, a collection path or
 * a basis and names the first two; the basis string it does not open. This
 * does, segment by segment, so "≠" on the record says WHY: "the prompt count
 * (10 against 17)", "the bank version (crm-software@1 against crm-software@2)".
 * Null when nothing differs, which `compare()` would not have refused for.
 */
export function whyNotComparable(a: Metric, b: Metric): string | null {
  if (a.algo_version !== b.algo_version) return `scored by different versions (${b.algo_version} against ${a.algo_version})`
  if (a.collection_path !== b.collection_path) return `collected by different paths (${b.collection_path} against ${a.collection_path})`
  return basisDifference(a.comparison_basis, b.comparison_basis)
}

/** The basis string, as `comparisonBasisFor` in services/grader/src/scan.ts writes it, one label per pipe-separated segment. */
const BASIS_SEGMENTS = ['the basis format', 'the engine set', 'the locale', 'the geography', 'the bank version', 'the prompt count', 'the runs per cell'] as const

export function basisDifference(current: string, previous: string): string | null {
  const a = (current ?? '').split('|')
  const b = (previous ?? '').split('|')
  const strip = (s: string) => s.replace(/^(engines|unprompted|runs)=/, '')
  const diffs: string[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    const label = BASIS_SEGMENTS[i] ?? `basis field ${i + 1}`
    diffs.push(`${label} (${strip(b[i] ?? 'absent')} against ${strip(a[i] ?? 'absent')})`)
  }
  return diffs.length ? `measured on a different basis: ${diffs.join(', ')}` : null
}

/**
 * Remember every cycle the SERVER holds for this domain that this browser
 * does not. Returns how many were added.
 *
 * The browser registry is the store that forgets: a run that finished after
 * the tab closed was filed on disk and never reached `rememberScan`, so the
 * record said one cycle and the button said "already collected today", with
 * no click that reconciled them. This asks `/api/cycles` once. On a static
 * deployment the route does not exist, the request 404s, and nothing is
 * added or claimed — the same rule `loadAnswers` follows. A day this browser
 * already holds is never replaced: the bundled reference cycle stays the
 * committed file, not the server's re-derived copy of the same day.
 */
export async function syncCycles(domain: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  try {
    const res = await fetchImpl(`/api/cycles?domain=${encodeURIComponent(normaliseTyped(domain))}`)
    if (!res.ok) return 0
    const body = (await res.json()) as { cycles?: unknown }
    if (!Array.isArray(body?.cycles)) return 0
    const known = new Set(datedCycles(domain).map(cycleDayOf))
    let added = 0
    for (const c of body.cycles) {
      if (!isScanResultFile(c) || normaliseTyped(c.domain) !== normaliseTyped(domain)) continue
      const day = cycleDayOf(c)
      if (!day || known.has(day)) continue
      rememberScan(c)
      known.add(day)
      added += 1
    }
    return added
  } catch {
    return 0
  }
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
