/**
 * THE LOOP TELLS THE OWNER WHAT IT DID (MVP_PLAN P2), rendered: every state of
 * the panel over a fixture of the machine's own outcome document, at SIMPLE
 * depth. And P1's button: offered when a run may start, replaced by the
 * server's fixed sentence when it may not.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { dayViewOf, outcomeWords, triggersWords, type DailyChecksStatus, type TickReport } from '../lib/daily-checks'
import { NOT_LIVE } from '../lib/local-tick'
import { sentence, simpleView } from '../lib/simple-view'
import { DailyChecksView } from './daily-checks'

const YESTERDAY = '2026-09-19'
const TODAY = '2026-09-20'
const report = (over: Partial<TickReport>): TickReport => ({ day: YESTERDAY, at: `${YESTERDAY}T00:45:00.000Z`, trigger: 'schedule', mode: 'live', capUsd: 1.5, spentUsd: 0.52, domains: [], ...over })

/** One of each outcome the loop can record for a tracked domain. */
const EVERY_STATE = report({
  domains: [
    { host: 'collected.test', kind: 'collected', calls: 85, spentUsd: 0.52 },
    { host: 'empty.test', kind: 'ran-without-result', status: 'no-answers', calls: 85, spentUsd: 0.5 },
    { host: 'refused.test', kind: 'refused', reason: 'the day’s cap of $1.500 has $0.100 left, less than this cycle’s $0.612' },
    { host: 'notdue.test', kind: 'not-due', reason: 'cycle-today', detail: `a cycle for ${YESTERDAY} is already stored` },
    { host: 'ended.test', kind: 'not-due', reason: 'expired', detail: 'tracked until 2026-09-18; the daily re-check has ended, switch it on again to continue' },
  ],
})

const status = (over: Partial<DailyChecksStatus>): DailyChecksStatus => ({
  local: true,
  tickAt: '06:15',
  armed: true,
  tracked: ['collected.test', 'empty.test', 'refused.test'],
  todayDay: TODAY,
  yesterdayDay: YESTERDAY,
  today: null,
  yesterday: dayViewOf(YESTERDAY, [EVERY_STATE]),
  missedToday: false,
  failedPublishes: [],
  ...over,
})
const render = (s: DailyChecksStatus, refusal: string | null = null) => renderToStaticMarkup(<DailyChecksView status={s} busy={false} refusal={refusal} onRun={() => {}} />)

