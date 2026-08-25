'use client'

import { useState } from 'react'
import { formatInterval, formatProvenance, formatValue } from '@bliprank/stats'
import { CHART, VERDICT_GLYPH, VERDICT_WORDS, chartHeight, xOf, yOf, type HeadToHead, type HeadToHeadRow } from '../lib/head-to-head'

/**
 * PHASES 3.4 — the head-to-head comparison, with every interval drawn.
 *
 * A thin renderer. Ordering, verdicts and geometry are all in
 * `lib/head-to-head.ts` and tested there; nothing below decides anything.
 *
 * Rule R8 in a component, the same way `MetricCard` does it: every row is typed
 * `HeadToHeadRow`, whose `metric` is a `Metric` with no optional fields. There
 * is no shape you can pass this that renders a point estimate without its
 * interval, its `n`, its algorithm version and its collection path — dropping
 * provenance would be a type error, not an oversight caught in review.
 *
 * The Confidence Grade is displayed by the caller and never consulted here. The
 * thresholds behind it are provisional (`CONFIDENCE_GRADE_STATUS`), so any chart
 * logic keyed on "is this a good grade" would bake a placeholder into the shape
 * of the picture, where it is far harder to find than a constant.
 */
export function HeadToHeadChart({ data, subjectLabel }: { data: HeadToHead; subjectLabel: string }) {
  const [active, setActive] = useState<number | null>(null)
  const { rows } = data
  const H = chartHeight(rows.length)
  const plotRight = CHART.width - CHART.padRight
  const ticks = [0, 0.25, 0.5, 0.75, 1]

  const bandLeft = xOf(data.subject.metric.ci_low)
  const bandRight = xOf(data.subject.metric.ci_high)
  const plotTop = CHART.padTop - 8
  const plotBottom = CHART.padTop + rows.length * CHART.rowHeight

  const describe = rows
    .map((r) => `${r.label}, ${formatValue(r.metric)}, interval ${formatInterval(r.metric)}, n equals ${r.metric.n}, ${VERDICT_WORDS[r.verdict]}`)
    .join('. ')

  return (
    <figure style={{ margin: 0 }}>
      <svg
        className="chart"
        viewBox={`0 0 ${CHART.width} ${H}`}
        role="img"
        aria-label={`How ${subjectLabel} compares with its category, each with its 95% confidence interval. ${describe}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart__axis" x1={xOf(t)} x2={xOf(t)} y1={plotTop} y2={plotBottom} />
            <text className="chart__tick" x={xOf(t)} y={H - 14} textAnchor="middle">
              {t * 100}%
            </text>
          </g>
        ))}

        {/* The subject's interval, projected across every row. This is the mark
            that stops the vertical ordering from reading as a league table: a
            bar that touches this region is a brand the sample cannot separate
            from yours, whatever order it happens to sit in. */}
        <rect className="h2h__band" x={bandLeft} y={plotTop} width={Math.max(1, bandRight - bandLeft)} height={plotBottom - plotTop} />
        <line className="h2h__band-edge" x1={bandLeft} x2={bandLeft} y1={plotTop} y2={plotBottom} />
        <line className="h2h__band-edge" x1={bandRight} x2={bandRight} y1={plotTop} y2={plotBottom} />

        {rows.map((row, i) => (
          <Row key={row.label} row={row} y={yOf(i)} />
        ))}

        {/*
          A full-width hotspot per row, drawn last so it sits above the marks.
          Real buttons rather than hover targets: hover does not exist on touch,
          and a bar 3px tall is not a pointer target on a phone either. The row
          band is.
        */}
        {rows.map((row, i) => (
          <rect
            key={`hit-${row.label}`}
            className="h2h__row-hit"
            x={2}
            y={yOf(i) - CHART.rowHeight / 2}
            width={CHART.width - 4}
            height={CHART.rowHeight}
            rx={3}
            tabIndex={0}
            role="button"
            aria-label={`${row.label}: ${formatValue(row.metric)}, 95% interval ${formatInterval(row.metric)}, n=${row.metric.n}, ${VERDICT_WORDS[row.verdict]}`}
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
        ))}

        <text className="chart__tick" x={plotRight} y={H - 14} textAnchor="end">
          mention rate
        </text>
      </svg>

      <RowTip rows={rows} active={active} subjectLabel={subjectLabel} />

      {/* A screen reader cannot navigate a concatenated aria-label row by row,
          so the same data is offered as a real table — including the verdict as
          a word, because the glyph in the chart is not readable as one. */}
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">How {subjectLabel} compares with its category</caption>
          <thead>
            <tr>
              <th scope="col">Brand</th>
              <th scope="col">Estimate</th>
              <th scope="col">95% interval</th>
              <th scope="col">n</th>
              <th scope="col">Versus you</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">
                  {row.label}
                  {row.isSubject ? ' (you)' : ''}
                </th>
                <td className="num">{formatValue(row.metric)}</td>
                <td className="num">{formatInterval(row.metric)}</td>
                <td className="num">{row.metric.n}</td>
                {/* `comparison.label` is not reused here: it is worded for
                    week-on-week ("+4.2% vs previous") and this axis is not time.
                    format.ts is HUMAN-OWNED and mid-review, so the wording is
                    adapted at the call site rather than by editing it. */}
                <td>{row.isSubject ? '—' : VERDICT_WORDS[row.verdict]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <figcaption className="chart__legend">
        <span>
          <span className="chart__swatch" style={{ background: 'var(--color-primary)' }} aria-hidden="true" />
          Your estimate and range
        </span>
        <span>
          <span className="chart__swatch" style={{ background: 'var(--color-secondary)' }} aria-hidden="true" />
          Competitor range
        </span>
        <span>
          <span
            className="chart__swatch"
            style={{ background: 'var(--color-muted)', outline: '1px dashed var(--color-primary)' }}
            aria-hidden="true"
          />
          Your interval, projected
        </span>
        <span>Ordered by estimate. Order is not a ranking — see below.</span>
        <span>Scale fixed 0–100%, never auto-fitted.</span>
      </figcaption>

      {/* Provenance travels with the number on the free surface too — this is
          the page most likely to be screenshotted beside a competitor's tool. */}
      <p className="metric__provenance">{formatProvenance(data.subject.metric)} · all brands scored over the same scan unless the table says otherwise</p>
    </figure>
  )
}

function Row({ row, y }: { row: HeadToHeadRow; y: number }) {
  const lo = xOf(row.metric.ci_low)
  const hi = xOf(row.metric.ci_high)
  const mid = xOf(row.metric.value)
  const uncompared = row.verdict === 'insufficient-data' || row.verdict === 'not-comparable'
  const cap = 5

  return (
    <g>
      <text className={`h2h__label${row.isSubject ? ' h2h__label--subject' : ''}`} x={CHART.padLeft - 8} y={y + 4} textAnchor="end">
        {row.isSubject ? '▸ ' : ''}
        {row.label.length > 13 ? `${row.label.slice(0, 12)}…` : row.label}
      </text>

      <line
        className={`h2h__interval${row.isSubject ? ' h2h__interval--subject' : ''}${uncompared ? ' h2h__interval--uncompared' : ''}`}
        x1={lo}
        x2={hi}
        y1={y}
        y2={y}
      />
      {/* End caps, so a narrow interval still reads as a range rather than as a
          slightly fat dot. The bound is the number a sceptic checks first. */}
      {[lo, hi].map((x) => (
        <line key={x} className={`h2h__cap${row.isSubject ? ' h2h__cap--subject' : ''}`} x1={x} x2={x} y1={y - cap} y2={y + cap} />
      ))}
      {/* A collar, for the same reason the range rail has one: the primary dot
          sits ON the secondary bar and computes 1.63:1 against it — invisible,
          and missed by every contrast assertion because those check marks
          against SURFACES, never against other marks. */}
      <circle className="h2h__dot-collar" cx={mid} cy={y} r={row.isSubject ? 6.5 : 5.5} />
      <circle className="h2h__dot" cx={mid} cy={y} r={row.isSubject ? 4 : 3} />

      <text className="h2h__glyph" x={CHART.width - CHART.padRight + 6} y={y + 4} textAnchor="start" aria-hidden="true">
        {VERDICT_GLYPH[row.verdict]}
      </text>
    </g>
  )
}

/**
 * The detail panel for the hovered, tapped or focused brand.
 *
 * The verdict is the point of it. A reader looking at two bars that nearly touch
 * wants to know whether the difference is real, and this is where the chart
 * answers in words rather than leaving them to judge overlap by eye — which is
 * exactly the judgement the product argues nobody should have to make.
 */
function RowTip({ rows, active, subjectLabel }: { rows: readonly HeadToHeadRow[]; active: number | null; subjectLabel: string }) {
  if (active === null) {
    return (
      <div className="tip" aria-live="polite">
        <p className="tip__idle" style={{ margin: 0 }}>
          Hover, tap or tab to a brand for its interval and how it compares with {subjectLabel}.
        </p>
      </div>
    )
  }
  const row = rows[active]!
  return (
    <div className="tip" aria-live="polite">
      <div className="tip__head">
        <span>
          {row.label}
          {row.isSubject ? ' — your brand' : ''}
        </span>
        <span className="tip__value">{formatValue(row.metric)}</span>
      </div>
      <p className="tip__row" style={{ margin: 0 }}>
        95% interval {formatInterval(row.metric)} · n={row.metric.n}
      </p>
      <p className="tip__row" style={{ margin: 0 }}>
        {row.isSubject ? 'This is the domain being graded.' : `Versus ${subjectLabel}: ${VERDICT_WORDS[row.verdict]}.`}
      </p>
      <p className="tip__row" style={{ margin: 0 }}>
        {formatProvenance(row.metric)}
      </p>
    </div>
  )
}
