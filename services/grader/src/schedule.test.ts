import { describe, expect, it } from 'vitest'
import { cronRefusal, DEFAULT_TICK_CRON, parseScheduleArgs, runSchedule, scheduleSpec, TICK_RETRIES, TICK_SCHEDULE_ID, TICK_TIMEOUT_SEC } from './schedule.js'

/**
 * THE ONE SCHEDULE, WITHOUT QSTASH (ADR-0018 D8). The spec is a pure function
 * of the environment; every action that talks to QStash goes through an
 * injected fetch that records what would have been sent and answers as the
 * documented API does. Nothing here holds a token or opens a socket, and the
 * cases below prove that the default action calls nothing at all.
 */
const ENV = { SITE_URL: 'https://bliprank.test' }

const fakeQStash = () => {
  const seen: { url: string; method: string; headers: Record<string, string>; body: string }[] = []
  const f: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: String(init?.method ?? 'GET'), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') })
    if (String(input).endsWith('/v2/schedules')) return new Response(JSON.stringify([{ scheduleId: TICK_SCHEDULE_ID, cron: DEFAULT_TICK_CRON, destination: 'https://bliprank.test/api/tick', isPaused: true, nextScheduleTime: Date.UTC(2026, 8, 16, 6, 15) }]), { status: 200 })
    return new Response(JSON.stringify({ scheduleId: TICK_SCHEDULE_ID }), { status: 200 })
  }
  return { f, seen }
}

describe('the schedule spec is the environment, and nothing else', () => {
  it('names the destination from SITE_URL, the default cron, the fixed id, the fan-out body, the retries and the timeout', () => {
    expect(scheduleSpec(ENV)).toEqual({ destination: 'https://bliprank.test/api/tick', cron: '15 6 * * *', scheduleId: 'bliprank-daily-tick', body: { v: 1, kind: 'fan-out' }, retries: TICK_RETRIES, timeoutSec: TICK_TIMEOUT_SEC })
    expect(TICK_TIMEOUT_SEC).toBe(300)
    // The origin only: a path or query on SITE_URL does not smuggle itself into the destination.
    expect(scheduleSpec({ SITE_URL: 'https://bliprank.test/somewhere?x=1' })).toMatchObject({ destination: 'https://bliprank.test/api/tick' })
    expect(scheduleSpec({ SITE_URL: 'https://bliprank.test', GRADER_TICK_CRON: '0 5 * * *' })).toMatchObject({ cron: '0 5 * * *' })
  })

  it('refuses without SITE_URL, a SITE_URL that is not an absolute http(s) URL, a cron that is not five plain fields, and any CRON_TZ prefix (the day is UTC)', () => {
    expect(scheduleSpec({})).toMatchObject({ refuse: expect.stringContaining('SITE_URL is not set') })
    expect(scheduleSpec({ SITE_URL: 'bliprank.test' })).toMatchObject({ refuse: expect.stringContaining('not an absolute http(s) URL') })
    expect(scheduleSpec({ SITE_URL: 'ftp://bliprank.test' })).toMatchObject({ refuse: expect.stringContaining('not an absolute http(s) URL') })
    expect(scheduleSpec({ ...ENV, GRADER_TICK_CRON: '15 6 * *' })).toMatchObject({ refuse: expect.stringContaining('five fields') })
    expect(scheduleSpec({ ...ENV, GRADER_TICK_CRON: 'CRON_TZ=Asia/Kolkata 15 6 * * *' })).toMatchObject({ refuse: expect.stringContaining('must be UTC') })
    expect(cronRefusal('*/5 * * * *')).toBeNull()
    expect(cronRefusal('15 6 * * MON')).toMatch(/five fields/)
  })

  it('parses one action, refuses two or an unknown flag, and defaults to print', () => {
    expect(parseScheduleArgs([])).toEqual({ action: 'print' })
    expect(parseScheduleArgs(['--register'])).toEqual({ action: 'register' })
    expect(parseScheduleArgs(['--pause'])).toEqual({ action: 'pause' })
    expect(parseScheduleArgs(['--register', '--remove'])).toMatchObject({ refuse: expect.stringContaining('one action at a time') })
    expect(parseScheduleArgs(['--arm'])).toMatchObject({ refuse: expect.stringContaining('unknown flag') })
  })
})

describe('the actions, against a recorded QStash', () => {
  it('print calls nothing and says how to register and that registering does not arm', async () => {
    const { f, seen } = fakeQStash()
    const out = await runSchedule('print', ENV, { fetch: f })
    if ('refuse' in out) throw new Error(out.refuse)
    expect(seen).toEqual([])
    expect(out.lines.join('\n')).toContain('Nothing was registered')
    expect(out.lines.join('\n')).toContain('GRADER_DAILY_LOOP=armed')
  })

  it('every action but print refuses without QSTASH_TOKEN in the environment, and calls nothing', async () => {
    const { f, seen } = fakeQStash()
    for (const action of ['register', 'list', 'pause', 'resume', 'remove'] as const) {
      expect(await runSchedule(action, ENV, { fetch: f })).toMatchObject({ refuse: expect.stringContaining('QSTASH_TOKEN is not set') })
    }
    expect(seen).toEqual([])
  })

  it('register sends the documented request once: the destination in the path, the cron, the fixed schedule id, the retries, the timeout and the fan-out body, with the token as the bearer', async () => {
    const { f, seen } = fakeQStash()
    const out = await runSchedule('register', { ...ENV, QSTASH_TOKEN: 'qs_tok' }, { fetch: f })
    if ('refuse' in out) throw new Error(out.refuse)
    expect(seen).toHaveLength(1)
    const req = seen[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`https://qstash.upstash.io/v2/schedules/${encodeURIComponent('https://bliprank.test/api/tick')}`)
    expect(req.headers['authorization']).toBe('Bearer qs_tok')
    expect(req.headers['upstash-cron']).toBe('15 6 * * *')
    expect(req.headers['upstash-schedule-id']).toBe('bliprank-daily-tick')
    expect(req.headers['upstash-retries']).toBe('2')
    expect(req.headers['upstash-timeout']).toBe('300s')
    expect(JSON.parse(req.body)).toEqual({ v: 1, kind: 'fan-out' })
    expect(out.lines.join('\n')).toContain('registered as bliprank-daily-tick')
    expect(out.lines.join('\n')).toContain('spends nothing until GRADER_DAILY_LOOP=armed')
  })

  it('list, pause, resume and remove hit the documented paths for the fixed id', async () => {
    const { f, seen } = fakeQStash()
    const env = { ...ENV, QSTASH_TOKEN: 'qs_tok' }
    const listed = await runSchedule('list', env, { fetch: f })
    if ('refuse' in listed) throw new Error(listed.refuse)
    expect(listed.lines[0]).toContain('bliprank-daily-tick')
    expect(listed.lines[0]).toContain('(paused)')
    expect(listed.lines[0]).toContain('next 2026-09-16T06:15:00.000Z')
    await runSchedule('pause', env, { fetch: f })
    await runSchedule('resume', env, { fetch: f })
    await runSchedule('remove', env, { fetch: f })
    expect(seen.map((r) => [r.method, r.url.replace('https://qstash.upstash.io', '')])).toEqual([
      ['GET', '/v2/schedules'],
      ['POST', '/v2/schedules/bliprank-daily-tick/pause'],
      ['POST', '/v2/schedules/bliprank-daily-tick/resume'],
      ['DELETE', '/v2/schedules/bliprank-daily-tick'],
    ])
  })
})
