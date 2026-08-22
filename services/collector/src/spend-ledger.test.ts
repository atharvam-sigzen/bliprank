import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Budget, BudgetExceeded } from './budget.js'
import { MemoryKV } from './cache-index.js'
import {
  detectMultiInstanceRuntime,
  KvSpendLedger,
  LocalSpendLedger,
  resolveTopology,
  UnsafeSpendLedgerError,
  windowKey,
  type AlertSink,
  type SpendAlert,
  type SpendLedger,
} from './spend-ledger.js'

const ledgerFile = () => join(mkdtempSync(join(tmpdir(), 'spend-')), 'ledger.json')
const PRICE = 0.002
const SINGLE = { COLLECTOR_TOPOLOGY: 'single-process' }
const ACK = { iUnderstandThisCapIsPerProcess: true, reason: 'unit test: one process', env: SINGLE } as const

/** A KV whose batched increments interleave, so a check-then-increment bug shows. */
class InterleavingKV extends MemoryKV {
  public gate: (() => Promise<void>) | null = null
  override async incrManyByFloat(ops: readonly { key: string; delta: number }[], opts?: { ttlSec?: number }): Promise<number[]> {
    if (this.gate) await this.gate()
    return super.incrManyByFloat(ops, opts)
  }
}

/** A KV whose refunds (negative deltas) fail, to exercise the alert path. */
class RefundFailsKV extends MemoryKV {
  override async incrManyByFloat(ops: readonly { key: string; delta: number }[], opts?: { ttlSec?: number }): Promise<number[]> {
    if (ops.some((o) => o.delta < 0)) throw new Error('connection reset')
    return super.incrManyByFloat(ops, opts)
  }
}

function collectAlerts(): { sink: AlertSink; seen: SpendAlert[] } {
  const seen: SpendAlert[] = []
  return { sink: (a) => seen.push(a), seen }
}

// --- (a) the guard ---------------------------------------------------------

describe('choosing the per-process ledger is a deliberate act', () => {
  it('the factory is the only route in', () => {
    expect(typeof LocalSpendLedger.forSingleProcess).toBe('function')
  })

  it('demands a written reason', () => {
    expect(() =>
      LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), { iUnderstandThisCapIsPerProcess: true, reason: '   ', env: SINGLE }),
    ).toThrow(UnsafeSpendLedgerError)
  })

  it('REFUSES on a multi-instance runtime, where a per-process cap is a spend hole', () => {
    for (const marker of ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'K_SERVICE', 'FLY_ALLOC_ID']) {
      expect(
        () =>
          LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), {
            iUnderstandThisCapIsPerProcess: true,
            reason: 'wiring the QStash handler',
            env: { ...SINGLE, [marker]: '1' },
          }),
        marker,
      ).toThrow(/own full budget/)
    }
  })

  it('the refusal quotes the stated reason, so the argument reaches whoever judges it', () => {
    try {
      LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), {
        iUnderstandThisCapIsPerProcess: true,
        reason: 'it seemed fine locally',
        env: { VERCEL: '1' },
      })
      throw new Error('should have refused')
    } catch (e) {
      expect((e as Error).message).toContain('it seemed fine locally')
      expect((e as Error).message).toContain('KvSpendLedger')
    }
  })

  it('the override is possible but alerts loudly rather than passing quietly', () => {
    const { sink, seen } = collectAlerts()
    const l = LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), {
      iUnderstandThisCapIsPerProcess: true,
      reason: 'single dedicated worker on this host',
      overrideUndeclaredTopology: true,
      env: {},
      onAlert: sink,
    })
    expect(l).toBeInstanceOf(LocalSpendLedger)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.kind).toBe('undeclared-topology-override')
    expect(seen[0]?.message).toContain('NOT global')
  })

  it('allows the pilot, which really is one process', () => {
    const l = LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), {
      iUnderstandThisCapIsPerProcess: true,
      reason: 'G0 pilot runner: a single operator-launched script',
      env: SINGLE,
    })
    expect(l.capUsd).toBe(1)
  })

  it('detectMultiInstanceRuntime names the marker it found', () => {
    expect(detectMultiInstanceRuntime({ VERCEL_ENV: 'production' })).toBe('VERCEL_ENV')
    expect(detectMultiInstanceRuntime({})).toBeNull()
  })
})

// --- (d) window rollover ---------------------------------------------------

