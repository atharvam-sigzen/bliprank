import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listCycles, writeCycle } from '../../../../../services/grader/src/cycles.js'
import { recordCategory } from '../../../../../services/grader/src/resolve-category.js'
import { recordDomainCycle, defaultDomainCeilingConfig } from '../../../../../services/grader/src/domain-ceiling.js'

/**
 * THE SECOND CYCLE, THROUGH THE REAL ROUTE, WITHOUT SPENDING.
 *
 * Two modules are mocked and only two: the runner (so no provider is reached
 * and the "collected" result is synthetic) and the live quota read (so no HTTP
 * leaves the machine). Everything else is the real code path — the cache, the
 * record and bank checks, the same-day refusal, the flags, the visitor
 * throttle, the per-domain ceiling and the cycle store — running against a
 * scratch data directory named by `GRADER_DATA_DIR`, never the real data-live.
 *
 * ⚠️ WHAT THIS DOES AND DOES NOT PROVE ABOUT THE CATEGORY. With the runner
 * mocked, "the category never re-derives" is asserted here only at the route:
 * a new cycle is refused when no record exists or the recorded slug has no
 * bank, and the runner is asked with the same data directory, mode and author
 * a first scan passes — so it resolves through `resolveCategory`, whose rung 0
 * returns the record before anything can fetch (resolve-category.test.ts pins
 * that with a fetch that throws). The mock cannot prove the runner used the
 * record; the resolver's own tests do. What IS proven end to end: the cycle
 * is filed beside the earlier one, the latest follows, the first cycle's bytes
 * are unchanged, the record did not move, and every gate refuses a second
 * cycle in the words it refuses a first.
 */

const graderCalls: { domain: string; day: string; dataDir: string; mode: string; author: boolean; maxPrompts: number | undefined }[] = []
let gateVerdict: { ok: true; quota: never[] } | { ok: false; reason: 'quota'; message: string; short: never[] } = { ok: true, quota: [] }

vi.mock('../../../../../services/grader/src/run.js', () => ({
  runGrader: vi.fn(async (o: { domain: string; day: string; dataDir: string; mode: string; author?: unknown; maxPrompts?: number }) => {
    graderCalls.push({ domain: o.domain, day: o.day, dataDir: o.dataDir, mode: o.mode, author: o.author !== undefined, maxPrompts: o.maxPrompts })
    const w = { value: 0.3, ci_low: 0.21, ci_high: 0.41, n: 85 }
    return {
      status: 'scanned',
      domain: o.domain,
      category: 'crm-software',
      categoryName: 'CRM software',
      classification: { status: 'classified', slug: 'crm-software', signal: 'leader-domain', evidence: o.domain },
      subjectSource: 'domain-label',
      comparisonBasis: 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=17|runs=1',
      algoVersion: 'det-2',
      collectedAt: `${o.day}T10:00:00.000Z`,
      counts: { cellsRequested: 85, cacheHits: 0, collected: 85, failed: 0, answersScored: 85, providerCalls: 85 },
      brands: [{ id: `domain:${o.domain}`, name: o.domain, isSubject: true, mentions: 25, citations: 0, metric: { ...w, algo_version: 'det-2', collection_path: 'third-party-grounded', comparison_basis: 'b' } }],
      promptRows: [],
      run: { mode: 'live', plan: 'payg', day: o.day, engines: ['chatgpt', 'gemini', 'copilot', 'google-ai-mode', 'google-ai-overviews'], spentUsd: 0.3, capUsd: 5, at: `${o.day}T10:01:00.000Z` },
    }
  }),
}))

vi.mock('../../../../../services/grader/src/live-gate.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/live-gate.js')>()
  return { ...actual, checkGate: vi.fn(async () => gateVerdict) }
})

import { POST } from './route'

const DOMAIN = 'acme-cycles.example'
let dir: string
let ipCounter = 0
const originalEnv = { ...process.env }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-cycles-route-'))
  graderCalls.length = 0
  gateVerdict = { ok: true, quota: [] }
  process.env['GRADER_DATA_DIR'] = dir
  process.env['COLLECTION_ENABLED'] = 'true'
  process.env['GRADER_LIVE_SCAN'] = 'true'
  process.env['OPENWEBNINJA_API_KEY'] = 'test-key-never-used'
  process.env['TRUSTED_PROXY'] = 'cloudflare'
  // The RECORDED category, decided once. Rung 0 of the resolver reads this and
  // nothing else on every later scan.
  recordCategory(dir, { host: DOMAIN, slug: 'crm-software', source: 'leader-domain', evidence: DOMAIN, decidedAt: '2026-09-01T00:00:00.000Z', generated: false })
})
afterEach(async () => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const post = async (body: Record<string, unknown>) => {
  ipCounter += 1
  const req = new Request('http://localhost:3001/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': `203.0.113.${ipCounter}` },
    body: JSON.stringify(body),
  })
  const res = await POST(req)
  const text = await res.text()
  const events: { event: string; data: Record<string, unknown> }[] = []
  for (const block of text.split('\n\n')) {
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim()
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (data) events.push({ event, data: JSON.parse(data) as Record<string, unknown> })
  }
  return events
}

