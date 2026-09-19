import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBasis } from '@bliprank/contracts'
import { readScanAnswers } from './answers.js'
import { applyOverride } from './competitor-overrides.js'
import { applyCustomPrompts } from './custom-prompts.js'
import { listCycles, writeCycle } from './cycles.js'
import { planRescore, restampRefusal } from './rescore.js'
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

/**
 * A cycle as the runner wrote it while ADR-0016 decision 4 stood: the bank's
 * prompts as the headline, the person's as a second block on its own basis.
 * Today's runner no longer writes that shape (Amendment 1), so it is assembled
 * from two real offline runs over the same store and day: the set's cells
 * (whose answers and basis are exactly what the old block carried) and the
 * bank's, pinned with `customPrompts: null`. What the readers consult, the
 * basis strings, the block's prompts and the answer store, is all real.
 */
async function collectDecision4(day: string) {
  const own = await collect(day)
  const bank = await runGrader({
    domain: 'pipedrive.com',
    plan: 'payg',
    day,
    engines: ['chatgpt', 'gemini'],
    capUsd: 5,
    maxPrompts: 2,
    customPrompts: null,
    mode: 'fixture',
    apiKey: '',
    dataDir: dir,
    log: () => {},
  })
  if (own.status !== 'scanned' || bank.status !== 'scanned') return bank
  return {
    ...bank,
    customPrompts: {
      version: 1,
      prompts: CUSTOM,
      comparisonBasis: own.comparisonBasis,
      counts: { cellsRequested: own.counts.cellsRequested, answersScored: own.counts.answersScored },
      brands: own.brands,
      promptRows: own.promptRows,
    },
  }
}

