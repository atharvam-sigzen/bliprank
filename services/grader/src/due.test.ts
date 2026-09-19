import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGINES } from '@bliprank/contracts'
import { applyCustomPrompts } from './custom-prompts.js'
import { writeCycle } from './cycles.js'
import { MemoryKV } from '@bliprank/collector'
import { decideDueIn, dueToday, dueTodayIn, readTracked, readTrackedIn, setTracked, workspaceOf } from './due.js'
import { kvLedgerStores, ledgerStores } from './ledger-stores.js'
import { fileWorkspaceStore } from './store/file-store.js'
import { recordCategory } from './resolve-category.js'

/**
 * The due list (ADR-0017): what a daily tick WOULD collect, decided with the
 * same refusals a person's click meets. Synthetic store; nothing spends.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-due-'))
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
  recordCategory(dir, { host: 'nobank.test', slug: 'vanished-category', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const cycle = (host: string, day: string, prompts = 17, engines = 'chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews') => ({
  status: 'scanned',
  domain: host,
  category: 'crm-software',
  categoryName: 'CRM',
  comparisonBasis: `grader|engines=${engines}|en-US|US|crm-software@1|unprompted=${prompts}|runs=1`,
  algoVersion: 'det-2',
  collectedAt: `${day}T10:00:00.000Z`,
  run: { mode: 'live', plan: 'payg', day, engines: engines.split(','), capUsd: 5, at: `${day}T10:01:00.000Z` },
  counts: { cellsRequested: 2, cacheHits: 0, collected: 2, failed: 0, answersScored: 2, providerCalls: 2 },
  brands: [],
})

describe('tracking is a person’s opt-in', () => {
  it('refuses a domain with no record, records who and why, and switches off cleanly', () => {
    expect(setTracked(dir, 'nobody.test', true, { by: 'operator', reason: 'customer' })).toMatchObject({ refuse: expect.stringContaining('no category on record') })
    expect(setTracked(dir, 'https://www.acme.test/', true, { by: 'operator', reason: 'paying customer', at: '2026-09-03T00:00:00.000Z' })).toEqual([{ host: 'acme.test', since: '2026-09-03T00:00:00.000Z', by: 'operator', reason: 'paying customer' }])
    expect(readTracked(dir)).toHaveLength(1)
    expect(setTracked(dir, 'acme.test', false, { by: 'operator', reason: 'churned' })).toEqual([])
  })
})

describe('the tracked file is a fact, not a guess', () => {
  it('a corrupt file throws rather than reading as nobody, and a hand-edited host is normalised', () => {
    writeFileSync(join(dir, 'tracked.json'), '{ not json')
    expect(() => readTracked(dir)).toThrow(/not readable JSON/)
    expect(() => setTracked(dir, 'acme.test', false, { by: 'operator', reason: 'churned' })).toThrow(/not readable JSON/)
    writeFileSync(join(dir, 'tracked.json'), JSON.stringify([{ host: 'WWW.Acme.test', since: '2026-09-01' }]))
    expect(readTracked(dir)).toEqual([{ host: 'acme.test', since: '2026-09-01', by: 'operator', reason: '' }])
  })

  it('an environment that cannot size a scan makes nothing due, as the route refuses', () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    const list = dueToday(dir, { GRADER_PROMPTS_PER_SCAN: '0' }, '2026-09-03')
    expect(list.due).toEqual([])
    expect(list.config).toContain('cannot size a scan')
  })
})

describe('the due list', () => {
  it('nothing tracked, nothing due; a tracked domain is due with its cells and cost, and a set of the person’s own REPLACES the bank’s (ADR-0016 Amendment 1)', () => {
    expect(dueToday(dir, {}, '2026-09-03')).toMatchObject({ due: [], notDue: [], cells: 0, usd: 0 })
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    const list = dueToday(dir, {}, '2026-09-03')
    expect(list.due).toHaveLength(1)
    expect(list.due[0]).toMatchObject({ host: 'acme.test', category: 'crm-software', curatedPrompts: 17, customPrompts: 0, cells: 17 * ENGINES.length })
    expect(list.tracked).toEqual([{ host: 'acme.test', cells: 17 * ENGINES.length, usd: list.usd }])
    expect(list.usd).toBeCloseTo((0.007 * 3 + 0.008 + 0.005) * 17, 6)
    applyCustomPrompts(dir, { host: 'acme.test', prompts: ['which crm works offline on a phone'], reason: 'the questions our buyers ask', by: 'operator' })
    // The set IS the measurement: one prompt on five engines, not the bank's seventeen plus one.
    expect(dueToday(dir, {}, '2026-09-03').due[0]).toMatchObject({ curatedPrompts: 0, customPrompts: 1, cells: 1 * ENGINES.length })
  })

  it('not due: a cycle already today, a prior cycle on another basis, a domain whose bank is gone; the manual ceiling is not consulted', () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    setTracked(dir, 'nobank.test', true, { by: 'operator', reason: 'r' })
    writeCycle(dir, cycle('acme.test', '2026-09-03') as never)
    let list = dueToday(dir, {}, '2026-09-03')
    expect(list.due).toEqual([])
    expect(list.notDue.map((n) => [n.host, n.reason])).toEqual([
      ['acme.test', 'cycle-today'],
      ['nobank.test', 'no-bank'],
    ])
    // Tomorrow it is due again; but a prior cycle at 10 prompts against today's 17 is not.
    expect(dueToday(dir, {}, '2026-09-04').due.map((d) => d.host)).toEqual(['acme.test'])
    writeCycle(dir, cycle('acme.test', '2026-09-04', 10) as never)
    list = dueToday(dir, {}, '2026-09-05')
    expect(list.notDue.find((n) => n.host === 'acme.test')).toMatchObject({ reason: 'basis-moved' })
    // Under GRADER_PROMPTS_PER_SCAN=10 the basis matches again.
    expect(dueToday(dir, { GRADER_PROMPTS_PER_SCAN: '10' }, '2026-09-05').due[0]).toMatchObject({ host: 'acme.test', curatedPrompts: 10, cells: 50 })
  })
})

describe('the tracked list as a ledger document, and the due list over a workspace store (ADR-0018 D3, D6)', () => {
  const ONE = { COLLECTOR_TOPOLOGY: 'single-process' }

  it('readTrackedIn reads the very file readTracked reads on a machine and the document on KV; entries keep their workspace and role, a bad role is dropped, a document that is not a list throws', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r', at: '2026-09-01T00:00:00.000Z' })
    const files = ledgerStores(dir, ONE)
    expect(await readTrackedIn(files)).toEqual(readTracked(dir))
    expect(workspaceOf((await readTrackedIn(files))[0]!)).toBe('local')
    const kv = kvLedgerStores(new MemoryKV())
    expect(await readTrackedIn(kv)).toEqual([])
    await kv.doc('tracked.json').update(() => [
      { host: 'WWW.Acme.test', since: '2026-09-15T00:00:00.000Z', by: 'acct-1', reason: 'paying', workspaceId: 'ws-1', role: 'owner' },
      { host: 'x.test', since: 's', by: 'acct-2', reason: '', workspaceId: 'ws-2', role: 'not-a-role' },
      { since: 'no host' },
    ])
    const list = await readTrackedIn(kv)
    expect(list).toEqual([
      { host: 'acme.test', since: '2026-09-15T00:00:00.000Z', by: 'acct-1', reason: 'paying', workspaceId: 'ws-1', role: 'owner' },
      { host: 'x.test', since: 's', by: 'acct-2', reason: '', workspaceId: 'ws-2' },
    ])
    expect(list.map(workspaceOf)).toEqual(['ws-1', 'ws-2'])
    await kv.doc('tracked.json').update(() => ({ not: 'a list' }))
    await expect(readTrackedIn(kv)).rejects.toThrow(/not a list/)
  })

  it('dueTodayIn over the file store agrees with dueToday on every field, carries each entry’s workspace onto the due domain, and refuses an environment that cannot size a scan', async () => {
    setTracked(dir, 'acme.test', true, { by: 'operator', reason: 'r' })
    setTracked(dir, 'nobank.test', true, { by: 'operator', reason: 'r' })
    writeCycle(dir, cycle('acme.test', '2026-09-02'))
    const store = fileWorkspaceStore(dir)
    const entries = readTracked(dir).map((entry) => ({ entry, store }))
    const viaStore = await dueTodayIn(dir, {}, '2026-09-03', entries)
    expect(viaStore).toEqual(dueToday(dir, {}, '2026-09-03'))
    expect(viaStore.due.map((d) => [d.host, d.workspaceId])).toEqual([['acme.test', 'local']])
    expect(viaStore.notDue.map((n) => [n.host, n.workspaceId, n.reason])).toEqual([['nobank.test', 'local', 'no-bank']])
    const named = await dueTodayIn(dir, {}, '2026-09-03', [{ entry: { ...readTracked(dir)[0]!, workspaceId: 'ws-1' }, store }])
    expect(named.due[0]).toMatchObject({ host: 'acme.test', workspaceId: 'ws-1' })
    expect((await dueTodayIn(dir, { GRADER_PROMPTS_PER_SCAN: '0' }, '2026-09-03', entries)).config).toMatch(/cannot size/)
  })

  it('decideDueIn re-decides one host at run time: due, then cycle-today once a cycle is filed, then basis-moved when the prompt count changed', async () => {
    const store = fileWorkspaceStore(dir)
    const entry = { host: 'acme.test', workspaceId: 'ws-1' }
    const first = await decideDueIn(dir, {}, '2026-09-03', entry, store)
    expect('config' in first ? null : first.verdict).toMatchObject({ due: { host: 'acme.test', workspaceId: 'ws-1', cells: 17 * ENGINES.length } })
    writeCycle(dir, cycle('acme.test', '2026-09-03'))
    const second = await decideDueIn(dir, {}, '2026-09-03', entry, store)
    expect('config' in second ? null : second.verdict).toMatchObject({ notDue: { reason: 'cycle-today' } })
    const third = await decideDueIn(dir, { GRADER_PROMPTS_PER_SCAN: '10' }, '2026-09-04', entry, store)
    expect('config' in third ? null : third.verdict).toMatchObject({ notDue: { reason: 'basis-moved' } })
  })
})