// Read at assertion time, not at module load, so a run across UTC midnight cannot disagree with the route's own clock.
const today = () => new Date().toISOString().slice(0, 10)
const firstCycle = (day: string, comparisonBasis = 'b') => ({
  status: 'scanned',
  domain: DOMAIN,
  category: 'crm-software',
  categoryName: 'CRM software',
  comparisonBasis,
  algoVersion: 'det-2',
  collectedAt: `${day}T10:00:00.000Z`,
  counts: { cellsRequested: 85, cacheHits: 0, collected: 85, failed: 0, answersScored: 85, providerCalls: 85 },
  brands: [{ id: 'x', name: DOMAIN, isSubject: true, mentions: 20, citations: 0, metric: { value: 0.24, ci_low: 0.16, ci_high: 0.34, n: 85, algo_version: 'det-2', collection_path: 'third-party-grounded', comparison_basis: 'b' } }],
  run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt'], capUsd: 5, at: `${day}T10:01:00.000Z` },
})

describe('a second cycle coexists with the first', () => {
  it('a plain request for a scanned domain is still the free cached latest', async () => {
    writeCycle(dir, firstCycle('2026-09-01'))
    const events = await post({ domain: DOMAIN })
    expect(events.map((e) => e.event)).toEqual(['cached', 'result'])
    expect(graderCalls).toEqual([])
  })

  it('⚠️ cycle: "new" collects today beside the earlier day; the latest follows; the category is the recorded one', async () => {
    writeCycle(dir, firstCycle('2026-09-01'))
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    expect(events.find((e) => e.event === 'error')).toBeUndefined()
    expect(events.find((e) => e.event === 'cached')).toBeUndefined()
    const result = events.find((e) => e.event === 'result')!.data as { category: string; run: { day: string } }
    expect(result.run.day).toBe(today())
    expect(result.category).toBe('crm-software')
    // The runner was asked once, for today, with the same data directory, mode
    // and authoring config a first scan passes — which is what makes it resolve
    // through the record rather than around it.
    expect(graderCalls).toHaveLength(1)
    expect(graderCalls[0]).toMatchObject({ domain: DOMAIN, day: today(), dataDir: dir, mode: 'live', maxPrompts: 17 })

    const cycles = listCycles(dir, DOMAIN)
    expect(cycles.map((c) => c.day)).toEqual(['2026-09-01', today()])
    // The first cycle is untouched: same bytes as before the second was filed.
    expect(JSON.parse(readFileSync(cycles[0]!.file, 'utf8')).brands[0].mentions).toBe(20)
    expect(JSON.parse(readFileSync(join(dir, 'results', `${DOMAIN}.json`), 'utf8')).run.day).toBe(today())
    // And the record did not move.
    expect(JSON.parse(readFileSync(join(dir, 'domain-categories.json'), 'utf8'))[DOMAIN].slug).toBe('crm-software')
  })

  it('a third cycle joins the two, and each keeps its own file', async () => {
    writeCycle(dir, firstCycle('2026-08-25'))
    writeCycle(dir, firstCycle('2026-09-01'))
    await post({ domain: DOMAIN, cycle: 'new' })
    expect(listCycles(dir, DOMAIN).map((c) => c.day)).toEqual(['2026-08-25', '2026-09-01', today()])
  })

  it('a first scan with cycle: "new" is just a first scan', async () => {
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    expect(events.find((e) => e.event === 'error')).toBeUndefined()
    expect(listCycles(dir, DOMAIN).map((c) => c.day)).toEqual([today()])
  })
})