describe('the ledger owns its window', () => {
  it('derives a UTC day key, matching the cache key date bucket', () => {
    expect(windowKey('daily', new Date('2026-08-21T23:59:59Z'))).toBe('2026-08-21')
    expect(windowKey('daily', new Date('2026-08-22T00:00:01Z'))).toBe('2026-08-22')
    expect(windowKey('hourly', new Date('2026-08-21T09:30:00Z'))).toBe('2026-08-21T09')
    expect(windowKey('total', new Date('2026-08-21T09:30:00Z'))).toBe('total')
  })

  it('rolls at the boundary without the caller doing anything', async () => {
    const kv = new MemoryKV()
    const clock = { d: new Date('2026-08-21T23:59:00Z') }
    const l = new KvSpendLedger({ kv, capUsd: 0.005, priceUsd: () => PRICE, now: () => clock.d, engines: ['chatgpt'] })
    await l.charge('chatgpt')
    await l.charge('chatgpt')
    await expect(l.charge('chatgpt')).rejects.toThrow(BudgetExceeded)
    expect(l.currentWindow()).toBe('2026-08-21')

    clock.d = new Date('2026-08-22T00:00:30Z') // a long-lived worker crosses midnight
    expect(l.currentWindow()).toBe('2026-08-22')
    expect(await l.spentUsd()).toBe(0) // fresh window, fresh cap
    await expect(l.charge('chatgpt')).resolves.toBeUndefined()
  })

  it('a "total" window never rolls, for a fixed-budget backfill', async () => {
    const kv = new MemoryKV()
    const clock = { d: new Date('2026-08-21T00:00:00Z') }
    const l = new KvSpendLedger({ kv, capUsd: 1, priceUsd: () => PRICE, window: 'total', now: () => clock.d })
    await l.charge('chatgpt')
    clock.d = new Date('2027-01-01T00:00:00Z')
    expect(await l.spentUsd()).toBeCloseTo(PRICE, 9)
  })
})

// --- cap behaviour + (c) breakdown -----------------------------------------

describe('KvSpendLedger — the fleet path', () => {
  const make = (cap: number, kv: MemoryKV = new MemoryKV(), onAlert?: AlertSink) =>
    new KvSpendLedger({
      kv,
      capUsd: cap,
      priceUsd: (e) => (e === 'google-ai-overviews' ? 0.001 : PRICE),
      now: () => new Date('2026-08-21T09:00:00Z'),
      engines: ['chatgpt', 'gemini', 'google-ai-overviews'],
      ...(onAlert ? { onAlert } : {}),
    })

  it('accumulates across instances that share the counter', async () => {
    const kv = new MemoryKV()
    await make(1, kv).charge('chatgpt')
    await make(1, kv).charge('chatgpt') // a second container
    expect(await make(1, kv).spentUsd()).toBeCloseTo(0.004, 9)
  })

  it('THE FINDING: a cold instance does NOT get its own fresh cap', async () => {
    const kv = new MemoryKV()
    const first = make(0.005, kv)
    await first.charge('chatgpt')
    await first.charge('chatgpt')
    const cold = make(0.005, kv)
    await expect(cold.charge('chatgpt')).rejects.toThrow(BudgetExceeded)
    expect(await cold.spentUsd()).toBeCloseTo(0.004, 9)
  })

  it('preserves the per-engine breakdown /cost-audit reconciles against', async () => {
    const l = make(1)
    await l.charge('chatgpt')
    await l.charge('chatgpt')
    await l.charge('gemini')
    await l.charge('google-ai-overviews')
    const b = await l.breakdown()
    expect(b.window).toBe('2026-08-21')
    expect(b.calls).toBe(4)
    expect(b.spentUsd).toBeCloseTo(0.007, 9)
    expect(b.byEngine['chatgpt']?.calls).toBe(2)
    expect(b.byEngine['chatgpt']?.usd).toBeCloseTo(0.004, 9)
    // Per-engine prices differ, so one scalar total could not reproduce this.
    expect(b.byEngine['google-ai-overviews']?.usd).toBeCloseTo(0.001, 9)
    // Per-engine USD must sum to the authoritative total, or the audit is a lie.
    const summed = Object.values(b.byEngine).reduce((s, e) => s + e.usd, 0)
    expect(summed).toBeCloseTo(b.spentUsd, 9)
  })

  it('reports engines that spent nothing as zero rather than omitting them', async () => {
    const b = await make(1).breakdown()
    expect(b.byEngine['gemini']).toEqual({ calls: 0, usd: 0 })
    expect(b.spentUsd).toBe(0)
  })

  it('charges the whole breakdown in ONE round-trip', async () => {
    let batches = 0
    const kv = new MemoryKV()
    const orig = kv.incrManyByFloat.bind(kv)
    kv.incrManyByFloat = async (ops, opts) => {
      batches++
      return orig(ops, opts)
    }
    await make(1, kv).charge('chatgpt')
    expect(batches).toBe(1) // total + engine usd + engine calls, not three trips
  })

  it('a refused charge refunds all three counters, so the breakdown stays honest', async () => {
    const kv = new MemoryKV()
    const l = make(0.003, kv)
    await l.charge('chatgpt')
    await expect(l.charge('chatgpt')).rejects.toThrow(BudgetExceeded)
    const b = await l.breakdown()
    expect(b.spentUsd).toBeCloseTo(0.002, 9)
    expect(b.byEngine['chatgpt']?.calls).toBe(1) // the refused call is not counted
  })

  it('concurrent charges cannot both take the last slot', async () => {
    const kv = new InterleavingKV()
    const cap = 0.004
    const at = () => new Date('2026-08-21T09:00:00Z')
    const a = new KvSpendLedger({ kv, capUsd: cap, priceUsd: () => PRICE, now: at })
    const b = new KvSpendLedger({ kv, capUsd: cap, priceUsd: () => PRICE, now: at })
    await a.charge('chatgpt')

    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let waiting = 0
    kv.gate = async () => {
      if (++waiting <= 2) await held
    }
    const both = Promise.allSettled([a.charge('chatgpt'), b.charge('chatgpt')])
    release()
    const accepted = (await both).filter((r) => r.status === 'fulfilled').length
    expect(accepted).toBe(1)
    expect(await a.spentUsd()).toBeLessThanOrEqual(cap)
  })

  it('alerts when the cap is reached', async () => {
    const { sink, seen } = collectAlerts()
    await expect(make(0.001, new MemoryKV(), sink).charge('chatgpt')).rejects.toThrow(BudgetExceeded)
    expect(seen.some((a) => a.kind === 'cap-reached')).toBe(true)
  })
})

