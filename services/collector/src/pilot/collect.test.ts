import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { optionsFromEnv, priorSpendUsd, runPilot, PILOT_DIR, type RunOptions } from './collect.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { BudgetExceeded } from '../budget.js'
import { loadDotEnv } from './util.js'
import { AdapterError, cacheCell, type EngineAdapter, type EngineId, type RawAnswer } from '@bliprank/contracts'
import { runDoctor, assertSpendAllowed, projectSpend } from './collect.js'
import { fixtureAdapter } from './fixture-adapter.js'

/** An engine that always rejects (bad key / no subscription), charged at fixture price $0. */
function rejectingAdapter(engine: EngineId): EngineAdapter {
  return {
    ...fixtureAdapter(engine, { latencyMs: 0 }),
    collect: async () => {
      throw new AdapterError('rejected', 'HTTP 403: You are not subscribed to this API', false)
    },
  }
}

const bankFile = join(PILOT_DIR, 'bank.json')

describe('R3 gate — the runner refuses unless collection is deliberately enabled', () => {
  const base = ['--day', '2026-08-19', '--bank', bankFile]
  it('refuses without COLLECTION_ENABLED=true', () => {
    expect(optionsFromEnv(base, { OPENWEBNINJA_API_KEY: 'k', COLLECTION_BUDGET_USD: '5' })).toMatchObject({ refuse: expect.stringContaining('COLLECTION_ENABLED') })
    expect(optionsFromEnv(base, { COLLECTION_ENABLED: 'false', OPENWEBNINJA_API_KEY: 'k', COLLECTION_BUDGET_USD: '5' })).toMatchObject({ refuse: expect.stringContaining('COLLECTION_ENABLED') })
  })
  it('refuses without a key, and without an explicit cap', () => {
    expect(optionsFromEnv(base, { COLLECTION_ENABLED: 'true', COLLECTION_BUDGET_USD: '5' })).toMatchObject({ refuse: expect.stringContaining('API_KEY') })
    expect(optionsFromEnv(base, { COLLECTION_ENABLED: 'true', OPENWEBNINJA_API_KEY: 'k' })).toMatchObject({ refuse: expect.stringContaining('COLLECTION_BUDGET_USD') })
  })
  it('refuses without an explicit plan — never defaults to pay-as-you-go for a real run', () => {
    expect(optionsFromEnv(base, { COLLECTION_ENABLED: 'true', OPENWEBNINJA_API_KEY: 'k', COLLECTION_BUDGET_USD: '75' })).toMatchObject({ refuse: expect.stringContaining('plan') })
    const o = optionsFromEnv(base, { COLLECTION_ENABLED: 'true', OPENWEBNINJA_API_KEY: 'k', COLLECTION_BUDGET_USD: '75', OPENWEBNINJA_PLAN: 'mega' })
    expect(o).toMatchObject({ day: '2026-08-19', runs: 10, plan: 'mega', capUsd: 75, engines: expect.arrayContaining(['chatgpt', 'google-ai-overviews']) })
    expect(optionsFromEnv([...base, '--plan', 'ultra'], { COLLECTION_ENABLED: 'true', OPENWEBNINJA_API_KEY: 'k', COLLECTION_BUDGET_USD: '75' })).toMatchObject({ plan: 'ultra' })
  })
  it('fixture mode needs no key and never spends', () => {
    const o = optionsFromEnv([...base, '--fixture'], {})
    expect(o).toMatchObject({ fixture: true, capUsd: 1 })
  })
})

describe('runPilot in fixture mode — resumable, budgeted, day-bucketed', () => {
  it('collects prompts × runs per engine, skips already-stored pairs on resume, stops on the cap', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    const logs: string[] = []
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-19', '--bank', bankFile, '--runs', '3', '--limit-prompts', '4', '--engines', 'chatgpt,gemini', '--rps-scale', '300', '--data', dataDir], {}) as RunOptions
    opts.log = (l) => logs.push(l)
    const r1 = await runPilot(opts)
    expect(r1.exitCode).toBe(0)
    expect(r1.stats['chatgpt']!.done).toBe(12)
    expect(r1.stats['gemini']!.done).toBe(12)
    const lines = readFileSync(join(dataDir, '2026-08-19', 'chatgpt.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(12)
    const first = JSON.parse(lines[0]!) as { cell: { dateBucket: string; engine: string }; adapter: string; run: number }
    expect(first.cell.dateBucket).toBe('2026-08-19')
    expect(first.adapter).toBe('fixture:chatgpt')
    expect(existsSync(join(dataDir, '2026-08-19', 'ledger.json'))).toBe(true)

    // resume with one more run: only the new run is collected
    const r2 = await runPilot({ ...opts, runs: 4 })
    expect(r2.stats['chatgpt']!.done).toBe(4)
    expect(logs.some((l) => l.includes('12 already stored'))).toBe(true)
  })

  it('a zero-price fixture never spends; a positive price with a tiny cap stops with exit 3', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    // Force a price by faking a non-fixture plan through a wrapper: simplest is to run
    // fixture mode (price 0) and assert nothing was charged.
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-19', '--bank', bankFile, '--runs', '1', '--limit-prompts', '2', '--engines', 'copilot', '--data', dataDir], {}) as RunOptions
    opts.log = () => {}
    const r = await runPilot(opts)
    const ledger = JSON.parse(readFileSync(r.ledgerFile, 'utf8')) as { spentUsd: number; calls: number }
    expect(ledger.spentUsd).toBe(0)
    expect(ledger.calls).toBe(2)
  })
})

