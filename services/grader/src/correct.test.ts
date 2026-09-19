import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGINES } from '@bliprank/contracts'
import { consequencesOf } from './category-requests.js'
import { parseCorrectArgs } from './correct.js'
import { writeCycle } from './cycles.js'
import { DEFAULT_PROMPTS_PER_SCAN } from './live-gate.js'
import { recordCategory } from './resolve-category.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-correct-cli-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the arguments', () => {
  it('apply and decline are two acts, each needs a domain, and --to needs --reason', () => {
    expect(parseCorrectArgs(['--apply', '--decline', '--domain', 'a.test'])).toMatchObject({ refuse: expect.stringContaining('two different acts') })
    expect(parseCorrectArgs(['--apply'])).toMatchObject({ refuse: expect.stringContaining('needs --domain') })
    expect(parseCorrectArgs(['--domain', 'a.test', '--to', 'erp-software'])).toMatchObject({ refuse: expect.stringContaining('needs --reason') })
    expect(parseCorrectArgs(['--domain', 'a.test', '--decline', '--to', 'erp-software', '--reason', 'x'])).toMatchObject({ refuse: expect.stringContaining('--decline takes --note only') })
    const ok = parseCorrectArgs(['--domain', 'a.test', '--to', 'erp-software', '--reason', 'because', '--apply', '--data', dir])
    expect(ok).toMatchObject({ domain: 'a.test', to: 'erp-software', reason: 'because', apply: true, decline: false, by: 'operator', dataDir: dir })
    expect(parseCorrectArgs([])).toMatchObject({ apply: false, decline: false })
    expect(parseCorrectArgs([], { GRADER_DATA_DIR: dir })).toMatchObject({ dataDir: dir })
    expect(parseCorrectArgs(['--data', 'elsewhere'], { GRADER_DATA_DIR: dir })).toMatchObject({ dataDir: 'elsewhere' })
  })
})

describe('the consequences a person sees before --apply', () => {
  it('counts every stored cycle as kept-but-off-the-trend, and prices the next cycle at the plan in the environment', () => {
    recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
    const cycle = (day: string) => ({
      status: 'scanned',
      domain: 'acme.test',
      category: 'crm-software',
      categoryName: 'CRM',
      comparisonBasis: 'grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=2|runs=1',
      algoVersion: 'det-2',
      collectedAt: `${day}T10:00:00.000Z`,
      run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt'], capUsd: 5, at: `${day}T10:01:00.000Z` },
      counts: { cellsRequested: 2, cacheHits: 0, collected: 2, failed: 0, answersScored: 2, providerCalls: 2 },
      brands: [],
    })
    writeCycle(dir, cycle('2026-08-20'))
    writeCycle(dir, cycle('2026-09-01'))

    const c = consequencesOf(dir, 'acme.test', {})
    expect(c.earlierCycles).toBe(2)
    expect(c.prompts).toBe(DEFAULT_PROMPTS_PER_SCAN)
    expect(c.engines).toBe(ENGINES.length)
    expect(c.cells).toBe(DEFAULT_PROMPTS_PER_SCAN * ENGINES.length)
    // Pay-as-you-go when the plan is unset: the dearest, so the stated cost is never an underestimate.
    expect(c.plan).toBe('payg')
    expect(c.usd).toBeCloseTo((0.007 * 3 + 0.008 + 0.005) * DEFAULT_PROMPTS_PER_SCAN, 6)

    const mega = consequencesOf(dir, 'acme.test', { OPENWEBNINJA_PLAN: 'mega', GRADER_PROMPTS_PER_SCAN: '10' })
    expect(mega).toMatchObject({ plan: 'mega', prompts: 10, cells: 10 * ENGINES.length })
    expect(mega.usd).toBeCloseTo((0.002 * 4 + 0.001) * 10, 6)
  })

  it('a domain with no cycles has nothing to leave off a trend', () => {
    expect(consequencesOf(dir, 'nobody.test', {}).earlierCycles).toBe(0)
    // The domain's own set, when one is in force, IS the next cycle (ADR-0016 Amendment 1), and a correction does not clear it: the figure follows the set, in either direction (C3 cost review).
    expect(consequencesOf(dir, 'acme.test', { GRADER_PROMPTS_PER_SCAN: '10' }, 0, 12)).toMatchObject({ prompts: 12, cells: 12 * 5 })
    expect(consequencesOf(dir, 'acme.test', {}, 0, 3)).toMatchObject({ prompts: 3, cells: 3 * 5 })
    expect(consequencesOf(dir, 'acme.test', {}, 0, 0)).toMatchObject({ prompts: 17 })
  })
})
