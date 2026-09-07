import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Budget, RunAllowanceExceeded } from '@bliprank/collector'
import { ENGINES } from '@bliprank/contracts'
import { dailyCapUsd, readDailyLedger, runTick } from './daily-loop.js'
import { RETRY_HEADROOM, checkDomainCeiling, cyclesThisMonth, recordDomainCycle, runAllowanceFor, type DomainCeilingConfig } from './domain-ceiling.js'
import { dueToday, setTracked } from './due.js'
import { recordCategory } from './resolve-category.js'
import { runGrader } from './run.js'
import type { ScanResult } from './scan.js'

/**
 * THE THREE FAILURES ADR-0017 WORKED WITH REAL NUMBERS, RE-RUN UNDER THE SPLIT
 * (decided 2026-09-07): the manual ceiling denominated in cycles, the loop
 * bounded by one cycle a day, the daily cap, and a per-run allowance the
 * collector's Budget enforces. Same numbers as the investigation: 17 prompts
 * = 85 cells, 15 custom prompts on top = 160 cells, pay-as-you-go.
 *
 * Nothing here spends: scratch ledgers, a fake collector, and the real runner
 * in fixture mode where a call costs $0 but still counts as an attempt.
 */

let dir: string
let cfg: DomainCeilingConfig
const at = (d: string) => new Date(`${d}T09:00:00.000Z`)
const PER_PROMPT = 0.007 * 3 + 0.008 + 0.005
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-worked-'))
  cfg = { maxCyclesPerMonth: 2, ledgerFile: join(dir, 'domain-ceiling.json') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A hand-started cycle as the route runs it: refuse on the count, else run, then book the cycle with its realised calls. */
function manualCycle(day: string, cells: number, realised: number): 'allowed' | 'refused' {
  const v = checkDomainCeiling('acme.test', cfg, at(day))
  if (!v.ok) return 'refused'
  expect(runAllowanceFor(cells)).toBeGreaterThanOrEqual(realised) // the run itself would have been stopped at the allowance
  recordDomainCycle('acme.test', realised, cfg, at(day))
  return 'allowed'
}

describe('A · the prompt set shrinks mid-month', () => {
  it('a domain that took its two hand-started cycles is refused a third on the count, not on a limit its own change of set moved; the refusal names cycles', () => {
    expect(manualCycle('2026-09-01', 160, 160)).toBe('allowed')
    expect(manualCycle('2026-09-08', 160, 160)).toBe('allowed')
    // The customer clears the set; the next hand-started cycle would be 85 cells.
    const third = checkDomainCeiling('acme.test', cfg, at('2026-09-15'))
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.message).toContain('has already started 2 of its 2 hand-started cycles')
    expect(third.message).toContain('320 provider requests')
    // Under the old, call-denominated ceiling this read "used 320 + 85 > 204": a refusal caused by the set change.
    // Now it is the same refusal the domain would have met at 85 cells all month: two cycles, then October.
    expect(cyclesThisMonth('acme.test', cfg, at('2026-09-22'))).toEqual({ cycles: 2, calls: 320 })
    expect(checkDomainCeiling('acme.test', cfg, at('2026-10-01')).ok).toBe(true)
  })
})

describe('B · the prompt set grows mid-month', () => {
  it('two hand-started cycles are the month; adding 15 prompts does not unlock a third, so the over-collection of 330 calls for $2.24 cannot happen', () => {
    expect(manualCycle('2026-09-01', 85, 85)).toBe('allowed')
    expect(manualCycle('2026-09-08', 85, 85)).toBe('allowed')
    expect(manualCycle('2026-09-12', 85, 85)).toBe('refused')
    // The customer adds 15 own prompts: a cycle is now 160 cells. Under the old ceiling this raised the limit to 384 and admitted a third cycle.
    expect(manualCycle('2026-09-15', 160, 160)).toBe('refused')
    expect(cyclesThisMonth('acme.test', cfg, at('2026-09-15'))).toEqual({ cycles: 2, calls: 170 })
    // What the month cost: the designed two cycles, 170 calls, not 330.
    expect(170 * PER_PROMPT / ENGINES.length).toBeCloseTo(1.156, 3)
  })

  it('a bigger set changes what one cycle may realise, through the allowance, never how many cycles a month allows', () => {
    expect(runAllowanceFor(85)).toBe(102)
    expect(runAllowanceFor(160)).toBe(192)
    // A run of 160 cells that retries every cell once would need 320 attempts; the allowance stops it at 192.
    const b = new Budget(join(dir, 'ledger.fixture.json'), 5, () => 0, () => new Date(), runAllowanceFor(160))
    let made = 0
    try {
      for (;;) {
        b.charge(ENGINES[made % ENGINES.length]!)
        made += 1
      }
    } catch (e) {
      expect(e).toBeInstanceOf(RunAllowanceExceeded)
    }
    expect(made).toBe(192)
  })
})

