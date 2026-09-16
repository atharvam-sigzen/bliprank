import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AdapterError, cacheCell, type EngineAdapter, type EngineId } from '@bliprank/contracts'
import { MemoryBlobStore } from './blob-store.js'
import { Budget } from './budget.js'
import { LocalSpendLedger } from './spend-ledger.js'

/** The guarded factory, wrapped once so each test reads clearly. */
const localLedger = (b: Budget) =>
  LocalSpendLedger.forSingleProcess(b, { iUnderstandThisCapIsPerProcess: true, reason: 'unit test: one process, no fleet', env: { COLLECTOR_TOPOLOGY: 'single-process' } })

import { AnswerIndex, MemoryKV, r2KeyFor } from './cache-index.js'
import { MemoryDeadLetter } from './dead-letter.js'
import { LocalRateBudget } from './rate-budget.js'
import { stubAdapter } from './adapters/stub.js'
import { CollectionOrchestrator, type OrchestratorDeps } from './collect-cell.js'

/** The charge count behind a ledger — the local impl wraps a file-backed Budget. */
const ledgerCalls = (d: { budget: unknown }) => (d.budget as LocalSpendLedger).budget.state.calls

const cellOf = (prompt: string, engine: EngineId = 'chatgpt', day = '2026-08-20') => cacheCell({ prompt, engine, locale: 'en-US', geo: 'US', dateBucket: day })

/** A stub whose collect() is counted, so we can prove "0 provider calls on a cache hit". */
function countingStub(engine: EngineId): EngineAdapter & { calls: number } {
  const base = stubAdapter(engine)
  const a = { ...base, calls: 0 } as EngineAdapter & { calls: number }
  a.collect = async (req) => {
    a.calls++
    return base.collect(req)
  }
  return a
}

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps & { _advance: (ms: number) => void } {
  const ledger = join(mkdtempSync(join(tmpdir(), 'orch-')), 'ledger.json')
  const clock = { ms: Date.parse('2026-08-20T00:00:00Z') }
  return {
    index: new AnswerIndex(new MemoryKV(() => clock.ms), 100 * 86_400, () => new Date(clock.ms)),
    blob: new MemoryBlobStore(),
    rateBudget: LocalRateBudget.forSingleProcess({ chatgpt: { rps: 1000, burst: 1000 }, gemini: { rps: 1000, burst: 1000 } }, { iUnderstandThisBudgetIsPerProcess: true, reason: 'unit test: one process, no fleet', env: { COLLECTOR_TOPOLOGY: 'single-process' } }),
    budget: localLedger(new Budget(ledger, 100, () => 0.002)),
    deadLetter: new MemoryDeadLetter(),
    owner: 'worker-1',
    sleep: async () => {},
    now: () => new Date(clock.ms),
    collectionEnabled: () => true, // offline tests still pass the gate; real-adapter tests override
    _advance: (ms: number) => {
      clock.ms += ms
    },
    ...over,
  }
}

