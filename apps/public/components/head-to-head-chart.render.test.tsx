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
import { HeadToHeadSection } from './head-to-head-section'
import { NO_RUN_BLOCK_SCAN } from '../lib/__fixtures__/no-run-block-scan'
import type { ScanResultFile } from '../lib/scan-result'
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
const data: HeadToHead = { rows, subject: rows[0]!, compared: rows.length - 1, allIndistinguishable: false }
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
    // The bound carries the same decimals as the estimate: '0.0–4.3%' under
    // '0.0%'. Until 2026-09-07 `formatInterval` printed an exact zero as a bare
    // '0', the one row on this table whose decimals did not line up in a
    // tabular-figures column; this pins the fix.
    expect(html).toContain('0.0–4.3%')
  })

  it('no mark escapes the plot, at either end of the scale', () => {
    for (const m of html.matchAll(/<circle class="h2h__dot-collar" cx="([\d.]+)"[^>]*r="([\d.]+)"/g)) {
      const [cx, r] = [Number(m[1]), Number(m[2])]
      expect(cx - r).toBeGreaterThanOrEqual(108) // padLeft — the label column
      expect(cx + r).toBeLessThanOrEqual(574) // width - padRight
    }
  })
})

/**
 * ZERO COMPETITORS HAS TWO CAUSES, AND THEY ARE NOT THE SAME SENTENCE.
 *
 * The copy asserted, unconditionally, that a zero-competitor scan "was measured
 * against the general business-software prompt set" and belonged to "a business
 * we could not categorise". True for the FALLBACK bank. False, and insulting,
 * for a GENERATED one: thecosmicbyte.com was correctly placed in an authored
 * "Gaming Peripherals India" and measured on its own seventeen prompts, then
 * told on its own dashboard that we could not categorise it.
 */
describe('the zero-competitor explanation names the right cause', () => {
  const base = {
    ...NO_RUN_BLOCK_SCAN,
    brands: [NO_RUN_BLOCK_SCAN.brands.find((b) => b.isSubject) ?? NO_RUN_BLOCK_SCAN.brands[0]!],
  } as ScanResultFile

  const html = (scan: ScanResultFile) => renderToStaticMarkup(<HeadToHeadSection scan={scan} />)

  it('a GENERATED category says it was authored, and never says we could not categorise it', () => {
    const authored = {
      ...base,
      domain: 'thecosmicbyte.com',
      categoryName: 'Gaming Peripherals India',
      fallback: undefined,
      categorySource: { signal: 'generated', evidence: "authored from thecosmicbyte.com's homepage" },
    } as unknown as ScanResultFile
    const out = html(authored)
    expect(out).toContain('a category authored for it')
    expect(out).toContain('Gaming Peripherals India')
    // THE TWO FALSE CLAIMS. Neither may appear for a categorised business.
    expect(out).not.toContain('could not categorise')
    expect(out).not.toContain('general business-software prompt set')
  })

  it('the FALLBACK bank still says exactly what it always said', () => {
    const fell = {
      ...base,
      domain: 'example.com',
      fallback: { reason: 'unclassified', detail: 'no known keyword', candidates: [] },
    } as unknown as ScanResultFile
    const out = html(fell)
    expect(out).toContain('general business-software prompt set')
    expect(out).toContain('could not categorise')
  })

  it('neither case ever draws a chart', () => {
    for (const scan of [base, { ...base, categorySource: { signal: 'generated', evidence: 'x' } } as unknown as ScanResultFile]) {
      expect(html(scan)).toContain('An empty chart is not drawn in its place')
    }
  })
})