describe('C · a daily loop for a whole month', () => {
  it('thirty ticks file thirty cycles: the manual ceiling is never consulted, one cycle a day holds, the daily cap gates each day, and the allowance bounds each run', async () => {
    recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'paying customer' })
    const cap = dailyCapUsd(dueToday(dir, {}, '2026-09-01'))
    expect(cap).toBeCloseTo(17 * PER_PROMPT * RETRY_HEADROOM, 6)
    const allowances: number[] = []
    const scanned = (host: string, day: string): ScanResult & { run: { spentUsd: number } } =>
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
        counts: { cellsRequested: 85, cacheHits: 0, collected: 85, failed: 0, answersScored: 85, providerCalls: 85 },
        brands: [],
        promptRows: [],
        run: { spentUsd: 85 * (PER_PROMPT / ENGINES.length) },
      }) as unknown as ScanResult & { run: { spentUsd: number } }
    let filed = 0
    for (let d = 1; d <= 30; d++) {
      const day = `2026-09-${String(d).padStart(2, '0')}`
      const outcome = await runTick(
        { dataDir: dir, env: {}, day, apply: true, mode: 'fixture' },
        { collect: async (dom, o) => (allowances.push(o.allowanceCalls), scanned(dom.host, o.day)), now: () => at(day) },
      )
      if ('refuse' in outcome) throw new Error(outcome.refuse)
      filed += outcome.ran.length
      expect(outcome.refused).toEqual([])
      // Each day's spend is one cycle, under that day's cap.
      expect(outcome.spentAfter).toBeLessThanOrEqual(cap + 1e-9)
    }
    expect(filed).toBe(30)
    expect(new Set(allowances)).toEqual(new Set([102]))
    // Under the old ceiling the third day was `not due: ceiling` (170 + 85 > 204). The manual ledger was never written by the loop: the file does not exist.
    expect(existsSync(cfg.ledgerFile)).toBe(false)
    expect(cyclesThisMonth('acme.test', cfg, at('2026-09-30'))).toEqual({ cycles: 0, calls: 0 })
    // Thirty days of ledger, each its own cap.
    expect(Object.keys(readDailyLedger(dir))).toHaveLength(30)
    // A hand-started cycle in the same month is still bounded by the manual ceiling, on its own count.
    expect(checkDomainCeiling('acme.test', cfg, at('2026-09-30'))).toMatchObject({ ok: true, cycles: 0 })
  })

  it('a retry storm inside one run is stopped at the allowance by the real runner, offline, with the ledger left clean', async () => {
    recordCategory(dir, { host: 'pipedrive.com', slug: 'crm-software', source: 'leader-domain', evidence: 'x', decidedAt: '2026-08-01', generated: false })
    // Two prompts on two engines is four cells; an allowance of three attempts stops the fourth cell's first attempt.
    const result = await runGrader({
      domain: 'pipedrive.com',
      plan: 'payg',
      day: '2026-09-07',
      engines: ['chatgpt', 'gemini'],
      capUsd: 5,
      maxPrompts: 2,
      mode: 'fixture',
      apiKey: '',
      dataDir: dir,
      outFile: join(dir, 'latest.json'),
      log: () => {},
      runAllowanceCalls: 3,
    })
    if (!('counts' in result)) throw new Error(result.status)
    expect(result.counts.providerCalls).toBe(3)
    expect(result.counts.cellsRequested).toBe(4)
    expect(result.status === 'scanned' ? result.counts.answersScored : 0).toBe(3)
    // The stop was the allowance, not the ledger: a second run against the same store starts clean and completes.
    const again = await runGrader({ domain: 'pipedrive.com', plan: 'payg', day: '2026-09-08', engines: ['chatgpt', 'gemini'], capUsd: 5, maxPrompts: 2, mode: 'fixture', apiKey: '', dataDir: dir, outFile: join(dir, 'latest.json'), log: () => {}, runAllowanceCalls: runAllowanceFor(4) })
    if (!('counts' in again)) throw new Error(again.status)
    expect(again.counts.providerCalls).toBe(4)
    expect(again.status).toBe('scanned')
  })
})

describe('D · the held claim after an allowance stop (ADR-0017 "left as they are", fixed 2026-09-07)', () => {
  it('a re-run on the SAME day, inside the lease window, completes the cell the allowance stop left short: one call, four answers, scanned', async () => {
    recordCategory(dir, { host: 'pipedrive.com', slug: 'crm-software', source: 'leader-domain', evidence: 'x', decidedAt: '2026-08-01', generated: false })
    const run = (allowance: number, outcomes: string[]) =>
      runGrader({
        domain: 'pipedrive.com',
        plan: 'payg',
        day: '2026-09-07',
        engines: ['chatgpt', 'gemini'],
        capUsd: 5,
        maxPrompts: 2,
        mode: 'fixture',
        apiKey: '',
        dataDir: dir,
        outFile: join(dir, 'latest.json'),
        log: () => {},
        runAllowanceCalls: allowance,
        onProgress: (p) => outcomes.push(p.outcome),
      })
    const first: string[] = []
    const stopped = await run(3, first)
    if (!('counts' in stopped)) throw new Error(stopped.status)
    expect(stopped.counts).toMatchObject({ cellsRequested: 4, collected: 3, failed: 1, providerCalls: 3 })
    // The stream names the bound that refused: the run's allowance, not the ledger's cap.
    expect(first).toEqual(['collected', 'collected', 'collected', 'allowance-exhausted'])
    // Measured before the fix, same day, same store: 3 of 4 cells, no provider
    // call, the fourth cell `claimed-elsewhere`, and the status `scanned`.
    const again: string[] = []
    const completed = await run(runAllowanceFor(4), again)
    if (!('counts' in completed)) throw new Error(completed.status)
    expect(completed.status).toBe('scanned')
    expect(completed.counts).toMatchObject({ cellsRequested: 4, cacheHits: 3, collected: 1, failed: 0, providerCalls: 1, answersScored: 4 })
    expect(again).toEqual(['cache-hit', 'cache-hit', 'cache-hit', 'collected'])
  })
})