describe('one cycle carrying both corrections, through the real runner, offline', () => {
  it('the person\u2019s set IS the measurement (ADR-0016 Amendment 1): the headline basis carries set=1 and custom=2@1 with unprompted=0, the excluded rival is gone, the included one is scored, and no second block is written', async () => {
    const override = applyOverride(dir, { host: 'pipedrive.com', exclude: ['zoho-crm'], include: ['semrush'], reason: 'Zoho is our integration partner', by: 'operator' })
    if ('refuse' in override) throw new Error(override.refuse)
    const set = applyCustomPrompts(dir, { host: 'pipedrive.com', prompts: CUSTOM, reason: 'what our buyers actually ask', by: 'operator' })
    if ('refuse' in set) throw new Error(set.refuse)

    const result = await collect('2026-09-03')
    expect(result.status).toBe('scanned')
    if (result.status !== 'scanned') return

    // The headline: the person's two prompts and nothing of the bank's, on a basis that names the override version AND the set version.
    const basis = parseBasis(result.comparisonBasis)!
    expect(basis).toMatchObject({ bank: { slug: 'crm-software', version: 1 }, unprompted: 0, set: 1, custom: { count: 2, version: 1 } })
    expect(result.brands.map((b) => b.id)).not.toContain('zoho-crm')
    expect(result.brands.map((b) => b.id)).toContain('semrush')
    expect(result.brands.find((b) => b.isSubject)!.metric.n).toBe(4)
    expect(result.brands.every((b) => b.metric.comparison_basis === result.comparisonBasis)).toBe(true)
    expect(result.promptRows).toHaveLength(4)
    expect(result.promptRows.map((r) => r.prompt).every((p) => CUSTOM.includes(p))).toBe(true)

    // Decision 4's second block is superseded: the set is the headline, not a block beside it.
    expect(result.customPrompts).toBeUndefined()

    // The whole cycle is the set's cells: two prompts on two engines. The `maxPrompts: 2` the runner was handed sizes the BANK and does not touch the set.
    expect(result.counts.cellsRequested).toBe(4)
    expect(result.counts.answersScored).toBe(4)
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).comparisonBasis).toBe(result.comparisonBasis)

    // Filed as a cycle, it reads back under the sets it recorded: the evidence is the set's answers, and they are the headline's own sample.
    expect(writeCycle(dir, result)).toMatchObject({ day: '2026-09-03' })
    expect(listCycles(dir, 'pipedrive.com')).toHaveLength(1)
    const evidence = await readScanAnswers(dir, 'pipedrive.com', '2026-09-03')
    if ('refuse' in evidence) throw new Error(evidence.refuse)
    expect(evidence.answers).toHaveLength(4)
    expect(evidence.answers.filter((a) => a.custom)).toHaveLength(0)
    expect([...new Set(evidence.answers.map((a) => a.prompt))].sort()).toEqual([...CUSTOM].sort())

    // The re-score pre-flight finds every cell of the SET, none of the bank's, and pins both versions.
    const plan = await planRescore(dir, 'pipedrive.com', 2)
    expect(plan).toMatchObject({ missing: [], cells: 4, competitorSet: 1, customPrompts: 1, promptSetRole: 'headline' })

    // The version-diff rows cover every stored answer, and the row key keeps them apart.
    const scored = await scoreStoredCycle(dir, 'pipedrive.com', '2026-09-03')
    if ('refuse' in scored) throw new Error(scored.refuse)
    const rows = snapshotRows(scored)
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((r) => `${r.engine}|${r.prompt}|${r.run}`)).size).toBe(4)
  })

  it('a later change to either set makes the next cycle a new question on a new basis, and the earlier cycle still reads back under its own sets', async () => {
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
    // The version change is ON THE HEADLINE's basis now: that is where the trend breaks and compare() refuses.
    expect(parseBasis(second.comparisonBasis)?.custom).toMatchObject({ count: 1, version: 2 })
    expect(parseBasis(first.comparisonBasis)?.custom).toMatchObject({ count: 2, version: 1 })
    expect(first.comparisonBasis).not.toBe(second.comparisonBasis)

    // The first cycle's evidence and re-score still resolve under set 1 and prompt set 1, not today's.
    const evidence = await readScanAnswers(dir, 'pipedrive.com', '2026-09-03')
    if ('refuse' in evidence) throw new Error(evidence.refuse)
    expect(evidence.answers).toHaveLength(4)
    expect([...new Set(evidence.answers.map((a) => a.prompt))].sort()).toEqual([...CUSTOM].sort())
    const plan = await planRescore(dir, 'pipedrive.com', 2, join(dir, 'results', 'cycles', 'pipedrive.com', '2026-09-03.json'))
    expect(plan).toMatchObject({ missing: [], cells: 4, competitorSet: 1, customPrompts: 1 })
  })

  it('a cycle stored while decision 4 stood still reads back with its second block: the bank\u2019s headline, the block kept apart (R5)', async () => {
    // What a pre-amendment runner wrote: the bank's prompts as the headline, the person's as a block. Built with the scan's own request field, which is kept for exactly this.
    applyCustomPrompts(dir, { host: 'pipedrive.com', prompts: CUSTOM, reason: 'what our buyers actually ask', by: 'operator' })
    const old = await collectDecision4('2026-09-02')
    if (old.status !== 'scanned') throw new Error(old.status)
    expect(parseBasis(old.comparisonBasis)).toMatchObject({ unprompted: 2 })
    expect(parseBasis(old.comparisonBasis)?.custom).toBeUndefined()
    expect(parseBasis(old.customPrompts!.comparisonBasis)).toMatchObject({ unprompted: 0, custom: { count: 2, version: 1 } })
    writeCycle(dir, old)
    const evidence = await readScanAnswers(dir, 'pipedrive.com', '2026-09-02')
    if ('refuse' in evidence) throw new Error(evidence.refuse)
    expect(evidence.answers).toHaveLength(8)
    expect(evidence.answers.filter((a) => a.custom)).toHaveLength(4)
    const plan = await planRescore(dir, 'pipedrive.com', 2, join(dir, 'results', 'cycles', 'pipedrive.com', '2026-09-02.json'))
    // The plan reads the ROLE off the stored file: this set was a block beside a bank headline, not the headline's sample.
    expect(plan).toMatchObject({ missing: [], cells: 8, customPrompts: 1, promptSetRole: 'block' })

    // THE FINDING (C3 stats review, BLOCKER): the re-derivation is the runner with the plan's pins. With the
    // role pinned it measures the sample the stored cycle measured: the bank's headline on its own basis, the
    // person's prompts as the block on theirs, every cell a cache hit.
    const pinned = { domain: 'pipedrive.com', plan: 'payg' as const, day: '2026-09-02', engines: ['chatgpt', 'gemini'] as const, capUsd: 5, maxPrompts: 2, customPrompts: 1, mode: 'fixture' as const, apiKey: '', dataDir: dir, log: () => {} }
    const rederived = await runGrader({ ...pinned, engines: [...pinned.engines], promptSetRole: 'block' })
    if (rederived.status !== 'scanned') throw new Error(rederived.status)
    expect(rederived.comparisonBasis).toBe(old.comparisonBasis)
    expect(parseBasis(rederived.comparisonBasis)?.custom).toBeUndefined()
    expect(rederived.customPrompts!.comparisonBasis).toBe(old.customPrompts!.comparisonBasis)
    expect(rederived.counts).toMatchObject({ cellsRequested: 8, cacheHits: 8, providerCalls: 0 })
    expect(rederived.brands.find((b) => b.isSubject)!.metric.n).toBe(old.brands.find((b) => b.isSubject)!.metric.n)
    // And the test bites: WITHOUT the role the same pins measure the person's set as the headline, a different
    // sample under the same file name, which is what a re-score did before the role existed.
    const rebased = await runGrader({ ...pinned, engines: [...pinned.engines] })
    if (rebased.status !== 'scanned') throw new Error(rebased.status)
    expect(rebased.comparisonBasis).not.toBe(old.comparisonBasis)
    expect(parseBasis(rebased.comparisonBasis)).toMatchObject({ unprompted: 0, custom: { count: 2, version: 1 } })
  })
})

