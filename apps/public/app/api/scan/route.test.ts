import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POST } from './route'
import { writeCycle } from '../../../../../services/grader/src/cycles.js'
import { recordCategory } from '../../../../../services/grader/src/resolve-category.js'
import { recordVisitorScan, defaultVisitorThrottleConfig } from '../../../../../services/grader/src/visitor-throttle'

/**
 * Route-level integration test for per-visitor scan throttling on POST /api/scan.
 *
 * Verifies:
 *   1. Throttled requests emit `kind: 'visitor-rate-limit'` SSE error.
 *   2. Throttled requests short-circuit before provider-quota / checkGate logic.
 *   3. Throttled requests do not touch the global shared ledger.
 *   4. Cached domains bypass the throttle entirely and return instantly.
 *
 * ⚠️ OVER A SCRATCH DATA DIRECTORY, NEVER THE MACHINE'S OWN (MVP_PLAN B5).
 * The first version of this file walked up to the machine's live data
 * directory, wrote its visitor ledger there, and expected a cached
 * pipedrive.com cycle that only one machine held — so the suite failed on a
 * clean checkout and CI's first run on the branch was red. Every path the
 * route touches is now `GRADER_DATA_DIR`, a fresh directory per test, and
 * the cached cycle is written from a fixture result the way
 * cycles.route.test.ts writes its own. Nothing here reaches the network: the
 * first case is refused at the throttle, before the quota read, and the
 * second is served from the cache, before the flags.
 */

const CACHED = 'cached-domain.example'
let dir: string
const originalEnv = { ...process.env }

/** A finished cycle, the shape `/api/scan` files and reads back (cycles.route.test.ts's fixture). */
const cycleOf = (domain: string, day: string) => ({
  status: 'scanned',
  domain,
  category: 'crm-software',
  categoryName: 'CRM software',
  comparisonBasis: 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=17|runs=1',
  algoVersion: 'det-2',
  collectedAt: `${day}T10:00:00.000Z`,
  counts: { cellsRequested: 85, cacheHits: 0, collected: 85, failed: 0, answersScored: 85, providerCalls: 85 },
  brands: [{ id: 'x', name: domain, isSubject: true, mentions: 20, citations: 0, metric: { value: 0.24, ci_low: 0.16, ci_high: 0.34, n: 85, algo_version: 'det-2', collection_path: 'third-party-grounded', comparison_basis: 'b' } }],
  run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt'], capUsd: 5, at: `${day}T10:01:00.000Z` },
})

describe('POST /api/scan per-visitor throttling', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bliprank-scan-route-'))
    process.env['GRADER_DATA_DIR'] = dir
    // The per-visitor throttle reads a header only behind a named proxy; the requests below write cf-connecting-ip.
    process.env['TRUSTED_PROXY'] = 'cloudflare'
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    rmSync(dir, { recursive: true, force: true })
  })

  async function parseSseResponse(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
    const reader = res.body?.getReader()
    if (!reader) return []
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }

    const events: { event: string; data: Record<string, unknown> }[] = []
    for (const block of text.split('\n\n')) {
      if (!block.trim()) continue
      let event = 'message'
      let dataStr = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim()
        else if (line.startsWith('data: ')) dataStr += line.slice(6).trim()
      }
      if (dataStr) {
        try {
          events.push({ event, data: JSON.parse(dataStr) as Record<string, unknown> })
        } catch {}
      }
    }
    return events
  }

  it('rejects with visitor-rate-limit when visitor limit is reached', async () => {
    const visitorIp = '203.0.113.88'
    const vCfg = defaultVisitorThrottleConfig(dir, { GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR: '2' } as unknown as NodeJS.ProcessEnv)

    // Pre-populate 2 scans for this IP, in the scratch directory's own ledger
    const now = new Date()
    await recordVisitorScan(visitorIp, vCfg, now)
    await recordVisitorScan(visitorIp, vCfg, now)

    process.env['COLLECTION_ENABLED'] = 'true'
    process.env['GRADER_LIVE_SCAN'] = 'true'
    process.env['OPENWEBNINJA_API_KEY'] = 'test-key-mock'
    process.env['GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR'] = '2'

    const req = new Request('http://localhost:3001/api/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-connecting-ip': visitorIp,
      },
      body: JSON.stringify({ domain: 'fresh-domain-test-123.com' }),
    })

    const res = await POST(req)
    const events = await parseSseResponse(res)

    const errorEvent = events.find((e) => e.event === 'error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent?.data['kind']).toBe('visitor-rate-limit')
    expect(String(errorEvent?.data['message'])).toContain('per-visitor limit of 2 live scan(s) per hour')
    expect(String(errorEvent?.data['message'])).toContain('not the shared daily demo budget')

    // Confirm it never progressed to "checking quota"
    const stageEvent = events.find((e) => e.event === 'stage')
    expect(stageEvent).toBeUndefined()
  })

  it('cached domains return cached result without hitting visitor throttle', async () => {
    const visitorIp = '203.0.113.99'
    const vCfg = defaultVisitorThrottleConfig(dir, { GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR: '1' } as unknown as NodeJS.ProcessEnv)

    // Pre-populate limit
    await recordVisitorScan(visitorIp, vCfg, new Date())

    // The cached cycle, written from the fixture under the category it records:
    // a cycle is served only when it still measures the recorded category.
    recordCategory(dir, { host: CACHED, slug: 'crm-software', source: 'leader-domain', evidence: CACHED, decidedAt: '2026-09-01T00:00:00.000Z', generated: false })
    const filed = writeCycle(dir, cycleOf(CACHED, '2026-09-01'))
    expect('refuse' in filed).toBe(false)

    const req = new Request('http://localhost:3001/api/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-connecting-ip': visitorIp,
      },
      body: JSON.stringify({ domain: CACHED }),
    })

    const res = await POST(req)
    const events = await parseSseResponse(res)

    const cachedEvent = events.find((e) => e.event === 'cached')
    expect(cachedEvent).toBeDefined()
    expect(cachedEvent?.data['domain']).toBe(CACHED)

    const resultEvent = events.find((e) => e.event === 'result')
    expect(resultEvent).toBeDefined()
    expect((resultEvent?.data as { run?: { day?: string } }).run?.day).toBe('2026-09-01')

    // No error was raised
    expect(events.find((e) => e.event === 'error')).toBeUndefined()
  })
})