// --- (b) a failed refund is visible ----------------------------------------

describe('a failed refund fails safe AND loud', () => {
  it('still refuses the call, and says the remaining cap has shrunk', async () => {
    const { sink, seen } = collectAlerts()
    const l = new KvSpendLedger({
      kv: new RefundFailsKV(),
      capUsd: 0.003,
      priceUsd: () => PRICE,
      now: () => new Date('2026-08-21T09:00:00Z'),
      onAlert: sink,
    })
    await l.charge('chatgpt') // 0.002
    await expect(l.charge('chatgpt')).rejects.toThrow(BudgetExceeded) // refused; the refund throws

    const refund = seen.find((a) => a.kind === 'refund-failed')
    expect(refund).toBeDefined()
    expect(refund?.engine).toBe('chatgpt')
    expect(refund?.window).toBe('2026-08-21')
    expect(refund?.message).toMatch(/over-counts/)
    expect(refund?.message).toMatch(/under-spend/)

    // The direction is still safe: the counter is high, not low, so the next
    // charge is refused early rather than let through.
    expect(await l.spentUsd()).toBeCloseTo(0.004, 9)
    await expect(l.charge('chatgpt')).rejects.toThrow(BudgetExceeded)
  })
})

describe('both implementations satisfy the same contract', () => {
  it('are substitutable through SpendLedger', async () => {
    const ledgers: SpendLedger[] = [
      LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), ACK),
      new KvSpendLedger({ kv: new MemoryKV(), capUsd: 1, priceUsd: () => PRICE, engines: ['gemini'] }),
    ]
    for (const l of ledgers) {
      await l.charge('gemini')
      expect(await l.spentUsd()).toBeCloseTo(PRICE, 9)
      expect(l.capUsd).toBe(1)
      const b = await l.breakdown()
      expect(b.byEngine['gemini']?.calls).toBe(1)
      expect(b.spentUsd).toBeCloseTo(PRICE, 9)
    }
  })
})

describe('KV increments', () => {
  it('incrByFloat returns the post-increment value', async () => {
    const kv = new MemoryKV()
    expect(await kv.incrByFloat('k', 1.5)).toBe(1.5)
    expect(await kv.incrByFloat('k', -0.5)).toBe(1)
  })
  it('incrManyByFloat returns each value in order', async () => {
    const kv = new MemoryKV()
    expect(
      await kv.incrManyByFloat([
        { key: 'a', delta: 1 },
        { key: 'b', delta: 2 },
        { key: 'a', delta: 3 },
      ]),
    ).toEqual([1, 2, 4])
    expect(await kv.incrManyByFloat([])).toEqual([])
  })
})

