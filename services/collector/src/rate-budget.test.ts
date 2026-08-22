import { describe, expect, it } from 'vitest'
import { LocalRateBudget, UnsafeRateBudgetError, msUntilWindowOpen, type Clock } from './rate-budget.js'

/** Deterministic clock: sleeping advances time; no real waiting. */
function fakeClock(startMs = 0): Clock & { t: number } {
  const c = {
    t: startMs,
    now: () => c.t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) {
        const e = new Error('aborted')
        e.name = 'AbortError'
        throw e
      }
      c.t += ms
    },
  }
  return c
}

/** Single-process construction for tests: topology is injected, never read from the ambient shell. */
function localRateBudget(buckets: Parameters<typeof LocalRateBudget.forSingleProcess>[0], clock?: Clock): LocalRateBudget {
  return LocalRateBudget.forSingleProcess(buckets, {
    iUnderstandThisBudgetIsPerProcess: true,
    reason: 'unit test: one process, no fleet',
    env: { COLLECTOR_TOPOLOGY: 'single-process' },
    ...(clock ? { clock } : {}),
  })
}

describe('LocalRateBudget', () => {
  it('paces at the configured rps after the burst is spent', async () => {
    const clock = fakeClock()
    const rb = localRateBudget({ api: { rps: 2, burst: 1 } }, clock)
    await rb.acquire('api') // burst token, t=0
    await rb.acquire('api')
    await rb.acquire('api')
    await rb.acquire('api')
    // 3 paced acquisitions at 2 rps = 1500ms of waiting
    expect(clock.t).toBeGreaterThanOrEqual(1500)
    expect(clock.t).toBeLessThan(1700)
  })

  it('burst allows immediate acquisitions up to the burst size', async () => {
    const clock = fakeClock()
    const rb = localRateBudget({ api: { rps: 1, burst: 5 } }, clock)
    for (let i = 0; i < 5; i++) await rb.acquire('api')
    expect(clock.t).toBe(0) // all from burst, no waiting
    await rb.acquire('api')
    expect(clock.t).toBeGreaterThanOrEqual(1000)
  })

  it('multi-key sharding multiplies throughput and spreads keys round-robin', async () => {
    const clock = fakeClock()
    const rb = localRateBudget({ api: { rps: 1, burst: 1, keys: ['k1', 'k2', 'k3'] } }, clock)
    expect(rb.state('api').totalRps).toBe(3)
    const keys: (string | null)[] = []
    for (let i = 0; i < 3; i++) keys.push((await rb.acquire('api')).key)
    expect(clock.t).toBe(0) // one burst token per shard
    expect(new Set(keys)).toEqual(new Set(['k1', 'k2', 'k3'])) // no shard hammered
    await rb.acquire('api')
    expect(clock.t).toBeGreaterThanOrEqual(1000 / 3 - 5) // 3 shards ≈ 3 rps aggregate
    expect(clock.t).toBeLessThan(1100)
  })

  it('waits for the collection window and reports it in state()', async () => {
    // window 06:00–18:00 UTC; start the clock at 03:00
    const clock = fakeClock(3 * 3_600_000)
    const rb = localRateBudget({ api: { rps: 10, burst: 1, window: { utcStartHour: 6, hours: 12 } } }, clock)
    expect(rb.state('api').windowOpen).toBe(false)
    const a = await rb.acquire('api')
    expect(clock.t).toBe(6 * 3_600_000) // slept exactly until the window opened
    expect(a.waitedMs).toBe(3 * 3_600_000)
    expect(rb.state('api').windowOpen).toBe(true)
  })

  it('msUntilWindowOpen: inside, before, after, and always-open', () => {
    const H = 3_600_000
    const w = { utcStartHour: 6, hours: 12 }
    expect(msUntilWindowOpen(w, 7 * H)).toBe(0) // inside
    expect(msUntilWindowOpen(w, 5 * H)).toBe(H) // an hour before opening
    expect(msUntilWindowOpen(w, 19 * H)).toBe(11 * H) // after close → tomorrow 06:00
    expect(msUntilWindowOpen({ utcStartHour: 0, hours: 24 }, 5)).toBe(0)
    expect(msUntilWindowOpen(undefined, 5)).toBe(0)
  })

  it('abort stops a waiting acquisition', async () => {
    const clock = fakeClock(0)
    const rb = localRateBudget({ api: { rps: 1, burst: 1, window: { utcStartHour: 6, hours: 1 } } }, clock)
    const ac = new AbortController()
    ac.abort()
    await expect(rb.acquire('api', ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects unknown buckets and bad configs', async () => {
    const rb = localRateBudget({ api: { rps: 1, burst: 1 } })
    await expect(rb.acquire('nope')).rejects.toThrow(RangeError)
    expect(() => localRateBudget({ bad: { rps: 0, burst: 1 } })).toThrow(RangeError)
    expect(() => localRateBudget({ bad: { rps: 1, burst: 0 } })).toThrow(RangeError)
  })

  it('penalize drains a shard for a window so siblings slow too', async () => {
    const clock = fakeClock()
    const rb = localRateBudget({ api: { rps: 10, burst: 3, keys: ['k1', 'k2'] } }, clock)
    rb.penalize('api', 5000, 'k1') // k1 throttled for 5s
    const a = await rb.acquire('api') // k2 still has burst
    expect(a.key).toBe('k2')
    // drain k2's burst too, then everything must wait out k1's penalty window
    await rb.acquire('api')
    await rb.acquire('api')
    const before = clock.t
    await rb.acquire('api')
    expect(clock.t - before).toBeGreaterThanOrEqual(100) // had to wait for a token, not instant
  })
})

describe('the bucket is per process, so the topology has to be declared (ADR-0006)', () => {
  const BUCKETS = { api: { rps: 1, burst: 1 } }
  const ACK = { iUnderstandThisBudgetIsPerProcess: true } as const

  it('refuses a declared fleet outright, with no override', () => {
    // Twelve workers each holding a full bucket issue 12x the configured rps at
    // a ceiling the provider enforces per key. ADR-0002's fleet design is a
    // static slice, which is a different construction, not this one waived.
    expect(() =>
      LocalRateBudget.forSingleProcess(BUCKETS, { ...ACK, reason: 'hetzner worker', env: { COLLECTOR_TOPOLOGY: 'fleet' } }),
    ).toThrow(/static slice/)
    expect(() =>
      LocalRateBudget.forSingleProcess(BUCKETS, {
        ...ACK,
        reason: 'trying to force it',
        overrideUndeclaredTopology: true,
        env: { COLLECTOR_TOPOLOGY: 'fleet' },
      }),
    ).toThrow(UnsafeRateBudgetError)
  })

  it('refuses an undeclared runtime — a bare VM sets no marker, so absence proves nothing', () => {
    expect(() => LocalRateBudget.forSingleProcess(BUCKETS, { ...ACK, reason: 'one worker on this box', env: {} })).toThrow(
      /cannot show it is the only one/,
    )
  })

  it('a detected PaaS marker beats the declaration', () => {
    expect(() =>
      LocalRateBudget.forSingleProcess(BUCKETS, { ...ACK, reason: 'lambda', env: { COLLECTOR_TOPOLOGY: 'single-process', VERCEL: '1' } }),
    ).toThrow(UnsafeRateBudgetError)
  })

  it('demands a written reason', () => {
    expect(() => LocalRateBudget.forSingleProcess(BUCKETS, { ...ACK, reason: '   ', env: { COLLECTOR_TOPOLOGY: 'single-process' } })).toThrow(
      /written reason/,
    )
  })

  it('the undeclared override works but leaves a trail', () => {
    const seen: string[] = []
    const rb = LocalRateBudget.forSingleProcess(BUCKETS, {
      ...ACK,
      reason: 'CI runner cannot set env',
      overrideUndeclaredTopology: true,
      env: {},
      onAlert: (m) => seen.push(m),
    })
    expect(rb.state('api').totalRps).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/undeclared topology/)
  })

  it('a declared single process is allowed, and still validates its config', () => {
    expect(localRateBudget({ api: { rps: 2, burst: 1 } }).state('api').rps).toBe(2)
    expect(() => localRateBudget({ bad: { rps: 0, burst: 1 } })).toThrow(RangeError)
  })
})
