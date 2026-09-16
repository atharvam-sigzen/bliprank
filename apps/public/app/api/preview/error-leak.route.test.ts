import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A thrown error on the preview path reaches the visitor as a fixed sentence,
 * never as the error's own text: a provider body, a ledger path or a stack
 * detail is the server's to log (2026-09-09 audit, defect 6). And a request
 * whose domain is not a host is refused as input before anything runs.
 */
vi.mock('../../../../../services/grader/src/resolve-category.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/resolve-category.js')>()
  return {
    ...actual,
    resolveCategory: vi.fn(async () => {
      throw new Error('ENOENT C:\\Users\\secret\\bank-author-ledger.json')
    }),
  }
})

import { PREVIEW_FAILED } from '@/lib/route-errors'
import { POST } from './route'

let dir: string
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-preview-leak-'))
  process.env['GRADER_DATA_DIR'] = dir
  process.env['TRUSTED_PROXY'] = 'cloudflare'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
      body: JSON.stringify(body),
    }),
  )

describe('POST /api/preview never leaks the error it caught', () => {
  it('answers 500 with the fixed sentence and logs the cause server-side', async () => {
    const res = await post({ domain: 'pipedrive.com' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { kind: string; message: string }
    expect(body).toEqual({ kind: 'failed', message: PREVIEW_FAILED })
    expect(JSON.stringify(body)).not.toMatch(/secret|ENOENT|ledger/)
    expect(console.error).toHaveBeenCalled()
  })

  it('refuses a domain that is not a host as input, before anything runs', async () => {
    for (const domain of ['not a host', 'hello', 'a.b', '']) {
      const res = await post({ domain })
      expect([domain, res.status]).toEqual([domain, 400])
      expect(((await res.json()) as { kind: string }).kind).toBe('input')
    }
  })
})