describe('topology is declared, never assumed', () => {
  it('THE REVIEW FINDING: an undeclared runtime is REFUSED, not assumed safe', () => {
    // A bare Hetzner VM — the actual P5 target — sets no PaaS marker. The first
    // guard read that absence as "not a fleet", so worker 7 of 12 would have
    // sailed through with a full private budget: the exact bug this file exists
    // to close, reinstated on the one topology it was written for.
    expect(() =>
      LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), {
        iUnderstandThisCapIsPerProcess: true,
        reason: 'one worker on this box',
        env: {}, // no marker, no declaration: indistinguishable from a fleet
      }),
    ).toThrow(/cannot show it is the only one/)
  })

  it('resolveTopology: a PaaS marker overrules any declaration', () => {
    expect(resolveTopology({ COLLECTOR_TOPOLOGY: 'single-process', VERCEL: '1' }).topology).toBe('fleet')
    expect(resolveTopology({ COLLECTOR_TOPOLOGY: 'single-process' }).topology).toBe('single-process')
    expect(resolveTopology({ COLLECTOR_TOPOLOGY: 'fleet' }).topology).toBe('fleet')
    expect(resolveTopology({ COLLECTOR_TOPOLOGY: 'probably-fine' }).topology).toBe('undeclared')
    expect(resolveTopology({}).topology).toBe('undeclared')
  })

  it('a declared fleet is refused even with no marker present', () => {
    expect(() =>
      LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), {
        iUnderstandThisCapIsPerProcess: true,
        reason: 'hetzner worker',
        env: { COLLECTOR_TOPOLOGY: 'fleet' },
      }),
    ).toThrow(/own full budget/)
  })

  it('the undeclared override cannot rescue a DETECTED fleet', () => {
    expect(() =>
      LocalSpendLedger.forSingleProcess(new Budget(ledgerFile(), 1, () => PRICE), {
        iUnderstandThisCapIsPerProcess: true,
        reason: 'trying to force it',
        overrideUndeclaredTopology: true,
        env: { VERCEL: '1' },
      }),
    ).toThrow(UnsafeSpendLedgerError)
  })
})

describe('a wrong clock cannot buy a private budget', () => {
  it('a worker whose clock is behind charges against the real window, loudly', async () => {
    const kv = new MemoryKV()
    const { sink, seen } = collectAlerts()
    // A correctly-clocked worker establishes the high-water mark.
    const ontime = new KvSpendLedger({ kv, capUsd: 0.005, priceUsd: () => PRICE, now: () => new Date('2026-08-22T09:00:00Z') })
    await ontime.charge('chatgpt')
    await ontime.charge('chatgpt') // 0.004 of 0.005

    // A stuck worker still thinks it is yesterday. Without the guard it would
    // write to a key nobody else shares and get a whole fresh cap.
    const skewed = new KvSpendLedger({ kv, capUsd: 0.005, priceUsd: () => PRICE, now: () => new Date('2026-08-21T09:00:00Z'), onAlert: sink })
    await expect(skewed.charge('chatgpt')).rejects.toThrow(BudgetExceeded)
    expect(seen.some((a) => a.kind === 'clock-skew')).toBe(true)
    expect(seen.find((a) => a.kind === 'clock-skew')?.message).toMatch(/clock is behind/)
  })

  it('the high-water check costs one round-trip per window, not per charge', async () => {
    const kv = new MemoryKV()
    let gets = 0
    const orig = kv.get.bind(kv)
    kv.get = async (k) => {
      gets++
      return orig(k)
    }
    const l = new KvSpendLedger({ kv, capUsd: 1, priceUsd: () => PRICE, now: () => new Date('2026-08-21T09:00:00Z') })
    for (let i = 0; i < 20; i++) await l.charge('chatgpt')
    expect(gets).toBe(1)
  })

  it('a clock that is AHEAD advances the window, which is not a fault', async () => {
    const kv = new MemoryKV()
    const { sink, seen } = collectAlerts()
    await new KvSpendLedger({ kv, capUsd: 1, priceUsd: () => PRICE, now: () => new Date('2026-08-21T09:00:00Z') }).charge('chatgpt')
    const ahead = new KvSpendLedger({ kv, capUsd: 1, priceUsd: () => PRICE, now: () => new Date('2026-08-22T09:00:00Z'), onAlert: sink })
    await ahead.charge('chatgpt')
    expect(seen.filter((a) => a.kind === 'clock-skew')).toHaveLength(0)
  })
})

describe('a failed charge is as loud as a failed refund', () => {
  class ChargeFailsKV extends MemoryKV {
    override async incrManyByFloat(): Promise<number[]> {
      throw new Error('upstash 500')
    }
  }

  it('alerts and rethrows, rather than failing silently', async () => {
    const { sink, seen } = collectAlerts()
    const l = new KvSpendLedger({ kv: new ChargeFailsKV(), capUsd: 1, priceUsd: () => PRICE, now: () => new Date('2026-08-21T09:00:00Z'), onAlert: sink })
    await expect(l.charge('chatgpt')).rejects.toThrow('upstash 500')
    const a = seen.find((x) => x.kind === 'charge-failed')
    expect(a).toBeDefined()
    // The batch is not a transaction, so part of it may have landed.
    expect(a?.message).toMatch(/may have applied/)
    expect(a?.message).toMatch(/under-spend/)
  })
})
