/**
 * The day's checks run from the app (MVP_PLAN P1): WHETHER a run may start,
 * and that when it does it is `runTick`, under the same daily cap, with the
 * same gates. Nothing here is live: the refusals call nothing, and the armed
 * case runs the REAL tick path with the collector and the quota gate
 * injected, so no provider is ever asked.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dailyLedgerFile, readDailyLedger, type TickDeps } from '../../../services/grader/src/daily-loop.js'
import { setTracked } from '../../../services/grader/src/due.js'
import { recordCategory } from '../../../services/grader/src/resolve-category.js'
import { readTickReports } from '../../../services/grader/src/tick-outcomes.js'
import { ledgerStores } from '../../../services/grader/src/ledger-stores.js'
import { fileWorkspaceStore } from '../../../services/grader/src/store/file-store.js'
import { NOBODY_TRACKED, NOT_LIVE, NOT_LOCAL, NO_CAP, SWITCHED_OFF, localArming, localEnv, runLocalTick, type Env } from './local-tick'
import type { WorkspaceAccess } from './workspace-access'

let dir: string
const NOW = new Date('2026-09-20T06:15:00.000Z')
const DAY = '2026-09-20'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-local-tick-'))
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** This machine, identity off: the file store over the scratch directory. */
const machine = async (env: Env): Promise<WorkspaceAccess> => ({ ok: true, backend: 'file', store: fileWorkspaceStore(dir), ledgers: ledgerStores(dir, { ...env, COLLECTOR_TOPOLOGY: 'single-process' } as unknown as NodeJS.ProcessEnv), dataDir: dir, who: 'local', role: 'local', workspaceId: 'local' })
/** Everything `liveGates` asks for besides the owner's two acts. `root` is the scratch directory, so this machine's real dotenv is never read. */
const REST = { COLLECTOR_TOPOLOGY: 'single-process', COLLECTION_ENABLED: 'true', OPENWEBNINJA_API_KEY: 'not-a-real-key', OPENWEBNINJA_PLAN: 'payg' }
const TWO_ACTS = { COLLECTION_BUDGET_USD_DAILY: '2', GRADER_LIVE_SCAN: 'true' }
const mustNotCollect: TickDeps = { collect: async () => Promise.reject(new Error('must not be called')), gate: async () => Promise.reject(new Error('must not be called')) }
const track = () => setTracked(dir, 'acme.test', true, { by: 'local', reason: 'r', at: '2026-09-19T00:00:00.000Z', until: '2026-09-25' })

const scanned = (host: string, day: string, spentUsd: number, calls: number) =>
  ({
    status: 'scanned',
    domain: host,
    category: 'crm-software',
    categoryName: 'CRM',
    classification: { status: 'classified', slug: 'crm-software', evidence: 'x' },
    subjectSource: 'domain-label',
    comparisonBasis: 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=17|runs=1',
    algoVersion: 'det-3',
    collectedAt: `${day}T06:16:00.000Z`,
    counts: { cellsRequested: calls, cacheHits: 0, collected: calls, failed: 0, answersScored: calls, providerCalls: calls },
    brands: [],
    promptRows: [],
    run: { spentUsd, day },
  }) as never

describe('arming on the machine is the owner’s two acts and a tracked domain', () => {
  it('the decision, pure, in the order a person fixes them: the cap, the live flag, a tracked domain; an explicit other value of the loop variable is the off switch', () => {
    expect(localArming({}, 1)).toMatchObject({ armed: false, kind: 'no-cap', message: NO_CAP })
    expect(localArming({ COLLECTION_BUDGET_USD_DAILY: 'lots' }, 1)).toMatchObject({ armed: false, kind: 'no-cap' })
    expect(localArming({ COLLECTION_BUDGET_USD_DAILY: '0' }, 1)).toMatchObject({ armed: false, kind: 'no-cap' })
    expect(localArming({ COLLECTION_BUDGET_USD_DAILY: '2' }, 1)).toMatchObject({ armed: false, kind: 'not-live', message: NOT_LIVE })
    expect(localArming({ COLLECTION_BUDGET_USD_DAILY: '2', GRADER_LIVE_SCAN: 'yes' }, 1)).toMatchObject({ armed: false, kind: 'not-live' })
    expect(localArming(TWO_ACTS, 0)).toMatchObject({ armed: false, kind: 'nobody-tracked', message: NOBODY_TRACKED })
    expect(localArming({ ...TWO_ACTS, GRADER_DAILY_LOOP: 'off' }, 1)).toMatchObject({ armed: false, kind: 'switched-off', message: SWITCHED_OFF })
    expect(localArming({ ...TWO_ACTS, GRADER_DAILY_LOOP: 'fixture' }, 1)).toMatchObject({ armed: false, kind: 'switched-off' })
    const armed = localArming(TWO_ACTS, 1)
    expect(armed).toMatchObject({ armed: true })
    // The ONE thing this path supplies, and only when every condition above held.
    if (armed.armed) expect(armed.env['GRADER_DAILY_LOOP']).toBe('armed')
    for (const s of [NO_CAP, NOT_LIVE, NOBODY_TRACKED, SWITCHED_OFF]) expect(s).toContain('Nothing was collected and nothing was spent.')
  })

  it('the two acts are read from the dotenv at the top of the project, the environment first, as the scan route reads its flags', () => {
    writeFileSync(join(dir, '.env.local'), 'COLLECTION_BUDGET_USD_DAILY=3\nGRADER_LIVE_SCAN=true\nOPENWEBNINJA_PLAN=payg\nGRADER_TICK_HOUR=07:30\nUNRELATED_SECRET=x\n')
    const env = localEnv({}, dir)
    expect(env).toMatchObject({ COLLECTION_BUDGET_USD_DAILY: '3', GRADER_LIVE_SCAN: 'true', OPENWEBNINJA_PLAN: 'payg', GRADER_TICK_HOUR: '07:30' })
    // An allow-list, not a loader: nothing else in the file is taken.
    expect(env['UNRELATED_SECRET']).toBeUndefined()
    expect(localEnv({ COLLECTION_BUDGET_USD_DAILY: '1' }, dir)['COLLECTION_BUDGET_USD_DAILY']).toBe('1')
  })
})

