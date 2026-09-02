import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureAdapter } from '../../../../../services/collector/src/pilot/fixture-adapter.js'
import { listCycles, writeCycle } from '../../../../../services/grader/src/cycles.js'
import { recordCategory } from '../../../../../services/grader/src/resolve-category.js'

/**
 * THE WHOLE PATH, WITH ONLY THE NETWORK REPLACED.
 *
 * `cycles.route.test.ts` mocks the runner, which is the right way to test the
 * route's own decisions and the wrong way to test what the runner does with
 * them. This file mocks nothing in the grader: the real `POST` calls the real
 * `runGrader`, which takes the real run lock, opens the real budget and rate
 * ledgers in a scratch directory, resolves the category through the real
 * `resolveCategory`, collects every cell through the real
 * `CollectionOrchestrator` into the real blob store, scores with the real
 * scorer, and files the cycle through the real store.
 *
 * Two things are replaced, both at the network edge:
 *
 *   - the provider adapter, swapped for the offline FIXTURE adapter the pilot
 *     and `grader:scan --fixture` use — deterministic answers, no socket;
 *   - the live quota read, which is an HTTP call to the provider.
 *
 * And the global `fetch` is stubbed to THROW, which covers the provider adapter
 * and the bank author. It does NOT cover the homepage fetcher, which uses
 * undici's own client (`fetch-site.ts`); that path is free and is proven
 * unreached by the category assertion below, not by the stub: rung 0 answers
 * from the record before rung 3 could read a page.
 *
 * ⚠️ THE CATEGORY IS PROVEN HERE, NOT BY CONSTRUCTION. The domain is
 * pipedrive.com, which the host-shape classifier places in crm-software as a
 * tracked leader. The record says accounting-software. If anything on the path
 * re-derived the category, the result would say crm-software; it says what the
 * record says, on the second cycle as on the first.
 *
 * `COLLECTION_ENABLED` is set in THIS PROCESS's env only, because the route
 * refuses without it; the orchestrator's own spend guard does not consult it
 * for an adapter that declares itself offline, and this adapter does. Nothing
 * here can spend: there is no key that works, no socket, and a fetch that throws.
 */

// Mocked by FILE, not by package name: apps/public does not depend on
// @bliprank/collector, so the specifier would not resolve from here, while
// services/grader's `import '@bliprank/collector'` resolves to exactly this file.
vi.mock('../../../../../services/collector/src/index.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/collector/src/index.js')>()
  return { ...actual, openWebNinjaAdapter: (engine: Parameters<typeof fixtureAdapter>[0]) => fixtureAdapter(engine, { latencyMs: 0 }) }
})

vi.mock('../../../../../services/grader/src/live-gate.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/live-gate.js')>()
  return { ...actual, checkGate: vi.fn(async () => ({ ok: true, quota: [] })) }
})

import { POST } from './route'

