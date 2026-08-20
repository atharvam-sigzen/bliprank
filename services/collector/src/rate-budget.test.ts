import { describe, expect, it } from 'vitest'
import { LocalRateBudget, msUntilWindowOpen, type Clock } from './rate-budget.js'

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

describe('LocalRateBudget', () => {
  it('paces at the configured rps after the burst is spent', async () => {
    const clock = fakeClock()
    const rb = new LocalRateBudget({ api: { rps: 2, burst: 1 } }, clock)
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
    const rb = new LocalRateBudget({ api: { rps: 1, burst: 5 } }, clock)
    for (let i = 0; i < 5; i++) await rb.acquire('api')
    expect(clock.t).toBe(0) // all from burst, no waiting
    await rb.acquire('api')
    expect(clock.t).toBeGreaterThanOrEqual(1000)
  })

  it('multi-key sharding multiplies throughput and spreads keys round-robin', async () => {
    const clock = fakeClock()
    const rb = new LocalRateBudget({ api: { rps: 1, burst: 1, keys: ['k1', 'k2', 'k3'] } }, clock)
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
    const rb = new LocalRateBudget({ api: { rps: 10, burst: 1, window: { utcStartHour: 6, hours: 12 } } }, clock)
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
    const rb = new LocalRateBudget({ api: { rps: 1, burst: 1, window: { utcStartHour: 6, hours: 1 } } }, clock)
    const ac = new AbortController()
    ac.abort()
    await expect(rb.acquire('api', ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects unknown buckets and bad configs', async () => {
    const rb = new LocalRateBudget({ api: { rps: 1, burst: 1 } })
    await expect(rb.acquire('nope')).rejects.toThrow(RangeError)
    expect(() => new LocalRateBudget({ bad: { rps: 0, burst: 1 } })).toThrow(RangeError)
    expect(() => new LocalRateBudget({ bad: { rps: 1, burst: 0 } })).toThrow(RangeError)
  })

  it('penalize drains a shard for a window so siblings slow too', async () => {
    const clock = fakeClock()
    const rb = new LocalRateBudget({ api: { rps: 10, burst: 3, keys: ['k1', 'k2'] } }, clock)
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
