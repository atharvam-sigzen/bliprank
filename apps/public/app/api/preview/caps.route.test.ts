import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * THE BOUND THAT DOES NOT TRUST THE CALLER, on /api/preview.
 *
 * The per-visitor throttle keys on `cf-connecting-ip` behind a Cloudflare edge
 * (TRUSTED_PROXY, set below), and every request below sets a fresh one — which
 * is exactly what an attacker on a misconfigured deployment does. The only thing replaced is the homepage fetch (mocked to fail fast, so
 * no socket opens and no page content can classify); the resolver, the
 * records, the ledgers and the route are real, in a scratch directory.
 */
const fetches: string[] = []
vi.mock('../../../../../services/grader/src/fetch-site.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../services/grader/src/fetch-site.js')>()
  return {
    ...actual,
    fetchSiteHtml: vi.fn(async (domain: string) => {
      fetches.push(domain)
      return { ok: false as const, reason: 'unreachable' as const, message: 'no socket in this test' }
    }),
  }
})

import { POST } from './route'

let dir: string
let seq = 0
const originalEnv = { ...process.env }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-preview-caps-'))
  process.env['GRADER_DATA_DIR'] = dir
  process.env['TRUSTED_PROXY'] = 'cloudflare'
  // No author: an unclassifiable domain falls back after the (failed) read and never calls a model.
  delete process.env['OPENROUTER_API_KEY']
  delete process.env['BANK_AUTHOR_API_KEY']
  fetches.length = 0
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

/** A new "visitor" every time: the header is the caller's to write. */
const post = (domain: string) => {
  seq += 1
  return POST(
    new Request('http://localhost/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${seq % 250}`, 'x-forwarded-for': `203.0.113.${seq % 250}` },
      body: JSON.stringify({ domain }),
    }),
  )
}

describe('the global cap on previews that cost', () => {
  it('⚠️ counts every costing preview against one shared ledger, whatever the caller calls itself', async () => {
    process.env['GRADER_MAX_COSTING_PREVIEWS_PER_HOUR'] = '2'
    // Three unknown domains the host alone cannot classify, from three "visitors".
    expect((await post('zzq-unknown-one.example')).status).toBe(200)
    expect((await post('zzq-unknown-two.example')).status).toBe(200)
    const third = await post('zzq-unknown-three.example')
    expect(third.status).toBe(429)
    const body = (await third.json()) as { kind: string; message: string }
    expect(body.kind).toBe('preview-global-cap')
    expect(body.message).toContain('everyone combined')
    // Two homepages were read; the third request reached no socket.
    expect(fetches).toEqual(['zzq-unknown-one.example', 'zzq-unknown-two.example'])
  })

  it('a recorded or host-classified domain is free and passes an exhausted cap untouched', async () => {
    process.env['GRADER_MAX_COSTING_PREVIEWS_PER_HOUR'] = '1'
    expect((await post('zzq-unknown-one.example')).status).toBe(200)
    expect((await post('zzq-unknown-two.example')).status).toBe(429)
    // The first domain now has a record (a failed read records a fallback, once).
    expect((await post('zzq-unknown-one.example')).status).toBe(200)
    // pipedrive.com classifies from its host alone (a tracked leader): no fetch, no cap.
    const leader = await post('pipedrive.com')
    expect(leader.status).toBe(200)
    expect(((await leader.json()) as { category: string }).category).toBe('crm-software')
    expect(fetches).toEqual(['zzq-unknown-one.example'])
  })

  it('one domain is never read twice: the record makes the second look free', async () => {
    process.env['GRADER_MAX_COSTING_PREVIEWS_PER_HOUR'] = '10'
    for (let i = 0; i < 4; i++) expect((await post('zzq-unknown-one.example')).status).toBe(200)
    expect(fetches).toEqual(['zzq-unknown-one.example'])
  })

  it('the per-visitor throttle is still there for the ordinary case', async () => {
    process.env['GRADER_MAX_PREVIEWS_PER_VISITOR_PER_HOUR'] = '1'
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.250' }
    const ask = () => POST(new Request('http://localhost/api/preview', { method: 'POST', headers, body: JSON.stringify({ domain: 'pipedrive.com' }) }))
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(429)
    expect(((await (await ask()).json()) as { kind: string }).kind).toBe('preview-rate-limit')
  })
})
