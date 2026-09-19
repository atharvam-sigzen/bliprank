'use client'

import { useState } from 'react'
import type { Metric } from '@bliprank/stats'
import { formatInterval, formatProvenance, formatValue } from '@bliprank/stats'
import { compareCycles, continuousCycles } from '@/lib/compare-cycles'

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
  const [active, setActive] = useState<number | null>(null)
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

  /*
   * R5: charts show a version boundary. `compare()` refuses across a scoring
   * bump or a changed measurement basis, so drawing those points as one
   * continuous shape would reassert on the chart exactly the comparison the
   * number below it declines to make.
   *
   * ⚠️ THE BAND USED TO SPAN A BOUNDARY THE LINE BROKE AT. The line was
   * segmented on `continuous` and the band was one polygon over every point,
   * so after a version bump the ribbon joined two measurements the line, the
   * verdict and `compare()` all refused to join — and the ribbon is the part
   * that carries the uncertainty, which is the part a reader uses to decide
   * whether movement is real. Found in review on 2026-09-07 while it was still
   * unreachable (every domain had one cycle) and fixed before the daily loop
   * makes second cycles routine.
   *
   * The fix is one segmentation, computed once, consumed by both marks. Two
   * derivations of "may these points be joined" is what let them disagree in
   * the first place, and a second copy would drift again.
   */
  // The basis is read by its own rule (`sameBasis`, through `continuousCycles`): a revert to a list asked before is one sample under a new version number, and the line joins it.
  const continuous = (a: TrendPoint, b: TrendPoint) => continuousCycles(a.metric, b.metric)

  /** Contiguous runs of comparable points, as indices into `points`. */
  const runs: number[][] = []
  points.forEach((p, i) => {
    if (i === 0 || !continuous(points[i - 1]!, p)) runs.push([i])
    else runs[runs.length - 1]!.push(i)
  })

  const line = runs
    .map((run) => run.map((i, k) => `${k === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(points[i]!.metric.value).toFixed(1)}`).join(' '))
    .join(' ')

  /*
   * One closed sub-path per run. A run of a single point collapses to a
   * vertical segment from `ci_high` to `ci_low`, which `.chart__band`'s stroke
   * draws as an error bar — so the cycle that opens a new version still shows
   * its interval instead of losing the band the moment it is alone. That case
   * is the common one right after a bump, and it is exactly the reader who most
   * needs the uncertainty in front of them.
   */
  const band = runs
    .map((run) =>
      [
        ...run.map((i, k) => `${k === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(points[i]!.metric.ci_high).toFixed(1)}`),
        ...[...run].reverse().map((i) => `L${x(i).toFixed(1)},${y(points[i]!.metric.ci_low).toFixed(1)}`),
        'Z',
      ].join(' '),
    )
    .join(' ')

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

        {active !== null ? <line className="chart__crosshair" x1={x(active)} x2={x(active)} y1={PAD.top} y2={H - PAD.bottom} /> : null}

        {/*
          One hotspot per point, wide enough to be a 44px-class target on a
          phone rather than a 3px dot. Every one is a real focusable control:
          the guidance is explicit that a hover-only affordance simply does not
          exist on touch, and a `div` with an onMouseEnter is not operable by
          keyboard either. Drawn last so they sit above the marks.
        */}
        {points.map((p, i) => {
          // Clamped to the plot. With `overflow: visible` on the SVG, a target
          // centred on the last point used to hang past the right edge of the
          // drawing, and on a phone that was the one element wider than the
          // viewport — a horizontal scroll caused by an invisible rectangle.
          const half = Math.max(12, plotW / (points.length * 2))
          const x0 = Math.max(PAD.left, x(i) - half)
          const x1 = Math.min(W - PAD.right, x(i) + half)
          return (
          <rect
            key={`hit-${p.cycle}`}
            className="chart__hit"
            x={x0}
            y={PAD.top}
            width={x1 - x0}
            height={plotH}
            rx={3}
            tabIndex={0}
            role="button"
            aria-label={`${p.cycle}: ${formatValue(p.metric)}, 95% interval ${formatInterval(p.metric)}, n=${p.metric.n}`}
            aria-pressed={active === i}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            onClick={() => setActive((c) => (c === i ? null : i))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActive((c) => (c === i ? null : i))
              }
              if (e.key === 'Escape') setActive(null)
            }}
          />
          )
        })}
      </svg>

      <TrendTip points={points} active={active} />

      {/* A screen reader cannot navigate a concatenated aria-label point by
          point, so the same data is offered as a real table.

          Hidden by a WRAPPER, not by the class on the table. A table never lays
          out narrower than its content, so `.visually-hidden`'s 1px width did
          not hold and the nowrap rows sat 300px wide past the right edge of a
          phone — measured as the one element overflowing a 390px viewport. A
          block wrapper clips at 1px as intended. */}
      <div className="visually-hidden">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Cycle</th>
            <th scope="col">Estimate</th>
            <th scope="col">95% interval</th>
            <th scope="col">Sample size</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.cycle}>
              <th scope="row">{p.cycle}</th>
              <td>{formatValue(p.metric)}</td>
              <td>{formatInterval(p.metric)}</td>
              <td>{p.metric.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <figcaption className="chart__legend">
        <span>
          <span className="chart__swatch" style={{ background: 'var(--color-primary)' }} aria-hidden="true" />
          Estimate
        </span>
        <span>
          {/* Matches the band's actual fill-opacity AND its actual edge colour.
              The key previously showed 0.3 for a band drawn at 0.16 — a legend
              that misdescribes the chart — and then kept a secondary outline
              after the edge moved to primary for contrast. */}
          <span className="chart__swatch chart__swatch--band" aria-hidden="true" />
          95% confidence interval
        </span>
        <span>Scale fixed 0–100%, never auto-fitted.</span>
      </figcaption>
    </figure>
  )
}

