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

const quotaRow = (remaining: number) => ({ name: 'Requests', used: 50 - remaining, limit: 50, remaining, reset_at: '2026-09-21T11:07:00.000Z' })

/**
 * THE SHAPE THE PROVIDER ACTUALLY SERVES, captured from a real response on
 * 2026-09-01. One product per call, `data` a single object rather than a list:
 *
 *   {"status":"OK","data":{"api_id":"chatgpt","plan":{...},"status":"active",
 *    "quotas":[{"name":"Requests","limit":50,"used":0,"remaining":50,...}]}}
 *
 * A product the account does not hold answers 2xx with no quota row, which is a
 * missing SUBSCRIPTION and not a failed read — the two are asserted apart below.
 */
const usagePerProduct = (per: Record<string, number>) =>
  ((async (input: string) => {
    const apiId = new URL(String(input)).searchParams.get('api_id') ?? ''
    const remaining = per[apiId]
    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        data:
          remaining === undefined
            ? { api_id: apiId, status: 'inactive' }
            : { api_id: apiId, plan: { key: 'basic', is_free: true }, status: 'active', quotas: [quotaRow(remaining)] },
      }),
    } as unknown as Response
  }) as unknown as typeof fetch)

/** The retired aggregate shape, kept because `usageItems` still accepts it. */
const usageAggregate = (per: Record<string, number>) =>
  ((async () =>
    ({
      ok: true,
      json: async () => ({ data: { items: Object.entries(per).map(([api_id, remaining]) => ({ api_id, quotas: [quotaRow(remaining)] })) } }),
    }) as unknown as Response) as unknown as typeof fetch)