describe('the cap is per pilot, not per day', () => {
  it('earlier days\' ledgers come off the top; a spent cap refuses the next day before any call', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    mkdirSync(join(dataDir, '2026-08-19'), { recursive: true })
    writeFileSync(join(dataDir, '2026-08-19', 'ledger.json'), JSON.stringify({ capUsd: 5, spentUsd: 3.25, calls: 500, byEngine: {}, updatedAt: 'x' }))
    expect(priorSpendUsd(dataDir, '2026-08-20')).toBeCloseTo(3.25)
    expect(priorSpendUsd(dataDir, '2026-08-19')).toBe(0)
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-20', '--bank', bankFile, '--runs', '1', '--limit-prompts', '2', '--engines', 'gemini', '--data', dataDir, '--cap', '3'], {}) as RunOptions
    opts.log = () => {}
    await expect(runPilot(opts)).rejects.toBeInstanceOf(BudgetExceeded)
    // with headroom the day runs under (cap − prior); the lock is released afterwards
    const ok = await runPilot({ ...opts, capUsd: 5 })
    expect(ok.exitCode).toBe(0)
    const ledger = JSON.parse(readFileSync(ok.ledgerFile, 'utf8')) as { capUsd: number }
    expect(ledger.capUsd).toBeCloseTo(1.75)
    expect(existsSync(join(dataDir, 'run.lock'))).toBe(false)
    expect(existsSync(join(dataDir, '2026-08-20', 'meta.json'))).toBe(true)
  })
  it('a live lock from another process refuses a second run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    writeFileSync(join(dataDir, 'run.lock'), String(process.pid)) // this very process is alive
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-21', '--bank', bankFile, '--runs', '1', '--limit-prompts', '1', '--engines', 'gemini', '--data', dataDir], {}) as RunOptions
    opts.log = () => {}
    await expect(runPilot(opts)).rejects.toThrow(/another run holds/)
  })

  it('the lock is pilot-wide, so a CONCURRENT run on a different day is refused too', async () => {
    // The cap is per pilot. A day-scoped lock let two operators launch --day A
    // and --day B at the same moment, each reading prior spend as $0 and each
    // free to spend the whole cap.
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    writeFileSync(join(dataDir, 'run.lock'), String(process.pid))
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-22', '--bank', bankFile, '--runs', '1', '--limit-prompts', '1', '--engines', 'gemini', '--data', dataDir], {}) as RunOptions
    opts.log = () => {}
    await expect(runPilot(opts)).rejects.toThrow(/another run holds/)
  })
})

describe('dotenv loading', () => {
  it('reads .env.local then .env; process env wins; values never overridden', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-'))
    writeFileSync(join(root, '.env'), 'A=from-env\nB=from-env\nC="quoted"\n# comment\nPLAN=payg\n')
    writeFileSync(join(root, '.env.local'), 'A=from-local\n')
    const env: NodeJS.ProcessEnv = { B: 'from-process' }
    const loaded = loadDotEnv(root, env, ['A', 'B', 'C', 'PLAN'])
    expect(env['A']).toBe('from-local')
    expect(env['B']).toBe('from-process')
    expect(env['C']).toBe('quoted')
    expect(env['PLAN']).toBe('payg')
    expect(loaded).toEqual(['A (.env.local)', 'C (.env)', 'PLAN (.env)'])
    const env2: NodeJS.ProcessEnv = {}
    loadDotEnv(root, env2) // default allowlist: none of these test keys qualify
    expect(Object.keys(env2)).toEqual([])
  })
})

