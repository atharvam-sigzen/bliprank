/**
 * ALL SIX VERDICTS, ACTUALLY RENDERED.
 *
 * The sibling suite asserts that every verdict has a glyph, a phrase and a
 * reason. That is necessary and not sufficient: a verdict can be complete in the
 * lookup tables and still reach a branch the component does not handle, and the
 * committed scan only exercises four of the six. `insufficient-data` in
 * particular is currently UNREACHABLE from a live scan — every brand in a scan
 * shares one n, so a scan with n=85 can never produce it — which means it would
 * rot silently until the first scan small enough to trigger it, live, on stage.
 *
 * So the six are rendered here against a constructed dataset, and what a reader
 * must be able to find is asserted on the real markup.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { wilson, type Metric } from '@bliprank/stats'
import { SCAN_BASIS } from '../lib/fixtures'
import { HeadToHeadChart } from './head-to-head-chart'
import { VERDICT_WORDS, type HeadToHead, type HeadToHeadRow, type Verdict } from '../lib/head-to-head'

const ALL: Verdict[] = ['you', 'ahead', 'behind', 'indistinguishable', 'insufficient-data', 'not-comparable']

const metric = (k: number, n: number): Metric => {
  const w = wilson(k, n)
  return { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-1', collection_path: 'third-party-grounded', comparison_basis: SCAN_BASIS }
}

const row = (label: string, verdict: Verdict, hits: number, n: number): HeadToHeadRow => ({
  label,
  metric: metric(hits, n),
  isSubject: verdict === 'you',
  comparison: verdict === 'you' ? null : ({ label: verdict === 'not-comparable' ? 'precision differs' : 'x' } as never),
  verdict,
})

// Close's real shape from the collected pipedrive.com scan: 0 hits of 85, so a
// genuine 0.0% [0.0-4.3] whose interval is far tighter than the subject's.
const rows = [
  row('You Inc', 'you', 34, 85),
  row('Ahead Co', 'ahead', 60, 85),
  row('Same A', 'indistinguishable', 33, 85),
  row('Same B', 'indistinguishable', 35, 85),
  row('Behind Co', 'behind', 8, 85),
  row('Close', 'not-comparable', 0, 85),
  row('Thin Data', 'insufficient-data', 2, 11),
]
const data: HeadToHead = { rows, subject: rows[0]!, allIndistinguishable: false }
const html = renderToStaticMarkup(<HeadToHeadChart data={data} subjectLabel="You Inc" />)

describe('the chart renders every verdict it can produce', () => {
  it('every row appears, and none renders an empty verdict cell', () => {
    for (const r of rows) expect(html).toContain(r.label)
    expect(html).not.toMatch(/<td>\s*<\/td>/)
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('NaN')
  })

  it('each verdict states itself in words, not only as a glyph', () => {
    for (const v of ALL.filter((v) => v !== 'you')) expect(html).toContain(VERDICT_WORDS[v])
  })

  it('a refused row says WHY in the table, where a screen reader will reach it', () => {
    // The dashed bar and the "≠" are aria-hidden. Without this the one reader
    // who cannot see the chart gets strictly less than everyone else.
    expect(html).toContain('its range is far tighter than yours')
    expect(html).toContain('too few answers to compare')
  })

  it('a refused row is drawn dashed AND labelled as set aside', () => {
    expect(html).toContain('h2h__interval--uncompared')
    expect(html).toContain('h2h__label--uncompared')
    // ...and the legend explains that dash, rather than leaving the reader to
    // match it against the dashed swatch that means something else.
    expect(html).toContain('Measured, but not ranked against you')
  })

  it('a brand measured at 0% still shows its real number and its bound', () => {
    // Never blanked, never rounded away: the refusal is about the COMPARISON.
    expect(html).toContain('0.0%')
    // ⚠️ Note the asymmetry: the estimate prints '0.0%' and the bound prints
    // '0', not '0.0'. Every other interval on this table carries 1dp on both
    // bounds, so an exact zero is the one row whose decimals do not line up in a
    // tabular-figures column. `formatInterval` lives in format.ts, which is
    // HUMAN-OWNED, so this asserts what ships rather than changing it.
    expect(html).toContain('0–4.3%')
  })

  it('no mark escapes the plot, at either end of the scale', () => {
    for (const m of html.matchAll(/<circle class="h2h__dot-collar" cx="([\d.]+)"[^>]*r="([\d.]+)"/g)) {
      const [cx, r] = [Number(m[1]), Number(m[2])]
      expect(cx - r).toBeGreaterThanOrEqual(108) // padLeft — the label column
      expect(cx + r).toBeLessThanOrEqual(574) // width - padRight
    }
  })
})
