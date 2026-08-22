/**
 * Golden set — PHASES.md 2.5, gate G2.
 *
 * 300-500 hand-labelled answers plus an agreement harness. This file is the
 * structure and the scoring of agreement; the labels themselves are human work
 * and live in `services/scorer/golden/answers/*.json`.
 *
 * The harness deliberately reports rather than asserts a verdict. G2 wants
 * >= 95% deterministic agreement, >= 97% citation-class agreement and 0%
 * silently bucketed as `owned` — but those thresholds only mean something at
 * the full set size. Judged on a seed set of a dozen answers they would be
 * noise dressed as a gate, so `gateStatus` returns NOT_RUN until the set is
 * populated. A criterion with no executable check is NOT RUN, not PASS
 * (docs/PHASES.md).
 */

import type { AnswerBody } from '@bliprank/contracts'
import type { SourceClass } from './classify-source.js'
import { scoreAnswer, type BrandSpec } from './score.js'

/** The G2 target set size. Agreement below this is diagnostic, not a verdict. */
export const GOLDEN_SET_TARGET = 300

/** One hand-labelled answer. Everything a human asserts about it. */
export interface GoldenCase {
  readonly id: string
  /** Where the answer came from, so a disputed label can be traced back. */
  readonly source: { readonly engine: string; readonly collectedAt?: string; readonly note?: string }
  readonly answer: AnswerBody
  readonly brand: BrandSpec
  readonly competitors?: readonly BrandSpec[]
  readonly publishers?: Readonly<Record<string, string>>
  /** What a human says the correct output is. */
  readonly label: {
    readonly mentioned: boolean
    readonly cited: boolean
    /** 1-based rank among detected brands, or null. */
    readonly position: number | null
    /** Competitor names, in order of first appearance. */
    readonly competitorsMentioned: readonly string[]
    /** Expected class per citation position. */
    readonly citationClasses: Readonly<Record<string, SourceClass>>
  }
  /** Why this case is in the set: the edge it covers. */
  readonly covers?: string
}

export interface FieldAgreement {
  readonly field: string
  readonly agreed: number
  readonly total: number
  readonly rate: number
  readonly disagreements: readonly { caseId: string; expected: unknown; actual: unknown }[]
}

export interface GoldenReport {
  readonly cases: number
  readonly deterministic: readonly FieldAgreement[]
  /** Weighted across mention/cited/position/competitors — the G2 headline. */
  readonly deterministicRate: number
  readonly citationClass: FieldAgreement
  /**
   * ADR-0005's hard constraint: a URL a human labelled as anything else must
   * never come back `owned`. Any count above zero is a correctness failure, not
   * an accuracy shortfall — it inflates the customer's own number.
   */
  readonly silentOwned: readonly { caseId: string; url: string; expected: SourceClass }[]
  readonly gateStatus: 'NOT_RUN' | 'PASS' | 'FAIL'
  readonly gateNote: string
}

const eqArray = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Run the scorer over every labelled case and report agreement per field.
 * Never throws on disagreement — disagreement is the output.
 */