describe('yesterday, per tracked domain, at simple depth', () => {
  it('collected, ran without a result, refused and why, not due, and ended: each in a sentence, none of them hidden as detail', () => {
    const html = render(status({}))
    const simple = simpleView(html)
    expect(simple).toContain('data-daily-checks')
    const text = sentence(simple)
    expect(text).toMatch(/Yesterday.{1,6}s checks \(\s*2026-09-19\s*\), run on schedule:/)
    expect(text).toContain('Yesterday')
    expect(text).toContain('collected.test: checked, and the day’s answers were collected (85 requests, $0.520)')
    expect(text).toContain('empty.test: checked, but nothing could be measured that day (the run ended as')
    expect(text).toContain('no-answers')
    expect(text).toContain('; 85 requests, $0.500)')
    expect(text).toContain('refused.test: not checked: the day’s cap of $1.500 has $0.100 left')
    expect(text).toContain('notdue.test: already checked that day, so it was not checked again')
    expect(text).toContain('ended.test: its daily checks have ended (tracked until 2026-09-18')
    for (const kind of ['collected', 'ran-without-result', 'refused', 'not-due']) expect(simple).toContain(`data-outcome="${kind}"`)
  })

  it('a run that was refused whole says so, with the loop’s own reason, and every due domain is listed as not checked', () => {
    const refused = report({ refused: 'no provider key is configured, so a live tick cannot run', capUsd: 0, spentUsd: 0, domains: [{ host: 'collected.test', kind: 'refused', reason: 'no provider key is configured, so a live tick cannot run' }] })
    const text = sentence(render(status({ yesterday: dayViewOf(YESTERDAY, [refused]) })))
    expect(text).toContain('the run did not start.')
    expect(text).toContain('no provider key is configured')
    expect(text).toContain('collected.test: not checked: no provider key is configured')
  })

  it('no run yesterday is said when something is tracked, and nothing is said when nothing is', () => {
    expect(sentence(render(status({ yesterday: null })))).toMatch(/Yesterday.{1,6}s checks: no check ran\./)
    expect(render(status({ yesterday: null, tracked: [], armed: false, notArmed: 'x' }))).not.toContain('data-day-report')
  })

  it('what was ACHIEVED in a day wins over a later, emptier run: collected at 06:15 stays collected after a press at noon finds it not due', () => {
    const morning = report({ domains: [{ host: 'collected.test', kind: 'collected', calls: 85, spentUsd: 0.52 }] })
    const noon = report({ at: `${YESTERDAY}T06:30:00.000Z`, trigger: 'button', domains: [{ host: 'collected.test', kind: 'not-due', reason: 'cycle-today', detail: 'x' }] })
    const view = dayViewOf(YESTERDAY, [noon, morning])!
    expect(view.domains).toEqual([{ host: 'collected.test', kind: 'collected', calls: 85, spentUsd: 0.52 }])
    expect(triggersWords(view.triggers)).toBe('on schedule and from this page')
    // A day refused in the morning and run from the page later is NOT a refused day.
    expect(dayViewOf(YESTERDAY, [report({ refused: 'x' }), noon])!.refused).toBeUndefined()
    expect(dayViewOf('2026-01-01', [morning])).toBeNull()
  })
})

describe('this morning, and the button (P1)', () => {
  it('A TICK THAT DID NOT RUN BY ITS HOUR IS SAID ON OPENING, and the button is offered to run it', () => {
    const html = render(status({ missedToday: true }))
    expect(html).toContain('data-missed')
    expect(sentence(html)).toContain('s 06:15 check has not run: this app was not open at that time, and opening it later does not start a check by itself.')
    expect(html).toContain('data-run-now')
    expect(html).toContain('Run today’s checks now')
  })

  it('armed: says when the checks run and under what; not armed: the server’s fixed sentence stands where the button would, because a button that can only refuse explains less', () => {
    const armed = sentence(render(status({})))
    expect(armed).toContain('3 domains are re-checked daily on this machine: collected.test, empty.test, refused.test.')
    expect(armed).toMatch(/s checks run at 06:15 by this machine.{1,6}s clock, once, under the daily spending limit/)
    const off = render(status({ armed: false, notArmed: NOT_LIVE }))
    expect(off).toContain('data-not-armed')
    expect(sentence(off)).toContain('live collection is switched off on this machine')
    expect(sentence(off)).toContain('Nothing was collected and nothing was spent.')
    expect(off).not.toContain('data-run-now')
  })

  it('a refused press shows the server’s sentence; failed publishes are shown only when there are any', () => {
    expect(render(status({}), 'Today’s checks did not run: x')).toContain('data-run-refused')
    expect(render(status({}))).not.toContain('data-failed-publishes')
    const failed = sentence(render(status({ failedPublishes: [{ day: YESTERDAY, failed: 2 }] })))
    expect(failed).toContain('2 scheduled checks could not be queued, so they were never started. Nothing was spent on them.')
  })

  it('off the owner’s machine the panel is nothing at all', () => {
    expect(render(status({ local: false }))).toBe('')
  })

  it('an outcome this build does not know a sentence for is still said, never dropped', () => {
    expect(outcomeWords({ host: 'x.test', kind: 'not-due', reason: 'something-new', detail: 'a reason a later loop added' })).toBe('not checked: a reason a later loop added')
  })
})
