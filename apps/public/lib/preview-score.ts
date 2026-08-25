import { compare } from '@bliprank/stats'
import type { ScanBrand } from './scan-result'

/**
 * ⚠️ A PREVIEW SCORE. THIS IS NOT A MEASUREMENT AND IT IS NOT A METHOD.
 *
 * It lives here, in an app's lib, and deliberately NOT in `packages/stats` —
 * that package is human-owned and holds statistical methods, and putting a
 * hand-weighted display index next to Wilson intervals would let a placeholder
 * inherit their credibility. The real methodology (weighting, grounding, an
 * error term) is a separate piece of work and gets its own ADR.
 *
 * WHY IT CARRIES NO INTERVAL, AND THEREFORE NO RAIL. R8 requires every METRIC to
 * ship with `{value, ci_low, ci_high, n, algo_version, collection_path}`. This is
 * not a metric — it is an arithmetic combination of one metric and one ordering,
 * and it has no sampling distribution anybody has derived. Giving it the range
 * rail would claim an interval that does not exist, which is the exact failure
 * the rail was built to prevent. So the score is set as a plain figure, its
 * composition is disclosed beside it, and the Precision grade next to it keeps
 * its separate job: the grade says how much the sample knows, this says how
 * visible the brand is. Two questions, two numbers, never merged.
 *
 * The weights below are a placeholder chosen for legibility, not for accuracy.
 */

export interface ScorePart {
  readonly label: string
  /** Share of the final 100 this part contributed, after renormalisation. */
  readonly points: number
  readonly weight: number
  readonly detail: string
}

export interface PreviewScore {
  readonly score: number
  readonly parts: readonly ScorePart[]
  /** Components with no data in this build, named so the omission is visible. */
  readonly missing: readonly string[]
  readonly comparable: number
}

/** Placeholder weights. Not derived from anything. */
const WEIGHTS = { mention: 0.6, position: 0.25, sentiment: 0.15 } as const

/**
 * Where the subject sits against the competitors it can legitimately be ranked
 * against — 1 for "ahead of all of them", 0 for "behind all of them".
 *
 * `compare()` decides, never a raw value comparison: a pair whose intervals
 * overlap is NOT a win and is not a loss, and it scores as a draw rather than
 * being resolved by whichever point estimate happened to be higher. Pairs
 * `compare()` refuses outright are excluded from the denominator instead of
 * being counted as losses.
 */
function position(subject: ScanBrand, competitors: readonly ScanBrand[]): { fraction: number | null; comparable: number } {
  let credit = 0
  let comparable = 0
  for (const c of competitors) {
    // ARGUMENT ORDER IS THE WHOLE THING HERE. The signature is
    // `compare(current, previous)`, and head-to-head calls it as
    // `compare(contender, subject)` so that 'higher' reads as "ahead of you".
    // This wants the opposite question — did the SUBJECT win — so the subject
    // goes in the `current` slot. Getting this backwards inverts the entire
    // position component silently, and every score would still look plausible.
    const { significance } = compare(subject.metric, c.metric)
    if (significance === 'not-comparable' || significance === 'insufficient-data') continue
    comparable += 1
    if (significance === 'no-significant-change') credit += 0.5
    else if (significance === 'higher') credit += 1
  }
  /*
   * ⚠️ NO HALF CREDIT FOR BEING UNPLACEABLE. This returned 0.5 when nothing was
   * comparable, and the concept portfolio caught what that does: a client
   * measured at 0.0% scored 15 while a client measured at 14.1% scored 10,
   * because a 0% rate has an interval so tight that `compare()` refuses every
   * pairing on precision divergence — and the refusals were paying it half of
   * the position component.
   *
   * Awarding a middle value for an absent input is inventing data, which is the
   * one thing this product exists not to do. The component is reported as
   * UNAVAILABLE instead and its weight is redistributed, exactly as sentiment's
   * is. A brand nobody can rank is scored on what was actually measured.
   */
  return { fraction: comparable === 0 ? null : credit / comparable, comparable }
}

export function previewScore(subject: ScanBrand, competitors: readonly ScanBrand[]): PreviewScore {
  const pos = position(subject, competitors)

  /*
   * Sentiment is not collected in this build, so its weight is REDISTRIBUTED
   * across the components that do have data, and the omission is named.
   *
   * The alternative — scoring out of 85 and calling it out of 100 — would cap
   * every brand below a number the page displays as achievable, which reads as
   * a low score rather than as a missing input. Renormalising and saying so is
   * the honest version of the same arithmetic.
   */
  const hasPosition = pos.fraction !== null
  const missing = ['sentiment', ...(hasPosition ? [] : ['competitive position'])]
  const available = WEIGHTS.mention + (hasPosition ? WEIGHTS.position : 0)
  const w = { mention: WEIGHTS.mention / available, position: hasPosition ? WEIGHTS.position / available : 0 }

  const parts: ScorePart[] = [
    {
      label: 'mention rate',
      weight: w.mention,
      points: 100 * w.mention * subject.metric.value,
      detail: `${(subject.metric.value * 100).toFixed(1)}% of ${subject.metric.n} answers`,
    },
    ...(hasPosition
      ? [
          {
            label: 'competitive position',
            weight: w.position,
            points: 100 * w.position * pos.fraction!,
            detail: `ahead of ${(pos.fraction! * 100).toFixed(0)}% of ${pos.comparable} ranked`,
          },
        ]
      : []),
  ]

  return {
    // Rounded to a whole number: a decimal place on a placeholder index implies
    // a precision the weights cannot support.
    score: Math.round(parts.reduce((t, p) => t + p.points, 0)),
    parts,
    missing,
    comparable: pos.comparable,
  }
}

/** The label every surface must print beside the number. One source, one wording. */
export const PREVIEW_SCORE_CAPTION = 'Preview score — methodology being finalised'