const DOMAIN = 'pipedrive.com'
const RECORDED_SLUG = 'accounting-software'
let dir: string
let ip = 0
const originalEnv = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-cycles-e2e-'))
  process.env['GRADER_DATA_DIR'] = dir
  process.env['COLLECTION_ENABLED'] = 'true'
  process.env['GRADER_LIVE_SCAN'] = 'true'
  process.env['OPENWEBNINJA_API_KEY'] = 'not-a-real-key'
  process.env['OPENWEBNINJA_PLAN'] = 'payg'
  // Two prompts × five engines = ten cells, so the real rate budget paces the
  // run in seconds rather than minutes. The ceiling default follows this too.
  process.env['GRADER_PROMPTS_PER_SCAN'] = '2'
  delete process.env['OPENROUTER_API_KEY']
  delete process.env['BANK_AUTHOR_API_KEY']
  vi.stubGlobal('fetch', (async (u: unknown) => {
    throw new Error(`network reached: ${String(u)}`)
  }) as unknown as typeof fetch)
  recordCategory(dir, { host: DOMAIN, slug: RECORDED_SLUG, source: 'site-content', evidence: 'recorded for the test', decidedAt: '2026-08-01T00:00:00.000Z', generated: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const post = async (body: Record<string, unknown>) => {
  ip += 1
  const res = await POST(new Request('http://localhost:3001/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip}` }, body: JSON.stringify(body) }))
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

const today = () => new Date().toISOString().slice(0, 10)

const earlier = () => ({
  status: 'scanned',
  domain: DOMAIN,
  category: RECORDED_SLUG,
  categoryName: 'Accounting software',
  comparisonBasis: `grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|${RECORDED_SLUG}@1|unprompted=2|runs=1`,
  algoVersion: 'det-2',
  collectedAt: '2026-08-01T10:00:00.000Z',
  counts: { cellsRequested: 10, cacheHits: 0, collected: 10, failed: 0, answersScored: 10, providerCalls: 10 },
  brands: [{ id: `domain:${DOMAIN}`, name: 'pipedrive', isSubject: true, mentions: 1, citations: 0, metric: { value: 0.1, ci_low: 0.02, ci_high: 0.4, n: 10, algo_version: 'det-2', collection_path: 'third-party-grounded', comparison_basis: 'b' } }],
  run: { mode: 'live', plan: 'payg', day: '2026-08-01', engines: ['chatgpt'], capUsd: 5, at: '2026-08-01T10:01:00.000Z' },
})

describe('a second cycle through the real runner, resolver, orchestrator, scorer and store', () => {
  it('⚠️ collects today beside the earlier day, under the RECORDED category and not the classifier’s', async () => {
    writeCycle(dir, earlier())

    const events = await post({ domain: DOMAIN, cycle: 'new' })
    const error = events.find((e) => e.event === 'error')
    expect(error, JSON.stringify(error?.data)).toBeUndefined()
    expect(events.map((e) => e.event)).toContain('progress')

    const result = events.find((e) => e.event === 'result')!.data as {
      status: string
      category: string
      subjectSource: string
      comparisonBasis: string
      counts: { cellsRequested: number; collected: number; answersScored: number; providerCalls: number; failed: number }
      run: { day: string; mode: string }
      brands: { isSubject: boolean; metric: { n: number; algo_version: string } }[]
      promptRows: unknown[]
    }
    expect(result.status).toBe('scanned')
    // THE PROPERTY. pipedrive.com is a crm-software leader by its host; the
    // record says accounting-software; the second cycle says what the record says.
    expect(result.category).toBe(RECORDED_SLUG)
    expect(result.comparisonBasis).toContain(`${RECORDED_SLUG}@`)
    expect(result.comparisonBasis).toContain('unprompted=2')
    expect(result.subjectSource).toBe('domain-label')
    expect(result.run.day).toBe(today())
    expect(result.counts).toMatchObject({ cellsRequested: 10, collected: 10, failed: 0, answersScored: 10 })
    expect(result.counts.providerCalls).toBeGreaterThan(0)
    expect(result.promptRows).toHaveLength(10)
    const subject = result.brands.find((b) => b.isSubject)!
    expect(subject.metric.n).toBe(10)
    expect(subject.metric.algo_version).toBe('det-2')

    // Filed beside the earlier day; the latest follows; the earlier bytes hold.
    const cycles = listCycles(dir, DOMAIN)
    expect(cycles.map((c) => c.day)).toEqual(['2026-08-01', today()])
    expect(JSON.parse(readFileSync(cycles[0]!.file, 'utf8')).brands[0].mentions).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'results', `${DOMAIN}.json`), 'utf8')).run.day).toBe(today())

    // The record did not move, and the resolver read it rather than the site.
    expect(JSON.parse(readFileSync(join(dir, 'domain-categories.json'), 'utf8'))[DOMAIN].slug).toBe(RECORDED_SLUG)

    // Every gate and ledger a first scan touches was touched: the ceiling booked
    // the realised calls, the burst cap has the domain, the run lock is released.
    const ceiling = JSON.parse(readFileSync(join(dir, 'domain-ceiling.json'), 'utf8')) as Record<string, Record<string, number>>
    expect(Object.values(ceiling)[0]![DOMAIN]).toBe(result.counts.providerCalls)
    const cap = JSON.parse(readFileSync(join(dir, 'live-cap.json'), 'utf8')) as Record<string, string[]>
    expect(cap[today()]).toContain(DOMAIN)
    expect(() => readFileSync(join(dir, 'run.lock'))).toThrow()
  }, 120_000)

  it('the same day again is refused before the runner, and a plain request now serves today’s cycle from cache', async () => {
    writeCycle(dir, earlier())
    await post({ domain: DOMAIN, cycle: 'new' })
    const again = await post({ domain: DOMAIN, cycle: 'new' })
    expect(again.find((e) => e.event === 'error')!.data['kind']).toBe('cycle-exists')
    const plain = await post({ domain: DOMAIN })
    expect(plain.map((e) => e.event)).toEqual(['cached', 'result'])
    expect((plain[1]!.data as { run: { day: string } }).run.day).toBe(today())
    expect(listCycles(dir, DOMAIN)).toHaveLength(2)
  }, 120_000)
})