describe('CollectionOrchestrator — the cache-check → collect → R2 funnel', () => {
  it('collects on a miss: N answers, ONE blob per cell, an index entry, budget charged per run', async () => {
    const d = deps()
    const orch = new CollectionOrchestrator(d)
    const adapter = countingStub('chatgpt')
    const cell = cellOf('Best CRM for a small business?')
    const r = await orch.collectCell({ cell, prompt: 'Best CRM for a small business?', runs: 5, adapter })
    expect(r.status).toBe('collected')
    if (r.status !== 'collected') return
    expect(r.answers).toHaveLength(5)
    expect(adapter.calls).toBe(5)
    expect(r.providerCalls).toBe(5)
    expect((d.blob as MemoryBlobStore).size).toBe(1) // R4: one object per cell, not per answer
    expect(await d.blob.has(r2KeyFor(cell, adapter.id))).toBe(true) // path-qualified (B1)
    expect(r.entry.runs).toBe(5)
    expect(ledgerCalls(d)).toBe(5)
  })

  it('R6: a re-collect of the same cell serves from cache with ZERO provider calls', async () => {
    const d = deps()
    const orch = new CollectionOrchestrator(d)
    const cell = cellOf('best crm')
    await orch.collectCell({ cell, prompt: 'best crm', runs: 5, adapter: countingStub('chatgpt') })
    const before = ledgerCalls(d)
    const adapter2 = countingStub('chatgpt')
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 5, adapter: adapter2 })
    expect(r.status).toBe('cache-hit')
    expect(r.providerCalls).toBe(0)
    expect(adapter2.calls).toBe(0) // nothing hit the provider
    expect(ledgerCalls(d)).toBe(before) // nothing charged
  })

  it('shared prompt-pool dedupe: while a claim is held, a second worker does not collect', async () => {
    const d = deps()
    // pre-claim the cell as another worker (claim survives because MemoryKV has no TTL expiry here)
    const cell = cellOf('best crm')
    await d.index.claim(cell, 'stubsearch:chatgpt', 'other-worker')
    const orch = new CollectionOrchestrator(d)
    const adapter = countingStub('chatgpt')
    // the counting stub reports adapter.id 'stubsearch:chatgpt' (same as the pre-claim)
    expect(adapter.id).toBe('stubsearch:chatgpt')
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 5, adapter })
    expect(r.status).toBe('claimed-elsewhere')
    expect(r.providerCalls).toBe(0)
    expect(adapter.calls).toBe(0)
  })

  it('the alternate collection path is not short-circuited by the primary entry (ADR-0003)', async () => {
    const d = deps()
    const orch = new CollectionOrchestrator(d)
    const cell = cellOf('best crm')
    // primary path collects
    const primary = { ...countingStub('chatgpt'), id: 'openwebninja:chatgpt', provider: 'openwebninja' } as EngineAdapter & { calls: number }
    let pCalls = 0
    primary.collect = async (rq) => {
      pCalls++
      return stubAdapter('chatgpt').collect(rq)
    }
    await orch.collectCell({ cell, prompt: 'best crm', runs: 3, adapter: primary })
    expect(pCalls).toBe(3)
    // alternate path (different adapter id) must still collect, not serve the primary's cache
    const alt = countingStub('chatgpt') // id stubsearch:chatgpt
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 3, adapter: alt })
    expect(r.status).toBe('collected')
    expect(alt.calls).toBe(3)
    // B1: the two paths write SEPARATE R2 objects — the alternate must not overwrite the primary's
    expect((d.blob as MemoryBlobStore).size).toBe(2)
    const primaryBlob = JSON.parse((await d.blob.get(r2KeyFor(cell, 'openwebninja:chatgpt')))!) as { adapter: string }
    const altBlob = JSON.parse((await d.blob.get(r2KeyFor(cell, 'stubsearch:chatgpt')))!) as { adapter: string }
    expect(primaryBlob.adapter).toBe('openwebninja:chatgpt')
    expect(altBlob.adapter).toBe('stubsearch:chatgpt')
  })

  it('B2: a partial prior collection is NOT a permanent cache hit — a later call completes n', async () => {
    const ledger = join(mkdtempSync(join(tmpdir(), 'orch-')), 'ledger.json')
    // first call: budget for only 3 of 10 requested runs
    const d = deps({ budget: localLedger(new Budget(ledger, 0.006, () => 0.002)) })
    const orch = new CollectionOrchestrator(d)
    const cell = cellOf('best crm')
    const a1 = countingStub('chatgpt')
    const r1 = await orch.collectCell({ cell, prompt: 'best crm', runs: 10, adapter: a1 })
    expect(r1.status).toBe('budget-exhausted')
    expect(a1.calls).toBe(3)
    // a later cycle with a fresh, ample budget: the under-target cell must
    // complete n, not serve n=3 as a hit forever
    d._advance(1_801_000) // past the 1800s claim lease (the release below makes this moot; kept so the case is still the one it was)
    const ledger2 = join(mkdtempSync(join(tmpdir(), 'orch-')), 'ledger.json')
    const orch2 = new CollectionOrchestrator({ ...d, budget: localLedger(new Budget(ledger2, 100, () => 0.002)) })
    const a2 = countingStub('chatgpt')
    const r2 = await orch2.collectCell({ cell, prompt: 'best crm', runs: 10, adapter: a2 })
    expect(r2.status).toBe('collected') // NOT cache-hit
    // ...and it buys only the seven runs that are missing. This line said 10
    // until 2026-09-07: the three stored runs were re-bought, and the test had
    // pinned the waste as if it were the point.
    expect(a2.calls).toBe(7)
    if (r2.status === 'collected') expect(r2.entry.runs).toBe(10)
  })

  it('M1: a real (spending) adapter refuses when COLLECTION_ENABLED is false; offline adapters run', async () => {
    const d = deps({ collectionEnabled: () => false })
    const orch = new CollectionOrchestrator(d)
    const cell = cellOf('best crm')
    const real = { ...stubAdapter('chatgpt'), offline: false } as EngineAdapter // pretend it spends
    await expect(orch.collectCell({ cell, prompt: 'best crm', runs: 1, adapter: real })).rejects.toThrow(/COLLECTION_ENABLED/)
    // an offline adapter (the stub) is unaffected by the gate
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 1, adapter: countingStub('chatgpt') })
    expect(r.status).toBe('collected')
  })

  it('M2: an abort mid-cell persists the runs already collected and returns a typed outcome, not a throw', async () => {
    const d = deps()
    const orch = new CollectionOrchestrator(d)
    const cell = cellOf('best crm')
    const ac = new AbortController()
    let n = 0
    const adapter = { ...stubAdapter('chatgpt') } as EngineAdapter
    adapter.collect = async (rq) => {
      n++
      if (n === 3) ac.abort() // cancel after two successful runs, during the third
      if (rq.signal?.aborted) {
        const e = new Error('aborted')
        e.name = 'AbortError'
        throw e
      }
      return stubAdapter('chatgpt').collect(rq)
    }
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 10, adapter, signal: ac.signal })
    expect(r.status).toBe('aborted')
    if (r.status === 'aborted') {
      expect(r.answers.length).toBeGreaterThanOrEqual(2) // the runs before the abort are kept
      expect(r.entry).not.toBeNull() // partial persisted, not lost
    }
    expect((d.blob as MemoryBlobStore).size).toBe(1)
  })

  it('crash recovery: an orphaned complete blob (crash between put and mark) is re-indexed, not re-collected', async () => {
    const d = deps()
    const cell = cellOf('best crm')
    const adapterId = 'stubsearch:chatgpt'
    // simulate the crash: blob written, index never marked
    const r2Key = r2KeyFor(cell, adapterId)
    await d.blob.put(r2Key, JSON.stringify({ cell, adapter: adapterId, runs: [1, 2, 3, 4, 5] }))
    expect((await d.index.lookup([cell], adapterId)).hits.size).toBe(0) // orphan: not indexed
    const orch = new CollectionOrchestrator(d)
    const adapter = countingStub('chatgpt') // id stubsearch:chatgpt
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 5, adapter })
    expect(r.status).toBe('cache-hit') // recovered from the orphan
    expect(adapter.calls).toBe(0) // nothing re-collected, nothing re-paid
  })

  it('a blob READ that fails is not "nothing stored": the cell halts and nothing is re-bought (2026-09-10 cost review)', async () => {
    // A network store answers a 500, a 403 or a dropped socket by throwing.
    // Swallowed into an empty read, that was a duplicate purchase of a cell
    // already paid for — once per transient blip, unbounded across an incident.
    const failing = (store: MemoryBlobStore): MemoryBlobStore => {
      const f = Object.create(store) as MemoryBlobStore
      f.get = async () => {
        throw new Error('R2 GET failed: HTTP 500')
      }
      return f
    }
    const cell = cellOf('best crm')
    const adapterId = 'stubsearch:chatgpt'

    // Orphan path: the object exists, the index does not know it, the read fails.
    const s1 = new MemoryBlobStore()
    await s1.put(r2KeyFor(cell, adapterId), JSON.stringify({ runs: [1, 2, 3, 4, 5] }))
    const d1 = deps({ blob: failing(s1) })
    const a1 = countingStub('chatgpt')
    await expect(new CollectionOrchestrator(d1).collectCell({ cell, prompt: 'best crm', runs: 5, adapter: a1 })).rejects.toThrow(/HTTP 500/)
    expect(a1.calls).toBe(0)
    expect(ledgerCalls(d1)).toBe(0)

    // Partial path: the index says two runs are stored, the read of them fails.
    const s2 = new MemoryBlobStore()
    await s2.put(r2KeyFor(cell, adapterId), JSON.stringify({ runs: [1, 2] }))
    const d2 = deps({ blob: failing(s2) })
    await d2.index.markCollected(cell, adapterId, 2, r2KeyFor(cell, adapterId))
    const a2 = countingStub('chatgpt')
    await expect(new CollectionOrchestrator(d2).collectCell({ cell, prompt: 'best crm', runs: 5, adapter: a2 })).rejects.toThrow(/HTTP 500/)
    expect(a2.calls).toBe(0)

    // A CORRUPT object is still the honest re-collection, as before.
    const d3 = deps()
    await d3.blob.put(r2KeyFor(cell, adapterId), 'not json')
    const a3 = countingStub('chatgpt')
    const r = await new CollectionOrchestrator(d3).collectCell({ cell, prompt: 'best crm', runs: 2, adapter: a3 })
    expect(r.status).toBe('collected')
    expect(a3.calls).toBe(2)
  })

  it('a non-retryable rejection dead-letters the run and writes nothing; failed status, no index entry', async () => {
    const d = deps()
    const orch = new CollectionOrchestrator(d)
    const cell = cellOf('best crm')
    const bad = { ...stubAdapter('chatgpt') } as EngineAdapter
    bad.collect = async () => {
      throw new AdapterError('rejected', 'HTTP 403 not subscribed', false)
    }
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 3, adapter: bad })
    expect(r.status).toBe('failed')
    expect(d.deadLetter.count('chatgpt', 'rejected')).toBe(3) // one per run, no retries
    expect((d.blob as MemoryBlobStore).size).toBe(0) // nothing stored
    expect((await d.index.lookup([cell])).hits.size).toBe(0) // not marked collected
    expect(ledgerCalls(d)).toBe(3) // each attempt still charged (R3)
  })

  it('retryable failures are retried per policy, then succeed', async () => {
    const d = deps()
    const orch = new CollectionOrchestrator(d)
    const cell = cellOf('best crm')
    const flaky = { ...stubAdapter('chatgpt') } as EngineAdapter
    let n = 0
    flaky.collect = async (rq) => {
      n++
      if (n < 3) throw new AdapterError('provider', 'HTTP 500', true) // fail the first two attempts
      return stubAdapter('chatgpt').collect(rq)
    }
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 1, adapter: flaky })
    expect(r.status).toBe('collected')
    if (r.status === 'collected') expect(r.answers).toHaveLength(1)
    expect(n).toBe(3) // two retries then success
    expect(d.deadLetter.count()).toBe(0)
  })

  it('budget exhaustion stops the cell before overspending; partial answers still stored', async () => {
    const ledger = join(mkdtempSync(join(tmpdir(), 'orch-')), 'ledger.json')
    const d = deps({ budget: localLedger(new Budget(ledger, 0.006, () => 0.002)) }) // room for exactly 3 charges
    const orch = new CollectionOrchestrator(d)
    const cell = cellOf('best crm')
    const adapter = countingStub('chatgpt')
    const r = await orch.collectCell({ cell, prompt: 'best crm', runs: 10, adapter })
    expect(r.status).toBe('budget-exhausted')
    expect(adapter.calls).toBe(3) // cap stopped it at 3, not 10
    expect((d.budget as LocalSpendLedger).budget.state.spentUsd).toBeCloseTo(0.006, 9)
    if (r.status === 'budget-exhausted') expect(r.answers).toHaveLength(3) // the 3 that succeeded are kept
    expect((d.blob as MemoryBlobStore).size).toBe(1) // partial cell written
  })
})

