/**
 * WHAT THESE TESTS DEFEND.
 *
 *   1. THE SAMPLE DOES NOT MOVE. A re-score changes the derivation over answers
 *      that have not changed. The moment it re-scopes the measurement too, it is
 *      a new scan wearing an old file's name — and the way that happens in
 *      practice is silent: `GRADER_PROMPTS_PER_SCAN` was temporarily 10 while
 *      pipedrive.com's stored result was collected over 17, so a re-score under
 *      "today's setting" would have republished it on 50 answers instead of 85,
 *      with a wider interval and a changed basis, for no reason a reader of the
 *      file could ever discover.
 *
 *   2. IT IS FREE BEFORE IT RUNS, NOT AFTER. Every cell is checked against the
 *      answer index first, and one miss refuses the domain. A check afterwards
 *      discovers a charge; it does not prevent one.
 *
 *   3. HISTORY IS KEPT. The superseded row is never overwritten, R5.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AnswerIndex } from '@bliprank/collector'
import { ENGINES, type EngineId } from '@bliprank/contracts'
import { DEMO_BANKS } from '@bliprank/taxonomy'
import { FileKV } from './local-store.js'
import { auditPathFor, planRescore, storedResults } from './rescore.js'
import { cyclePath, cyclesDir } from './cycles.js'
import { basisOf, cellsFor } from './scan.js'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'rescore-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const BANK = DEMO_BANKS.find((b) => b.category === 'crm-software')!
const BASIS = 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=17|runs=1'

/** A data dir holding one stored result, one category record, and an index. */
async function seed(
  dir: string,
  opts: { readonly day?: string; readonly basis?: string; readonly record?: boolean; readonly collected?: number } = {},
): Promise<void> {
  const day = opts.day ?? '2026-08-25'
  mkdirSync(join(dir, 'results'), { recursive: true })
  writeFileSync(
    join(dir, 'results', 'pipedrive.com.json'),
    JSON.stringify({
      status: 'scanned',
      domain: 'pipedrive.com',
      category: 'crm-software',
      algoVersion: 'det-1',
      comparisonBasis: opts.basis ?? BASIS,
      collectedAt: `${day}T06:00:00.000Z`,
      run: { mode: 'live', plan: 'payg', day, engines: [...ENGINES], capUsd: 5, at: `${day}T06:19:05.858Z` },
      counts: { cellsRequested: 85, cacheHits: 0, collected: 85, failed: 0, answersScored: 85, providerCalls: 22 },
      brands: [],
    }),
  )
  if (opts.record !== false) {
    writeFileSync(
      join(dir, 'domain-categories.json'),
      JSON.stringify({
        'pipedrive.com': { host: 'pipedrive.com', slug: 'crm-software', source: 'leader-domain', evidence: 'pipedrive.com', decidedAt: day, generated: false },
      }),
    )
  }
  // Seed the answer index with the first `collected` cells of the recorded scope.
  const cells = cellsFor(BANK, [...ENGINES] as EngineId[], day, 17)
  const index = new AnswerIndex(new FileKV(join(dir, 'index.json')))
  for (const c of cells.slice(0, opts.collected ?? cells.length)) {
    await index.markCollected(c.cell, `openwebninja:${c.engine}`, 1)
  }
}

describe('the scope comes off the file, never off today’s settings', () => {
  it('reads the prompt count and engine set out of the stored basis', () => {
    expect(basisOf(BASIS)).toEqual({ maxPrompts: 17, engines: ['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews'] })
  })

  it('⚠️ a 17-prompt result plans 85 cells even when the gate default is 10', async () => {
    // The defect this exists to prevent, exactly as it would have happened:
    // `GRADER_PROMPTS_PER_SCAN` is temporarily 10, and re-deriving under it
    // would republish an 85-answer measurement as a 50-answer one.
    const dir = tmp()
    await seed(dir)
    const plan = await planRescore(dir, 'pipedrive.com', 10)
    if ('refuse' in plan) throw new Error(plan.refuse)
    expect(plan.maxPrompts).toBe(17)
    expect(plan.cells).toBe(85)
    expect(plan.missing).toEqual([])
  })

  it('falls back to the caller’s default only when the file records no scope', async () => {
    // A file that never recorded its scope cannot have it recovered, and
    // guessing narrow is as wrong as guessing wide.
    expect(basisOf('')).toEqual({})
    expect(basisOf('grader|en-US|US|crm-software@1')).toEqual({})
    const dir = tmp()
    await seed(dir, { basis: 'grader|en-US|US|crm-software@1' })
    const plan = await planRescore(dir, 'pipedrive.com', 3)
    if ('refuse' in plan) throw new Error(plan.refuse)
    expect(plan.maxPrompts).toBe(3)
    expect(plan.engines).toEqual([...ENGINES])
  })

  it('ignores an engine the contract does not know', () => {
    expect(basisOf('engines=chatgpt,telepathy|unprompted=4').engines).toEqual(['chatgpt'])
    expect(basisOf('unprompted=0').maxPrompts).toBeUndefined()
    expect(basisOf('unprompted=abc').maxPrompts).toBeUndefined()
  })
})

