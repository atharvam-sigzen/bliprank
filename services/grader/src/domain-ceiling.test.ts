import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGINES } from '@bliprank/contracts'
import {
  CYCLES_PER_MONTH,
  DEFAULT_CELLS_PER_CYCLE,
  RETRY_HEADROOM,
  checkDomainCeiling,
  cyclesThisMonth,
  defaultDomainCeilingConfig,
  recordDomainCycle,
  resetDate,
  runAllowanceFor,
  type DomainCeilingConfig,
} from './domain-ceiling.js'

/**
 * The per-domain ceiling on HAND-STARTED cycles, denominated in cycles, and
 * the per-run allowance that bounds each cycle's calls (ADR-0017, 2026-09-07).
 * ⚠️ HUMAN-OWNED AREA. Synthetic ledgers; nothing spends.
 */

let dir: string
let cfg: DomainCeilingConfig
const SEP = new Date('2026-09-10T12:00:00.000Z')
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-ceiling-'))
  cfg = { maxCyclesPerMonth: 2, ledgerFile: join(dir, 'domain-ceiling.json') }
})
afterEach(async () => rmSync(dir, { recursive: true, force: true }))

describe('the ceiling counts hand-started cycles, and records the calls each realised', () => {
  it('starts at zero, admits a cycle, books the realised calls beside the count', async () => {
    expect(await checkDomainCeiling('acme.test', cfg, SEP)).toMatchObject({ ok: true, cycles: 0, calls: 0, limit: 2 })
    await recordDomainCycle('acme.test', 97, cfg, SEP)
    expect(await cyclesThisMonth('acme.test', cfg, SEP)).toEqual({ cycles: 1, calls: 97 })
    expect(await checkDomainCeiling('acme.test', cfg, SEP)).toMatchObject({ ok: true, cycles: 1, calls: 97 })
  })

  it('refuses the cycle after the count is reached, naming cycles and the reset date, whatever the cycle size', async () => {
    await recordDomainCycle('acme.test', 160, cfg, SEP)
    await recordDomainCycle('acme.test', 160, cfg, SEP)
    const v = await checkDomainCeiling('acme.test', cfg, SEP)
    expect(v).toMatchObject({ ok: false, reason: 'domain-ceiling', cycles: 2, limit: 2, resetsOn: '2026-10-01' })
    if (v.ok) return
    expect(v.message).toContain('has reached its 2 hand-started cycles')
    // The figures are the verdict's, never the sentence's: the ledger is deployment-wide, and a count may be another workspace's (B3b tenancy audit).
    expect(v.message).not.toMatch(/\d+ provider requests|started \d+ of/)
    expect(v).toMatchObject({ cycles: 2, limit: 2 })
  })

  it('a cycle served entirely from cache made no call and is not a cycle against the count', async () => {
    await recordDomainCycle('acme.test', 0, cfg, SEP)
    expect(await cyclesThisMonth('acme.test', cfg, SEP)).toEqual({ cycles: 0, calls: 0 })
  })

  it('holds one domain down without touching another', async () => {
    await recordDomainCycle('acme.test', 85, cfg, SEP)
    await recordDomainCycle('acme.test', 85, cfg, SEP)
    expect((await checkDomainCeiling('acme.test', cfg, SEP)).ok).toBe(false)
    expect((await checkDomainCeiling('beta.test', cfg, SEP)).ok).toBe(true)
  })
})

describe('the month boundary', () => {
  it('resets on the first of the next UTC month; a domain held down in September scans in October; only the current month is kept', async () => {
    expect(resetDate(SEP)).toBe('2026-10-01')
    await recordDomainCycle('acme.test', 85, cfg, SEP)
    await recordDomainCycle('acme.test', 85, cfg, SEP)
    const OCT = new Date('2026-10-01T00:00:01.000Z')
    expect(await checkDomainCeiling('acme.test', cfg, OCT)).toMatchObject({ ok: true, cycles: 0 })
    await recordDomainCycle('acme.test', 85, cfg, OCT)
    const file = JSON.parse(readFileSync(cfg.ledgerFile, 'utf8')) as Record<string, unknown>
    expect(Object.keys(file)).toEqual(['2026-10'])
  })
})

