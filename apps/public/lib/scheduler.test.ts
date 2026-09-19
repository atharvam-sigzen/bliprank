/**
 * The in-app daily scheduler (MVP_PLAN P1): WHEN it fires. Whether a run may
 * spend is `local-tick.test.ts`. Every run here is a counter; nothing is
 * collected and no clock is real.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ledgerStores } from '../../../services/grader/src/ledger-stores.js'
import type { LocalTickResult } from './local-tick'
import { DEFAULT_TICK_TIME, claimLocalDay, crossed, localDayOf, pollOnce, startLocalScheduler, tickInstantOn, tickTimeOf, tickTimeWords } from './scheduler'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-scheduler-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const ledgers = () => ledgerStores(dir, { COLLECTOR_TOPOLOGY: 'single-process' } as unknown as NodeJS.ProcessEnv)
/** A LOCAL time, so the test means the same thing on any machine's clock. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute, 0, 0)
const ran: LocalTickResult = { ok: true, report: { day: '2026-09-20', at: 'x', trigger: 'schedule', mode: 'live', capUsd: 1, spentUsd: 0, domains: [] } }

describe('the tick time', () => {
  it('is 06:15 by default, reads HH:MM or H, and a typo keeps the default rather than moving the day’s spend', () => {
    expect(tickTimeOf(undefined)).toEqual(DEFAULT_TICK_TIME)
    expect(tickTimeWords(DEFAULT_TICK_TIME)).toBe('06:15')
    expect(tickTimeOf('07:30')).toEqual({ hour: 7, minute: 30 })
    expect(tickTimeOf('9')).toEqual({ hour: 9, minute: 0 })
    for (const bad of ['', 'dawn', '25:00', '06:75', '6.15', '-1', '06:15:00']) expect(tickTimeOf(bad), bad).toEqual(DEFAULT_TICK_TIME)
  })
})

describe('the crossing', () => {
  const at = DEFAULT_TICK_TIME
  it('a START is never a crossing: opening the app after the hour does not start a spend', () => {
    expect(crossed(null, local(20, 9), at)).toBe(false)
    expect(crossed(null, local(20, 6, 15), at)).toBe(false)
  })

  it('fires when the clock passes the time while the process is alive, including a laptop that slept through it, and at no other poll', () => {
    expect(crossed(local(20, 6, 14), local(20, 6, 15), at)).toBe(true)
    expect(crossed(local(19, 23), local(20, 8), at)).toBe(true) // asleep at 06:15, awake at 08:00
    expect(crossed(local(20, 6, 15), local(20, 6, 16), at)).toBe(false) // already past it at the previous poll
    expect(crossed(local(20, 5), local(20, 6, 14), at)).toBe(false)
    expect(crossed(local(20, 7), local(20, 23), at)).toBe(false)
    expect(tickInstantOn(local(20, 23), at)).toEqual(local(20, 6, 15))
  })
})

describe('once per local day, and never twice', () => {
  it('FIRES ONCE A DAY OVER THREE DAYS OF POLLS, never on start, never twice in a day', async () => {
    let now = local(20, 5)
    let runs = 0
    const state = { previous: null as Date | null, running: false }
    const deps = { now: () => now, env: () => ({}), ledgers: async () => ledgers(), run: async () => (runs++, ran), log: () => {} }
    const fired: string[] = []
    // A poll every half hour from 05:00 on the 20th to 05:00 on the 23rd.
    for (let i = 0; i <= 3 * 48; i++) {
      now = new Date(local(20, 5).getTime() + i * 30 * 60_000)
      if ((await pollOnce(state, deps)) === 'ran') fired.push(`${localDayOf(now)} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`)
    }
    expect(fired).toEqual(['2026-09-20 6:30', '2026-09-21 6:30', '2026-09-22 6:30'])
    expect(runs).toBe(3)
  })

  it('TWO SCHEDULERS OVER ONE STORE RUN THE DAY ONCE: the day is claimed under the document’s lock before the tick', async () => {
    let runs = 0
    const make = () => ({ state: { previous: local(20, 6) as Date | null, running: false }, deps: { now: () => local(20, 6, 20), env: () => ({}), ledgers: async () => ledgers(), run: async () => (runs++, ran), log: () => {} } })
    const a = make()
    const b = make()
    expect([await pollOnce(a.state, a.deps), await pollOnce(b.state, b.deps)]).toEqual(['ran', 'claimed-elsewhere'])
    expect(runs).toBe(1)
    // The claim itself: once per day, and a new day is a new claim.
    expect(await claimLocalDay(ledgers(), '2026-09-20')).toBe(false)
    expect(await claimLocalDay(ledgers(), '2026-09-21')).toBe(true)
    expect(await claimLocalDay(ledgers(), '2026-09-21')).toBe(false)
  })

  it('a restart after the hour does not run again, and does not run at all: the first poll of a process only records the time', async () => {
    let runs = 0
    const deps = { now: () => local(20, 9), env: () => ({}), ledgers: async () => ledgers(), run: async () => (runs++, ran), log: () => {} }
    expect(await pollOnce({ previous: null, running: false }, deps)).toBe('idle')
    expect(await pollOnce({ previous: null, running: false }, deps)).toBe('idle')
    expect(runs).toBe(0)
  })

  it('off the owner’s machine nothing is scheduled: no ledgers, no run', async () => {
    let runs = 0
    expect(await pollOnce({ previous: local(20, 6), running: false }, { now: () => local(20, 6, 20), env: () => ({}), ledgers: async () => null, run: async () => (runs++, ran), log: () => {} })).toBe('not-local')
    expect(runs).toBe(0)
  })

  it('a poll that lands while a run is still going does not start a second one', async () => {
    const state = { previous: local(20, 6) as Date | null, running: true }
    expect(await pollOnce(state, { now: () => local(20, 6, 20), env: () => ({}), ledgers: async () => ledgers(), run: async () => ran, log: () => {} })).toBe('busy')
  })

  it('GRADER_TICK_HOUR moves the time, read at every poll', async () => {
    let runs = 0
    const state = { previous: local(20, 7) as Date | null, running: false }
    expect(await pollOnce(state, { now: () => local(20, 7, 45), env: () => ({ GRADER_TICK_HOUR: '07:30' }), ledgers: async () => ledgers(), run: async () => (runs++, ran), log: () => {} })).toBe('ran')
    expect(runs).toBe(1)
  })
})

describe('the timer', () => {
  it('polls on an interval under a fake clock, fires once as the clock passes the time, and a second start replaces the first rather than doubling it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(local(20, 6, 0))
    let runs = 0
    const deps = { env: () => ({}), ledgers: async () => ledgers(), run: async () => (runs++, ran), log: () => {}, pollMs: 60_000 }
    startLocalScheduler(deps)
    const stop = startLocalScheduler(deps) // a dev server re-evaluating the module
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(runs).toBe(0) // 06:10
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(runs).toBe(1) // crossed 06:15 once, with one timer
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
    expect(runs).toBe(1)
    stop()
  })
})
