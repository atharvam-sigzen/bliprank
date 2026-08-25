import { formatInterval, formatProvenance, formatValue, type Metric } from '@bliprank/stats'

/**
 * THE SIGNATURE: the interval is the hero and the estimate is a mark inside it.
 *
 * Every tool in this category renders a confident figure. This one cannot be
 * looked at without seeing how much it does not know — the range is the
 * dominant shape on the card, drawn against the full 0-100% scale so a wide
 * interval looks wide and a narrow one looks narrow.
 *
 * The scale is fixed, never fitted. Fitting it to the interval would draw a
 * 17-45% range and a 2-4% range at identical width, which is the chart lying by
 * omission — and it is the same rule the trend and head-to-head charts follow.
 *
 * THE NUMBER STILL HAS ITS OWN JOB. The range is the dominant SHAPE; the figure
 * is the fastest DATUM. It stays large, heavy, near-black (18.5:1 light,
 * 15.3:1 dark) and in a FIXED position — a number that slides along with the
 * estimate cannot be found at a glance, which defeats the point of it.
 *
 * R8: the prop is a `Metric`, which has no optional fields. There is no shape
 * you can pass that renders a value without its interval, its n, its algorithm
 * version and its collection path.
 */
export function RangeRail({ label, metric, dp = 1 }: { label: string; metric: Metric; dp?: number }) {
  const pct = (x: number) => `${Math.min(100, Math.max(0, x * 100))}%`

  return (
    <div className="rail">
      <div className="rail__head">
        <h2>{label}</h2>
        <span className="rail__n">n = {metric.n}</span>
      </div>

      <p className="rail__value">{formatValue(metric, dp)}</p>

      {/*
        aria-hidden: the rail is a picture of numbers a screen reader already
        has from the value and the bounds below it. Announcing the geometry as
        well would be the same fact three times.
      */}
      <div className="rail__track" aria-hidden="true">
        <div className="rail__band" style={{ left: pct(metric.ci_low), width: pct(metric.ci_high - metric.ci_low) }} />
        <div className="rail__needle" style={{ left: pct(metric.value) }} />
      </div>

      <p className="rail__bounds" aria-hidden="true">
        <span>{(metric.ci_low * 100).toFixed(dp)}</span>
        <span>{(metric.ci_high * 100).toFixed(dp)}</span>
      </p>

      <p className="visually-hidden">
        95% confidence interval {formatInterval(metric, dp)}, sample size {metric.n}.
      </p>
    </div>
  )
}

/** The provenance line, unchanged in substance and set as a footer. */
export function RailProvenance({ metric }: { metric: Metric }) {
  return <p className="metric__provenance">{formatProvenance(metric)}</p>
}
