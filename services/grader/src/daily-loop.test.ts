import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGINES } from '@bliprank/contracts'
import { applyCustomPrompts } from './custom-prompts.js'
import { listCycles } from './cycles.js'
import { dailyCapUsd, dailyLedgerFile, formulaCapUsd, hardCeilingUsd, readDailyLedger, runTick } from './daily-loop.js'
import { RETRY_HEADROOM, callsThisMonth, defaultDomainCeilingConfig } from './domain-ceiling.js'
import { dueToday, setTracked } from './due.js'
import { recordCategory } from './resolve-category.js'
import type { ScanResult } from './scan.js'

/**
 * THE DAILY LOOP, OFFLINE (ADR-0017 decisions 1 and 2). A fake collector
 * proves the cap gates and the ledger books; the real runner in fixture mode
 * proves the loop files cycles through the store. Nothing here spends.
 */

let dir: string
const PER_PROMPT = 0.007 * 3 + 0.008 + 0.005 // pay-as-you-go, one prompt on five engines
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-loop-'))
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
  recordCategory(dir, { host: 'beta.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
  recordCategory(dir, { host: 'pipedrive.com', slug: 'crm-software', source: 'leader-domain', evidence: 'x', decidedAt: '2026-08-01', generated: false })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const scanned = (host: string, day: string, spentUsd: number, calls: number): ScanResult & { run: { spentUsd: number } } =>
  ({
    status: 'scanned',
    domain: host,
    category: 'crm-software',
    categoryName: 'CRM',
    classification: { status: 'classified', slug: 'crm-software', evidence: 'x' },
    subjectSource: 'domain-label',
    comparisonBasis: 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=17|runs=1',
    algoVersion: 'det-2',
    collectedAt: `${day}T10:00:00.000Z`,
    counts: { cellsRequested: calls, cacheHits: 0, collected: calls, failed: 0, answersScored: calls, providerCalls: calls },
    brands: [],
    promptRows: [],
    run: { spentUsd },
  }) as unknown as ScanResult & { run: { spentUsd: number } }

describe('the cap is a formula over the tracked set', () => {
  it('is zero with nobody tracked, is every tracked domain’s expected cost with headroom, and moves as domains are tracked and untracked', () => {
    expect(dailyCapUsd(dueToday(dir, {}, '2026-09-07'))).toBe(0)
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    expect(dailyCapUsd(dueToday(dir, {}, '2026-09-07'))).toBeCloseTo(17 * PER_PROMPT * RETRY_HEADROOM, 6)
    applyCustomPrompts(dir, { host: 'acme.test', prompts: ['which crm works offline on a phone', 'best crm for a two-person studio'], reason: 'buyers ask these', by: 'operator' })
    setTracked(dir, 'beta.test', true, { by: 'operator', reason: 'r' })
    expect(dailyCapUsd(dueToday(dir, {}, '2026-09-07'))).toBeCloseTo((19 + 17) * PER_PROMPT * RETRY_HEADROOM, 6)
    setTracked(dir, 'beta.test', false, { by: 'operator', reason: 'churned' })
    expect(dailyCapUsd(dueToday(dir, {}, '2026-09-07'))).toBeCloseTo(19 * PER_PROMPT * RETRY_HEADROOM, 6)
  })

  it('is bounded above by the hard ceiling the owner names, and the ceiling must be a positive number to count', () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    setTracked(dir, 'beta.test', true, { by: 'operator', reason: 'r' })
    const list = dueToday(dir, {}, '2026-09-07')
    expect(formulaCapUsd(list)).toBeCloseTo(34 * PER_PROMPT * RETRY_HEADROOM, 6)
    expect(dailyCapUsd(list, { COLLECTION_BUDGET_USD_DAILY: '0.50' })).toBe(0.5)
    expect(dailyCapUsd(list, { COLLECTION_BUDGET_USD_DAILY: '50' })).toBeCloseTo(formulaCapUsd(list), 6)
    expect(hardCeilingUsd({ COLLECTION_BUDGET_USD_DAILY: 'lots' })).toBeNull()
    expect(hardCeilingUsd({ COLLECTION_BUDGET_USD_DAILY: '0' })).toBeNull()
    expect(hardCeilingUsd({})).toBeNull()
  })
})

describe('the loop, with a fake collector', () => {
  it('dry: lists, books nothing; apply offline: runs each due domain, books realised spend and calls, files the cycle, and a second tick the same day runs nothing', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    setTracked(dir, 'beta.test', true, { by: 'operator', reason: 'r' })
    const dry = await runTick({ dataDir: dir, env: {}, day: '2026-09-07', apply: false, mode: 'fixture' })
    if ('refuse' in dry) throw new Error(dry.refuse)
    expect(dry.ran).toEqual([])
    expect(readDailyLedger(dir)).toEqual({})

    const collected: string[] = []
    const applied = await runTick(
      { dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' },
      { collect: async (d, o) => (collected.push(d.host), scanned(d.host, o.day, 0.41, 85)), now: () => new Date('2026-09-07T06:00:00.000Z') },
    )
    if ('refuse' in applied) throw new Error(applied.refuse)
    expect(collected).toEqual(['acme.test', 'beta.test'])
    expect(applied.ran.map((r) => [r.host, r.status, r.spentUsd, r.calls])).toEqual([
      ['acme.test', 'scanned', 0.41, 85],
      ['beta.test', 'scanned', 0.41, 85],
    ])
    expect(applied.spentAfter).toBeCloseTo(0.82, 6)
    const ledger = readDailyLedger(dir)['2026-09-07']!
    expect(ledger).toMatchObject({ capUsd: applied.capUsd, spentUsd: 0.82, calls: 170 })
    expect(Object.keys(ledger.domains)).toEqual(['acme.test', 'beta.test'])
    expect(listCycles(dir, 'acme.test').map((c) => c.day)).toEqual(['2026-09-07'])
    expect(callsThisMonth('acme.test', defaultDomainCeilingConfig(dir, {}, 85), new Date('2026-09-07T00:00:00.000Z'))).toBe(85)

    const again = await runTick({ dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' }, { collect: async () => { throw new Error('must not be called') } })
    if ('refuse' in again) throw new Error(again.refuse)
    expect(again.ran).toEqual([])
    expect(again.list.notDue.map((n) => n.reason)).toEqual(['cycle-today', 'cycle-today'])
    expect(again.spentAfter).toBeCloseTo(0.82, 6)
  })

  it('the cap gates: a domain whose expected cost with headroom does not fit in what is left is refused, and a prior over-spend closes the day', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    setTracked(dir, 'beta.test', true, { by: 'operator', reason: 'r' })
    const cap = dailyCapUsd(dueToday(dir, {}, '2026-09-07'))
    // The first domain's runner reports a storm: it spent almost the whole day's cap. The second must be refused, not run.
    const outcome = await runTick(
      { dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' },
      { collect: async (d, o) => scanned(d.host, o.day, cap - 0.01, 300) },
    )
    if ('refuse' in outcome) throw new Error(outcome.refuse)
    expect(outcome.ran.map((r) => r.host)).toEqual(['acme.test'])
    expect(outcome.refused).toEqual([{ host: 'beta.test', reason: expect.stringContaining('daily cap') }])
    expect(outcome.spentAfter).toBeCloseTo(cap - 0.01, 6)
  })

  it('a collector that reports no spend figure is booked at the expected cost with headroom, never at zero', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    const outcome = await runTick(
      { dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' },
      { collect: async (d, o) => ({ ...scanned(d.host, o.day, 0, 85), run: undefined }) as never },
    )
    if ('refuse' in outcome) throw new Error(outcome.refuse)
    expect(outcome.ran[0]!.spentUsd).toBeCloseTo(17 * PER_PROMPT * RETRY_HEADROOM, 6)
  })

  it('a collector that throws is booked at the expected cost, and the loop goes on to the next domain', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    setTracked(dir, 'beta.test', true, { by: 'operator', reason: 'r' })
    const outcome = await runTick(
      { dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' },
      { collect: async (d, o) => (d.host === 'acme.test' ? Promise.reject(new Error('socket hung up')) : scanned(d.host, o.day, 0.4, 85)) },
    )
    if ('refuse' in outcome) throw new Error(outcome.refuse)
    expect(outcome.ran.map((r) => [r.host, r.status.slice(0, 6)])).toEqual([
      ['acme.test', 'failed'],
      ['beta.test', 'scanne'],
    ])
    expect(readDailyLedger(dir)['2026-09-07']!.domains['acme.test']!.spentUsd).toBeCloseTo(17 * PER_PROMPT * RETRY_HEADROOM, 6)
  })
})

describe('fail closed', () => {
  it('a corrupt daily ledger refuses the whole tick before a cell is asked', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    writeFileSync(dailyLedgerFile(dir), '{ not json')
    await expect(runTick({ dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' }, { collect: async () => { throw new Error('must not be called') } })).rejects.toThrow(/not readable JSON/)
  })

  it('a live tick refuses without the loop armed, without both flags, without a key, without a plan, without the hard ceiling, for a day that is not today, and on an exhausted or short runner ledger, in that order', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    const now = () => new Date('2026-09-07T06:00:00.000Z')
    const live = (env: NodeJS.ProcessEnv, day = '2026-09-07') => runTick({ dataDir: dir, env, day, apply: true, mode: 'live', root: dir }, { collect: async () => { throw new Error('must not be called') }, now })
    const armed = { GRADER_DAILY_LOOP: 'armed', COLLECTION_ENABLED: 'true', GRADER_LIVE_SCAN: 'true', OPENWEBNINJA_API_KEY: 'k', OPENWEBNINJA_PLAN: 'payg' }
    expect(await live({})).toMatchObject({ refuse: expect.stringContaining('not armed') })
    expect(await live({ GRADER_DAILY_LOOP: 'armed' })).toMatchObject({ refuse: expect.stringContaining('live collection is off') })
    expect(await live({ GRADER_DAILY_LOOP: 'armed', COLLECTION_ENABLED: 'true', GRADER_LIVE_SCAN: 'true' })).toMatchObject({ refuse: expect.stringContaining('no provider key') })
    expect(await live({ GRADER_DAILY_LOOP: 'armed', COLLECTION_ENABLED: 'true', GRADER_LIVE_SCAN: 'true', OPENWEBNINJA_API_KEY: 'k' })).toMatchObject({ refuse: expect.stringContaining('OPENWEBNINJA_PLAN') })
    expect(await live(armed)).toMatchObject({ refuse: expect.stringContaining('COLLECTION_BUDGET_USD_DAILY') })
    expect(await live({ ...armed, COLLECTION_BUDGET_USD_DAILY: '2' }, '2026-09-08')).toMatchObject({ refuse: expect.stringContaining('runs for today') })
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ capUsd: 5, spentUsd: 4.9, calls: 700, byEngine: {}, updatedAt: 'x', exhaustedAt: '2026-09-06T00:00:00.000Z' }))
    expect(await live({ ...armed, COLLECTION_BUDGET_USD_DAILY: '2' })).toMatchObject({ refuse: expect.stringContaining('exhausted') })
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ capUsd: 5, spentUsd: 4.9, calls: 700, byEngine: {}, updatedAt: 'x' }))
    expect(await live({ ...armed, COLLECTION_BUDGET_USD_DAILY: '2' })).toMatchObject({ refuse: expect.stringContaining('less than today') })
    expect(readDailyLedger(dir)).toEqual({})
  })

  it('one tick at a time: a second tick over the same store is refused while the lock is held', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    writeFileSync(join(dir, 'tick.lock'), '999 now')
    const outcome = await runTick({ dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' }, { collect: async () => { throw new Error('must not be called') } })
    expect(outcome).toMatchObject({ refuse: expect.stringContaining('another tick holds') })
  })

  it('a run the runner refused before any call, because another scan holds its lock, is booked at zero', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    const outcome = await runTick({ dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' }, { collect: async () => Promise.reject(new Error('another scan holds d:/x/run.lock (pid 1, last active 3s ago)')) })
    if ('refuse' in outcome) throw new Error(outcome.refuse)
    expect(outcome.ran[0]).toMatchObject({ status: expect.stringContaining('refused-before-call'), spentUsd: 0 })
  })

  it('nobody tracked: the cap is zero and nothing runs even with --apply', async () => {
    const outcome = await runTick({ dataDir: dir, env: {}, day: '2026-09-07', apply: true, mode: 'fixture' }, { collect: async () => { throw new Error('must not be called') } })
    if ('refuse' in outcome) throw new Error(outcome.refuse)
    expect(outcome.capUsd).toBe(0)
    expect(outcome.ran).toEqual([])
  })
})

