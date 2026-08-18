import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Budget, BudgetExceeded } from './budget.js'

const price = (e: string) => (e === 'cheap' ? 0.001 : 0.007)

describe('Budget — hard cap, charged before every attempt', () => {
  it('charges attempts and refuses the first one that would breach the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bud-'))
    const b = new Budget(join(dir, 'ledger.json'), 0.02, price)
    b.charge('x') // 0.007
    b.charge('x') // 0.014
    expect(b.canAfford('x')).toBe(false) // 0.021 > 0.02
    expect(b.canAfford('cheap')).toBe(true)
    expect(() => b.charge('x')).toThrow(BudgetExceeded)
    expect(b.state.spentUsd).toBeCloseTo(0.014, 9) // the refused call was not charged
    expect(b.state.calls).toBe(2)
    expect(b.state.exhaustedAt).toBeTruthy()
    b.charge('cheap')
    expect(b.state.spentUsd).toBeCloseTo(0.015, 9)
  })

  it('persists after every charge and resumes from the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bud-'))
    const file = join(dir, 'ledger.json')
    const a = new Budget(file, 1, price)
    a.charge('x')
    a.charge('cheap')
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { spentUsd: number; calls: number; byEngine: Record<string, { calls: number }> }
    expect(onDisk.calls).toBe(2)
    expect(onDisk.byEngine['x']!.calls).toBe(1)
    const resumed = new Budget(file, 1, price)
    expect(resumed.state.spentUsd).toBeCloseTo(0.008, 9)
    expect(resumed.remainingUsd()).toBeCloseTo(0.992, 9)
  })

  it('a resumed run may lower the cap but never silently raise it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bud-'))
    const file = join(dir, 'ledger.json')
    new Budget(file, 1, price).charge('x')
    expect(new Budget(file, 0.5, price).state.capUsd).toBe(0.5)
    expect(() => new Budget(file, 5, price)).toThrow(/raise it deliberately/)
  })

  it('rejects a non-positive cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bud-'))
    expect(() => new Budget(join(dir, 'l.json'), 0, price)).toThrow(RangeError)
  })
})
