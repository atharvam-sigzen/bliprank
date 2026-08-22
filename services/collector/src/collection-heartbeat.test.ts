import { describe, expect, it } from 'vitest'
import { MemoryKV } from './cache-index.js'
import { CollectionHeartbeat } from './collection-heartbeat.js'

const AT = (iso: string) => new Date(iso)

function beat(opts: Partial<ConstructorParameters<typeof CollectionHeartbeat>[0]> = {}) {
  const clock = { d: AT('2026-08-21T09:00:00Z') }
  const kv = new MemoryKV(() => clock.d.getTime())
  const hb = new CollectionHeartbeat({ kv, now: () => clock.d, ...opts })
  return { hb, kv, clock }
}

describe('the alarm is on the absence of success, not the presence of errors', () => {
  it('is healthy right after a collection', async () => {
    const { hb } = beat()
    await hb.recordCollected()
    const s = await hb.status()
    expect(s.health).toBe('healthy')
    expect(s.shouldAlert).toBe(false)
    expect(s.collectedInWindow).toBe(1)
  })

  it('goes stale, then dark, as silence accumulates', async () => {
    const { hb, clock } = beat({ staleAfterHours: 6, darkAfterHours: 24 })
    await hb.recordCollected()

    clock.d = AT('2026-08-21T14:00:00Z') // 5h
    expect((await hb.status()).health).toBe('healthy')

    clock.d = AT('2026-08-21T16:00:00Z') // 7h
    const stale = await hb.status()
    expect(stale.health).toBe('stale')
    expect(stale.shouldAlert).toBe(true)

    clock.d = AT('2026-08-22T10:00:00Z') // 25h
    const dark = await hb.status()
    expect(dark.health).toBe('dark')
    expect(dark.shouldAlert).toBe(true)
    expect(dark.hoursSince).toBeCloseTo(25, 1)
  })

  it('the dark message points at the failure mode this alarm exists for', async () => {
    const { hb, clock } = beat()
    await hb.recordCollected()
    clock.d = AT('2026-08-23T09:00:00Z')
    const s = await hb.status()
    // Both transports fail closed, so "no errors" is the expected symptom.
    expect(s.message).toMatch(/fail closed/)
    expect(s.message).toMatch(/signature verification/)
  })

  it('a never-collected deployment reports it but does NOT page anyone', async () => {
    const { hb } = beat()
    const s = await hb.status()
    expect(s.health).toBe('never-collected')
    expect(s.lastCollectedAt).toBeNull()
    // Paging on day one trains everyone to ignore the alarm.
    expect(s.shouldAlert).toBe(false)
  })

  it('a scheduled quiet window suppresses the stale alert but not the dark one', async () => {
    const { hb, clock } = beat({ staleAfterHours: 6, darkAfterHours: 24, isExpectedQuiet: () => true })
    await hb.recordCollected()

    clock.d = AT('2026-08-21T18:00:00Z') // 9h — between cycles, expected
    const stale = await hb.status()
    expect(stale.health).toBe('stale')
    expect(stale.shouldAlert).toBe(false)
    expect(stale.message).toMatch(/scheduled quiet window/)

    clock.d = AT('2026-08-22T12:00:00Z') // 27h — no schedule explains this
    const dark = await hb.status()
    expect(dark.shouldAlert).toBe(true)
  })

  it('counts cells collected today, and the count resets with the day', async () => {
    const { hb, clock } = beat()
    await hb.recordCollected(5)
    await hb.recordCollected(3)
    expect((await hb.status()).collectedInWindow).toBe(8)

    clock.d = AT('2026-08-22T09:00:00Z')
    expect((await hb.status()).collectedInWindow).toBe(0)
  })

  it('refuses a nonsensical threshold pair rather than never firing', () => {
    expect(() => new CollectionHeartbeat({ kv: new MemoryKV(), staleAfterHours: 48, darkAfterHours: 24 })).toThrow(RangeError)
  })
})
