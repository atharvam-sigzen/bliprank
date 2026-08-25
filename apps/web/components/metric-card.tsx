import { compare, formatProvenance, type Metric } from '@bliprank/stats'
import { RangeRail } from './range-rail'

/**
 * The one way a number reaches the screen.
 *
 * Rule R8 in a component: the props type is `Metric`, which has no optional
 * fields, so there is no way to render this card without an interval, an `n`, an
 * algorithm version and a collection path. Dropping provenance would be a type
 * error rather than an oversight caught in review.
 *
 * The interval is not small print. It sits under the value at a size that reads
 * as part of the same number — a customer who never notices it has been misled
 * by our layout, which is no better than being misled by our arithmetic.
 */
export function MetricCard({ label, metric, previous }: { label: string; metric: Metric; previous?: Metric }) {
  const comparison = previous ? compare(metric, previous) : null

  return (
    <article className="card">
      {/* The rail leads. What used to be here was a big number with the interval
          set beneath it as small print — the exact hierarchy this product argues
          against, in the component built to demonstrate the argument. */}
      <RangeRail label={label} metric={metric} />

      {comparison ? <DeltaBadge comparison={comparison} /> : null}

      <p className="metric__provenance">{formatProvenance(metric)}</p>
    </article>
  )
}

/**
 * Week-on-week movement.
 *
 * If the intervals overlap, this says "no significant change" and gets no
 * colour, no arrow and no emphasis. That is the whole rule. Drawing a green
 * arrow on a movement the sample cannot resolve is the most common dishonesty
 * in this category and the specific thing customers pay us not to do.
 *
 * When a change IS significant it is marked with weight, a glyph AND a word —
 * never colour alone, which is invisible to a colour-blind reader and to anyone
 * printing the report in greyscale.
 */
export function DeltaBadge({ comparison }: { comparison: ReturnType<typeof compare> }) {
  const significant = comparison.significance === 'higher' || comparison.significance === 'lower'
  const glyph =
    comparison.significance === 'higher' ? '▲' : comparison.significance === 'lower' ? '▼' : comparison.significance === 'not-comparable' ? '≠' : '–'

  return (
    <p className={`delta${significant ? ' delta--significant' : ''}`} title={hint(comparison.significance)}>
      <span className="delta__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>{comparison.label}</span>
    </p>
  )
}

/**
 * The three non-significant verdicts mean genuinely different things, and a
 * reader who conflates them draws the wrong conclusion:
 *   no significant change  — measured, and the sample cannot resolve a change
 *   not enough data        — not enough runs to attempt the comparison at all
 *   not comparable         — the two numbers answer different questions (R5)
 */
function hint(s: ReturnType<typeof compare>['significance']): string | undefined {
  switch (s) {
    case 'no-significant-change':
      return 'The two confidence intervals overlap, so this sample cannot tell the cycles apart. See the methodology page.'
    case 'insufficient-data':
      return 'Too few runs in one of the cycles to compare them.'
    case 'not-comparable':
      return 'These measurements were produced by different scoring versions or collection paths, so comparing them would attribute a definition change to the brand.'
    default:
      return undefined
  }
}
