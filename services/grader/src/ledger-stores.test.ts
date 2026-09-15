import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetExceeded, MemoryKV, RunAllowanceExceeded } from '@bliprank/collector'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CORRUPT, fileLedgerDoc, kvLedgerDoc, withRunAllowance } from './ledger-doc.js'
import { declaredSingleProcess, kvLedgerStores, ledgerStores } from './ledger-stores.js'
import { checkVisitorThrottle, recordVisitorScan } from './visitor-throttle.js'

/**
 * Where the ledgers live and how they behave on each backend (MVP_PLAN B3b,
 * B3c item 4, R3). Nothing here reaches a network: the KV is the collector's
 * in-memory double, the fetch handed to the Upstash path is never called.
 */
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-ledgers-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const KV_ENV = { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', UPSTASH_REDIS_REST_URL: 'https://kv.test', UPSTASH_REDIS_REST_TOKEN: 't' }
const ONE = { COLLECTOR_TOPOLOGY: 'single-process' }
const neverFetch: typeof fetch = () => Promise.reject(new Error('the test never reaches a network'))

describe('the choice of backend', () => {
  it('files on a machine that declares itself one process over its data directory', () => {
    expect(ledgerStores(dir, ONE).backend).toBe('file')
  })

  it('Upstash when the answer store is configured, chosen by the same six variables, whatever the topology says', () => {
    expect(ledgerStores(dir, KV_ENV, neverFetch).backend).toBe('kv')
    expect(ledgerStores(dir, { ...KV_ENV, COLLECTOR_TOPOLOGY: 'fleet' }, neverFetch).backend).toBe('kv')
  })

  it('a partly configured store is refused, never silently files', () => {
    expect(() => ledgerStores(dir, { UPSTASH_REDIS_REST_URL: 'https://kv.test', ...ONE })).toThrow(/partly configured/)
  })

  it('a fleet runtime with no KV is refused, by marker or by declaration: a file ledger there is a cap per instance (R3, B3c item 4)', () => {
    expect(() => ledgerStores(dir, { VERCEL: '1' })).toThrow(/VERCEL is set, so this runtime is many instances/)
    expect(() => ledgerStores(dir, { COLLECTOR_TOPOLOGY: 'fleet' })).toThrow(/COLLECTOR_TOPOLOGY=fleet, so this runtime is many instances/)
    // A marker wins over a declaration: a process cannot declare its way off Vercel.
    expect(() => ledgerStores(dir, { VERCEL: '1', ...ONE })).toThrow(/VERCEL is set/)
    expect(ledgerStores(dir, { ...KV_ENV, VERCEL: '1' }, neverFetch).backend).toBe('kv')
  })

  it('an undeclared runtime is refused too: a bare VM looks exactly like a laptop from in here (ADR-0006)', () => {
    expect(() => ledgerStores(dir, {})).toThrow(/COLLECTOR_TOPOLOGY is not set, so this process cannot show it is the only one/)
    expect(() => ledgerStores(dir, { COLLECTOR_TOPOLOGY: 'laptop' })).toThrow(/not a recognised value/)
  })

  it('the file backend hands the collector the environment as given, so its own guard agrees or refuses on the same facts', async () => {
    const ledger = ledgerStores(dir, ONE).spend('ledger.json', 1, () => 0.004)
    await ledger.charge('chatgpt')
    expect(await ledger.spentUsd()).toBeCloseTo(0.004, 9)
  })

  it('a CLI declares single-process for itself only when nothing is declared; a declared fleet stays a fleet', () => {
    expect(declaredSingleProcess({})).toEqual({ COLLECTOR_TOPOLOGY: 'single-process' })
    expect(declaredSingleProcess({ COLLECTOR_TOPOLOGY: 'fleet' })).toEqual({ COLLECTOR_TOPOLOGY: 'fleet' })
    expect(() => ledgerStores(dir, declaredSingleProcess({ COLLECTOR_TOPOLOGY: 'fleet' }))).toThrow(/COLLECTOR_TOPOLOGY=fleet/)
    expect(() => ledgerStores(dir, declaredSingleProcess({ VERCEL: '1' }))).toThrow(/VERCEL is set/)
    expect(ledgerStores(dir, declaredSingleProcess({})).backend).toBe('file')
  })

  it('the KV ledgers over the in-memory double are the deployment\'s shape: a document under a lock and an atomic spend ledger', async () => {
    const s = kvLedgerStores(new MemoryKV())
    expect(s.backend).toBe('kv')
    await s.doc('x.json').update(() => ({ n: 1 }))
    expect(await s.doc('x.json').read()).toEqual({ n: 1 })
    const ledger = s.spend('ledger.json', 0.01, () => 0.004, { runAllowanceCalls: 5 })
    await ledger.charge('chatgpt')
    await ledger.charge('chatgpt')
    await expect(ledger.charge('chatgpt')).rejects.toBeInstanceOf(BudgetExceeded)
  })
})

describe('a ledger document', () => {
  it('on a file: absent reads null, update replaces whole, a corrupt file reaches the writer as CORRUPT', async () => {
    const doc = fileLedgerDoc(join(dir, 'x.json'))
    expect(await doc.read()).toBeNull()
    expect(await doc.update((cur) => ({ was: cur, n: 1 }))).toEqual({ was: null, n: 1 })
    expect(await doc.read()).toEqual({ was: null, n: 1 })
    writeFileSync(join(dir, 'x.json'), '{ not json')
    await expect(doc.read()).rejects.toThrow()
    expect(await doc.update((cur) => (cur === CORRUPT ? 'started afresh' : 'kept'))).toBe('started afresh')
    expect(JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8'))).toBe('started afresh')
  })

  it('on a file: two updates at once in one process both land; a fresh lock another writer holds fails the write closed; a lock a dead process left behind is reclaimed (B3c cost review)', async () => {
    const file = join(dir, 'c.json')
    const doc = fileLedgerDoc(file, async () => {})
    await doc.update(() => ({ n: 0 }))
    // Without the lock the two reads interleaved across the await and one increment was lost.
    await Promise.all([doc.update((c) => ({ n: (c as { n: number }).n + 1 })), doc.update((c) => ({ n: (c as { n: number }).n + 1 }))])
    expect(await doc.read()).toEqual({ n: 2 })
    expect(existsSync(`${file}.lock`)).toBe(false)
    // Another process holds the lock, freshly: refused after the attempts, nothing written.
    writeFileSync(`${file}.lock`, 'someone else')
    await expect(doc.update(() => ({ n: 99 }))).rejects.toThrow(/could not take its lock/)
    expect(await doc.read()).toEqual({ n: 2 })
    // The same lock, older than the TTL: its holder is presumed dead and the write lands.
    const old = new Date(Date.now() - 11_000)
    utimesSync(`${file}.lock`, old, old)
    expect(await doc.update((c) => ({ n: (c as { n: number }).n + 1 }))).toEqual({ n: 3 })
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  it('on KV: the same contract, and update serialises under a lock that a second writer waits for', async () => {
    const kv = new MemoryKV()
    const doc = kvLedgerDoc(kv, 'ledger:x', async () => {})
    expect(await doc.read()).toBeNull()
    await doc.update(() => ({ n: 1 }))
    expect(await doc.read()).toEqual({ n: 1 })
    // Two increments at once: with the lock both land; without it one would overwrite the other.
    await Promise.all([doc.update((c) => ({ n: (c as { n: number }).n + 1 })), doc.update((c) => ({ n: (c as { n: number }).n + 1 }))])
    expect(await doc.read()).toEqual({ n: 3 })
    // The lock is released after each update.
    expect(await kv.get('ledger:x:lock')).toBeNull()
    await kv.set('ledger:x', 'not json')
    expect(await doc.update((cur) => (cur === CORRUPT ? 'afresh' : 'kept'))).toBe('afresh')
  })

  it('on KV: a lock nobody releases fails the write closed', async () => {
    const kv = new MemoryKV()
    await kv.set('ledger:y:lock', 'someone-else')
    const doc = kvLedgerDoc(kv, 'ledger:y', async () => {})
    await expect(doc.update(() => 1)).rejects.toThrow(/could not take its lock/)
    expect(await kv.get('ledger:y')).toBeNull()
  })

  it('the visitor throttle is the same throttle on either backend', async () => {
    const NOW = new Date('2026-09-15T10:00:00Z')
    for (const stores of [ledgerStores(dir, ONE), { doc: (name: string) => kvLedgerDoc(new MemoryKV(), name) }]) {
      const cfg = { maxScansPerHour: 1, windowMs: 3600_000, ledgerFile: join(dir, 'visitor-throttle.json'), ledger: stores.doc('visitor-throttle.json') }
      expect((await checkVisitorThrottle('1.2.3.4', cfg, NOW)).ok).toBe(true)
      await recordVisitorScan('1.2.3.4', cfg, NOW)
      expect((await checkVisitorThrottle('1.2.3.4', cfg, NOW)).ok).toBe(false)
      expect((await checkVisitorThrottle('5.6.7.8', cfg, NOW)).ok).toBe(true)
    }
  })
})

describe('the spend ledger', () => {
  it('on a file: Budget under LocalSpendLedger, charged before the attempt, the file the CLIs read', async () => {
    const s = ledgerStores(dir, ONE)
    const ledger = s.spend('ledger.json', 0.01, () => 0.004)
    await ledger.charge('chatgpt')
    await ledger.charge('chatgpt')
    await expect(ledger.charge('chatgpt')).rejects.toBeInstanceOf(BudgetExceeded)
    expect(await ledger.spentUsd()).toBeCloseTo(0.008, 9)
    expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'))).toMatchObject({ capUsd: 0.01, calls: 2, exhaustedAt: expect.any(String) })
  })

  it('on KV: atomic counters under the same cap, and the run allowance bounds one run\'s attempts before the cap', async () => {
    const s = ledgerStores(dir, KV_ENV, neverFetch)
    // The KV the store built talks to a network; build the same ledger over the in-memory double to prove the semantics.
    void s
    const kv = new MemoryKV()
    const stores = { doc: (n: string) => kvLedgerDoc(kv, n) }
    void stores
    const ledger = withRunAllowance(
      // the same class ledger-stores.ts constructs
      new (await import('@bliprank/collector')).KvSpendLedger({ kv, capUsd: 1, priceUsd: () => 0.004, keyPrefix: 'spend:ledger', window: 'total' }),
      2,
    )
    await ledger.charge('chatgpt')
    await ledger.charge('gemini')
    await expect(ledger.charge('chatgpt')).rejects.toBeInstanceOf(RunAllowanceExceeded)
    expect(ledger.runCalls).toBe(2)
    expect(await ledger.spentUsd()).toBeCloseTo(0.008, 9)
    // The allowance refusal left the shared ledger open: a fresh run charges on.
    const again = withRunAllowance(new (await import('@bliprank/collector')).KvSpendLedger({ kv, capUsd: 1, priceUsd: () => 0.004, keyPrefix: 'spend:ledger', window: 'total' }), 1)
    await again.charge('chatgpt')
    expect(await again.spentUsd()).toBeCloseTo(0.012, 9)
  })
})
