import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A thrown error inside a live scan reaches the visitor as a fixed sentence
 * over SSE, never as the error's own text (2026-09-09 audit, defect 6); and a
 * domain that is not a host is refused as input before any gate runs.
 */
vi.mock('../../../../../services/grader/src/run.js', () => ({
  runGrader: vi.fn(async () => {
    throw new Error('budget exhausted: C:\\Users\\secret\\ledger.json x-api-key=abc')
  }),
}))
vi.mock('../../../../../services/grader/src/live-gate.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/live-gate.js')>()
  return { ...actual, checkGate: vi.fn(async () => ({ ok: true, quota: [] })) }
})

import { SCAN_FAILED } from '@/lib/route-errors'
import { POST } from './route'

let dir: string
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-scan-leak-'))
  process.env['GRADER_DATA_DIR'] = dir
  process.env['COLLECTION_ENABLED'] = 'true'
  process.env['GRADER_LIVE_SCAN'] = 'true'
  process.env['OPENWEBNINJA_API_KEY'] = 'test-key-never-used'
  process.env['TRUSTED_PROXY'] = 'cloudflare'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

async function events(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const text = await res.text()
  const out: { event: string; data: Record<string, unknown> }[] = []
  for (const block of text.split('\n\n')) {
    const event = /^event: (.*)$/m.exec(block)?.[1]
    const data = /^data: (.*)$/m.exec(block)?.[1]
    if (event && data) out.push({ event, data: JSON.parse(data) as Record<string, unknown> })
  }
  return out
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
      body: JSON.stringify(body),
    }),
  )

describe('POST /api/scan never leaks the error it caught', () => {
  it('emits the fixed sentence and logs the cause server-side', async () => {
    const got = await events(await post({ domain: 'errleak.example' }))
    const err = got.find((e) => e.event === 'error')
    expect(err?.data).toEqual({ kind: 'failed', message: SCAN_FAILED })
    expect(JSON.stringify(got)).not.toMatch(/secret|x-api-key|ledger\.json/)
    expect(console.error).toHaveBeenCalled()
  })

  it('refuses a domain that is not a host as input, before any gate', async () => {
    for (const domain of ['not a host', 'hello', 'a.b']) {
      const got = await events(await post({ domain }))
      expect([domain, got[0]?.event, got[0]?.data['kind']]).toEqual([domain, 'error', 'input'])
    }
  })
})
