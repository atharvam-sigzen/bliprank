import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Budget, BudgetExceeded } from './budget.js'
import { MemoryKV } from './cache-index.js'
import { KvSpendLedger, LocalSpendLedger, type SpendLedger } from './spend-ledger.js'

const ledgerFile = () => join(mkdtempSync(join(tmpdir(), 'spend-')), 'ledger.json')
const PRICE = 0.002

/** A KV whose increments interleave, so a check-then-increment bug is visible. */
class InterleavingKV extends MemoryKV {
  public gate: (() => Promise<void>) | null = null
  override async incrByFloat(key: string, delta: number, opts?: { ttlSec?: number }): Promise<number> {
    if (this.gate) await this.gate()
    return super.incrByFloat(key, delta, opts)
  }
}

describe('LocalSpendLedger — the single-process path', () => {
  it('charges through to the file-backed Budget', async () => {
    const l = new LocalSpendLedger(new Budget(ledgerFile(), 1, () => PRICE))
    await l.charge('chatgpt')
    await l.charge('chatgpt')
    expect(await l.spentUsd()).toBeCloseTo(0.004, 9)
    expect(l.capUsd).toBe(1)
  })

  it('refuses once the cap is reached', async () => {
    const l = new LocalSpendLedger(new Budget(ledgerFile(), 0.005, () => PRICE))
    await l.charge('chatgpt')
    await l.charge('chatgpt')
    await expect(l.charge('chatgpt')).rejects.toThrow(BudgetExceeded) // 0.006 > 0.005
  })
})

describe('KvSpendLedger — the fleet path', () => {
  const make = (cap: number, kv = new MemoryKV()) => new KvSpendLedger({ kv, capUsd: cap, priceUsd: () => PRICE, key: 'spend:2026-08-21' })

  it('accumulates across instances that share the counter', async () => {
    const kv = new MemoryKV()
    // Two separate ledger objects: this is the whole point — two containers.
    const a = make(1, kv)
    const b = make(1, kv)
    await a.charge('chatgpt')
    await b.charge('chatgpt')
    expect(await a.spentUsd()).toBeCloseTo(0.004, 9)
    expect(await b.spentUsd()).toBeCloseTo(0.004, 9)
  })

  it('THE FINDING: a second container does NOT get its own fresh cap', async () => {
    const kv = new MemoryKV()
    const first = make(0.005, kv)
    await first.charge('chatgpt')
    await first.charge('chatgpt') // 0.004 of 0.005
    // A cold instance constructs a brand new ledger. With the old file-backed
    // Budget this would start at zero and happily spend another full cap.
    const cold = make(0.005, kv)
    await expect(cold.charge('chatgpt')).rejects.toThrow(BudgetExceeded)
    expect(await cold.spentUsd()).toBeCloseTo(0.004, 9) // refunded, not left counted
  })

  it('a refused charge is refunded, so a rejection does not eat the remaining budget', async () => {
    const kv = new MemoryKV()
    const l = make(0.003, kv)
    await l.charge('chatgpt') // 0.002
    await expect(l.charge('chatgpt')).rejects.toThrow(BudgetExceeded) // would be 0.004
    expect(await l.spentUsd()).toBeCloseTo(0.002, 9)
  })

  it('concurrent charges cannot both slip through the last slot', async () => {
    // Both callers reach the counter before either has finished. Increment-then-
    // check means each sees its own post-increment total, so exactly one is
    // inside the cap. Check-then-increment would let both read 0.002 and pass.
    const kv = new InterleavingKV()
    const cap = 0.004 // room for exactly two charges
    const a = new KvSpendLedger({ kv, capUsd: cap, priceUsd: () => PRICE, key: 'k' })
    const b = new KvSpendLedger({ kv, capUsd: cap, priceUsd: () => PRICE, key: 'k' })
    await a.charge('chatgpt') // 0.002 used, one slot left

    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let waiting = 0
    kv.gate = async () => {
      if (++waiting <= 2) await held // hold the first two entrants at the door
    }
    const both = Promise.allSettled([a.charge('chatgpt'), b.charge('chatgpt')])
    release()
    const results = await both
    const accepted = results.filter((r) => r.status === 'fulfilled').length
    expect(accepted).toBe(1)
    expect(await a.spentUsd()).toBeCloseTo(0.004, 9)
    expect(await a.spentUsd()).toBeLessThanOrEqual(cap) // the cap held
  })

  it('an empty counter reads as zero rather than NaN', async () => {
    expect(await make(1).spentUsd()).toBe(0)
  })

  it('is substitutable for the local ledger', async () => {
    const ledgers: SpendLedger[] = [new LocalSpendLedger(new Budget(ledgerFile(), 1, () => PRICE)), make(1)]
    for (const l of ledgers) {
      await l.charge('gemini')
      expect(await l.spentUsd()).toBeCloseTo(PRICE, 9)
      expect(l.capUsd).toBe(1)
    }
  })
})

describe('KV.incrByFloat', () => {
  it('returns the value AFTER the increment, which is what the cap check needs', async () => {
    const kv = new MemoryKV()
    expect(await kv.incrByFloat('k', 1.5)).toBe(1.5)
    expect(await kv.incrByFloat('k', 2.25)).toBe(3.75)
    expect(await kv.incrByFloat('k', -0.75)).toBe(3)
  })
})
