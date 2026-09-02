import { formatFrequency, formatInterval, formatValue, type Metric } from '@bliprank/stats'

/**
 * THE RECORD'S LEDE — the finding, in one sentence, before the instrument.
 *
 * The MVP feedback was that the product "reads like an essay". The structural
 * half of that was several competing headline numbers and no answer to the
 * question a brand owner arrived with; this is the answer, and it is a sentence
 * rather than a figure because a figure is what the rail already is.
 *
 * BYTE-IDENTICAL IN apps/public AND apps/web, pinned by headline.test.ts the way
 * theme.tsx is pinned. The two apps are separate deploys (ADR-0002) and cannot
 * share an import, and this is the one sentence a customer reads on both — two
 * copies free to drift would be two products describing one measurement
 * differently. That is why the props are PRIMITIVES rather than a scan: the
 * Grader has a `ScanResultFile`, the dashboard has fixtures, and a component
 * that took either could not be the same file in both trees.
 *
 * IT IS NOT MARKED `.detail`, AND THAT IS THE DESIGN. The obvious construction
 * — sentence at simple depth, rail at detailed — needs a rule that hides things
 * when the depth is NOT simple, and every such rule breaks the fail-open
 * guarantee in ADR-0010: a reader whose JavaScript never ran has no attribute,
 * so they would lose it. Rendering at both depths costs a detailed reader one
 * lede above an instrument they were going to read anyway, which is what a lede
 * is for, and costs the stylesheet no inverted rule at all.
 *
 * R8 HOLDS IN WORDS. Whichever branch runs, the sentence carries the estimate,
 * both bounds, `n` and the engine count — so the plain reading is not the
 * number with its uncertainty removed, it is the same disclosure typeset for
 * someone who has never thought about a confidence interval. A screen reader
 * gets the bounds in the same sentence a sighted reader does, which a tooltip
 * could never manage.
 */
export function Headline({ subject, metric, engines }: { subject: string; metric: Metric; engines: number }) {
  const spoken = formatFrequency(metric)

  /*
   * THE ZERO CASE YIELDS TO THE SURFACE'S OWN TREATMENT rather than printing the
   * same finding twice. `formatFrequency` returns a `none` shape carrying its
   * upper bound and nothing here reads it: the Grader's record already says
   * "not mentioned in any of the N answers… a real result with a real upper
   * bound, not an error", and adds the domain-label caveat, which is more than
   * a lede should carry.
   */
  if (spoken.kind === 'none') return null

  const from = `From ${metric.n} answers${engines > 0 ? ` across ${engines} ${engines === 1 ? 'engine' : 'engines'}` : ''}.`

  /*
   * WHEN THE ESTIMATE LANDS ON ONE OF ITS OWN BOUNDS, STATE THE RANGE INSTEAD.
   *
   * "1 in k" is coarse, so a tight interval can round its estimate onto a
   * bound: at n=750 and p̂=29.3% the sentence came out "in about 1 in 3
   * answers. Could be as few as 1 in 4, or as many as 1 in 3" — a last clause
   * that says nothing and reads like a bug. Rare (about one spoken case in
   * twenty-five) and not obscure: it was the shape of the dashboard's own
   * figures, which is where it was found, by rendering the page rather than by
   * reading the code.
   *
   * The range form drops the separate point estimate, and that is not a loss of
   * disclosure — at this granularity the estimate IS one of the two bounds, so
   * naming it again adds no information. It is also the product's own signature
   * read back in words: the rail directly below makes the interval the dominant
   * shape and the estimate a mark inside it, with value, bounds, n and
   * provenance all still on the page.
   *
   * `formatFrequency` returns the k values precisely so a surface can see this;
   * the arithmetic stays in packages/stats and the wording stays here.
   */
  const collides = spoken.kind === 'ratio' && (spoken.pointK === spoken.highK || spoken.pointK === spoken.lowK)

  return (
    <div className="headline">
      <p className="headline__claim">
        AI assistants mention <strong>{subject}</strong>{' '}
        {spoken.kind === 'ratio' && collides ? (
          <>
            in <span className="num">{spoken.low}</span> to <span className="num">{spoken.high}</span> answers.
          </>
        ) : (
          <>
            in about <span className="num">{spoken.kind === 'ratio' ? spoken.point : formatValue(metric)}</span>{' '}
            {spoken.kind === 'ratio' ? 'answers' : 'of answers'}.
          </>
        )}
      </p>
      <p className="headline__range">
        {spoken.kind === 'ratio' ? (
          collides ? null : (
            <>
              {/* "none at all" is a legitimate low bound here — it is what a
                  Wilson interval touching zero actually says, and it reads as a
                  word rather than as an unreadable denominator. */}
              Could be as few as <span className="num">{spoken.low}</span>, or as many as <span className="num">{spoken.high}</span>.{' '}
            </>
          )
        ) : (
          <>
            {/* THE FALLBACK IS NOT A DEGRADED RENDERING. Outside the narrow band
                where "1 in k" is both faithful and legible, a percentage with
                its interval is the honest rendering of this number, and it is
                exact where the frequency would have been approximate. */}
            The range is <span className="num">{formatInterval(metric)}</span>.{' '}
          </>
        )}
        {from}
      </p>
    </div>
  )
}
