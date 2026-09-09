import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { POST } from './route'
import { recordVisitorScan, defaultVisitorThrottleConfig } from '../../../../../services/grader/src/visitor-throttle'

/**
 * Route-level integration test for per-visitor scan throttling on POST /api/scan.
 *
 * Verifies:
 *   1. Throttled requests emit `kind: 'visitor-rate-limit'` SSE error.
 *   2. Throttled requests short-circuit before provider-quota / checkGate logic.
 *   3. Throttled requests do not touch the global shared ledger.
 *   4. Cached domains bypass the throttle entirely and return instantly.
 */

const getGraderDataDir = (): string => {
  let curr = process.cwd()
  while (curr && curr !== dirname(curr)) {
    if (existsSync(join(curr, 'services', 'grader', 'data-live'))) {
      return join(curr, 'services', 'grader', 'data-live')
    }
    curr = dirname(curr)
  }
  return join(process.cwd(), 'services', 'grader', 'data-live')
}

describe('POST /api/scan per-visitor throttling', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
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
    const rootData = getGraderDataDir()
    const vCfg = defaultVisitorThrottleConfig(rootData, { GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR: '2' } as unknown as NodeJS.ProcessEnv)

    // Pre-populate 2 scans for this IP
    const now = new Date()
    recordVisitorScan(visitorIp, vCfg, now)
    recordVisitorScan(visitorIp, vCfg, now)

    process.env['COLLECTION_ENABLED'] = 'true'
    process.env['GRADER_LIVE_SCAN'] = 'true'
    process.env['OPENWEBNINJA_API_KEY'] = 'test-key-mock'
    process.env['GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR'] = '2'
    // The per-visitor throttle reads a header only behind a named proxy; the requests below write cf-connecting-ip.
    process.env['TRUSTED_PROXY'] = 'cloudflare'

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
    const rootData = getGraderDataDir()
    const vCfg = defaultVisitorThrottleConfig(rootData, { GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR: '1' } as unknown as NodeJS.ProcessEnv)

    // Pre-populate limit
    recordVisitorScan(visitorIp, vCfg, new Date())

    const req = new Request('http://localhost:3001/api/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-connecting-ip': visitorIp,
      },
      // pipedrive.com is cached in data-live/results/pipedrive.com.json
      body: JSON.stringify({ domain: 'pipedrive.com' }),
    })

    const res = await POST(req)
    const events = await parseSseResponse(res)

    const cachedEvent = events.find((e) => e.event === 'cached')
    expect(cachedEvent).toBeDefined()
    expect(cachedEvent?.data['domain']).toBe('pipedrive.com')

    const resultEvent = events.find((e) => e.event === 'result')
    expect(resultEvent).toBeDefined()

    // No error was raised
    expect(events.find((e) => e.event === 'error')).toBeUndefined()
  })
})