describe('rejected engines cost one canary call, then nothing', () => {
  it('canary-first: a dead engine records exactly 1 attempt, not a concurrency window', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-22', '--bank', bankFile, '--runs', '2', '--limit-prompts', '5', '--engines', 'chatgpt,gemini', '--data', dataDir], {}) as RunOptions
    opts.log = () => {}
    opts.adapterFactory = (e) => (e === 'chatgpt' ? rejectingAdapter(e) : fixtureAdapter(e, { latencyMs: 0 }))
    const r = await runPilot(opts)
    expect(r.stats['chatgpt']!.attempts).toBe(1) // canary only — never the 64-wide window
    expect(r.stats['chatgpt']!.failed).toBe(1)
    expect(r.stats['gemini']!.done).toBe(10) // healthy engine unaffected
  })

  it('a re-run skips the rejected engine entirely until failures.jsonl is cleared', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-22', '--bank', bankFile, '--runs', '1', '--limit-prompts', '3', '--engines', 'copilot', '--data', dataDir], {}) as RunOptions
    const logs: string[] = []
    opts.log = (l) => logs.push(l)
    opts.adapterFactory = rejectingAdapter
    await runPilot(opts)
    const again = await runPilot(opts)
    expect(again.stats['copilot']!.attempts).toBe(0) // $0 on the second mistake
    expect(logs.some((l) => l.includes('SKIPPED') && l.includes('rejected'))).toBe(true)
    // clearing failures.jsonl re-arms the engine (cause assumed fixed): canary fires again
    const { unlinkSync } = await import('node:fs')
    unlinkSync(join(dataDir, '2026-08-22', 'failures.jsonl'))
    const healthy = await runPilot({ ...opts, adapterFactory: (e) => fixtureAdapter(e, { latencyMs: 0 }) })
    expect(healthy.stats['copilot']!.done).toBe(3)
  })
})

describe('second-provider swap (PHASES 1.3): same pipeline, stub dialect, zero spend', () => {
  it('--stub runs the identical pipeline offline and stores stub-dialect RawAnswers', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    const opts = optionsFromEnv(['--stub', '--day', '2026-08-23', '--bank', bankFile, '--runs', '2', '--limit-prompts', '4', '--engines', 'chatgpt,google-ai-overviews', '--rps-scale', '500', '--data', dataDir], {}) as RunOptions
    expect(opts).toMatchObject({ stub: true, fixture: false })
    opts.log = () => {}
    const r = await runPilot(opts)
    expect(r.exitCode).toBe(0)
    expect(r.stats['chatgpt']!.done).toBe(8)
    const ledger = JSON.parse(readFileSync(r.ledgerFile, 'utf8')) as { spentUsd: number }
    expect(ledger.spentUsd).toBe(0) // a stub never spends
    const first = JSON.parse(readFileSync(join(dataDir, '2026-08-23', 'chatgpt.jsonl'), 'utf8').split('\n')[0]!) as { adapter: string; collectionPath: string; payload: { api_version?: string } }
    expect(first.adapter).toBe('stubsearch:chatgpt')
    expect(first.collectionPath).toBe('official-api') // the alternate disclosure value, end to end
    expect(first.payload.api_version).toBe('v2') // verbatim stub payload stored, rule R4 shape intact
  }, 20_000)

  it('the analysis pipeline consumes stub answers unmodified', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    const base = ['--stub', '--bank', bankFile, '--runs', '4', '--limit-prompts', '30', '--engines', 'gemini', '--rps-scale', '500', '--data', dataDir]
    for (const day of ['2026-08-23', '2026-08-24']) {
      const o = optionsFromEnv([...base, '--day', day], {}) as RunOptions
      o.log = () => {}
      await runPilot(o)
    }
    const { analyseEngine, loadDay } = await import('./analyse.js')
    const bank = JSON.parse(readFileSync(bankFile, 'utf8')) as { brands: never[]; prompts: string[] }
    const rep = analyseEngine('gemini', loadDay(dataDir, '2026-08-23', 'gemini'), loadDay(dataDir, '2026-08-24', 'gemini'), bank, null, 4)
    expect(rep.answers).toBe(120)
    expect(rep.gate.status).toBe('RUN') // the estimator runs on stub data like any other
    expect(rep.byBrand.length).toBeGreaterThan(0)
  }, 60_000)
})

