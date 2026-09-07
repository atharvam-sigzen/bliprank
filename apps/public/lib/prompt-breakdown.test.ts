/**
 * THE CLAIM THIS FILE DEFENDS.
 *
 * A per-question table sitting under a headline rate is a promise that the two
 * are the same evidence. If they are not — a row dropped by the shape guard, a
 * hand-edited file, a partial write — the page shows two measurements under one
 * heading, and a reader who adds up the table and gets a different number than
 * the rate above it has caught this product doing the exact thing it sells
 * against.
 *
 * So `promptBreakdown` refuses rather than approximates, and these tests pin
 * every refusal. The positive cases are almost incidental by comparison: the
 * arithmetic is counting.
 */

import { describe, expect, it } from 'vitest'
import { byEngine, promptBreakdown, storedPromptRows } from './prompt-breakdown'
import type { ScanResultFile } from './scan-result'

const row = (over: Record<string, unknown> = {}) => ({
  prompt: 'best crm for a small team',
  engine: 'chatgpt',
  mentioned: true,
  mentionCount: 1,
  position: 1,
  brandsDetected: 3,
  cited: false,
  competitorsMentioned: [] as string[],
  ...over,
})

/** A scan file whose subject metric agrees with the rows it is given. */
function scanWith(rows: readonly (Record<string, unknown> | null)[], over: Partial<ScanResultFile> = {}): ScanResultFile {
  const mentions = rows.filter((r) => r?.['mentioned'] === true).length
  return {
    status: 'scanned',
    domain: 'example.com',
    category: 'crm-software',
    categoryName: 'CRM Software',
    subjectSource: 'domain-label',
    comparisonBasis: 'grader|engines=chatgpt,gemini|en-US|US|crm-software@1|unprompted=2|runs=1',
    algoVersion: 'det-2',
    counts: { cellsRequested: rows.length, cacheHits: 0, collected: rows.length, failed: 0, answersScored: rows.length, providerCalls: rows.length },
    collectedAt: '2026-09-02T00:00:00.000Z',
    brands: [
      {
        id: 'domain:example.com',
        name: 'Example',
        isSubject: true,
        mentions,
        citations: 0,
        metric: {
          value: rows.length ? mentions / rows.length : 0,
          ci_low: 0,
          ci_high: 1,
          n: rows.length,
          algo_version: 'det-2',
          collection_path: 'third-party-grounded',
          comparison_basis: 'grader|engines=chatgpt,gemini|en-US|US|crm-software@1|unprompted=2|runs=1',
        },
      },
    ],
    promptRows: rows,
    ...over,
  } as ScanResultFile
}

describe('the refusals — what is NOT drawn, and why', () => {
  it('a file with no promptRows yields null, not an empty table', () => {
    // Absent is ABSENT: the key is dropped, not set to `undefined`. A file that
    // predates the field has no key at all, and `exactOptionalPropertyTypes`
    // refuses an explicit `undefined` for an optional field, which is what
    // made the old `{ ...scan, promptRows: undefined } as ScanResultFile` a
    // type error the suite never saw (vitest does not typecheck).
    const { promptRows: _absent, ...noRows } = scanWith([])
    // An empty grid here would read as "mentioned nowhere", which is the
    // opposite claim from "this file does not carry the split".
    expect(promptBreakdown(noRows)).toBeNull()
    expect(storedPromptRows(noRows)).toEqual([])
  })

  it('promptRows that is not an array is treated as absent, not as a crash', () => {
    const scan = { ...scanWith([]), promptRows: 'not an array' } as unknown as ScanResultFile
    expect(promptBreakdown(scan)).toBeNull()
  })

  it('a row of the wrong shape is dropped — storage is a trust boundary', () => {
    // Two good rows and three kinds of junk. localStorage holds whatever a
    // stale build or a hand-edit left there, and `position - 1` on undefined is
    // how every record surface white-screened the last time this was skipped.
    const rows = [row(), row({ engine: 'gemini', mentioned: false, position: null }), {}, null, row({ brandsDetected: 'three' })]
    expect(storedPromptRows(scanWith(rows))).toHaveLength(2)
  })

  it('⚠️ REFUSES when the rows do not reconcile with the headline', () => {
    // The rows say one mention in two answers; the metric says two in two. One
    // of them is wrong and this cannot tell which, so it draws neither.
    const scan = scanWith([row(), row({ engine: 'gemini', mentioned: false, position: null })])
    const lying = {
      ...scan,
      brands: [{ ...scan.brands[0]!, mentions: 2 }],
    } as ScanResultFile
    expect(promptBreakdown(lying)).toBeNull()
  })

  it('⚠️ REFUSES when a dropped row makes the count short', () => {
    // Three rows in the file, one malformed. Two survive against an `n` of 3,
    // so the table would silently be measured on a smaller sample than the rate
    // above it — the shortfall the interval knows nothing about.
    const good = [row(), row({ engine: 'gemini' })]
    const scan = scanWith([...good, {} as Record<string, unknown>])
    // `scanWith` counted the junk row into n, exactly as a real short write would.
    expect(scan.brands[0]!.metric.n).toBe(3)
    expect(promptBreakdown(scan)).toBeNull()
  })
})