export function runGoldenSet(cases: readonly GoldenCase[]): GoldenReport {
  const fields: Record<string, { agreed: number; total: number; disagreements: { caseId: string; expected: unknown; actual: unknown }[] }> = {
    mentioned: { agreed: 0, total: 0, disagreements: [] },
    cited: { agreed: 0, total: 0, disagreements: [] },
    position: { agreed: 0, total: 0, disagreements: [] },
    competitorsMentioned: { agreed: 0, total: 0, disagreements: [] },
  }
  const citation = { agreed: 0, total: 0, disagreements: [] as { caseId: string; expected: unknown; actual: unknown }[] }
  const silentOwned: { caseId: string; url: string; expected: SourceClass }[] = []

  for (const c of cases) {
    const row = scoreAnswer({
      answer: c.answer,
      brand: c.brand,
      ...(c.competitors ? { competitors: c.competitors } : {}),
      ...(c.publishers ? { publishers: c.publishers } : {}),
    })

    const check = (field: string, expected: unknown, actual: unknown, ok: boolean) => {
      const f = fields[field]!
      f.total++
      if (ok) f.agreed++
      else f.disagreements.push({ caseId: c.id, expected, actual })
    }
    check('mentioned', c.label.mentioned, row.mentioned, c.label.mentioned === row.mentioned)
    check('cited', c.label.cited, row.cited, c.label.cited === row.cited)
    check('position', c.label.position, row.position, c.label.position === row.position)
    check(
      'competitorsMentioned',
      c.label.competitorsMentioned,
      row.competitorsMentioned,
      eqArray(c.label.competitorsMentioned, row.competitorsMentioned),
    )

    for (const got of row.citations) {
      const expected = c.label.citationClasses[String(got.position)]
      if (expected === undefined) continue // unlabelled citation: not counted either way
      citation.total++
      if (expected === got.sourceClass) citation.agreed++
      else {
        citation.disagreements.push({ caseId: c.id, expected: `${got.url} => ${expected}`, actual: got.sourceClass })
        if (got.sourceClass === 'owned') silentOwned.push({ caseId: c.id, url: got.url, expected })
      }
    }
  }

  const deterministic = Object.entries(fields).map(([field, f]) => ({
    field,
    agreed: f.agreed,
    total: f.total,
    rate: f.total === 0 ? 0 : f.agreed / f.total,
    disagreements: f.disagreements,
  }))
  const agreedAll = deterministic.reduce((s, f) => s + f.agreed, 0)
  const totalAll = deterministic.reduce((s, f) => s + f.total, 0)
  const deterministicRate = totalAll === 0 ? 0 : agreedAll / totalAll
  const citationRate = citation.total === 0 ? 0 : citation.agreed / citation.total

  let gateStatus: GoldenReport['gateStatus'] = 'NOT_RUN'
  let gateNote = `golden set holds ${cases.length} of ${GOLDEN_SET_TARGET} cases — G2 agreement thresholds are NOT RUN until it is populated`
  if (cases.length >= GOLDEN_SET_TARGET) {
    const pass = deterministicRate >= 0.95 && citationRate >= 0.97 && silentOwned.length === 0
    gateStatus = pass ? 'PASS' : 'FAIL'
    gateNote = `deterministic ${(deterministicRate * 100).toFixed(1)}% (need 95), citation class ${(citationRate * 100).toFixed(1)}% (need 97), silent owned ${silentOwned.length} (need 0)`
  }

  return {
    cases: cases.length,
    deterministic,
    deterministicRate,
    citationClass: { field: 'sourceClass', agreed: citation.agreed, total: citation.total, rate: citationRate, disagreements: citation.disagreements },
    silentOwned,
    gateStatus,
    gateNote,
  }
}

/** Structural validation of a labelled case, so a bad label fails at load. */
export function validateGoldenCase(c: GoldenCase): string[] {
  const errs: string[] = []
  if (!c.id) errs.push('missing id')
  if (!c.brand?.id) errs.push(`${c.id}: missing brand.id`)
  if (!c.brand?.aliases?.length) errs.push(`${c.id}: brand has no aliases — mention detection would always be false`)
  if (typeof c.answer?.text !== 'string') errs.push(`${c.id}: answer.text must be a string`)
  if (!Array.isArray(c.answer?.citations)) errs.push(`${c.id}: answer.citations must be an array`)
  if (c.label?.mentioned === false && c.label?.position !== null) errs.push(`${c.id}: not mentioned but position is not null`)
  if (c.label?.mentioned === true && c.label?.position === null) errs.push(`${c.id}: mentioned but position is null`)
  for (const [pos, cls] of Object.entries(c.label?.citationClasses ?? {})) {
    if (!c.answer.citations.some((x) => String(x.position) === pos)) errs.push(`${c.id}: label for citation position ${pos} which does not exist`)
    if (cls === 'owned' && !c.brand.domains?.length) errs.push(`${c.id}: labelled 'owned' but the brand has no domains`)
  }
  return errs
}