describe('failure modes', () => {
  it('a corrupt ledger refuses THIS request without taking the month down for a repair', async () => {
    mkdirSync(dirname(cfg.ledgerFile), { recursive: true })
    writeFileSync(cfg.ledgerFile, '{ not json')
    expect((await checkDomainCeiling('acme.test', cfg, SEP)).ok).toBe(false)
    await recordDomainCycle('acme.test', 85, cfg, SEP)
    expect(await checkDomainCeiling('acme.test', cfg, SEP)).toMatchObject({ ok: true, cycles: 1 })
  })

  it('a bare call count from before the split reads as the nearest number of cycles at the size in force, at least one', async () => {
    mkdirSync(dirname(cfg.ledgerFile), { recursive: true })
    writeFileSync(cfg.ledgerFile, JSON.stringify({ '2026-09': { 'acme.test': 97, 'beta.test': 170, 'gamma.test': -4 } }))
    expect(await cyclesThisMonth('acme.test', cfg, SEP)).toEqual({ cycles: 1, calls: 97 })
    expect(await cyclesThisMonth('beta.test', cfg, SEP)).toEqual({ cycles: 2, calls: 170 })
    expect(await cyclesThisMonth('gamma.test', cfg, SEP)).toEqual({ cycles: 0, calls: 0 })
    expect((await checkDomainCeiling('beta.test', cfg, SEP)).ok).toBe(false)
    // Two 10-prompt cycles under the old ledger were 102 calls; at the size in force (50 cells) that is two cycles, not one.
    const ten: DomainCeilingConfig = { ...cfg, legacyCellsPerCycle: 50 }
    writeFileSync(cfg.ledgerFile, JSON.stringify({ '2026-09': { 'acme.test': 102 } }))
    expect(await cyclesThisMonth('acme.test', ten, SEP)).toEqual({ cycles: 2, calls: 102 })
    expect(defaultDomainCeilingConfig(dir, { GRADER_PROMPTS_PER_SCAN: '10' }).legacyCellsPerCycle).toBe(50)
  })

  it('a nonsense entry reads as zero rather than throwing', async () => {
    mkdirSync(dirname(cfg.ledgerFile), { recursive: true })
    writeFileSync(cfg.ledgerFile, JSON.stringify({ '2026-09': { 'acme.test': { cycles: 'two', calls: null } } }))
    expect(await cyclesThisMonth('acme.test', cfg, SEP)).toEqual({ cycles: 0, calls: 0 })
  })
})

describe('the two constants and what they bound (ADR-0013, ADR-0017)', () => {
  it('two hand-started cycles a month; the per-run allowance is the cycle’s cells with headroom, 102 at 17 prompts on five engines', async () => {
    expect(CYCLES_PER_MONTH).toBe(2)
    expect(DEFAULT_CELLS_PER_CYCLE).toBe(17 * ENGINES.length)
    expect(runAllowanceFor(DEFAULT_CELLS_PER_CYCLE)).toBe(Math.ceil(85 * RETRY_HEADROOM))
    expect(runAllowanceFor(DEFAULT_CELLS_PER_CYCLE)).toBe(102)
    expect(runAllowanceFor(160)).toBe(192)
  })

  it('the count is a count: the environment may override it with an integer of cycles, never calls', async () => {
    expect(defaultDomainCeilingConfig(dir, {}).maxCyclesPerMonth).toBe(2)
    expect(defaultDomainCeilingConfig(dir, { GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH: '4' }).maxCyclesPerMonth).toBe(4)
    expect(defaultDomainCeilingConfig(dir, { GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH: '204' }).maxCyclesPerMonth).toBe(204)
    expect(defaultDomainCeilingConfig(dir, { GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH: '0' }).maxCyclesPerMonth).toBe(2)
    expect(defaultDomainCeilingConfig(dir, { GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH: 'lots' }).maxCyclesPerMonth).toBe(2)
    // The pre-split key is an error, not a silence: a person who set 400 calls must not get two cycles with no word said.
    expect(() => defaultDomainCeilingConfig(dir, { GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH: '400' })).toThrow(/no longer read/)
  })
})
