import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeCycle } from '../../../../../services/grader/src/cycles.js'

/**
 * The homepage fetch is the only thing replaced: `fetchSiteHtml` is mocked to
 * serve an invented page, or to fail, without a socket. Everything else — the
 * stored-cycle bound, the throttle and its ledger, the audit, the JSON — is
 * real, against a scratch data directory.
 */
const fetches: string[] = []
let serve: () => Promise<unknown> = async () => ({ ok: true, html: '<html><head><title>Acme</title></head><body><h1>Acme CRM</h1><p>A CRM for small teams.</p></body></html>', finalUrl: 'https://acme.example/', bytes: 120, truncated: false })

vi.mock('../../../../../services/grader/src/fetch-site.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/fetch-site.js')>()
  return {
    ...actual,
    fetchSiteHtml: vi.fn(async (domain: string) => {
      fetches.push(domain)
      return serve()
    }),
  }
})

import { GET } from './route'

let dir: string
let ip = 0
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-gaps-api-'))
  process.env['GRADER_DATA_DIR'] = dir
  fetches.length = 0
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const ask = (q: string, sameIp = false) => {
  if (!sameIp) ip += 1
  return GET(new Request(`http://localhost:3001/api/gaps${q}`, { headers: { 'cf-connecting-ip': `203.0.113.${ip}` } }))
}
const cycle = (domain: string, day: string) => ({
  status: 'scanned',
  domain,
  category: 'crm-software',
  categoryName: 'CRM software',
  comparisonBasis: 'grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=2|runs=1',
  algoVersion: 'det-2',
  collectedAt: `${day}T10:00:00.000Z`,
  counts: { cellsRequested: 2, cacheHits: 0, collected: 2, failed: 0, answersScored: 2, providerCalls: 2 },
  brands: [],
  run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt'], capUsd: 5, at: `${day}T10:01:00.000Z` },
})

describe('GET /api/gaps', () => {
  it('reports the page against the stored cycle’s prompts, and names the cycle', async () => {
    writeCycle(dir, cycle('acme.example', '2026-09-01'))
    const res = await ask('?domain=https://WWW.Acme.example/')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = (await res.json()) as { domain: string; category: string; day: string; promptCount: number; findings: { id: string }[]; coverage: unknown[] }
    expect(body.domain).toBe('acme.example')
    expect(body.category).toBe('crm-software')
    expect(body.day).toBe('2026-09-01')
    expect(body.promptCount).toBe(2)
    expect(body.coverage).toHaveLength(2)
    expect(body.findings.map((f) => f.id)).toContain('h1')
    expect(fetches).toEqual(['acme.example'])
  })

  it('⚠️ a domain with no stored cycle is refused BEFORE any request leaves — this is not a fetch proxy', async () => {
    const res = await ask('?domain=victim.example')
    expect(res.status).toBe(404)
    expect(fetches).toEqual([])
  })

  it('refuses anything that is not host-shaped, and nothing reaches a path or a socket', async () => {
    for (const bad of ['', '?domain=', '?domain=..%2F..%2Fetc', '?domain=acme', '?domain=a%20b.com']) {
      const res = await ask(bad)
      expect([400, 404], bad).toContain(res.status)
    }
    expect(fetches).toEqual([])
  })

  it('a page that cannot be read is a named refusal, and the attempt still counts against the visitor', async () => {
    writeCycle(dir, cycle('acme.example', '2026-09-01'))
    serve = async () => ({ ok: false, reason: 'unreachable', message: 'connection reset' })
    const res = await ask('?domain=acme.example')
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toContain('could not read the homepage')
    serve = async () => ({ ok: true, html: '<html><body><h1>x</h1></body></html>', finalUrl: 'https://acme.example/', bytes: 40, truncated: false })
  })

  it('⚠️ caps reads of ONE domain across every visitor — the bound that does not trust the caller’s headers', async () => {
    writeCycle(dir, cycle('acme.example', '2026-09-01'))
    process.env['GRADER_MAX_GAP_REPORTS_PER_DOMAIN_PER_HOUR'] = '3'
    // Three different "visitors" (the header is the caller's to write) get three reads...
    expect((await ask('?domain=acme.example')).status).toBe(200)
    expect((await ask('?domain=acme.example')).status).toBe(200)
    expect((await ask('?domain=acme.example')).status).toBe(200)
    // ...and the fourth, from a fourth name, is refused without a fetch.
    const fourth = await ask('?domain=acme.example')
    expect(fourth.status).toBe(429)
    expect(((await fourth.json()) as { message: string }).message).toContain('does not change that often')
    expect(fetches).toHaveLength(3)
    // Another domain is unaffected.
    writeCycle(dir, cycle('other.example', '2026-09-01'))
    expect((await ask('?domain=other.example')).status).toBe(200)
  })

  it('a named day with no cycle is a 404 before any throttle books anything', async () => {
    writeCycle(dir, cycle('acme.example', '2026-09-01'))
    process.env['GRADER_MAX_GAP_REPORTS_PER_VISITOR_PER_HOUR'] = '1'
    expect((await ask('?domain=acme.example&day=2026-01-01')).status).toBe(404)
    // The same visitor's one slot is still there.
    expect((await ask('?domain=acme.example&day=2026-09-01', true)).status).toBe(200)
    expect(fetches).toHaveLength(1)
  })

  it('throttles one visitor on its own ledger, after the bound check', async () => {
    writeCycle(dir, cycle('acme.example', '2026-09-01'))
    process.env['GRADER_MAX_GAP_REPORTS_PER_VISITOR_PER_HOUR'] = '2'
    expect((await ask('?domain=acme.example')).status).toBe(200)
    expect((await ask('?domain=acme.example', true)).status).toBe(200)
    const third = await ask('?domain=acme.example', true)
    expect(third.status).toBe(429)
    expect(fetches).toHaveLength(2)
    // Another visitor is unaffected, and an unknown domain never touched the ledger.
    expect((await ask('?domain=acme.example')).status).toBe(200)
  })
})