describe('REFUSED WITH A FIXED SENTENCE, AND NOTHING IS SPENT: without the cap, without the flag, without a tracked domain', () => {
  const press = (env: Env) => runLocalTick('button', { env: { ...REST, ...env }, root: dir, now: () => NOW, access: machine, tickDeps: mustNotCollect, log: () => {} })
  const nothingHappened = async () => {
    expect(existsSync(dailyLedgerFile(dir))).toBe(false)
    expect(existsSync(join(dir, 'ledger.json'))).toBe(false)
    expect(await readTickReports(ledgerStores(dir, { COLLECTOR_TOPOLOGY: 'single-process' } as unknown as NodeJS.ProcessEnv))).toEqual([])
  }

  it('without the cap', async () => {
    track()
    expect(await press({ GRADER_LIVE_SCAN: 'true' })).toEqual({ ok: false, status: 409, kind: 'no-cap', message: NO_CAP })
    await nothingHappened()
  })

  it('without the live flag', async () => {
    track()
    expect(await press({ COLLECTION_BUDGET_USD_DAILY: '2' })).toEqual({ ok: false, status: 409, kind: 'not-live', message: NOT_LIVE })
    await nothingHappened()
  })

  it('without a tracked domain, and with one whose days have ended', async () => {
    expect(await press(TWO_ACTS)).toEqual({ ok: false, status: 409, kind: 'nobody-tracked', message: NOBODY_TRACKED })
    setTracked(dir, 'acme.test', true, { by: 'local', reason: 'r', at: '2026-09-01T00:00:00.000Z', until: '2026-09-10' })
    expect(await press(TWO_ACTS)).toEqual({ ok: false, status: 409, kind: 'nobody-tracked', message: NOBODY_TRACKED })
    await nothingHappened()
  })

  it('off the owner’s machine the path does not exist: identity on, a fleet, or no store', async () => {
    track()
    const postgres = async (): Promise<WorkspaceAccess> => ({ ...(await machine({})), backend: 'postgres' }) as WorkspaceAccess
    const none = async (): Promise<WorkspaceAccess> => ({ ok: false, status: 503, message: 'no store' })
    for (const access of [postgres, none]) expect(await runLocalTick('button', { env: { ...REST, ...TWO_ACTS }, root: dir, now: () => NOW, access, tickDeps: mustNotCollect, log: () => {} })).toEqual({ ok: false, status: 404, kind: 'not-local', message: NOT_LOCAL })
    await nothingHappened()
  })

  it('every OTHER gate of a live tick still stands and is said as the loop says it: the master flag, the key, the plan', async () => {
    track()
    const armedBut = (env: Env) => runLocalTick('schedule', { env: { COLLECTOR_TOPOLOGY: 'single-process', ...TWO_ACTS, ...env }, root: dir, now: () => NOW, access: machine, tickDeps: mustNotCollect, log: () => {} })
    const refusal = async (env: Env) => {
      const r = await armedBut(env)
      return r.ok ? r.report.refused : r.message
    }
    expect(await refusal({})).toContain('live collection is off')
    expect(await refusal({ COLLECTION_ENABLED: 'true' })).toContain('no provider key')
    expect(await refusal({ COLLECTION_ENABLED: 'true', OPENWEBNINJA_API_KEY: 'k' })).toContain('OPENWEBNINJA_PLAN')
    // Nothing was reserved or spent by any of them; each refusal IS recorded, because the owner armed the loop and it did not run.
    expect(await readDailyLedger(dir)).toEqual({})
    const reports = await readTickReports(ledgerStores(dir, { COLLECTOR_TOPOLOGY: 'single-process' } as unknown as NodeJS.ProcessEnv))
    expect(reports.map((r) => [r.trigger, r.domains.map((d) => d.kind)])).toEqual([
      ['schedule', ['refused']],
      ['schedule', ['refused']],
      ['schedule', ['refused']],
    ])
  })
})

