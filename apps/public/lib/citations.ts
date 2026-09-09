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

import { formatProvenance, wilson, type Metric } from '@bliprank/stats'
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
  /** Citations of this class. A raw count, and the long tail lives here. */
  readonly count: number
  /**
   * ANSWERS in which this class was cited at least once — the class's REACH.
   *
   * ⚠️ THIS, NOT `count`, IS WHAT THE SURFACE PLOTS, for three reasons that
   * happen to agree.
   *
   *   1. It is the reader's question. "In 12% of answers about you an engine
   *      pointed at a rival" is actionable; "rival sites were 4.6% of all
   *      citations" is a fact about volume nobody acts on. On the shipped scan
   *      the two disagree sharply: 246 "other" citations come from only 41
   *      answers — a long tail of many sites inside the same answers.
   *   2. Its denominator is the page's own: the answers behind the headline,
   *      the same n as the mention rate, instead of a second denominator
   *      (citations) that appears nowhere else on the record.
   *   3. ⚠️ CITATIONS ARE CLUSTERED WITHIN ANSWERS AND ANSWERS ARE NOT. An
   *      answer carrying twenty citations contributes twenty CORRELATED
   *      observations, so a Wilson interval over `total` citations is narrower
   *      than the evidence supports — the design-effect problem G0 exists to
   *      measure, on a shipped surface. Reach is a proportion of independent
   *      answers, so its interval is honest with no correction.
   *
   * Reaches do NOT sum to one: an answer can cite several classes. Anything
   * drawn from them must be independent bars, never a stacked composition.
   */
  readonly answers: number
  /** Reach as a proportion of the headline's answers, with its interval. */
  readonly reach: Metric
  /**
   * Share of all citations, 0–1. A PLAIN NUMBER, not a `Metric`, deliberately.
   *
   * ⚠️ IT WAS A FULL METRIC AND THAT WAS A TRAP. It carried `n` = the citation
   * total (282 on the shipped scan) while `reach` beside it carries `n` = the
   * answers (85) — and both were stamped with the SAME `comparison_basis`. Two
   * different denominators wearing one basis is precisely what `compare()`
   * trusts to decide that two numbers may be compared, so anything that ever
   * passed these to it would have got a confident verdict across incompatible
   * samples. Nothing did; the shape simply invited it.
   *
   * It also could not honestly carry an interval anyway: citations cluster
   * inside answers, so a Wilson interval over the citation total is narrower
   * than the evidence supports. Dropping the Metric removes the interval that
   * overstated and the trap that invited a bad comparison, in one change. The
   * count and the share are volume facts and stay, as text.
   */
  readonly share: number
  /** Share of all citations, with its 95% interval; n is the citation count. */
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
  /**
   * The record's provenance line, ONCE. It used to be read off
   * `classes[0].metric`, which meant every class carried a duplicate copy of
   * the same four fields purely so one footer could print them.
   */
  readonly provenance: string
  /** Answers behind the headline: the denominator every reach shares. */
  readonly answersInSample: number
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

  // Reach: distinct ANSWERS touching each class. A class is counted once per
  // answer however many times it is cited in it, which is the whole difference
  // between reach and volume.
  const reached = new Map<string, number>()
  for (const a of answers.answers) {
    for (const cls of new Set(a.citations.map((c) => c.sourceClass))) reached.set(cls, (reached.get(cls) ?? 0) + 1)
  }
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
            const seen = reached.get(sourceClass) ?? 0
            const r = wilson(seen, answers.answers.length)
            return {
              sourceClass,
              label: labelFor(sourceClass),
              count,
              answers: seen,
              reach: { value: r.value, ci_low: r.ci_low, ci_high: r.ci_high, n: r.n, ...provenance(answers) },
              share: count / total,
            }
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

  // One provenance for the section, taken from the reach denominator — the one
  // every bar on this table is actually drawn against.
  const reachProvenance = formatProvenance({ value: 0, ci_low: 0, ci_high: 0, n: answers.answers.length, ...provenance(answers) })
  return { total, provenance: reachProvenance, answersInSample: answers.answers.length, answersWithAny, answersWithout, enginesWithNone, unresolvable, classes, hosts }
}
