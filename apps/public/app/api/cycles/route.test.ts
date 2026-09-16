import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeCycle } from '../../../../../services/grader/src/cycles.js'
import { GET } from './route'

let dir: string
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-cycles-api-'))
  process.env['GRADER_DATA_DIR'] = dir
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const ask = (q: string) => GET(new Request(`http://localhost:3001/api/cycles${q}`))
const cycle = (domain: string, day: string, mentions: number) => ({
  status: 'scanned',
  domain,
  category: 'crm-software',
  categoryName: 'CRM software',
  comparisonBasis: 'b',
  algoVersion: 'det-2',
  collectedAt: `${day}T10:00:00.000Z`,
  counts: { cellsRequested: 10, cacheHits: 0, collected: 10, failed: 0, answersScored: 10, providerCalls: 10 },
  brands: [{ id: 'x', name: domain, isSubject: true, mentions, citations: 0, metric: { value: mentions / 10, ci_low: 0, ci_high: 1, n: 10, algo_version: 'det-2', collection_path: 'third-party-grounded', comparison_basis: 'b' } }],
  run: { mode: 'live', plan: 'payg', day, engines: ['chatgpt'], capUsd: 5, at: `${day}T10:01:00.000Z` },
})

describe('GET /api/cycles', () => {
  it('lists every cycle of a domain, oldest first, as the result files the client already understands', async () => {
    writeCycle(dir, cycle('acme.example', '2026-09-05', 4))
    writeCycle(dir, cycle('acme.example', '2026-08-20', 2))
    const res = await ask('?domain=https://WWW.Acme.example/pricing')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = (await res.json()) as { domain: string; cycles: { run: { day: string }; brands: { mentions: number }[] }[] }
    expect(body.domain).toBe('acme.example')
    expect(body.cycles.map((c) => c.run.day)).toEqual(['2026-08-20', '2026-09-05'])
    expect(body.cycles.map((c) => c.brands[0]!.mentions)).toEqual([2, 4])
  })

  it('a domain this machine holds nothing for is an absence, not a fault', async () => {
    const res = await ask('?domain=never.example')
    expect(res.status).toBe(404)
  })

  it('refuses anything that is not host-shaped, and nothing from the request reaches a path', async () => {
    for (const bad of ['', '?domain=', '?domain=..%2F..%2Fetc', '?domain=acme', '?domain=a%20b.com']) {
      const res = await ask(bad)
      expect([400, 404], bad).toContain(res.status)
      const body = (await res.json()) as { message?: string }
      expect(body.message ?? '').not.toContain('etc')
    }
  })
})