describe('the loop through the real runner, offline', () => {
  it('a fixture tick collects a due domain through runGrader, files the cycle, books the ledger, and honours the one-cycle-per-day rule on the next tick', async () => {
    setTracked(dir, 'pipedrive.com', true, { by: 'operator', reason: 'reference domain' })
    const env = { GRADER_PROMPTS_PER_SCAN: '2' }
    const first = await runTick({ dataDir: dir, env, day: '2026-09-07', apply: true, mode: 'fixture' })
    if ('refuse' in first) throw new Error(first.refuse)
    expect(first.ran.map((r) => [r.host, r.status, r.calls])).toEqual([['pipedrive.com', 'scanned', 2 * ENGINES.length]])
    expect(first.ran[0]!.spentUsd).toBe(0) // the fixture adapter prices a call at zero, and the runner's ledger says so
    expect(listCycles(dir, 'pipedrive.com').map((c) => c.day)).toEqual(['2026-09-07'])
    const stored = JSON.parse(readFileSync(join(dir, 'results', 'pipedrive.com.json'), 'utf8')) as { run: { mode: string; day: string } }
    expect(stored.run).toMatchObject({ mode: 'fixture', day: '2026-09-07' })
    const second = await runTick({ dataDir: dir, env, day: '2026-09-07', apply: true, mode: 'fixture' })
    if ('refuse' in second) throw new Error(second.refuse)
    expect(second.ran).toEqual([])
    expect(second.list.notDue[0]).toMatchObject({ host: 'pipedrive.com', reason: 'cycle-today' })
  })
})