const FULL = { chatgpt: 50, gemini: 50, copilot: 50, google_ai_mode: 50, ai_overviews: 50 }
const fetchOK = (per: Record<string, number> = FULL) => usagePerProduct(per)

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

  it('a lock with a FRESH heartbeat is obeyed, whoever owns it', async () => {
    const { runGrader } = await import('./run.js')
    const dir = mkdtempSync(join(tmpdir(), 'lock2-'))
    writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    await expect(
      runGrader({
        domain: 'pipedrive.com', engines: ['chatgpt'], day: '2026-08-25', plan: 'mega', mode: 'fixture',
        apiKey: '', capUsd: 1, maxPrompts: 1, dataDir: dir, outFile: join(dir, 'out.json'), log: () => {},
      }),
    ).rejects.toThrow(/another scan holds/)
  })

  it('THE ONE THAT BIT: a LIVE owner whose scan stopped is reclaimed', async () => {
    // The pid check alone obeyed this forever. A browser disconnecting mid-scan
    // makes the server abort the handler, so the lock is never released — but
    // the owner is the long-lived dev server and is very much alive. Verified by
    // disconnecting a real client and watching the next scan get refused.
    const { runGrader } = await import('./run.js')
    const dir = mkdtempSync(join(tmpdir(), 'lock3-'))
    const lock = join(dir, 'run.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 5 * 60_000 }))
    const r = await runGrader({
      domain: 'pipedrive.com', engines: ['chatgpt'], day: '2026-08-25', plan: 'mega', mode: 'fixture',
      apiKey: '', capUsd: 1, maxPrompts: 1, dataDir: dir, outFile: join(dir, 'out.json'), log: () => {},
    })
    expect(r.status).toBe('scanned')
    expect(existsSync(lock)).toBe(false)
  })

  it('a legacy bare-pid lock is reclaimed, because it cannot prove it is held', async () => {
    // Older builds wrote just a pid. Without a heartbeat there is no way to tell
    // a running scan from an abandoned one, and obeying it risks the stranding
    // bug forever while reclaiming it risks a concurrency that no current build
    // can produce. Reclaim is the safer of the two.
    const { runGrader } = await import('./run.js')
    const dir = mkdtempSync(join(tmpdir(), 'lock4-'))
    writeFileSync(join(dir, 'run.lock'), String(process.pid))
    const r = await runGrader({
      domain: 'pipedrive.com', engines: ['chatgpt'], day: '2026-08-25', plan: 'mega', mode: 'fixture',
      apiKey: '', capUsd: 1, maxPrompts: 1, dataDir: dir, outFile: join(dir, 'out.json'), log: () => {},
    })
    expect(r.status).toBe('scanned')
  })

  it('THE FABRICATED COST: run.spentUsd is THIS scan, not the ledger total', async () => {
    // `Budget` loads the ledger off disk and only ever adds to it, so
    // `state.spentUsd` after a scan is everything the data dir has ever spent.
    // Stamping that into the result made pipedrive's 22-call scan record
    // $0.7640 - 4.3x its own cost at the dearest payg rate - and /api/scan then
    // cached that number as the domain's own, rising with every later run.
    //
    // Seeded with $0.50 of prior spend and run offline, so this scan's true
    // marginal cost is exactly $0. Before the fix this returned 0.5.
    const { runGrader } = await import('./run.js')
    const dir = mkdtempSync(join(tmpdir(), 'delta-'))
    writeFileSync(join(dir, 'ledger.fixture.json'), JSON.stringify({ capUsd: 1, spentUsd: 0.5, calls: 60, byEngine: {}, updatedAt: '' }))
    const r = await runGrader({
      domain: 'pipedrive.com', engines: ['chatgpt'], day: '2026-08-25', plan: 'mega', mode: 'fixture',
      apiKey: '', capUsd: 1, maxPrompts: 1, dataDir: dir, outFile: join(dir, 'out.json'), log: () => {},
    })
    expect(r.run.spentUsd).toBe(0)
    // The ledger itself is still cumulative - the delta is a view of it, not a
    // reset. A reset would break the cap, which is per data dir.
    expect(JSON.parse(readFileSync(join(dir, 'ledger.fixture.json'), 'utf8')).spentUsd).toBe(0.5)
    // And no scan may ever record more than its own calls could have cost.
    // The union must be narrowed first: `counts` only exists on a scanned
    // result, and this assertion is ABOUT a scanned result - if the status ever
    // stops being 'scanned' here, the test should fail on that line, loudly,
    // rather than on a type error nobody compiled.
    expect(r.status).toBe('scanned')
    if (r.status === 'scanned') expect(r.run.spentUsd).toBeLessThanOrEqual(r.counts.providerCalls * 0.008 + 1e-9)
  })

  it('an offline run never touches the live ledger', async () => {
    // A fixture run charges $0 but was rewriting the shared ledger's capUsd to
    // its own default, and Budget then refused every later live run that asked
    // for more. A fixture scan broke live collection while spending nothing.
    const { runGrader } = await import('./run.js')
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ capUsd: 5, spentUsd: 0.5, calls: 1, byEngine: {}, updatedAt: '' }))
    await runGrader({
      domain: 'pipedrive.com', engines: ['chatgpt'], day: '2026-08-25', plan: 'mega', mode: 'fixture',
      apiKey: '', capUsd: 1, maxPrompts: 1, dataDir: dir, outFile: join(dir, 'out.json'), log: () => {},
    })
    const live = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'))
    expect([live.capUsd, live.spentUsd]).toEqual([5, 0.5])
    expect(existsSync(join(dir, 'ledger.fixture.json'))).toBe(true)
  })
})

/**
 * THE DEMO-DAY SEQUENCE, END TO END.
 *
 * The account is down to roughly one full scan. The manual gate has been removed
 * on instruction, so the FIRST new domain typed spends what is left and the
 * SECOND must fail honestly rather than crash, blank, or quietly show something
 * that is not a measurement. This is the path most likely to be exercised in
 * front of an audience, so it is pinned rather than reasoned about.
 */
