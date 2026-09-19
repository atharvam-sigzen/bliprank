import { parseBasis } from '@bliprank/contracts/basis'

/**
 * THE PROMPT SET A MEASUREMENT WAS TAKEN OVER, read off its own basis string
 * (ADR-0016 Amendment 1, MVP_PLAN C3).
 *
 * Since the owner's decision of 2026-09-16 a person's edited prompt set IS the
 * measurement: the headline's basis carries `unprompted=0|…|custom=K@V`, and
 * every surface that prints the number says whose questions produced it, in
 * plain words: "your K prompts, version V". The basis string is the one place
 * that fact is recorded, by the writer that stamped the metric
 * (`comparisonBasisFor`, services/grader/src/scan.ts), so it is read from there
 * and from nowhere else; a surface that kept its own copy could come to
 * disagree with the number it sits beside.
 *
 * Null for a measurement over the category's bank (no `custom=` segment on the
 * headline basis), and for a string the shared definition cannot parse: a file
 * that never recorded a set is not shown as having one.
 */
export interface PromptSetRef {
  readonly count: number
  readonly version: number
}

export function promptSetOf(comparisonBasis: string | undefined): PromptSetRef | null {
  const b = parseBasis(comparisonBasis ?? '')
  // `unprompted=0` is what makes it the HEADLINE's set: decision 4's second block carried `custom=` on its own basis, never on the headline's.
  return b?.custom && b.unprompted === 0 ? { count: b.custom.count, version: b.custom.version } : null
}

/**
 * What travels with a number measured over a person's own set, beside the
 * label: what it may be compared with, and what it may not (ADR-0016
 * Amendment 1, "What it costs"; C3 stats review, MAJOR 5). The label alone
 * says whose questions these were; a screenshot also has to say that this is
 * not a position in the category.
 */
export const PROMPT_SET_SCOPE =
  'This number is measured over your own questions, so it compares with your own earlier cycles asked the same version of them, and with nothing else: not with another domain, and not with a scan asked the category bank.'

/** "your 5 prompts, version 2" — the words the owner asked for, one definition for every surface. */
export const promptSetWords = (s: PromptSetRef): string => `your ${s.count} ${s.count === 1 ? 'prompt' : 'prompts'}, version ${s.version}`