/**
 * The detail panel for the hovered, tapped or focused cycle.
 *
 * A block in the flow rather than a floating overlay: it cannot be clipped by
 * the SVG viewBox, it reflows on a narrow screen instead of hanging off the
 * edge, and `aria-live` announces it because it is live — not because a screen
 * reader happened to follow a pointer it does not have.
 *
 * It reserves its height whether or not anything is active, so hovering the
 * chart does not shove the rest of the page down (CLS).
 *
 * R8 applies here as much as anywhere: the panel shows the interval, the sample
 * size and the provenance, never a bare value. And where a cycle can be compared
 * with the one before it, the verdict is `compare()`'s, so a movement inside the
 * interval reads as "no significant change" here exactly as it does in a card.
 */
function TrendTip({ points, active }: { points: readonly TrendPoint[]; active: number | null }) {
  if (active === null) {
    return (
      <div className="tip" aria-live="polite">
        <p className="tip__idle" style={{ margin: 0 }}>
          Hover, tap or tab to a cycle for its interval and provenance.
        </p>
      </div>
    )
  }
  const p = points[active]!
  const prev = active > 0 ? points[active - 1] : undefined
  const verdict = prev ? compareCycles(p.metric, prev.metric) : null

  return (
    <div className="tip" aria-live="polite">
      <div className="tip__head">
        <span>{p.cycle}</span>
        <span className="tip__value">{formatValue(p.metric)}</span>
      </div>
      <p className="tip__row" style={{ margin: 0 }}>
        95% interval {formatInterval(p.metric)} · n={p.metric.n}
      </p>
      {verdict ? (
        <p className="tip__row" style={{ margin: 0 }}>
          vs {prev!.cycle}: {verdict.label}
        </p>
      ) : null}
      <p className="tip__row" style={{ margin: 0 }}>
        {formatProvenance(p.metric)}
      </p>
    </div>
  )
}
