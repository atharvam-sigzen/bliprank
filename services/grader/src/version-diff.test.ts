import { describe, expect, it } from 'vitest'
import type { GoldenReport } from '@bliprank/scorer'
import { diffGolden, diffRows, goldenSummary, rowKey, snapshotRows, type SnapshotRow } from './version-diff.js'

/** Synthetic rows: invented answers, hand-countable. */
const row = (over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  domain: 'acme.test',
  day: '2026-09-01',
  engine: 'chatgpt',
  prompt: 'best crm',
  run: 0,
  mentioned: true,
  mentionCount: 2,
  brandsDetected: 3,
  cited: false,
  citedAtPositions: [],
  position: 1,
  competitorsMentioned: ['HubSpot'],
  citations: [{ url: 'https://www.g2.com/products/acme', domain: 'g2.com', sourceClass: 'review' }],
  ...over,
})

describe('rows are built one per run, and two runs of one cell stay distinct', () => {
  it('numbers runs within a cell and copies the fields a rule can move', () => {
    const scored = {
      domain: 'acme.test',
      day: '2026-09-01',
      runs: [
        { prompt: 'p', engine: 'chatgpt', text: 'a', collectedAt: '', row: base(true) },
        { prompt: 'p', engine: 'chatgpt', text: 'b', collectedAt: '', row: base(false) },
        { prompt: 'p', engine: 'gemini', text: 'c', collectedAt: '', row: base(true) },
      ],
    }
    const rows = snapshotRows(scored as never)
    expect(rows.map((r) => [r.engine, r.run, r.mentioned])).toEqual([
      ['chatgpt', 0, true],
      ['chatgpt', 1, false],
      ['gemini', 0, true],
    ])
    expect(new Set(rows.map(rowKey)).size).toBe(3)
    expect(rows[0]!.citations).toEqual([{ url: 'https://x.test/a', domain: 'x.test', sourceClass: 'other' }])
    expect(rows[0]!.citedAtPositions).toEqual([])
  })
})

describe('the diff names every field that moved, and nothing that did not', () => {
  it('identical sets: compared, no flips', () => {
    const d = diffRows([row(), row({ engine: 'gemini' })], [row(), row({ engine: 'gemini' })])
    expect(d).toEqual({ compared: 2, flips: [], onlyBefore: [], onlyAfter: [] })
  })

  it('a rule that changes a class, a count and a competitor list yields one flip per field per row', () => {
    const before = [row(), row({ engine: 'gemini', mentioned: false, mentionCount: 0, position: null, competitorsMentioned: [] })]
    const after = [
      row({ citations: [{ url: 'https://www.g2.com/products/acme', domain: 'g2.com', sourceClass: 'competitor' }], mentionCount: 3, cited: true, citedAtPositions: [0] }),
      row({ engine: 'gemini', mentioned: false, mentionCount: 0, position: null, competitorsMentioned: ['Zoho CRM'] }),
    ]
    const d = diffRows(before, after)
    expect(d.compared).toBe(2)
    expect(d.flips.map((f) => [f.key.split('|')[2], f.field, f.before, f.after])).toEqual([
      ['chatgpt', 'mentionCount', 2, 3],
      ['chatgpt', 'cited', false, true],
      ['chatgpt', 'citedAtPositions', [], [0]],
      ['chatgpt', 'citations', [{ url: 'https://www.g2.com/products/acme', domain: 'g2.com', sourceClass: 'review' }], [{ url: 'https://www.g2.com/products/acme', domain: 'g2.com', sourceClass: 'competitor' }]],
      ['gemini', 'competitorsMentioned', [], ['Zoho CRM']],
    ])
  })

  it('a cycle present on one side only is reported as such, never as a flip', () => {
    const d = diffRows([row()], [row(), row({ day: '2026-09-02' })])
    expect(d.flips).toEqual([])
    expect(d.onlyAfter).toEqual([rowKey(row({ day: '2026-09-02' }))])
    expect(d.onlyBefore).toEqual([])
  })
})

describe('golden agreement is compared per field, and a fall on any field is a regression', () => {
  const report = (mentioned: number, citation: number, silent = 0): GoldenReport => ({
    cases: 7,
    deterministic: [
      { field: 'mentioned', agreed: mentioned, total: 7, rate: mentioned / 7, disagreements: [] },
      { field: 'cited', agreed: 7, total: 7, rate: 1, disagreements: [] },
    ],
    deterministicRate: (mentioned + 7) / 14,
    citationClass: { field: 'sourceClass', agreed: citation, total: 10, rate: citation / 10, disagreements: [] },
    silentOwned: Array.from({ length: silent }, () => ({ caseId: 'x', url: 'u', expected: 'other' as const })),
    gateStatus: 'NOT_RUN',
    gateNote: 'n',
  })

  it('summarises rates and the gate, and flags the field that fell', () => {
    const before = goldenSummary(report(7, 10))
    const after = goldenSummary(report(6, 10))
    expect(before).toEqual({ cases: 7, fields: { mentioned: 1, cited: 1 }, citationClass: 1, silentOwned: 0, gateStatus: 'NOT_RUN' })
    expect(diffGolden(before, after)).toEqual([
      { field: 'mentioned', before: 1, after: 6 / 7, regressed: true },
      { field: 'cited', before: 1, after: 1, regressed: false },
      { field: 'citationClass', before: 1, after: 1, regressed: false },
    ])
  })

  it('an improvement is not a regression', () => {
    expect(diffGolden(goldenSummary(report(6, 9)), goldenSummary(report(7, 10))).some((r) => r.regressed)).toBe(false)
  })
})

function base(mentioned: boolean) {
  return {
    algoVersion: 'det-2',
    brandId: 'acme',
    mentioned,
    mentionCount: mentioned ? 1 : 0,
    position: mentioned ? 1 : null,
    brandsDetected: 1,
    cited: false,
    citedAtPositions: [],
    competitorsMentioned: [],
    citations: [{ url: 'https://x.test/a', position: 0, domain: 'x.test', sourceClass: 'other' as const, detail: {} }],
  }
}
