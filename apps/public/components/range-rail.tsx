import { formatInterval, formatValue, type Metric } from '@bliprank/stats'

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
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  const pct = (x: number) => `${clamp(x) * 100}%`
  // The needle is 7px wide and has to stay INSIDE the track it marks. Positioned
  // by its centre it loses half its body at either end of the scale, and the
  // ends are exactly where it matters: a brand at 0.0% (Close, in the collected
  // result) or a saturated 100% is the reading a sceptic checks hardest. So the
  // travel is the track minus the needle, the way a slider thumb is placed.
  const needle = (x: number) => `calc((100% - 7px) * ${clamp(x)})`

  /*
   * THE SIGNATURE MOTION. The band grows OUTWARD FROM THE ESTIMATE to its true
   * bounds, rather than sweeping in from the left.
   *
   * That is not decoration, it is the product's whole argument played once: a
   * measurement starts as a point and the honest version of it is the range that
   * opens around that point. Every competitor animates a bar filling up, which
   * says "bigger is better"; this says "here is what we know, and here is how
   * much we do not".
   *
   * Implemented as `scaleX` about a computed origin, never as an animation of
   * `width` or `left` — those two run layout on every frame, and this sits on a
   * page that may be rendering a chart at the same time.
   */
  const span = metric.ci_high - metric.ci_low
  const origin = span > 0 ? `${clamp((metric.value - metric.ci_low) / span) * 100}%` : '50%'

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
        <div className="rail__band" style={{ left: pct(metric.ci_low), width: pct(span), transformOrigin: `${origin} center` }} />
        <div className="rail__needle" style={{ left: needle(metric.value) }} />
      </div>

      {/*
        THE BOUNDS SIT UNDER THE EDGES THEY DESCRIBE. They used to sit at the
        far corners of the track, where on a fixed 0-100 scale they read as
        the scale's endpoints — "34.6" under the 0 end is a mislabelled axis,
        not a bound. Each figure is now positioned at its own edge (clamped so
        it never leaves the track), a narrow interval merges the two into one
        label rather than overprinting them, and the quiet 0 / 100 endpoints
        state the fixed scale — yielding whenever a bound needs their corner.
      */}
      <BoundsRow lo={metric.ci_low * 100} hi={metric.ci_high * 100} dp={dp} />

      <p className="visually-hidden">
        95% confidence interval {formatInterval(metric, dp)}, sample size {metric.n}.
      </p>
    </div>
  )
}

function BoundsRow({ lo, hi, dp }: { lo: number; hi: number; dp: number }) {
  // Below ~10 points of separation two mono labels overprint, so a narrow
  // interval prints once, as the range it is.
  const narrow = hi - lo < 10
  const at = (x: number) => `${Math.min(97, Math.max(3, x))}%`
  const leftmost = narrow ? (lo + hi) / 2 : lo
  const rightmost = narrow ? (lo + hi) / 2 : hi

  return (
    <div className="rail__bounds rail__bounds--scale" aria-hidden="true">
      {leftmost >= 10 ? <span className="rail__end">0</span> : null}
      {narrow ? (
        <span className="rail__bound" style={{ left: at((lo + hi) / 2) }}>
          {lo.toFixed(dp)}–{hi.toFixed(dp)}
        </span>
      ) : (
        <>
          <span className="rail__bound" style={{ left: at(lo) }}>
            {lo.toFixed(dp)}
          </span>
          <span className="rail__bound" style={{ left: at(hi) }}>
            {hi.toFixed(dp)}
          </span>
        </>
      )}
      {rightmost <= 90 ? <span className="rail__end rail__end--hi">100</span> : null}
    </div>
  )
}