describe('running out of quota mid-demo', () => {
  const RESET = '2026-09-21'

  it('the second new domain is refused before it spends, and the message says what to do', async () => {
    // 17 per engine needed, 6 left on one engine: not enough for a full scan.
    const r = await checkGate('second.com', cfg({ maxNewPerDay: 12, callsPerEngine: 17 }), 'k', NOW, fetchOK({ ...FULL, chatgpt: 6 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('quota')
    // Everything a person standing in front of a room needs, in one string.
    expect(r.message).toContain('chatgpt has 6 of 50 left')
    expect(r.message).toContain(RESET)
    expect(r.message).toContain('nothing was charged')
    // The recovery, which is the part a bare error never carries.
    expect(r.message.toLowerCase()).toContain('cached')
  })

  it('refuses on ONE short engine even when the other four are full', async () => {
    // The average would pass. Averaging is how you half-collect a scan and then
    // report the shortfall as a low mention rate.
    const r = await checkGate('x.com', cfg({ callsPerEngine: 17 }), 'k', NOW, fetchOK({ ...FULL, ai_overviews: 0 }))
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === 'quota') expect(r.short.map((q) => q.engine)).toEqual(['google-ai-overviews'])
  })

  it('a domain already scanned today still passes the burst cap and is served from cache', async () => {
    const c = cfg({ maxNewPerDay: 1, callsPerEngine: 17 })
    recordScan('first.com', c, NOW)
    // Re-showing a domain must never be refused: that path spends nothing and is
    // exactly what a presenter does when they want the result back on screen.
    expect((await checkGate('first.com', c, 'k', NOW, fetchOK())).ok).toBe(true)
  })

  it('THE BACKSTOP IS NOT THE LIMIT: the default cap cannot fire before the quota does', async () => {
    // The instruction was that the PROVIDER's quota should be what stops a scan.
    // With 50 requests per engine per month and 17 per scan, at most two scans
    // can succeed in a cycle — so a burst cap above two can never be the thing a
    // visitor hits first, and the honest quota message is what they get.
    const capacity = Math.floor(50 / 17)
    expect(defaultGateConfig('/tmp', {} as NodeJS.ProcessEnv).maxNewPerDay).toBeGreaterThan(capacity)
  })

  it('an unreadable quota still fails CLOSED, and says it refused rather than guessed', async () => {
    const dead = (async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch
    const r = await checkGate('y.com', cfg(), 'k', NOW, dead)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('rather than run blind')
  })
})

/**
 * THE DAY THE ENDPOINT MOVED — 2026-09-01.
 *
 * `/usage` began answering the bare URL with `400 Missing required parameter:
 * api_id`. Every live scan was refused from that moment: correctly, because the
 * gate fails closed, and uselessly, because no quota could be read at all. The
 * aggregate call this was written against no longer exists.
 */
describe('readQuota asks per product, and keeps a dead read apart from a dead subscription', () => {
  it('sends one request per product, each carrying its own api_id', async () => {
    const asked: string[] = []
    const spy = (async (input: string) => {
      asked.push(new URL(String(input)).searchParams.get('api_id') ?? '')
      return {
        ok: true,
        json: async () => ({ data: { api_id: new URL(String(input)).searchParams.get('api_id'), quotas: [quotaRow(50)] } }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const q = await readQuota('k', spy)
    // The bare URL is what started returning 400. Nothing may request it.
    expect(asked.sort()).toEqual(['ai_overviews', 'chatgpt', 'copilot', 'gemini', 'google_ai_mode'])
    expect([...q.map((x) => x.engine)].sort()).toEqual(['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews'])
  })

  it('reads the real per-product body, quotas and all', async () => {
    const q = await readQuota('k', fetchOK({ ...FULL, gemini: 12 }))
    const gemini = q.find((x) => x.engine === 'gemini')
    expect(gemini).toEqual({ engine: 'gemini', used: 38, limit: 50, remaining: 12, resetAt: '2026-09-21T11:07:00.000Z' })
  })

  it('still parses the retired aggregate shape, because this endpoint moves', async () => {
    const q = await readQuota('k', usageAggregate(FULL))
    // Five calls each returning all five products must not report 25 engines.
    expect(q).toHaveLength(5)
  })

  it('a NON-2xx throws and names the product, so the gate refuses rather than guesses', async () => {
    const dead = (async (input: string) =>
      ({ ok: new URL(String(input)).searchParams.get('api_id') !== 'copilot', status: 400, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch

    await expect(readQuota('k', dead)).rejects.toThrow(/400 for copilot/)

    // And end to end: the gate turns that into 'unreadable', never into a spend.
    const verdict = await checkGate('a.com', cfg({ maxNewPerDay: 2 }), 'k', NOW, dead)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('unreadable')
  })

  it('a CLEAN 2xx with no quota row is a missing subscription, not a failed read', async () => {
    // The distinction is the whole point: one says "try again", the other says
    // "subscribe". Answering a billing problem with a network message helps
    // nobody standing in front of an audience.
    const q = await readQuota('k', fetchOK({ chatgpt: 50, gemini: 50, copilot: 50, google_ai_mode: 50 }))
    expect(q.map((x) => x.engine)).not.toContain('google-ai-overviews')
    expect(q).toHaveLength(4)

    const verdict = await checkGate('a.com', cfg({ maxNewPerDay: 2 }), 'k', NOW, fetchOK({ chatgpt: 50, gemini: 50, copilot: 50, google_ai_mode: 50 }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('quota')
      expect(verdict.message).toContain('No active subscription found for: google-ai-overviews')
    }
  })
})

/**
 * THE HUMAN-REVIEW ITEM, MADE EXECUTABLE.
 *
 * `live-gate.ts` is the gate between a public form and paid collection, so the
 * property that matters is not "the happy path works" but "no path says yes
 * without evidence". Reading the code and agreeing is how a gap survives a
 * refactor; this fails instead.
 *
 * THE INVARIANT: checkGate returns ok:true ONLY when every engine in
 * cfg.engines has a real quota row with remaining >= callsPerEngine. Asserted
 * over the whole power set of present/absent engines, so a future edit cannot
 * open a hole for one combination and pass because nobody wrote that case.
 */
describe('INVARIANT: ok:true requires a quota row for EVERY engine in cfg.engines', () => {
  const ALL = ['chatgpt', 'gemini', 'copilot', 'google_ai_mode', 'ai_overviews'] as const

  it('holds across all 32 subsets of engines the provider answers for', async () => {
    const c = cfg({ maxNewPerDay: 99, callsPerEngine: 17 })
    for (let mask = 0; mask < 1 << ALL.length; mask++) {
      const present: Record<string, number> = {}
      for (const [i, id] of ALL.entries()) if (mask & (1 << i)) present[id] = 50

      const verdict = await checkGate(`d${mask}.com`, c, 'k', NOW, fetchOK(present))
      const complete = Object.keys(present).length === ALL.length

      // The only shape allowed to pass is the complete one.
      expect(verdict.ok, `mask ${mask} had ${Object.keys(present).length}/5 engines`).toBe(complete)
      if (!verdict.ok && !complete) expect(verdict.reason).toBe('quota')
    }
  })

  it('a present engine that is SHORT is still a refusal, at every boundary', async () => {
    const c = cfg({ maxNewPerDay: 99, callsPerEngine: 17 })
    for (const id of ALL) {
      // One below the requirement refuses; exactly the requirement passes.
      const short = await checkGate('a.com', c, 'k', NOW, fetchOK({ ...FULL, [id]: 16 }))
      expect(short.ok, `${id} at 16`).toBe(false)
      const exact = await checkGate('a.com', c, 'k', NOW, fetchOK({ ...FULL, [id]: 17 }))
      expect(exact.ok, `${id} at 17`).toBe(true)
    }
  })

  it('a zero-remaining engine can never be read as absent-and-therefore-fine', async () => {
    // 0 is falsy. A membership test written as `if (!q.remaining)` would drop
    // the row, and a dropped row is a MISSING engine — which the subset test
    // above already refuses. Belt and braces, because this is the gate.
    const c = cfg({ maxNewPerDay: 99, callsPerEngine: 1 })
    const verdict = await checkGate('a.com', c, 'k', NOW, fetchOK({ ...FULL, copilot: 0 }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('quota')
  })

  it('an unreadable quota can never pass, whatever else is true', async () => {
    const c = cfg({ maxNewPerDay: 99, callsPerEngine: 1 })
    for (const bad of [
      (async () => { throw new Error('offline') }) as unknown as typeof fetch,
      (async () => ({ ok: false, status: 400, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch,
      (async () => ({ ok: true, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch,
      (async () => ({ ok: true, json: async () => { throw new Error('not json') } }) as unknown as Response) as unknown as typeof fetch,
    ]) {
      const verdict = await checkGate('a.com', c, 'k', NOW, bad)
      expect(verdict.ok).toBe(false)
    }
  })
})