describe('a re-score re-derives the sample that was measured, or refuses (MVP_PLAN C3r item 7)', () => {
  const setsFile = () => join(dir, 'custom-prompts.json')
  const editStoredSet = (prompts: readonly string[]) => {
    const stored = JSON.parse(readFileSync(setsFile(), 'utf8')) as Record<string, { prompts: readonly string[] }>
    stored['pipedrive.com']!.prompts = prompts
    writeFileSync(setsFile(), JSON.stringify(stored))
  }

  it('THE STORE\u2019S SET AT THAT VERSION MUST STILL BE THE LIST THE CYCLE ASKED: a changed list, or a changed count, is refused, never re-derived under the old file\u2019s name', async () => {
    applyCustomPrompts(dir, { host: 'pipedrive.com', prompts: CUSTOM, reason: 'what our buyers actually ask', by: 'operator' })
    const result = await collect('2026-09-03')
    if (result.status !== 'scanned') throw new Error(result.status)
    writeCycle(dir, result)
    expect(await planRescore(dir, 'pipedrive.com', 2)).toMatchObject({ missing: [], customPrompts: 1, promptSetRole: 'headline', restampsBasis: false })

    // The version is a pointer into a store a person can edit. Same count, another question: only the fingerprint can see it.
    editStoredSet([CUSTOM[0]!, 'which crm has the best reporting'])
    expect(await planRescore(dir, 'pipedrive.com', 2)).toMatchObject({ refuse: expect.stringContaining('is no longer the list this cycle asked') })
    // Another count: refused on K, fingerprint or none.
    editStoredSet([CUSTOM[0]!])
    expect(await planRescore(dir, 'pipedrive.com', 2)).toMatchObject({ refuse: expect.stringMatching(/asked 2 prompts at set 1, and the store.s set 1 now holds 1; re-deriving over a different list is a different measurement/) })
    // THE EVIDENCE READER MAKES THE SAME CHECK (stats review of C3r, MINOR 9): a store whose version 1 is no longer the list the
    // cycle asked must not yield "that cycle's evidence" over a narrower or different sample. It used to build cells from whatever
    // the store returned, and with repeats now dropped on read a hand-edited set silently narrowed the evidence.
    expect(await readScanAnswers(dir, 'pipedrive.com', '2026-09-03')).toMatchObject({ refuse: expect.stringContaining('is no longer the list this cycle asked (it asked 2 prompts and the set now holds 1)') })
    editStoredSet([CUSTOM[0]!, 'which crm has the best reporting'])
    expect(await readScanAnswers(dir, 'pipedrive.com', '2026-09-03')).toMatchObject({ refuse: expect.stringContaining('its fingerprint differs') })
    // The same list under another spelling and order is the same sample, and is re-derivable.
    editStoredSet([`${CUSTOM[1]!.toUpperCase()}?`, `  ${CUSTOM[0]}  `])
    expect(await planRescore(dir, 'pipedrive.com', 2)).toMatchObject({ missing: [], customPrompts: 1 })
    expect(await readScanAnswers(dir, 'pipedrive.com', '2026-09-03')).not.toHaveProperty('refuse')
  })

  it('a second measurement whose basis cannot be read is refused: it used to be re-derived WITHOUT the block and written back over the file that had one', async () => {
    applyCustomPrompts(dir, { host: 'pipedrive.com', prompts: CUSTOM, reason: 'what our buyers actually ask', by: 'operator' })
    const old = await collectDecision4('2026-09-02')
    if (old.status !== 'scanned') throw new Error(old.status)
    writeCycle(dir, { ...old, customPrompts: { ...old.customPrompts!, comparisonBasis: 'not a basis' } } as never)
    const plan = await planRescore(dir, 'pipedrive.com', 2, join(dir, 'results', 'cycles', 'pipedrive.com', '2026-09-02.json'))
    expect(plan).toMatchObject({ refuse: expect.stringContaining('second measurement whose basis cannot be read') })
  })

  it('A SAME-VERSION RE-SCORE MAY NOT MOVE A BASIS: a cycle stored before the fingerprint is restamped only across a scoring-version boundary (stats review of item 1, MINOR 4)', async () => {
    applyCustomPrompts(dir, { host: 'pipedrive.com', prompts: CUSTOM, reason: 'what our buyers actually ask', by: 'operator' })
    const result = await collect('2026-09-03')
    if (result.status !== 'scanned') throw new Error(result.status)
    // As C3 wrote it, before C3r item 1: the tail with no fingerprint.
    const before = result.comparisonBasis.replace(/#[0-9a-f]{12}$/, '')
    expect(before).toMatch(/\|custom=2@1$/)
    writeCycle(dir, { ...result, comparisonBasis: before } as never)
    const plan = await planRescore(dir, 'pipedrive.com', 2)
    if ('refuse' in plan) throw new Error(plan.refuse)
    expect(plan.restampsBasis).toBe(true)
    expect(restampRefusal(plan, true)).toContain('would change its basis string')
    // Under a new scoring version the restamp crosses a boundary compare() draws anyway, and is allowed.
    expect(restampRefusal(plan, false)).toBeNull()
    expect(restampRefusal({ restampsBasis: false }, true)).toBeNull()
  })
})
