import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POST } from './route'
import { DEFAULT_MAX_PREVIEWS_PER_HOUR } from '@/lib/preview-contract'

/**
 * Route-level tests for POST /api/preview — the step between the button and the
 * spend.
 *
 * ⚠️ NOTHING HERE MAY REACH THE NETWORK. Every domain used below resolves at
 * rung 0 or rung 1 of `resolve-category.ts` (a record, or a tracked leader
 * domain), which are the two rungs that never fetch a homepage and never author
 * a bank. A test that hits a real site would be slow, flaky, and would make the
 * suite depend on somebody else's uptime — and would spend a model call.
 *
 * ⚠️ OVER A SCRATCH DATA DIRECTORY (MVP_PLAN B5). The first version wrote the
 * route's throttle ledger and category records into the machine's own live
 * data directory and restored them afterwards, so "this domain has never been
 * seen" was true only on a machine where nobody had previewed it, and the
 * suite's state depended on what a dev server had written last. Every path
 * is now `GRADER_DATA_DIR`, a fresh directory per test: a domain is unseen
 * because nothing has seen it, not because a test remembered to forget it.
 */

let dir: string
const originalEnv = { ...process.env }

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost/api/preview', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))

/**
 * A fresh IP per test, so tests cannot throttle each other. The route reads
 * `cf-connecting-ip` through `extractClientIp` once `TRUSTED_PROXY` names
 * Cloudflare, which is the same resolution the scan route uses.
 */
let seq = 0
const freshIp = () => ({ 'cf-connecting-ip': `203.0.113.${(seq += 1) % 250}` })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-preview-route-'))
  process.env['GRADER_DATA_DIR'] = dir
  process.env['TRUSTED_PROXY'] = 'cloudflare'
})
afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/preview', () => {
  it('refuses an empty domain without touching anything', async () => {
    const res = await post({}, freshIp())
    expect(res.status).toBe(400)
    expect((await res.json()).kind).toBe('input')
  })

  it('returns the category and the exact prompts a scan would send', async () => {
    const res = await post({ domain: 'pipedrive.com' }, freshIp())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.domain).toBe('pipedrive.com')
    expect(body.category).toBe('crm-software')
    // The signal is on the sheet, not in a log: this one is a tracked brand,
    // not an inference from a page.
    expect(body.source).toBe('leader-domain')
    expect(body.prompts.length).toBeGreaterThan(0)
    expect(body.engines).toHaveLength(5)
    // A hand-authored category has competitors, so the head-to-head is real.
    expect(body.competitors.length).toBeGreaterThan(0)
    // And the subject is not among them. pipedrive.com IS a tracked leader of
    // this bank; the scan excludes it from the comparison set, so the preview
    // must promise the chart the scan actually draws: seven rivals, not eight
    // brands with the reader's own in the list.
    expect(body.competitors).not.toContain('Pipedrive')
    expect(body.competitors).toHaveLength(7)
  })

  it('shows ONLY unprompted prompts — a preview that lied about intent would be worse than none', async () => {
    // scan.ts PROPERTY 2: comparison and brand-verification prompts name brands
    // by construction and are never sent by a scan. Showing them here would
    // promise questions that are not asked.
    const body = await (await post({ domain: 'pipedrive.com' }, freshIp())).json()
    for (const p of body.prompts) expect(['discovery', 'problem-led']).toContain(p.intent)
    for (const p of body.prompts) expect(p.text.toLowerCase()).not.toContain('pipedrive')
  })

  it('normalises the domain the same way the scan route does', async () => {
    const body = await (await post({ domain: 'HTTPS://WWW.Pipedrive.com/pricing?x=1' }, freshIp())).json()
    expect(body.domain).toBe('pipedrive.com')
  })

  it('names both categories when a domain fits more than one', async () => {
    // zoho.com leads CRM, accounting and HR. Picking one would be inventing a
    // fact, and the preview says so before anything is bought.
    const body = await (await post({ domain: 'zoho.com' }, freshIp())).json()
    expect(body.fallback?.reason).toBe('ambiguous')
    expect(body.fallback.candidates.length).toBeGreaterThan(1)
    // And the fallback bank has no competitors, which the page states.
    expect(body.competitors).toEqual([])
  })

  it('throttles a visitor, and says nothing was collected or charged', async () => {
    const ip = freshIp()
    for (let i = 0; i < DEFAULT_MAX_PREVIEWS_PER_HOUR; i += 1) {
      expect((await post({ domain: 'pipedrive.com' }, ip)).status).toBe(200)
    }
    const res = await post({ domain: 'pipedrive.com' }, ip)
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.kind).toBe('preview-rate-limit')
    expect(body.message).toContain('nothing was charged')
  })

  it('keeps its own ledger, so previewing never consumes a scan allowance', async () => {
    // A shared counter would make looking at your prompts cost you a scan — the
    // feature that exists to make scanning safer would make it impossible.
    const scanLedger = join(dir, 'visitor-throttle.json')
    const before = existsSync(scanLedger) ? readFileSync(scanLedger, 'utf8') : null
    await post({ domain: 'pipedrive.com' }, freshIp())
    const after = existsSync(scanLedger) ? readFileSync(scanLedger, 'utf8') : null
    expect(after).toBe(before)
    // And its own ledger was written, in the scratch directory and nowhere else.
    expect(existsSync(join(dir, 'preview-throttle.json'))).toBe(true)
  })

  it('reuses the recorded category on a second look rather than re-deriving it', async () => {
    // The directory is fresh, so zendesk.com has never been seen here: the
    // first look decides and records, the second reads the record back.
    const first = await (await post({ domain: 'zendesk.com' }, freshIp())).json()
    const second = await (await post({ domain: 'zendesk.com' }, freshIp())).json()
    expect(second.category).toBe(first.category)
    // HOW it was decided does not change by being read back — that is
    // provenance, and it is permanent. WHETHER this call read it is a separate
    // field, and it is the visible half of the stability guarantee.
    expect(first.previouslyDecided).toBe(false)
    expect(second.previouslyDecided).toBe(true)
    expect(second.source).toBe(first.source)
    expect(second.decidedAt).toBe(first.decidedAt)
  })
})
