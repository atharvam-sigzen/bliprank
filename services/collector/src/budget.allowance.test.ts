import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Budget, BudgetExceeded, RunAllowanceExceeded } from './budget.js'

/**
 * The per-run allowance (ADR-0017, 2026-09-07): the most attempts one run may
 * make, retries included, checked before the lifetime cap and never marking
 * the ledger exhausted. ⚠️ HUMAN-OWNED AREA (spend control). Nothing spends.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-allowance-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const price = () => 0.01

describe('the allowance bounds this run, not the ledger', () => {
  it('refuses the attempt that would exceed it, as a BudgetExceeded the orchestrator already stops on, without marking the ledger exhausted', () => {
    const file = join(dir, 'ledger.json')
    const b = new Budget(file, 5, price, () => new Date('2026-09-07T00:00:00.000Z'), 3)
    b.charge('chatgpt')
    b.charge('chatgpt')
    b.charge('gemini')
    expect(b.runCalls).toBe(3)
    expect(b.runRemaining()).toBe(0)
    expect(() => b.charge('chatgpt')).toThrow(RunAllowanceExceeded)
    expect(() => b.charge('chatgpt')).toThrow(BudgetExceeded)
    const ledger = JSON.parse(readFileSync(file, 'utf8')) as { calls: number; spentUsd: number; exhaustedAt?: string }
    expect(ledger).toMatchObject({ calls: 3 })
    expect(ledger.spentUsd).toBeCloseTo(0.03, 9)
    expect(ledger).not.toHaveProperty('exhaustedAt')
  })

  it('a new run against the same ledger starts with a fresh allowance; the lifetime cap still applies underneath', () => {
    const file = join(dir, 'ledger.json')
    const first = new Budget(file, 0.05, price, () => new Date(), 3)
    for (let i = 0; i < 3; i++) first.charge('chatgpt')
    const second = new Budget(file, 0.05, price, () => new Date(), 3)
    expect(second.runCalls).toBe(0)
    expect(second.runRemaining()).toBe(3)
    second.charge('chatgpt')
    second.charge('chatgpt')
    // 0.05 cap, 0.05 spent: the sixth attempt is the LEDGER refusing, and that one does mark it exhausted.
    expect(() => second.charge('chatgpt')).toThrow(/budget exhausted/)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('exhaustedAt')
  })

  it('no allowance means unbounded within the cap, exactly as before; an allowance of zero refuses the first attempt; a bad one is refused at construction', () => {
    const file = join(dir, 'ledger.json')
    const open = new Budget(file, 5, price)
    expect(open.runRemaining()).toBe(Number.POSITIVE_INFINITY)
    for (let i = 0; i < 20; i++) open.charge('chatgpt')
    expect(open.runCalls).toBe(20)
    const none = new Budget(join(dir, 'other.json'), 5, price, () => new Date(), 0)
    expect(() => none.charge('chatgpt')).toThrow(RunAllowanceExceeded)
    expect(() => new Budget(join(dir, 'bad.json'), 5, price, () => new Date(), 1.5)).toThrow(RangeError)
    expect(() => new Budget(join(dir, 'bad2.json'), 5, price, () => new Date(), -1)).toThrow(RangeError)
  })

  it('a zero-price run (offline) is still bounded by its allowance, so the bound can be verified without spending', () => {
    const b = new Budget(join(dir, 'ledger.fixture.json'), 5, () => 0, () => new Date(), 2)
    b.charge('chatgpt')
    b.charge('chatgpt')
    expect(() => b.charge('chatgpt')).toThrow(/2 of its 2 allowed/)
  })
})
