import { formatBounds, type Metric } from '@bliprank/stats'
import { promptSetWords, type PromptSetRef } from '@/lib/prompt-set'

/**
 * ZERO IS A FINDING, AND IT IS SAID IN WORDS ON EVERY SURFACE THAT SHOWS IT
 * (MVP_PLAN C3r item 3).
 *
 * The lede (`Headline`) yields at zero mentions, on the ground that the surface
 * says it instead. The Grader's page did; the workspace record did not, so a
 * client with no mentions opened their record to a bare 0.0% rail and no
 * sentence at all: the one reader who most needs the number explained got the
 * least. This is that sentence, one component for both surfaces so they cannot
 * come to word it differently.
 *
 * WHAT IT SAYS, AND WHY IN THESE WORDS. "Not named in any of the N answers" is
 * the measurement. The second half is its range, spoken as a range: a zero
 * from fifteen answers does not mean the true rate is zero, it means the true
 * rate lies between none at all and an upper limit that depends on how many
 * answers were read. That upper limit is the Wilson interval's high bound as
 * `formatBounds` prints it, the same figure the rail beside it shows. Nothing
 * is computed here.
 *
 * ⚠️ ONE NUMBER FOR ONE BOUND (stats review of C3r, MAJOR 1). The first draft
 * printed the spoken frequency and the percentage together: "up to 1 in 4
 * answers (20.4%)". `formatFrequency` rounds its bound OUTWARD on purpose and
 * `formatBounds` rounds to nearest, so the pair disagreed in plain sight: 25%
 * beside 20.4% at fifteen answers, 50% beside 35.4% at seven. Two figures for
 * one limit, on a page whose claim is that its numbers reconcile. The exact
 * figure stands alone; a frequency voice for a zero needs "about" and no
 * percentage beside it, which is a wording decision for packages/stats.
 *
 * NOT `.detail`: R8 in words at both depths, exactly as the lede it replaces.
 */

/**
 * THE ONE PREDICATE for "this measurement is a zero finding". The lede yields
 * exactly when this is true and this component speaks exactly when it is, so
 * in every state one of them speaks and never both (stats review, NOTE 1: two
 * separate conditions disagreed at n = 0 and at a non-finite value, both
 * unreachable, and the comment claimed the guarantee absolutely).
 */
export const isZeroFinding = (metric: Metric): boolean => metric.n >= 1 && metric.value <= 0

export function zeroMentionsWords(metric: Metric, promptSet?: PromptSetRef | null): { readonly found: string; readonly range: string } | null {
  if (!isZeroFinding(metric)) return null
  const asked = promptSet ? ` to ${promptSetWords(promptSet)}` : ''
  const found = metric.n === 1 ? `Not named in the one answer collected${asked}.` : `Not named in any of the ${metric.n} answers${asked}.`
  return {
    found,
    range: `With this many answers the true rate could be anywhere from none at all up to ${formatBounds(metric).high} of answers, so this is a real result with an upper limit, not an error and not proof of zero.`,
  }
}

export function ZeroMentions({ metric, promptSet, subjectSource }: { metric: Metric; promptSet?: PromptSetRef | null; subjectSource?: string }) {
  const words = zeroMentionsWords(metric, promptSet)
  if (!words) return null
  return (
    <p className="prose" data-zero-mentions style={{ marginTop: 'var(--space-3)' }}>
      {words.found} {words.range}
      {subjectSource === 'domain-label'
        ? ' Note the brand was identified from the domain label alone, so a trading name that differs from the domain would be undercounted.'
        : ''}
    </p>
  )
}
