import type { Metric } from '@bliprank/stats'
import { formatInterval, formatValue } from '@bliprank/stats'

export interface TrendPoint {
  /** Cycle label, e.g. an ISO date. */
  readonly cycle: string
  readonly metric: Metric
}

/**
 * Visibility over cycles, drawn with its confidence band.
 *
 * The band is not decoration and it is not optional. A bare trend line implies
 * the movement between two points is real; the band is what tells the reader
 * whether it is. Where consecutive bands overlap heavily, the line between them
 * is not evidence of anything, and the chart has to make that obvious at a
 * glance rather than in a footnote.
 *
 * Inline SVG rather than a charting library: this is one shape (a band plus a
 * line), the axis is a fixed 0-100%, and every library that could draw it would
 * also make it easy to draw the line *without* the band. Visx arrives when the
 * per-prompt drill-down needs interaction (P4.2).
 */
export function CiTrendChart({ points, title, height = 200 }: { points: readonly TrendPoint[]; title: string; height?: number }) {
  if (points.length === 0) return <p className="metric__interval">No cycles collected yet.</p>

  const W = 600
  const H = height
  const PAD = { top: 12, right: 12, bottom: 26, left: 38 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  // Fixed 0–100% scale, never auto-fitted to the data. Auto-fitting a
  // proportion chart magnifies noise into a mountain range — the classic way to
  // make a 2-point wobble look like a trend.
  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW)
  const y = (v: number) => PAD.top + (1 - v) * plotH

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.metric.value).toFixed(1)}`).join(' ')
  const band = [
    ...points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.metric.ci_high).toFixed(1)}`),
    ...[...points].reverse().map((p, i) => `L${x(points.length - 1 - i).toFixed(1)},${y(p.metric.ci_low).toFixed(1)}`),
    'Z',
  ].join(' ')

  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const describe = points.map((p) => `${p.cycle}: ${formatValue(p.metric)}, interval ${formatInterval(p.metric)}, n=${p.metric.n}`).join('. ')

  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${describe}`} preserveAspectRatio="xMidYMid meet">
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart__axis" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="chart__tick" x={PAD.left - 6} y={y(t) + 3} textAnchor="end">
              {t * 100}%
            </text>
          </g>
        ))}

        {/* Band first, so the line reads on top of its own uncertainty. */}
        <path className="chart__band" d={band} />
        <path className="chart__line" d={line} />

        {points.map((p, i) => (
          <circle key={p.cycle} className="chart__dot" cx={x(i)} cy={y(p.metric.value)} r={3} />
        ))}

        {points.map((p, i) => (
          <text key={p.cycle} className="chart__tick" x={x(i)} y={H - 8} textAnchor="middle">
            {p.cycle.slice(5)}
          </text>
        ))}
      </svg>

      <figcaption className="chart__legend">
        <span>
          <span className="chart__swatch" style={{ background: 'var(--color-primary)' }} aria-hidden="true" />
          Estimate
        </span>
        <span>
          <span className="chart__swatch" style={{ background: 'var(--color-secondary)', opacity: 0.3 }} aria-hidden="true" />
          95% confidence interval
        </span>
        <span>Scale fixed 0–100%, never auto-fitted.</span>
      </figcaption>
    </figure>
  )
}
