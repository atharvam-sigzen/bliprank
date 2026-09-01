import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
 */

const dataDir = (): string => {
  let curr = process.cwd()
  while (curr && curr !== dirname(curr)) {
    if (existsSync(join(curr, 'services', 'grader'))) return join(curr, 'services', 'grader', 'data-live')
    curr = dirname(curr)
  }
  return join(process.cwd(), 'services', 'grader', 'data-live')
}

const PREVIEW_LEDGER = join(dataDir(), 'preview-throttle.json')
const RECORDS = join(dataDir(), 'domain-categories.json')

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost/api/preview', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))

/**
 * A fresh IP per test, so tests cannot throttle each other. The route reads
 * `x-forwarded-for` through `extractClientIp`, which is the same resolution the
 * scan route uses.
 */
let seq = 0
const freshIp = () => ({ 'x-forwarded-for': `203.0.113.${(seq += 1) % 250}` })

/** What the ledger and records looked like before, restored afterwards. */
let ledgerBefore: string | null = null
let recordsBefore: string | null = null

beforeEach(() => {
  ledgerBefore = existsSync(PREVIEW_LEDGER) ? readFileSync(PREVIEW_LEDGER, 'utf8') : null
  recordsBefore = existsSync(RECORDS) ? readFileSync(RECORDS, 'utf8') : null
})
afterEach(() => {
  // The route writes to the real data dir, like the scan route's test does.
  // Leaving a throttle entry or a category record behind would make the next
  // run of this suite behave differently from the first — which is the exact
  // class of "passes only because of how it was tested" bug this repo is
  // auditing for.
  for (const [path, before] of [
    [PREVIEW_LEDGER, ledgerBefore],
    [RECORDS, recordsBefore],
  ] as const) {
    if (before === null) rmSync(path, { force: true })
    else writeFileSync(path, before)
  }
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
    const scanLedger = join(dataDir(), 'visitor-throttle.json')
    const before = existsSync(scanLedger) ? readFileSync(scanLedger, 'utf8') : null
    await post({ domain: 'pipedrive.com' }, freshIp())
    const after = existsSync(scanLedger) ? readFileSync(scanLedger, 'utf8') : null
    expect(after).toBe(before)
  })

  it('reuses the recorded category on a second look rather than re-deriving it', async () => {
    const first = await (await post({ domain: 'pipedrive.com' }, freshIp())).json()
    const second = await (await post({ domain: 'pipedrive.com' }, freshIp())).json()
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
