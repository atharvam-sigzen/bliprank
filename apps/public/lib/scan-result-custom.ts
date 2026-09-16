/**
 * The second measurement on a stored cycle: the customer's own prompts
 * (ADR-0016, decision 4), read back with the same discipline as the first.
 *
 * Separate from `scan-result.ts` so the JSON-import type there stays what it
 * was; this module reads the optional block off a file and refuses to guess
 * at a malformed one.
 */

import type { Metric } from '@bliprank/stats'
import { compare, type Comparison } from '@bliprank/stats'
import { cycleDayOf, whyNotComparable } from '@/lib/cycles'
import type { ScanBrand, ScanResultFile as Base } from '@/lib/scan-result'

export interface CustomPromptsBlock {
  readonly version: number
  readonly prompts: readonly string[]
  readonly comparisonBasis: string
  readonly counts: { readonly cellsRequested: number; readonly answersScored: number }
  readonly brands: readonly ScanBrand[]
}

export type ScanResultFile = Base & { readonly customPrompts?: CustomPromptsBlock }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const isMetric = (m: unknown): m is Metric => typeof m === 'object' && m !== null && typeof (m as Metric).value === 'number' && typeof (m as Metric).n === 'number' && typeof (m as Metric).comparison_basis === 'string'

/** The block, shape-checked, or null when the file carries none or a malformed one. */
export function customBlockOf(scan: Base): CustomPromptsBlock | null {
  const raw = (scan as { customPrompts?: unknown }).customPrompts
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>
  const prompts = Array.isArray(b['prompts']) ? b['prompts'].filter((p): p is string => typeof p === 'string') : []
  const counts = typeof b['counts'] === 'object' && b['counts'] !== null ? (b['counts'] as Record<string, unknown>) : {}
  const brands = Array.isArray(b['brands'])
    ? b['brands'].filter((x): x is ScanBrand => typeof x === 'object' && x !== null && typeof (x as ScanBrand).id === 'string' && isMetric((x as ScanBrand).metric))
    : []
  if (!prompts.length || typeof b['comparisonBasis'] !== 'string' || num(b['version']) < 1) return null
  return { version: num(b['version']), prompts, comparisonBasis: b['comparisonBasis'], counts: { cellsRequested: num(counts['cellsRequested']), answersScored: num(counts['answersScored']) }, brands }
}

/** The subject's brand row in the custom block, or null when the block has no scored answers. */
export function customSubjectOf(scan: Base): ScanBrand | null {
  return customBlockOf(scan)?.brands.find((b) => b.isSubject) ?? null
}

/**
 * The verdict between the newest cycle's custom measurement and the previous
 * cycle's, or null with fewer than two cycles carrying one. The verdict is
 * `compare()`'s, which refuses across a changed prompt set (the basis carries
 * `custom=K@V`) in the same words the record uses for the headline.
 */
export function customMovement(cycles: readonly Base[]): { readonly current: string; readonly previous: string; readonly verdict: Comparison; readonly why: string | null } | null {
  const withBlock = cycles.filter((c) => customSubjectOf(c) !== null)
  if (withBlock.length < 2) return null
  const current = withBlock[withBlock.length - 1]!
  const previous = withBlock[withBlock.length - 2]!
  const a = customSubjectOf(current)!.metric
  const b = customSubjectOf(previous)!.metric
  const verdict = compare(a, b)
  return { current: cycleDayOf(current), previous: cycleDayOf(previous), verdict, why: verdict.significance === 'not-comparable' ? whyNotComparable(a, b) : null }
}
