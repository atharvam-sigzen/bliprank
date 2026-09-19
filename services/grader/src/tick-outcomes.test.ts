/**
 * What the loop did, kept where a person can read it (MVP_PLAN P2). The report
 * restates a tick's result and decides nothing; the document gates nothing.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TickOutcome } from './daily-loop.js'
import type { DueList } from './due.js'
import { ledgerStores } from './ledger-stores.js'
import { TICK_OUTCOMES, TICK_OUTCOME_DAYS, readTickReports, recordTickReport, reportOf, type TickReport } from './tick-outcomes.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-tick-outcomes-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const ledgers = () => ledgerStores(dir, { COLLECTOR_TOPOLOGY: 'single-process' })

const due = (host: string) => ({ host, workspaceId: 'local', category: 'crm-software', curatedPrompts: 17, customPrompts: 0, promptSet: null, cells: 85, usd: 0.5 })
const list = (over: Partial<DueList>): DueList => ({ day: '2026-09-19', plan: 'payg', due: [], notDue: [], cells: 0, usd: 0, tracked: [], ...over }) as DueList
const AT = '2026-09-19T00:45:00.000Z'

describe('the report restates the tick', () => {
  it('collected, ran without a result, refused and not due, each as the loop returned it', () => {
    const outcome: TickOutcome = {
      day: '2026-09-19',
      mode: 'live',
      capUsd: 1.5,
      spentBefore: 0,
      spentAfter: 0.92,
      ran: [
        { host: 'a.test', status: 'scanned', spentUsd: 0.52, calls: 85 },
        { host: 'b.test', status: 'no-answers', spentUsd: 0.4, calls: 85 },
        { host: 'u.test', status: 'scanned', spentUsd: 0.5, calls: 85, unsettled: 'the ledger refused the write' },
      ],
      refused: [{ host: 'c.test', reason: 'the day’s cap has $0.080 left' }],
      list: list({ notDue: [{ host: 'd.test', workspaceId: 'local', reason: 'expired', detail: 'tracked until 2026-09-18' }] }),
    }
    expect(reportOf(outcome, 'schedule', 'live', AT, '2026-09-19')).toEqual({
      day: '2026-09-19',
      at: AT,
      trigger: 'schedule',
      mode: 'live',
      capUsd: 1.5,
      spentUsd: 0.92,
      domains: [
        { host: 'a.test', kind: 'collected', calls: 85, spentUsd: 0.52 },
        { host: 'b.test', kind: 'ran-without-result', status: 'no-answers', calls: 85, spentUsd: 0.4 },
        { host: 'u.test', kind: 'collected', calls: 85, spentUsd: 0.5, unsettled: 'the ledger refused the write' },
        { host: 'c.test', kind: 'refused', reason: 'the day’s cap has $0.080 left' },
        { host: 'd.test', kind: 'not-due', reason: 'expired', detail: 'tracked until 2026-09-18' },
      ],
    })
  })

  it('a tick refused whole lists every DUE domain as refused for that reason, so no due domain is ever without a line', () => {
    const r = reportOf({ refuse: 'no provider key is configured', list: list({ due: [due('a.test'), due('b.test')] as never, notDue: [{ host: 'c.test', workspaceId: 'local', reason: 'cycle-today', detail: 'x' }] }) }, 'button', 'live', AT, '2026-09-19')
    expect(r).toMatchObject({ refused: 'no provider key is configured', capUsd: 0, spentUsd: 0 })
    expect(r.domains.map((d) => [d.host, d.kind])).toEqual([
      ['a.test', 'refused'],
      ['b.test', 'refused'],
      ['c.test', 'not-due'],
    ])
    expect(reportOf({ refuse: 'a ledger fault' }, 'cli', 'fixture', AT, '2026-09-19').domains).toEqual([])
  })
})

describe('the document', () => {
  const r = (day: string, trigger: TickReport['trigger'] = 'schedule'): TickReport => ({ day, at: `${day}T00:45:00.000Z`, trigger, mode: 'live', capUsd: 1, spentUsd: 0, domains: [] })

  it('keeps every run of a day, in order, and drops days older than the window', async () => {
    await recordTickReport(ledgers(), r('2026-09-01'))
    await recordTickReport(ledgers(), r('2026-09-19'))
    await recordTickReport(ledgers(), r('2026-09-19', 'button'))
    await recordTickReport(ledgers(), r('2026-09-20'))
    const kept = await readTickReports(ledgers())
    expect(kept.map((x) => [x.day, x.trigger])).toEqual([
      ['2026-09-19', 'schedule'],
      ['2026-09-19', 'button'],
      ['2026-09-20', 'schedule'],
    ])
    expect(TICK_OUTCOME_DAYS).toBe(14)
  })

  it('GATES NOTHING: missing is no reports, corrupt is no reports and is replaced by the next write, and a malformed entry is dropped, never trusted', async () => {
    expect(await readTickReports(ledgers())).toEqual([])
    writeFileSync(join(dir, TICK_OUTCOMES), '{ not json')
    expect(await readTickReports(ledgers())).toEqual([])
    await recordTickReport(ledgers(), r('2026-09-19'))
    expect(await readTickReports(ledgers())).toHaveLength(1)
    writeFileSync(join(dir, TICK_OUTCOMES), JSON.stringify([r('2026-09-19'), { day: 'yesterday' }, { ...r('2026-09-19'), domains: [{ host: 1 }] }, 'x']))
    expect(await readTickReports(ledgers())).toHaveLength(1)
    // It is its own file: the spend ledger is not touched by it.
    expect(() => readFileSync(join(dir, 'daily-spend.json'), 'utf8')).toThrow()
  })
})