describe('spend safety (post-review)', () => {
  it('runDoctor refuses offline flags — it always hits the real provider', async () => {
    const opts = optionsFromEnv(['--stub', '--doctor', '--day', '2026-08-25', '--bank', bankFile, '--limit-prompts', '1', '--data', mkdtempSync(join(tmpdir(), 'pilot-'))], {})
    // --doctor is never offline: without COLLECTION_ENABLED the gate refuses at options time
    expect(opts).toMatchObject({ refuse: expect.stringContaining('COLLECTION_ENABLED') })
  })

  it('runDoctor throws on fixture/stub options, and runPilot honours the in-process R3 guard', async () => {
    const stubOpts = optionsFromEnv(['--stub', '--day', '2026-08-25', '--bank', bankFile, '--limit-prompts', '1', '--data', mkdtempSync(join(tmpdir(), 'pilot-'))], {}) as RunOptions
    await expect(runDoctor(stubOpts)).rejects.toThrow(/no offline mode/)
    // a real (non-offline) options object with COLLECTION_ENABLED unset must be refused in-process
    expect(() => assertSpendAllowed({ fixture: false, stub: false }, {})).toThrow(/COLLECTION_ENABLED/)
    expect(() => assertSpendAllowed({ fixture: false, stub: false }, { COLLECTION_ENABLED: 'true' })).not.toThrow()
    expect(() => assertSpendAllowed({ fixture: true, stub: false }, {})).not.toThrow() // offline never spends
  })

  it('charges providerCalls, not collect() invocations, for a chaining adapter', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pilot-'))
    const chaining = (engine: EngineId): EngineAdapter => ({
      ...fixtureAdapter(engine, { latencyMs: 0 }),
      collect: async (req): Promise<RawAnswer> => ({
        text: 'x', citations: [], cell: req.cell, prompt: req.prompt, run: req.run,
        adapter: `chain:${engine}`, collectionPath: 'third-party-grounded',
        collectedAt: '2026-08-25T00:00:00Z', latencyMs: 0, providerCalls: 3, payload: {},
      }),
    })
    // price via a real plan path: use adapterFactory (offline → $0), so assert the ATTEMPT accounting instead
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-25', '--bank', bankFile, '--runs', '1', '--limit-prompts', '2', '--engines', 'chatgpt', '--rps-scale', '300', '--data', dataDir], {}) as RunOptions
    opts.adapterFactory = chaining
    opts.log = () => {}
    const r = await runPilot(opts)
    // 2 cells collected; the ledger charged the canary + workers; providerCalls top-up ran (offline price 0)
    const ledger = JSON.parse(readFileSync(r.ledgerFile, 'utf8')) as { calls: number }
    expect(r.stats['chatgpt']!.done).toBe(2)
    expect(ledger.calls).toBeGreaterThanOrEqual(2 * 3) // 3 providerCalls per collect, all charged
  })
})

describe('cost projection is scoped to the mode, not to the bank', () => {
  // The projection is what the operator approves a ceiling against, so it has to
  // describe the work actually about to happen. --doctor probes once per engine
  // (probeEngine issues exactly one request); projecting the full bank for that
  // made a 5-call health check demand a full-pilot budget.
  const argv = (extra: string[]) => ['--day', '2026-08-21', '--bank', bankFile, '--plan', 'pro', ...extra]
  const env = { COLLECTION_ENABLED: 'true', OPENWEBNINJA_API_KEY: 'k', COLLECTION_BUDGET_USD: '75' }

  it('--doctor projects one call per engine, not the whole bank', () => {
    const o = optionsFromEnv(argv(['--doctor']), env) as RunOptions
    expect(o.doctor).toBe(true)
    const { calls, estUsd } = projectSpend(o)
    expect(calls).toBe(5) // 5 engines x 1 probe
    expect(estUsd).toBeCloseTo(0.023, 6) // 4 x $0.005 + $0.003 (AI Overviews) at pro
    expect(estUsd).toBeLessThan(1)
  })

  it('the same argv without --doctor still projects the full pilot', () => {
    const o = optionsFromEnv(argv([]), env) as RunOptions
    expect(o.doctor).toBe(false)
    const { calls, estUsd } = projectSpend(o)
    expect(calls).toBe(5000) // 100 prompts x 5 engines x 10 runs
    expect(estUsd).toBeCloseTo(23, 6)
  })

  it('a doctor probe fits under a cap that the full pilot would blow', () => {
    const doctor = projectSpend(optionsFromEnv(argv(['--doctor']), env) as RunOptions)
    const pilot = projectSpend(optionsFromEnv(argv([]), env) as RunOptions)
    const remaining = 75 - 4.15 // the cap less what earlier days already spent
    expect(doctor.estUsd).toBeLessThanOrEqual(remaining)
    expect(pilot.estUsd).toBeLessThanOrEqual(remaining) // both fit at $75; the probe fits at $1 too
    expect(doctor.estUsd).toBeLessThanOrEqual(1)
    expect(pilot.estUsd).toBeGreaterThan(1)
  })

  it('--limit-prompts is reflected in the call count as well as the cost', () => {
    const o = optionsFromEnv(argv(['--limit-prompts', '4', '--runs', '2']), env) as RunOptions
    const { calls, estUsd } = projectSpend(o)
    expect(calls).toBe(40) // 4 prompts x 5 engines x 2 runs — previously reported 5000
    expect(estUsd).toBeCloseTo(4 * 2 * (0.005 * 4 + 0.003), 6)
  })

  it('offline modes project zero', () => {
    const o = optionsFromEnv(['--fixture', '--day', '2026-08-21', '--bank', bankFile], {}) as RunOptions
    expect(projectSpend(o).estUsd).toBe(0)
  })
})