describe('what refuses a second cycle, before anything could spend', () => {
  it('the same UTC day: the cache key is per day, so there is nothing new to buy', async () => {
    writeCycle(dir, firstCycle(today()))
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    const err = events.find((e) => e.event === 'error')!.data
    expect(err['kind']).toBe('cycle-exists')
    expect(String(err['message'])).toContain('one scan per UTC day')
    expect(String(err['message'])).toContain('nothing was charged')
    expect(graderCalls).toEqual([])
    expect(listCycles(dir, DOMAIN)).toHaveLength(1)
  })

  it('⚠️ a recorded category with no bank in this build: refused rather than measured against the general bank', async () => {
    // `resolveCategory` would leave the record alone and scan the fallback
    // bank — a second cycle against different prompts, filed on the same trend.
    writeCycle(dir, firstCycle('2026-09-01'))
    writeFileSync(
      join(dir, 'domain-categories.json'),
      JSON.stringify({ [DOMAIN]: { host: DOMAIN, slug: 'a-generated-slug-whose-bank-was-deleted', source: 'generated', evidence: 'x', decidedAt: '2026-09-01T00:00:00.000Z', generated: true } }),
    )
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    const err = events.find((e) => e.event === 'error')!.data
    expect(err['kind']).toBe('no-bank')
    expect(String(err['message'])).toContain('different question')
    expect(graderCalls).toEqual([])
    expect(listCycles(dir, DOMAIN)).toHaveLength(1)
  })

  it('⚠️ a basis the trend could not use: refused before the gates, naming the fix', async () => {
    // The last cycle was bought at 10 prompts per engine (both September scans
    // on disk were); the server now defaults to 17. A 17-prompt cycle would be
    // a point compare() refuses — spend for nothing drawable.
    writeCycle(dir, firstCycle('2026-09-01', 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=10|runs=1'))
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    const err = events.find((e) => e.event === 'error')!.data
    expect(err['kind']).toBe('basis-mismatch')
    expect(String(err['message'])).toContain('asked 10 prompts per engine and this one would ask 17')
    expect(String(err['message'])).toContain('GRADER_PROMPTS_PER_SCAN=10')
    expect(graderCalls).toEqual([])
    // With the server set to match, the same request goes ahead at 10.
    process.env['GRADER_PROMPTS_PER_SCAN'] = '10'
    const ok = await post({ domain: DOMAIN, cycle: 'new' })
    expect(ok.find((e) => e.event === 'error')).toBeUndefined()
    expect(graderCalls[0]).toMatchObject({ maxPrompts: 10 })
  })

  it('⚠️ a prompt count that cannot size a scan is refused before anything, on either path', async () => {
    // 0 would pass the ceiling (needing 0) and the quota gate, and the runner
    // drops a falsy maxPrompts and scans the whole bank.
    process.env['GRADER_PROMPTS_PER_SCAN'] = '0'
    for (const body of [{ domain: DOMAIN, cycle: 'new' }, { domain: 'other-cycles.example' }]) {
      const events = await post(body)
      expect(events.find((e) => e.event === 'error')!.data['kind']).toBe('config')
    }
    expect(graderCalls).toEqual([])
  })

  it('⚠️ no category record: refused rather than re-derived', async () => {
    writeCycle(dir, firstCycle('2026-09-01'))
    writeFileSync(join(dir, 'domain-categories.json'), '{}\n')
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    const err = events.find((e) => e.event === 'error')!.data
    expect(err['kind']).toBe('no-record')
    expect(String(err['message'])).toContain('not a trend')
    expect(graderCalls).toEqual([])
  })

  it('the per-domain ceiling applies to a second cycle exactly as to a first', async () => {
    writeCycle(dir, firstCycle('2026-09-01'))
    const ceilingCfg = defaultDomainCeilingConfig(dir, process.env)
    for (let i = 0; i < ceilingCfg.maxCyclesPerMonth; i++) await recordDomainCycle({ workspaceId: 'local', host: DOMAIN }, 85, ceilingCfg, new Date())
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    const err = events.find((e) => e.event === 'error')!.data
    expect(err['kind']).toBe('domain-ceiling')
    expect(graderCalls).toEqual([])
    expect(listCycles(dir, DOMAIN)).toHaveLength(1)
  })

  it('the live quota gate applies to a second cycle exactly as to a first', async () => {
    writeCycle(dir, firstCycle('2026-09-01'))
    gateVerdict = { ok: false, reason: 'quota', message: 'The provider quota for this cycle is used up', short: [] }
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    expect(events.find((e) => e.event === 'error')!.data['kind']).toBe('quota')
    expect(graderCalls).toEqual([])
  })

  it('the flags apply to a second cycle exactly as to a first', async () => {
    writeCycle(dir, firstCycle('2026-09-01'))
    process.env['GRADER_LIVE_SCAN'] = 'false'
    const events = await post({ domain: DOMAIN, cycle: 'new' })
    expect(events.find((e) => e.event === 'error')!.data['kind']).toBe('disabled')
    expect(graderCalls).toEqual([])
  })

  it('a second cycle is booked against the ceiling and the burst cap like any scan', async () => {
    writeCycle(dir, firstCycle('2026-09-01'))
    await post({ domain: DOMAIN, cycle: 'new' })
    const ceiling = JSON.parse(readFileSync(join(dir, 'domain-ceiling.json'), 'utf8')) as Record<string, Record<string, { cycles: number; calls: number }>>
    expect(Object.values(ceiling)[0]![DOMAIN]).toEqual({ cycles: 1, calls: 85 })
    const cap = JSON.parse(readFileSync(join(dir, 'live-cap.json'), 'utf8')) as Record<string, string[]>
    expect(cap[today()]).toContain(DOMAIN)
  })
})
