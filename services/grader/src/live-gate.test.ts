import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkGate, defaultGateConfig, readQuota, recordScan, scannedToday } from './live-gate.js'

/**
 * The gate, tested against the states it exists to refuse.
 *
 * Every one of these is a rule R3 surface protecting a quota of 50 requests per
 * engine per month against a scan that draws 17 from each. There is room for two
 * scans in a month, so a gate that lets one through by mistake costs half of it.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'gate-'))
const cfg = (over: Partial<ReturnType<typeof defaultGateConfig>> = {}) => ({ ...defaultGateConfig(dir(), {} as NodeJS.ProcessEnv), ...over })
const NOW = new Date('2026-08-25T09:00:00Z')

const usage = (per: Record<string, number>) =>
  ({
    ok: true,
    json: async () => ({
      data: {
        items: Object.entries(per).map(([api_id, remaining]) => ({
          api_id,
          quotas: [{ used: 50 - remaining, limit: 50, remaining, reset_at: '2026-09-21T11:07:00.000Z' }],
        })),
      },
    }),
  }) as unknown as Response

const FULL = { chatgpt: 50, gemini: 50, copilot: 50, google_ai_mode: 50, ai_overviews: 50 }
const fetchOK = (per: Record<string, number> = FULL) => (async () => usage(per)) as unknown as typeof fetch

describe('the quota is read from the provider, not tallied locally', () => {
  it('maps every provider api_id onto our engine ids', async () => {
    const q = await readQuota('k', fetchOK())
    expect([...q.map((x) => x.engine)].sort()).toEqual(['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews'])
  })

  it('ignores products we do not collect from', async () => {
    // `ai_answers` is a separate aggregate subscription this pipeline never
    // calls. Counting it would report quota we cannot actually spend.
    const q = await readQuota('k', fetchOK({ ...FULL, ai_answers: 50, jsearch: 50 }))
    expect(q).toHaveLength(5)
  })
})

describe('a scan is refused unless BOTH limits allow it', () => {
  it('passes when the burst cap is free and every engine has enough left', async () => {
    const r = await checkGate('a.com', cfg({ maxNewPerDay: 2, callsPerEngine: 17 }), 'k', NOW, fetchOK())
    expect(r.ok).toBe(true)
  })

  it('THE ARITHMETIC THIS EXISTS FOR: a daily cap alone would allow 60 scans against a 50-request month', async () => {
    // Two a day is sixty a month. Seventeen calls a scan against fifty per
    // engine is TWO scans for the whole month. The burst cap cannot see that,
    // which is why the quota check is not optional.
    const c = cfg({ maxNewPerDay: 2, callsPerEngine: 17 })
    const afterTwo = await checkGate('c.com', c, 'k', NOW, fetchOK({ ...FULL, gemini: 16 }))
    expect(afterTwo.ok).toBe(false)
    if (afterTwo.ok) return
    expect(afterTwo.reason).toBe('quota')
    expect(afterTwo.message).toMatch(/gemini has 16 of 50 left/)
    expect(afterTwo.message).toMatch(/needs 17 requests per engine/)
  })

  it('refuses a NEW domain once the day is spent, but never a repeat', async () => {
    const c = cfg({ maxNewPerDay: 2, callsPerEngine: 17 })
    recordScan('one.com', c, NOW)
    recordScan('two.com', c, NOW)

    const fresh = await checkGate('three.com', c, 'k', NOW, fetchOK())
    expect(fresh.ok).toBe(false)
    if (!fresh.ok) expect(fresh.reason).toBe('burst-cap')

    // A repeat is served from cache and spends nothing, so refusing it would be
    // refusing the free path — the opposite of what the cap is for.
    const repeat = await checkGate('one.com', c, 'k', NOW, fetchOK())
    expect(repeat.ok).toBe(true)
  })

  it('the cap is per UTC day and yesterday does not count against today', async () => {
    const c = cfg({ maxNewPerDay: 1, callsPerEngine: 17 })
    recordScan('one.com', c, new Date('2026-08-24T23:00:00Z'))
    expect(scannedToday(c, NOW)).toEqual([])
    expect((await checkGate('new.com', c, 'k', NOW, fetchOK())).ok).toBe(true)
  })

  it('FAILS CLOSED when the quota cannot be read', async () => {
    // Not knowing what is left is not permission to spend it. This is the branch
    // most likely to be written the other way round for convenience.
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const r = await checkGate('a.com', cfg(), 'k', NOW, dead)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unreadable')

    const http500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    expect((await checkGate('a.com', cfg(), 'k', NOW, http500)).ok).toBe(false)
  })

  it('FAILS CLOSED on a corrupt ledger rather than treating it as an empty day', async () => {
    const c = cfg({ maxNewPerDay: 2 })
    writeFileSync(c.ledgerFile, '{ not json')
    expect((await checkGate('a.com', c, 'k', NOW, fetchOK())).ok).toBe(false)
  })

  it('refuses when an engine has no active subscription at all', async () => {
    const r = await checkGate('a.com', cfg(), 'k', NOW, fetchOK({ chatgpt: 50, gemini: 50 }))
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === 'quota') expect(r.message).toMatch(/No active subscription found for: copilot, google-ai-mode, google-ai-overviews/)
  })

  it('refuses if ANY single engine is short, not just if the average is fine', async () => {
    // Four engines with plenty and one with nothing is not four fifths of a
    // scan; it is a scan whose comparison_basis silently changed.
    const r = await checkGate('a.com', cfg({ callsPerEngine: 17 }), 'k', NOW, fetchOK({ ...FULL, copilot: 3 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('quota')
  })
})

describe('the ledger records only what actually spent', () => {
  it('appends once per domain per day and is idempotent', () => {
    const c = cfg()
    recordScan('a.com', c, NOW)
    recordScan('a.com', c, NOW)
    recordScan('b.com', c, NOW)
    expect(scannedToday(c, NOW)).toEqual(['a.com', 'b.com'])
    expect(JSON.parse(readFileSync(c.ledgerFile, 'utf8'))['2026-08-25']).toEqual(['a.com', 'b.com'])
  })

  it('is configurable, because a demo and a quiet week want different numbers', () => {
    const c = defaultGateConfig('/tmp/x', { GRADER_MAX_NEW_SCANS_PER_DAY: '5', GRADER_PROMPTS_PER_SCAN: '9' } as unknown as NodeJS.ProcessEnv)
    expect([c.maxNewPerDay, c.callsPerEngine]).toEqual([5, 9])
  })
})

describe('a stranded run lock does not brick collection', () => {
  it('THE FINDING: a lock whose owner is gone is reclaimed, not obeyed forever', async () => {
    // A client that disconnects mid-scan, a killed dev server or a crash left
    // run.lock behind, and every later scan was refused with "another scan holds
    // run.lock". On the morning of a demo that is indistinguishable from the
    // product being broken, and the fix a hurried person reaches for is deleting
    // a file they have to know exists.
    const { runGrader } = await import('./run.js')
    const dir = mkdtempSync(join(tmpdir(), 'lock-'))
    const lock = join(dir, 'run.lock')
    // 2^31-1 is never a live pid; process.kill(pid, 0) throws for it.
    writeFileSync(lock, '2147483647')

    const r = await runGrader({
      domain: 'pipedrive.com',
      engines: ['chatgpt'],
      day: '2026-08-25',
      plan: 'mega',
      mode: 'fixture',
      apiKey: '',
      capUsd: 1,
      maxPrompts: 1,
      dataDir: dir,
      outFile: join(dir, 'out.json'),
      log: () => {},
    })
    expect(r.status).toBe('scanned')
    // And it releases its own lock on the way out.
    expect(existsSync(lock)).toBe(false)
  })

  it('a lock held by a LIVE process is still obeyed', async () => {
    const { runGrader } = await import('./run.js')
    const dir = mkdtempSync(join(tmpdir(), 'lock2-'))
    // A pid that is definitely alive and is not us would be ideal; the parent
    // process id is exactly that on every platform this runs on.
    writeFileSync(join(dir, 'run.lock'), String(process.ppid))
    await expect(
      runGrader({
        domain: 'pipedrive.com', engines: ['chatgpt'], day: '2026-08-25', plan: 'mega', mode: 'fixture',
        apiKey: '', capUsd: 1, maxPrompts: 1, dataDir: dir, outFile: join(dir, 'out.json'), log: () => {},
      }),
    ).rejects.toThrow(/another scan holds/)
  })
})