describe('the claim ends with the collection, not with the lease (ADR-0017 "left as they are", fixed 2026-09-07)', () => {
  /** The same store, a second worker with its own ledger: what a re-run inside the lease window sees. */
  const secondWorker = (d: OrchestratorDeps, capUsd: number) => {
    const ledger = join(mkdtempSync(join(tmpdir(), 'orch-')), 'ledger.json')
    return new CollectionOrchestrator({ ...d, owner: 'worker-2', budget: localLedger(new Budget(ledger, capUsd, () => 0.002)) })
  }

  it('a budget stop releases the claim: a re-run inside the window completes the cell instead of seeing it claimed elsewhere', async () => {
    const ledger = join(mkdtempSync(join(tmpdir(), 'orch-')), 'ledger.json')
    const d = deps({ budget: localLedger(new Budget(ledger, 0.006, () => 0.002)) }) // room for exactly 3 charges
    const cell = cellOf('best crm')
    const adapter = countingStub('chatgpt')
    const first = await new CollectionOrchestrator(d).collectCell({ cell, prompt: 'best crm', runs: 5, adapter })
    expect(first.status).toBe('budget-exhausted')
    expect(adapter.calls).toBe(3)
    d._advance(60_000) // a minute later: inside the thirty-minute lease, where the old code answered 'claimed-elsewhere'
    const again = await secondWorker(d, 100).collectCell({ cell, prompt: 'best crm', runs: 5, adapter })
    expect(again.status).toBe('collected')
    expect(adapter.calls).toBe(5) // exactly the two runs the cap refused; nothing bought twice
    if (again.status === 'collected') expect(again.entry.runs).toBe(5)
  })

  it('an allowance stop is its own outcome, leaves the ledger clean, and releases the claim too', async () => {
    const ledger = join(mkdtempSync(join(tmpdir(), 'orch-')), 'ledger.json')
    const budget = new Budget(ledger, 100, () => 0.002, () => new Date(), 2) // this run may make two attempts
    const d = deps({ budget: localLedger(budget) })
    const cell = cellOf('best crm')
    const adapter = countingStub('chatgpt')
    const r = await new CollectionOrchestrator(d).collectCell({ cell, prompt: 'best crm', runs: 4, adapter })
    expect(r.status).toBe('allowance-exhausted') // not 'budget-exhausted': the cap has $99.996 left
    expect(adapter.calls).toBe(2)
    expect(budget.state.exhaustedAt).toBeUndefined()
    if (r.status === 'allowance-exhausted') expect(r.answers).toHaveLength(2)
    const again = await secondWorker(d, 100).collectCell({ cell, prompt: 'best crm', runs: 4, adapter })
    expect(again.status).toBe('collected')
    expect(adapter.calls).toBe(4)
  })

  it('a completed collection releases the claim as well: nothing stays held once the cell is served from cache', async () => {
    const d = deps()
    const cell = cellOf('best crm')
    const adapter = countingStub('chatgpt')
    expect((await new CollectionOrchestrator(d).collectCell({ cell, prompt: 'best crm', runs: 2, adapter })).status).toBe('collected')
    expect(await d.index.claim(cell, adapter.id, 'anyone', 10)).toBe(true)
  })

  it('a throw on the way out releases the claim too', async () => {
    const ledger = join(mkdtempSync(join(tmpdir(), 'orch-')), 'ledger.json')
    const d = deps({ budget: localLedger(new Budget(ledger, 100, () => Number.NaN)) }) // a bad price is a RangeError, not a budget stop
    const cell = cellOf('best crm')
    const adapter = countingStub('chatgpt')
    await expect(new CollectionOrchestrator(d).collectCell({ cell, prompt: 'best crm', runs: 1, adapter })).rejects.toThrow(/bad price/)
    expect(adapter.calls).toBe(0)
    expect(await d.index.claim(cell, adapter.id, 'anyone', 10)).toBe(true)
  })
})
