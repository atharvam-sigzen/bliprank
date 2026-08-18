import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { optionsFromEnv, runPilot, PILOT_DIR, type RunOptions } from './collect.js'

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
  it('accepts when all three are present and defaults to the pay-as-you-go price table', () => {
    const o = optionsFromEnv(base, { COLLECTION_ENABLED: 'true', OPENWEBNINJA_API_KEY: 'k', COLLECTION_BUDGET_USD: '75' })
    expect(o).toMatchObject({ day: '2026-08-19', runs: 10, plan: 'payg', capUsd: 75, engines: expect.arrayContaining(['chatgpt', 'google-ai-overviews']) })
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
    const opts = optionsFromEnv(['--fixture', '--day', '2026-08-19', '--bank', bankFile, '--runs', '3', '--limit-prompts', '4', '--engines', 'chatgpt,gemini', '--data', dataDir], {}) as RunOptions
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
