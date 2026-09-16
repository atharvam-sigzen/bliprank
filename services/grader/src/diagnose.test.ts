import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Budget } from '@bliprank/collector'
import { runDiagnose } from './diagnose.js'

/**
 * The diagnostic probe is a provider attempt, and it is charged like one:
 * BEFORE the request, to a real ledger, and a refusal means no request.
 * (2026-09-09 audit, defect 2: it used to reach all five paid endpoints
 * behind nothing but an injected flag.)
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'diagnose-'))
  dirs.push(d)
  return d
}

const reply = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '49' } })

describe('runDiagnose', () => {
  it('charges the ledger before every probe, in order', async () => {
    const dir = tmp()
    const events: string[] = []
    const budget = new Budget(join(dir, 'ledger.json'), 1, () => 0.01)
    const spy = { charge: (e: string) => { events.push(`charge:${e}`); budget.charge(e) } }
    const fetchImpl: typeof fetch = async (url) => { events.push(`fetch:${String(url)}`); return reply() }
    const out = await runDiagnose(['chatgpt', 'gemini'], 'k', { budget: spy, fetchImpl, log: () => {} })
    expect(out).toEqual({ probed: ['chatgpt', 'gemini'], refused: [] })
    expect(events.map((e) => e.split(':')[0])).toEqual(['charge', 'fetch', 'charge', 'fetch'])
    const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')) as { calls: number; spentUsd: number }
    expect(ledger.calls).toBe(2)
    expect(ledger.spentUsd).toBeCloseTo(0.02, 9)
  })

  it('⚠️ a ledger that will not pay stops the run before the request leaves', async () => {
    const dir = tmp()
    // Room for exactly one probe.
    const budget = new Budget(join(dir, 'ledger.json'), 0.015, () => 0.01)
    const fetched: string[] = []
    const fetchImpl: typeof fetch = async (url) => { fetched.push(String(url)); return reply() }
    const out = await runDiagnose(['chatgpt', 'gemini', 'copilot'], 'k', { budget, fetchImpl, log: () => {} })
    expect(out.probed).toEqual(['chatgpt'])
    expect(out.refused).toEqual(['gemini', 'copilot'])
    expect(fetched).toHaveLength(1)
    expect(budget.state.exhaustedAt).toBeDefined()
  })

  it('the per-run allowance bounds it too: one attempt per engine, no retries', async () => {
    const dir = tmp()
    const budget = new Budget(join(dir, 'ledger.json'), 100, () => 0.01, () => new Date(), 1)
    const fetched: string[] = []
    const fetchImpl: typeof fetch = async (url) => { fetched.push(String(url)); return reply() }
    const out = await runDiagnose(['chatgpt', 'gemini'], 'k', { budget, fetchImpl, log: () => {} })
    expect(out.probed).toEqual(['chatgpt'])
    expect(fetched).toHaveLength(1)
    // An allowance refusal is about this run, never the lifetime ledger.
    expect(budget.state.exhaustedAt).toBeUndefined()
  })
})
