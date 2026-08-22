import { compare, formatInterval, formatProvenance, formatValue, type Metric } from '@bliprank/stats'

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
      <h2>{label}</h2>

      <p className="metric__value">{formatValue(metric)}</p>

      {/* The interval carries its own label for screen readers: "24.7 percent"
          followed by a bare range would otherwise be two unrelated numbers. */}
      <p className="metric__interval">
        <span className="visually-hidden">95% confidence interval: </span>
        {formatInterval(metric)}
        <span aria-hidden="true"> · </span>
        <span className="visually-hidden">sample size </span>n={metric.n}
      </p>

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
  const glyph = comparison.significance === 'higher' ? '▲' : comparison.significance === 'lower' ? '▼' : '–'

  return (
    <p className={`delta${significant ? ' delta--significant' : ''}`}>
      <span className="delta__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>{comparison.label}</span>
    </p>
  )
}