describe('the pre-flight refuses before anything can spend', () => {
  it('names every cell that is not already in the store, and plans nothing', async () => {
    const dir = tmp()
    await seed(dir, { collected: 80 })
    const plan = await planRescore(dir, 'pipedrive.com', 17)
    if ('refuse' in plan) throw new Error(plan.refuse)
    // Five cells short. The runner only re-derives plans with none missing, so
    // this domain is skipped rather than bought.
    expect(plan.missing).toHaveLength(5)
    expect(plan.cells).toBe(85)
  })

  it('⚠️ refuses a domain with no category record rather than deciding one today', async () => {
    // Re-deriving a historical number under a category we would have to decide
    // now is the rebase `recordCategory` and R5 both exist to prevent.
    const dir = tmp()
    await seed(dir, { record: false })
    const plan = await planRescore(dir, 'pipedrive.com', 17)
    expect('refuse' in plan && plan.refuse).toContain('no category record')
  })

  it('⚠️ a cycle collected under an earlier category re-derives under ITS bank, not the record’s', async () => {
    const dir = tmp()
    await seed(dir) // record: crm-software; latest: crm-software
    mkdirSync(cyclesDir(dir, 'pipedrive.com'), { recursive: true })
    const file = cyclePath(dir, 'pipedrive.com', '2026-08-01')
    writeFileSync(
      file,
      JSON.stringify({
        status: 'scanned',
        domain: 'pipedrive.com',
        category: 'accounting-software',
        algoVersion: 'det-1',
        comparisonBasis: BASIS.replace('crm-software@1', 'accounting-software@1'),
        collectedAt: '2026-08-01T06:00:00.000Z',
        run: { mode: 'live', plan: 'payg', day: '2026-08-01', engines: [...ENGINES], capUsd: 5, at: '2026-08-01T06:19:05.858Z' },
        counts: { cellsRequested: 85, cacheHits: 0, collected: 85, failed: 0, answersScored: 85, providerCalls: 85 },
        brands: [],
      }),
    )
    const plan = await planRescore(dir, 'pipedrive.com', 17, file)
    if ('refuse' in plan) throw new Error(plan.refuse)
    expect(plan.category).toBe('accounting-software')
    expect(plan.file).toBe(file)
    expect(plan.day).toBe('2026-08-01')
  })

  it('refuses a domain this build holds no result for', async () => {
    const plan = await planRescore(tmp(), 'nobody.com', 17)
    expect('refuse' in plan && plan.refuse).toContain('no stored result')
  })

  it('⚠️ refuses when the day cannot be established', async () => {
    // The day is in the cache key. Falling back to wall clock would miss every
    // cell and buy the entire scan again — the one mistake that costs money.
    const dir = tmp()
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeFileSync(join(dir, 'results', 'x.com.json'), JSON.stringify({ domain: 'x.com', comparisonBasis: BASIS, brands: [] }))
    expect('refuse' in (await planRescore(dir, 'x.com', 17))).toBe(true)
  })

  it('takes the day from the run block, and from collectedAt when there is none', async () => {
    const dir = tmp()
    await seed(dir, { day: '2026-08-25' })
    const withRun = await planRescore(dir, 'pipedrive.com', 17)
    if ('refuse' in withRun) throw new Error(withRun.refuse)
    expect(withRun.day).toBe('2026-08-25')

    // Same file, run block removed: `collectedAt` is the fallback and it is the
    // same day, so the cells still resolve.
    const raw = JSON.parse(readFileSync(join(dir, 'results', 'pipedrive.com.json'), 'utf8')) as Record<string, unknown>
    delete raw['run']
    writeFileSync(join(dir, 'results', 'pipedrive.com.json'), JSON.stringify(raw))
    const withoutRun = await planRescore(dir, 'pipedrive.com', 17)
    if ('refuse' in withoutRun) throw new Error(withoutRun.refuse)
    expect(withoutRun.day).toBe('2026-08-25')
    expect(withoutRun.run).toBeUndefined()
  })
})

describe('history is kept, R5', () => {
  it('never overwrites a superseded row', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'results'), { recursive: true })
    const first = auditPathFor(dir, 'pipedrive.com', 'det-1')
    expect(first).toMatch(/pipedrive\.com\.det-1\.audit\.json$/)
    writeFileSync(first, '{}')
    // A second re-score under one algorithm gets its own slot rather than
    // erasing the first supersession.
    const second = auditPathFor(dir, 'pipedrive.com', 'det-1')
    expect(second).toMatch(/pipedrive\.com\.det-1\.2\.audit\.json$/)
    expect(second).not.toBe(first)
  })

  it('a file with no version stamp still gets a slot rather than none', () => {
    expect(auditPathFor(tmp(), 'x.com', '')).toMatch(/x\.com\.unversioned\.audit\.json$/)
  })

  it('audit rows are not themselves re-scorable', async () => {
    // They are history. Feeding one back through would produce a re-score of a
    // superseded row and quietly resurrect it.
    const dir = tmp()
    await seed(dir)
    writeFileSync(join(dir, 'results', 'pipedrive.com.det-1.audit.json'), '{}')
    expect(storedResults(dir)).toEqual(['pipedrive.com'])
  })
})