describe('armed: the SAME tick path and the SAME daily cap', () => {
  it('runs runTick live with the collector injected: the host is reserved against the day’s cap, collected once, settled, and reported; a second press the same day collects nothing', async () => {
    track()
    const collected: string[] = []
    const tickDeps: TickDeps = {
      gate: async () => ({ ok: true, quota: [] }) as never,
      collect: async (d, o) => {
        collected.push(`${d.host} ${o.day} ${o.mode} allowance=${o.allowanceCalls}`)
        const r = scanned(d.host, o.day, 0.4, 85)
        await fileWorkspaceStore(dir).cycles.put({ host: d.host, day: o.day, algoVersion: 'det-3', comparisonBasis: (r as { comparisonBasis: string }).comparisonBasis, result: r as Record<string, unknown>, source: 'loop' })
        return r
      },
    }
    const press = () => runLocalTick('button', { env: { ...REST, ...TWO_ACTS }, root: dir, now: () => NOW, access: machine, tickDeps, log: () => {} })

    const first = await press()
    if (!first.ok) throw new Error(first.message)
    expect(collected).toHaveLength(1)
    expect(collected[0]).toMatch(/^acme\.test 2026-09-20 live allowance=\d+$/)
    expect(first.report).toMatchObject({ day: DAY, trigger: 'button', mode: 'live', domains: [{ host: 'acme.test', kind: 'collected', calls: 85, spentUsd: 0.4 }] })
    // THE SAME DAILY CAP: min(the formula over the tracked set, the owner's hard ceiling), booked in the same ledger the operator's command books.
    const day = (await readDailyLedger(dir))[DAY]!
    expect(first.report.capUsd).toBe(day.capUsd)
    expect(day.capUsd).toBeGreaterThan(0)
    expect(day.capUsd).toBeLessThanOrEqual(2)
    expect(day).toMatchObject({ spentUsd: 0.4, calls: 85, domains: { 'acme.test': { status: 'scanned', spentUsd: 0.4 } } })

    // One cycle a day: the second press finds the host not due and asks nobody.
    const second = await press()
    if (!second.ok) throw new Error(second.message)
    expect(collected).toHaveLength(1)
    expect(second.report.domains).toEqual([{ host: 'acme.test', kind: 'not-due', reason: 'cycle-today', detail: expect.stringContaining(DAY) }])
    expect((await readDailyLedger(dir))[DAY]!.spentUsd).toBe(0.4)
    // Both runs are on the record for the morning after (P2).
    expect((await readTickReports(ledgerStores(dir, { COLLECTOR_TOPOLOGY: 'single-process' } as unknown as NodeJS.ProcessEnv))).map((r) => r.trigger)).toEqual(['button', 'button'])
  })

  it('a hard ceiling below one cycle’s expected cost refuses the host at the cap, as the operator’s command would, and says so', async () => {
    track()
    const r = await runLocalTick('schedule', { env: { ...REST, ...TWO_ACTS, COLLECTION_BUDGET_USD_DAILY: '0.01' }, root: dir, now: () => NOW, access: machine, tickDeps: mustNotCollect, log: () => {} })
    if (!r.ok) throw new Error(r.message)
    expect(r.report.capUsd).toBe(0.01)
    expect(r.report.domains).toEqual([{ host: 'acme.test', kind: 'refused', reason: expect.any(String) }])
    expect((await readDailyLedger(dir))[DAY]?.spentUsd ?? 0).toBe(0)
  })

  it('the corrupt-ledger refusal is fail-closed and said in one line, not thrown at the button', async () => {
    track()
    writeFileSync(dailyLedgerFile(dir), '{ not json')
    const r = await runLocalTick('button', { env: { ...REST, ...TWO_ACTS }, root: dir, now: () => NOW, access: machine, tickDeps: mustNotCollect, log: () => {} })
    if (!r.ok) throw new Error(r.message)
    expect(r.report.refused).toContain('could not be read or written')
    expect(readFileSync(dailyLedgerFile(dir), 'utf8')).toBe('{ not json')
  })
})
