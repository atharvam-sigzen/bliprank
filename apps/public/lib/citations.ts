/**
 * What the engines cited, counted from the evidence file. ADR-0014.
 *
 * Every citation in `ScanAnswers` carries the class the scorer assigned it
 * (ADR-0005: owned, competitor, review, community, video, earned media,
 * reference, other). This module turns the list into the two things a reader
 * can act on: the share of citations in each class, with its interval, and
 * the sites cited most, each with its class and whether it is the subject's
 * own.
 *
 * R8 applies to a share of citations exactly as to a share of answers: it is a
 * proportion of a sample and it carries a Wilson interval. The denominator is
 * CITATIONS, not answers — a third legitimate base, stated where it is printed.
 *
 * Nothing here is a claim about influence. A citation is where an engine sent
 * a reader, not where it got its facts; the surface says so.
 */

import { wilson, type Metric } from '@bliprank/stats'
import { headlineAnswers, type ScanAnswers, type StoredCitation } from './answers'

export const SOURCE_ORDER = ['owned', 'competitor', 'review', 'community', 'video', 'earned_media', 'reference', 'other'] as const
export type SourceClass = (typeof SOURCE_ORDER)[number]

/** The reader's names for the classes. `owned` is worded from the subject's side. */
export const SOURCE_LABELS: Readonly<Record<SourceClass, string>> = {
  owned: 'Your own site',
  competitor: 'A competitor’s site',
  review: 'Review sites',
  community: 'Community threads',
  video: 'Video',
  earned_media: 'Earned media',
  reference: 'Reference works',
  other: 'Other sites',
}

/** Short form for a chip beside a single citation. */
export const SOURCE_SHORT: Readonly<Record<SourceClass, string>> = {
  owned: 'yours',
  competitor: 'competitor',
  review: 'review',
  community: 'community',
  video: 'video',
  earned_media: 'media',
  reference: 'reference',
  other: 'other',
}

export const labelFor = (sourceClass: string): string => SOURCE_LABELS[sourceClass as SourceClass] ?? sourceClass
export const shortFor = (sourceClass: string): string => SOURCE_SHORT[sourceClass as SourceClass] ?? sourceClass

export interface ClassShare {
  readonly sourceClass: string
  readonly label: string
  readonly count: number
  /** Share of all citations, with its 95% interval; n is the citation count. */
  readonly metric: Metric
}

export interface CitedHost {
  readonly domain: string
  readonly count: number
  /** The class this host was assigned; one host has one class. */
  readonly sourceClass: string
  /** In how many distinct answers it was cited. */
  readonly answers: number
}

export interface CitationMix {
  /** Every citation across every answer. The denominator of every share. */
  readonly total: number
  readonly answersWithAny: number
  readonly answersWithout: number
  /** Engines that returned no citation on any answer — a fact about the engine, stated rather than read as zero. */
  readonly enginesWithNone: readonly string[]
  /**
   * Citations whose URL names no host — a provider's own redirect link
   * (`/goto?url=…`) stored verbatim at collection. Counted in `total` and in
   * their class (the scan counted them), never listed as a site.
   */
  readonly unresolvable: number
  readonly classes: readonly ClassShare[]
  /** Most-cited hosts, descending by count, ties by name. */
  readonly hosts: readonly CitedHost[]
}

const provenance = (answers: ScanAnswers) => ({
  algo_version: answers.algoVersion || 'unknown',
  collection_path: 'third-party-grounded' as const,
  comparison_basis: answers.comparisonBasis,
})

export function citationMix(evidence: ScanAnswers, topHosts = 12): CitationMix {
  // The headline's answers only: a custom prompt's answers are evidence for the second block, not for this sample (ADR-0016).
  const answers = headlineAnswers(evidence)
  const all: StoredCitation[] = answers.answers.flatMap((a) => a.citations)
  const total = all.length
  const answersWithAny = answers.answers.filter((a) => a.citations.length > 0).length
  const answersWithout = answers.answers.length - answersWithAny

  const byEngine = new Map<string, number>()
  for (const a of answers.answers) byEngine.set(a.engine, (byEngine.get(a.engine) ?? 0) + a.citations.length)
  const enginesWithNone = [...byEngine.entries()].filter(([, n]) => n === 0).map(([e]) => e).sort()

  const counts = new Map<string, number>()
  for (const c of all) counts.set(c.sourceClass, (counts.get(c.sourceClass) ?? 0) + 1)
  const order = (k: string) => {
    const i = (SOURCE_ORDER as readonly string[]).indexOf(k)
    return i === -1 ? SOURCE_ORDER.length : i
  }
  // `wilson(k, 0)` throws rather than shrug, so with no citations there are no
  // shares — the surface says "cited nothing" instead of drawing a table.
  const classes: ClassShare[] =
    total === 0
      ? []
      : [...counts.entries()]
          .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
          .map(([sourceClass, count]) => {
            const w = wilson(count, total)
            return { sourceClass, label: labelFor(sourceClass), count, metric: { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, ...provenance(answers) } }
          })

  const unresolvable = all.filter((c) => !c.domain).length
  const hostCounts = new Map<string, { count: number; sourceClass: string; answers: Set<number> }>()
  answers.answers.forEach((a, i) => {
    for (const c of a.citations) {
      if (!c.domain) continue
      const held = hostCounts.get(c.domain) ?? { count: 0, sourceClass: c.sourceClass, answers: new Set<number>() }
      held.count += 1
      held.answers.add(i)
      hostCounts.set(c.domain, held)
    }
  })
  const hosts: CitedHost[] = [...hostCounts.entries()]
    .map(([domain, h]) => ({ domain, count: h.count, sourceClass: h.sourceClass, answers: h.answers.size }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, topHosts)

  return { total, answersWithAny, answersWithout, enginesWithNone, unresolvable, classes, hosts }
}
