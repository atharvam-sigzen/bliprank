/**
 * ⚠️ A HAND-STARTED SCAN MAY NOT LOWER THE STORE'S LIFETIME CAP.
 *
 * THE DEFECT THIS PINS, exactly as it was found. `Budget` lowers its cap
 * whenever it is opened with a smaller one, and persists that on the first
 * CHARGED call — not on construction, which is why the failure is invisible
 * until money moves. `/api/scan` passed `Number(env.GRADER_CAP_USD ?? 5)`.
 *
 * So after the lifetime cap was raised $5 → $300 on 2026-09-07, ONE cycle
 * started from the workspace record — on a server where nobody had exported
 * `GRADER_CAP_USD` — would have written the cap back to $5, leaving $2.85 of a
 * $300 budget, silently. Measured on a copy of the real ledger before the fix:
 * opened at 5 the file stayed 300, and the first `charge()` wrote 5.
 *
 * The route now asks `ledgerCapUsd(DATA, env)`, the same rule `daily-loop.ts`
 * already used. This is the regression test for that.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHY THIS TEST CANNOT PASS VACUOUSLY, which is the whole difficulty.
 *
 * "The cap is unchanged" is trivially true of a scan that never charged
 * anything — and the first probe of this defect made exactly that mistake,
 * constructing a Budget and concluding the file was safe because construction
 * does not persist. So the test asserts the charge happened FIRST: `spentUsd`
 * and `calls` must both have risen. Only a run that really moved money is
 * allowed to prove that the cap survived it.
 *
 * The network is replaced the way `cycles.integration.test.ts` replaces it —
 * the offline fixture adapter, a mocked quota read, and a global `fetch` that
 * throws. The adapter is offline but the route runs `mode: 'live'`, so
 * `Budget.charge` is called with the plan's REAL prices
 * (`collect-cell.ts:207`): the ledger moves for real while no socket opens.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureAdapter } from '../../../../../services/collector/src/pilot/fixture-adapter.js'
import { recordCategory } from '../../../../../services/grader/src/resolve-category.js'
// Imported directly rather than through the mocked package index: the
// counterfactual below needs the REAL Budget, not the adapter-swapped module.
import { Budget } from '../../../../../services/collector/src/budget.js'

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
const RAISED_CAP = 300
let dir: string
let ip = 0
const originalEnv = { ...process.env }

/** A ledger that a person has deliberately raised, with spend already on it. */
const seedLedger = (capUsd: number) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'ledger.json'),
    JSON.stringify({ capUsd, spentUsd: 2.14, calls: 399, byEngine: { chatgpt: { calls: 399, usd: 2.14 } }, updatedAt: '2026-09-01T11:29:44.897Z' }, null, 2),
  )
}
const ledger = () => JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')) as { capUsd: number; spentUsd: number; calls: number }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-ledger-cap-'))
  process.env['GRADER_DATA_DIR'] = dir
  process.env['COLLECTION_ENABLED'] = 'true'
  process.env['GRADER_LIVE_SCAN'] = 'true'
  process.env['OPENWEBNINJA_API_KEY'] = 'not-a-real-key'
  process.env['OPENWEBNINJA_PLAN'] = 'payg'
  process.env['GRADER_PROMPTS_PER_SCAN'] = '2'
  process.env['TRUSTED_PROXY'] = 'cloudflare'
  // ⚠️ THE SCENARIO: nobody set it. This is the whole point of the test.
  delete process.env['GRADER_CAP_USD']
  delete process.env['OPENROUTER_API_KEY']
  delete process.env['BANK_AUTHOR_API_KEY']
  vi.stubGlobal('fetch', (async (u: unknown) => {
    throw new Error(`network reached: ${String(u)}`)
  }) as unknown as typeof fetch)
  recordCategory(dir, { host: DOMAIN, slug: 'crm-software', source: 'leader-domain', evidence: 'recorded for the test', decidedAt: '2026-08-01T00:00:00.000Z', generated: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

const scan = async () => {
  ip += 1
  const res = await POST(
    new Request('http://localhost:3001/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': `203.0.113.${ip}` },
      body: JSON.stringify({ domain: DOMAIN }),
    }),
  )
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

describe('a hand-started scan and the store lifetime cap', () => {
  it('⚠️ does NOT lower a raised cap, with GRADER_CAP_USD unset', async () => {
    seedLedger(RAISED_CAP)
    const before = ledger()
    expect(before.capUsd).toBe(RAISED_CAP)
    expect(process.env['GRADER_CAP_USD']).toBeUndefined()

    const events = await scan()
    const error = events.find((e) => e.event === 'error')
    expect(error, JSON.stringify(error?.data)).toBeUndefined()

    const after = ledger()

    // ── FIRST: prove money actually moved. Without this the assertion below is
    //    true of a run that did nothing, which is the mistake that let this
    //    defect hide in the first place.
    expect(after.calls, 'no provider attempt was charged — the cap assertion below would be vacuous').toBeGreaterThan(before.calls)
    expect(after.spentUsd, 'nothing was spent — the cap assertion below would be vacuous').toBeGreaterThan(before.spentUsd)

    // ── THEN: the cap survived the charge that persists it.
    expect(after.capUsd).toBe(RAISED_CAP)
  })

  it('⚠️ the same run under the OLD rule would have lowered it — the counterfactual', () => {
    // The route no longer passes a default, so the defect cannot be re-run
    // through it. What can be re-run is the rule the route used to apply,
    // against the ledger this test just proved a real scan leaves alone. If
    // `Budget` ever stops lowering on a smaller cap, this fails and the test
    // above stops meaning anything.
    seedLedger(RAISED_CAP)
    const b = new Budget(join(dir, 'ledger.json'), 5, () => 0.007)
    expect(b.state.capUsd).toBe(5)
    b.charge('chatgpt')
    expect(ledger().capUsd, 'Budget no longer lowers on a smaller cap; the route fix may now be unnecessary').toBe(5)
  })

  it('a store with no ledger yet still honours GRADER_CAP_USD, so the variable keeps its meaning', async () => {
    // Deleting the variable outright would have been simpler and would have
    // quietly changed what a documented .env.example setting does. It now names
    // the cap a NEW ledger is created with.
    process.env['GRADER_CAP_USD'] = '42'
    const events = await scan()
    expect(events.find((e) => e.event === 'error'), 'the scan should have run').toBeUndefined()
    expect(ledger().capUsd).toBe(42)
  })

  it('and falls back to the default when neither a ledger nor the variable exists', async () => {
    const events = await scan()
    expect(events.find((e) => e.event === 'error')).toBeUndefined()
    expect(ledger().capUsd).toBe(5)
  })
})