describe('the counting — every number is a count of rows', () => {
  const rows = [
    row({ prompt: 'q1', engine: 'chatgpt', mentioned: true, position: 1, brandsDetected: 4, mentionCount: 2, competitorsMentioned: ['HubSpot'] }),
    row({ prompt: 'q1', engine: 'gemini', mentioned: false, position: null, brandsDetected: 3, mentionCount: 0, competitorsMentioned: ['HubSpot', 'Zoho'] }),
    row({ prompt: 'q2', engine: 'chatgpt', mentioned: false, position: null, brandsDetected: 2, mentionCount: 0, competitorsMentioned: ['Zoho'] }),
    row({ prompt: 'q2', engine: 'gemini', mentioned: true, position: 3, brandsDetected: 5, mentionCount: 1, cited: true, competitorsMentioned: [] }),
  ]

  it('groups by prompt in bank order and by engine in a stable order', () => {
    const b = promptBreakdown(scanWith(rows))!
    expect(b.prompts.map((p) => p.prompt)).toEqual(['q1', 'q2'])
    expect(b.engines).toEqual(['chatgpt', 'gemini'])
    expect(b.prompts[0]!.cells.map((c) => c.engine)).toEqual(['chatgpt', 'gemini'])
  })

  it('totals match the headline exactly, per prompt and overall', () => {
    const b = promptBreakdown(scanWith(rows))!
    expect(b.answers).toBe(4)
    expect(b.mentionedIn).toBe(2)
    expect(b.prompts.map((p) => `${p.mentionedIn}/${p.answers}`)).toEqual(['1/2', '1/2'])
  })

  it('the per-engine footer counts answers, it does not divide the total', () => {
    const b = promptBreakdown(scanWith(rows))!
    // Two answers per engine, one mention each — which a total of 2 over 4
    // divided five ways could never have told anyone.
    expect(byEngine(b)).toEqual([
      { engine: 'chatgpt', answers: 2, mentionedIn: 1 },
      { engine: 'gemini', answers: 2, mentionedIn: 1 },
    ])
  })

  it('a competitor is counted once per ANSWER, not once per occurrence', () => {
    // HubSpot in two answers, Zoho in two, and a duplicate name inside one row
    // must not become two. The denominator is answers, so the numerator has to
    // be answers too or the two cannot sit side by side.
    const withDupes = [...rows.slice(0, 3), row({ prompt: 'q2', engine: 'gemini', competitorsMentioned: ['Zoho', 'Zoho'] })]
    const b = promptBreakdown(scanWith(withDupes))!
    expect(b.competitors).toEqual([
      { name: 'Zoho', answers: 3 },
      { name: 'HubSpot', answers: 2 },
    ])
  })

  it('a bank with no leaders yields no competitors, and that is a fact about the bank', () => {
    // An authored category carries `leaders: []` by design (ADR-0009), so the
    // scorer reports no tracked competitor even when the engines named several.
    // Empty here must never be rendered as "the engines named nobody".
    const b = promptBreakdown(scanWith(rows.map((r) => ({ ...r, competitorsMentioned: [] }))))!
    expect(b.competitors).toEqual([])
    expect(b.prompts[3 - 3]!.cells[0]!.brandsDetected).toBeGreaterThan(0)
  })

  it('a cell with no answer is absent from the row rather than counted as a miss', () => {
    // Three answers over two prompts: q2 got no gemini answer. The row must be
    // 0 of 1, not 0 of 2 — a failed cell is not evidence of absence.
    const short = [rows[0]!, rows[1]!, rows[2]!]
    const b = promptBreakdown(scanWith(short))!
    const q2 = b.prompts.find((p) => p.prompt === 'q2')!
    expect(q2.answers).toBe(1)
    expect(q2.cells.map((c) => c.engine)).toEqual(['chatgpt'])
    expect(byEngine(b)).toEqual([
      { engine: 'chatgpt', answers: 2, mentionedIn: 1 },
      { engine: 'gemini', answers: 1, mentionedIn: 0 },
    ])
  })
})
