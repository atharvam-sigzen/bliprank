/**
 * ⚠️ THE BAND AND THE LINE BREAK AT THE SAME PLACES.
 *
 * THE DEFECT THIS PINS. The line was segmented on `continuous` — same
 * `algo_version`, `collection_path` and `comparison_basis` — and the band was
 * one polygon over every point. So after a scoring bump the ribbon joined two
 * measurements that the line, the verdict beneath it and `compare()` itself all
 * refuse to join. The ribbon is the part carrying the uncertainty, which is the
 * part a reader uses to decide whether movement is real, so it was the worse
 * half to get wrong.
 *
 * It was unreachable when found on 2026-09-07 — every domain held one cycle, so
 * no line was drawn at all. Arming the daily loop is what produces second
 * cycles, and det-3 has just moved every stored result, so the next collected
 * cycle for any domain lands on the far side of a boundary. Fixed before that
 * rather than after.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * These assertions read the `d` attribute of each path, because that is where
 * the defect lived. A subpath begins at an `M`: two `M`s in the band means the
 * band broke, one means it spanned. Counting them is the whole test.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Metric } from '@bliprank/stats'
import { CiTrendChart, type TrendPoint } from './ci-trend-chart'

const BASIS = 'grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=17|runs=1'

const metric = (over: Partial<Metric> = {}): Metric => ({
  value: 0.4,
  ci_low: 0.3,
  ci_high: 0.5,
  n: 85,
  algo_version: 'det-3',
  collection_path: 'third-party-grounded',
  comparison_basis: BASIS,
  ...over,
})

const point = (cycle: string, over: Partial<Metric> = {}): TrendPoint => ({ cycle, metric: metric(over) })

const paths = (points: readonly TrendPoint[]) => {
  const html = renderToStaticMarkup(<CiTrendChart points={points} title="Mention rate" />)
  const grab = (cls: string) => new RegExp(`class="${cls}" d="([^"]*)"`).exec(html)?.[1] ?? ''
  return { band: grab('chart__band'), line: grab('chart__line'), html }
}
/** A subpath starts at an `M`. Counting them counts the breaks. */
const subpaths = (d: string) => (d.match(/M/g) ?? []).length

describe('a run of comparable cycles', () => {
  it('draws one unbroken line and one unbroken band', () => {
    const { band, line } = paths([point('2026-09-01'), point('2026-09-02'), point('2026-09-03')])
    expect(subpaths(line)).toBe(1)
    expect(subpaths(band)).toBe(1)
  })
})

describe('⚠️ a version boundary', () => {
  const across = [point('2026-09-01', { algo_version: 'det-2' }), point('2026-09-02', { algo_version: 'det-3' })]

  it('breaks the line AND the band, not just the line', () => {
    const { band, line } = paths(across)
    expect(subpaths(line), 'the line should break at the bump').toBe(2)
    expect(subpaths(band), 'the band must break at the same place — this is the defect').toBe(2)
  })

  it('breaks both at a changed basis, which a promoted competitor set causes', () => {
    // ADR-0009 Amendment 3: promoting a competitor moves `category@version` in
    // the basis. Same scoring version, different measurement.
    const { band, line } = paths([point('2026-09-01'), point('2026-09-02', { comparison_basis: BASIS.replace('@1', '@2') })])
    expect(subpaths(line)).toBe(2)
    expect(subpaths(band)).toBe(2)
  })

  it('breaks both at a changed collection path', () => {
    const { band, line } = paths([point('2026-09-01'), point('2026-09-02', { collection_path: 'own-index' as Metric['collection_path'] })])
    expect(subpaths(line)).toBe(2)
    expect(subpaths(band)).toBe(2)
  })

  it('⚠️ the two marks agree on EVERY boundary, over a mixed history', () => {
    // The property, rather than one case: whatever the history, the number of
    // pieces is the same for both. A future edit that segments one and not the
    // other fails here even if it invents a new reason to break.
    const history = [
      point('2026-09-01', { algo_version: 'det-2' }),
      point('2026-09-02', { algo_version: 'det-2' }),
      point('2026-09-03', { algo_version: 'det-3' }),
      point('2026-09-04', { algo_version: 'det-3', comparison_basis: BASIS.replace('@1', '@2') }),
      point('2026-09-05', { algo_version: 'det-3', comparison_basis: BASIS.replace('@1', '@2') }),
    ]
    const { band, line } = paths(history)
    expect(subpaths(line)).toBe(3)
    expect(subpaths(band)).toBe(subpaths(line))
  })
})

describe('a cycle alone on its side of a boundary still shows its interval', () => {
  it('⚠️ draws a band segment for a single-point run rather than nothing', () => {
    // The common shape straight after a bump: one old cycle, one new one. The
    // new run holds a single point, and the band for it collapses to a vertical
    // segment from ci_high to ci_low — which `.chart__band`'s stroke draws as an
    // error bar. Losing the band exactly when the version moves would take the
    // uncertainty away from the reader who most needs it.
    const { band } = paths([point('2026-09-01', { algo_version: 'det-2' }), point('2026-09-02', { algo_version: 'det-3', ci_low: 0.2, ci_high: 0.6 })])
    const second = band.split('M')[2] ?? ''
    // Two distinct y values at one x: the interval, drawn.
    const ys = [...second.matchAll(/,(\d+\.\d)/g)].map((m) => m[1])
    expect(new Set(ys).size, 'the lone point should span its interval, not collapse to a dot').toBe(2)
  })

  it('a chart with exactly one cycle still draws its band', () => {
    const { band, line } = paths([point('2026-09-01')])
    expect(subpaths(band)).toBe(1)
    expect(subpaths(line)).toBe(1)
    expect(band).toContain('Z')
  })
})

describe('what the chart still refuses', () => {
  it('says so plainly with no cycles at all', () => {
    expect(renderToStaticMarkup(<CiTrendChart points={[]} title="Mention rate" />)).toContain('No cycles collected yet')
  })

  it('the accessible description carries every interval, boundary or not', () => {
    const { html } = paths([point('2026-09-01', { algo_version: 'det-2' }), point('2026-09-02', { algo_version: 'det-3' })])
    expect(html).toContain('aria-label')
    expect((html.match(/interval/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
