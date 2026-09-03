import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBasis } from '@bliprank/contracts'
import { readScanAnswers } from './answers.js'
import { applyOverride } from './competitor-overrides.js'
import { applyCustomPrompts } from './custom-prompts.js'
import { listCycles, writeCycle } from './cycles.js'
import { planRescore } from './rescore.js'
import { recordCategory } from './resolve-category.js'
import { runGrader } from './run.js'
import { snapshotRows } from './version-diff.js'
import { scoreStoredCycle } from './answers.js'

/**
 * THE CLOSING GATE OF ADR-0016 (step 5): one synthetic cycle through the REAL
 * runner, with only the network replaced by the fixture adapter, carrying a
 * competitor override AND a custom prompt set at once. Everything else is
 * real: the record store, the override and prompt stores, the answer index
 * and blob store, the budget, the basis, the scorer, the cycle file, the
 * evidence reader, the re-score pre-flight and the version-diff rows.
 *
 * Nothing here spends. The fixture adapter is declared offline, the run is
 * `mode: 'fixture'`, and the cap is a scratch ledger's.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-gate-'))
  // pipedrive.com leads crm-software: the subject is the leader, the fixture adapter knows the bank.
  recordCategory(dir, { host: 'pipedrive.com', slug: 'crm-software', source: 'leader-domain', evidence: 'tracked leader', decidedAt: '2026-08-01T00:00:00.000Z', generated: false })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const CUSTOM = ['which crm works offline on a phone', 'best crm for a two-person studio']

async function collect(day: string) {
  return runGrader({
    domain: 'pipedrive.com',
    plan: 'payg',
    day,
    engines: ['chatgpt', 'gemini'],
    capUsd: 5,
    maxPrompts: 2,
    mode: 'fixture',
    apiKey: '',
    dataDir: dir,
    outFile: join(dir, 'latest.json'),
    log: () => {},
  })
}

describe('one cycle carrying both corrections, through the real runner, offline', () => {
  it('the basis carries set=1, the custom block carries custom=2@1, the excluded rival is gone, the included one is scored, the headline is the curated sample alone', async () => {
    const override = applyOverride(dir, { host: 'pipedrive.com', exclude: ['zoho-crm'], include: ['semrush'], reason: 'Zoho is our integration partner', by: 'operator' })
    if ('refuse' in override) throw new Error(override.refuse)
    const set = applyCustomPrompts(dir, { host: 'pipedrive.com', prompts: CUSTOM, reason: 'what our buyers actually ask', by: 'operator' })
    if ('refuse' in set) throw new Error(set.refuse)

    const result = await collect('2026-09-03')
    expect(result.status).toBe('scanned')
    if (result.status !== 'scanned') return

    // The headline: curated cells only, on a basis that names the override version.
    const basis = parseBasis(result.comparisonBasis)!
    expect(basis).toMatchObject({ bank: { slug: 'crm-software', version: 1 }, unprompted: 2, set: 1 })
    expect(basis.custom).toBeUndefined()
    expect(result.brands.map((b) => b.id)).not.toContain('zoho-crm')
    expect(result.brands.map((b) => b.id)).toContain('semrush')
    expect(result.brands.find((b) => b.isSubject)!.metric.n).toBe(4)
    expect(result.promptRows).toHaveLength(4)

    // The second measurement: its own basis, its own rows, the same rivals.
    const custom = result.customPrompts!
    expect(parseBasis(custom.comparisonBasis)).toMatchObject({ unprompted: 0, set: 1, custom: { count: 2, version: 1 } })
    expect(custom.counts).toEqual({ cellsRequested: 4, answersScored: 4 })
    expect(custom.promptRows.map((r) => r.prompt).every((p) => CUSTOM.includes(p))).toBe(true)
    expect(custom.brands.map((b) => b.id)).not.toContain('zoho-crm')
    expect(custom.brands.map((b) => b.id)).toContain('semrush')

    // The whole cycle's counts are curated plus custom; the file on disk is the result.
    expect(result.counts.cellsRequested).toBe(8)
    expect(result.counts.answersScored).toBe(8)
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).customPrompts.version).toBe(1)

    // Filed as a cycle, it reads back under the sets it recorded: the evidence marks the custom answers.
    expect(writeCycle(dir, result)).toMatchObject({ day: '2026-09-03' })
    expect(listCycles(dir, 'pipedrive.com')).toHaveLength(1)
    const evidence = await readScanAnswers(dir, 'pipedrive.com', '2026-09-03')
    if ('refuse' in evidence) throw new Error(evidence.refuse)
    expect(evidence.answers).toHaveLength(8)
    expect(evidence.answers.filter((a) => a.custom).length).toBe(4)
    expect(evidence.answers.filter((a) => !a.custom).length).toBe(4)

    // The re-score pre-flight finds every cell, curated and custom, and pins both versions.
    const plan = await planRescore(dir, 'pipedrive.com', 2)
    expect(plan).toMatchObject({ missing: [], cells: 8, competitorSet: 1, customPrompts: 1 })

    // The version-diff rows cover every stored answer, custom included, and the row key keeps them apart.
    const scored = await scoreStoredCycle(dir, 'pipedrive.com', '2026-09-03')
    if ('refuse' in scored) throw new Error(scored.refuse)
    const rows = snapshotRows(scored)
    expect(rows).toHaveLength(8)
    expect(new Set(rows.map((r) => `${r.engine}|${r.prompt}|${r.run}`)).size).toBe(8)
  })

  it('a later change to either set makes the next cycle a new question, and the earlier cycle still reads back under its own sets', async () => {
    applyOverride(dir, { host: 'pipedrive.com', exclude: ['zoho-crm'], include: [], reason: 'Zoho is our integration partner', by: 'operator' })
    applyCustomPrompts(dir, { host: 'pipedrive.com', prompts: CUSTOM, reason: 'what our buyers actually ask', by: 'operator' })
    const first = await collect('2026-09-03')
    if (first.status !== 'scanned') throw new Error(first.status)
    writeCycle(dir, first)

    applyOverride(dir, { host: 'pipedrive.com', exclude: [], include: [], reason: 'we were wrong, Zoho does compete', by: 'operator' })
    applyCustomPrompts(dir, { host: 'pipedrive.com', prompts: [CUSTOM[0]!], reason: 'one question is enough', by: 'operator' })
    const second = await collect('2026-09-04')
    if (second.status !== 'scanned') throw new Error(second.status)
    writeCycle(dir, second)

    expect(parseBasis(second.comparisonBasis)?.set).toBe(2)
    expect(second.brands.map((b) => b.id)).toContain('zoho-crm')
    expect(parseBasis(second.customPrompts!.comparisonBasis)?.custom).toEqual({ count: 1, version: 2 })
    expect(first.comparisonBasis).not.toBe(second.comparisonBasis)

    // The first cycle's evidence and re-score still resolve under set 1 and prompt set 1, not today's.
    const evidence = await readScanAnswers(dir, 'pipedrive.com', '2026-09-03')
    if ('refuse' in evidence) throw new Error(evidence.refuse)
    expect(evidence.answers.filter((a) => a.custom)).toHaveLength(4)
    const plan = await planRescore(dir, 'pipedrive.com', 2, join(dir, 'results', 'cycles', 'pipedrive.com', '2026-09-03.json'))
    expect(plan).toMatchObject({ missing: [], competitorSet: 1, customPrompts: 1 })
  })
})
