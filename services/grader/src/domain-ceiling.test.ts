import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_CALLS_PER_DOMAIN_PER_MONTH,
  callsThisMonth,
  checkDomainCeiling,
  defaultDomainCeilingConfig,
  recordDomainCalls,
  resetDate,
  utcMonth,
} from './domain-ceiling.js'

let dir: string
let cfg: ReturnType<typeof defaultDomainCeilingConfig>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-ceiling-'))
  cfg = { maxCallsPerMonth: 100, ledgerFile: join(dir, 'domain-ceiling.json') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const SEP = new Date('2026-09-15T12:00:00.000Z')
const OCT = new Date('2026-10-02T12:00:00.000Z')

describe('the ceiling counts calls, not scans', () => {
  it('starts at zero and admits a scan that fits', () => {
    const v = checkDomainCeiling('acme.com', 85, cfg, SEP)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.used).toBe(0)
    expect(v.remaining).toBe(15)
  })

  it('books the REALISED call count, so retries are visible', () => {
    // The whole point. A limit denominated in scans cannot tell a clean scan
    // from one that retried every cell twice, and the retry storm is the
    // scenario this exists for.
    recordDomainCalls('acme.com', 85, cfg, SEP)
    recordDomainCalls('acme.com', 40, cfg, SEP) // a partial, failed, retried run
    expect(callsThisMonth('acme.com', cfg, SEP)).toBe(125)
  })

  it('refuses the scan that would cross the line, rather than half-collecting it', () => {
    recordDomainCalls('acme.com', 90, cfg, SEP)
    const v = checkDomainCeiling('acme.com', 85, cfg, SEP)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toBe('domain-ceiling')
    expect(v.used).toBe(90)
    // The refusal is actionable: what it is, when it lifts, and what still works.
    expect(v.message).toContain('per-domain ceiling')
    expect(v.message).toContain('2026-10-01')
    expect(v.message).toContain('nothing was charged')
    expect(v.message).toContain('cache')
  })

  it('holds one domain down without touching another', () => {
    // A shared counter here would make the busiest domain everyone else's
    // problem, which is the failure being prevented, not the mechanism.
    recordDomainCalls('acme.com', 100, cfg, SEP)
    expect(checkDomainCeiling('acme.com', 1, cfg, SEP).ok).toBe(false)
    expect(checkDomainCeiling('other.com', 85, cfg, SEP).ok).toBe(true)
  })
})

describe('the month boundary', () => {
  it('resets on the first of the next UTC month, matching the provider cycle', () => {
    expect(utcMonth(SEP)).toBe('2026-09')
    expect(resetDate(SEP)).toBe('2026-10-01')
    // December rolls the year, which is the arithmetic most likely to be wrong.
    expect(resetDate(new Date('2026-12-20T00:00:00.000Z'))).toBe('2027-01-01')
  })

  it('a domain held down in September scans freely in October', () => {
    recordDomainCalls('acme.com', 100, cfg, SEP)
    expect(checkDomainCeiling('acme.com', 85, cfg, SEP).ok).toBe(false)
    expect(checkDomainCeiling('acme.com', 85, cfg, OCT).ok).toBe(true)
  })

  it('keeps only the current month, so the ledger cannot grow forever', () => {
    recordDomainCalls('acme.com', 50, cfg, SEP)
    recordDomainCalls('acme.com', 10, cfg, OCT)
    expect(callsThisMonth('acme.com', cfg, OCT)).toBe(10)
    expect(callsThisMonth('acme.com', cfg, SEP)).toBe(0)
  })
})

describe('failure modes', () => {
  it('a corrupt ledger refuses THIS request without taking the month down', () => {
    /*
     * Deliberately different from live-gate's and visitor-throttle's "treat as
     * full". Those refuse the one allowance they guard; this one is keyed by
     * domain, so the same reflex would refuse every domain for the rest of the
     * month over one bad byte.
     */
    mkdirSync(dir, { recursive: true })
    writeFileSync(cfg.ledgerFile, '{ not json')
    expect(callsThisMonth('acme.com', cfg, SEP)).toBe(cfg.maxCallsPerMonth)
    expect(checkDomainCeiling('acme.com', 1, cfg, SEP).ok).toBe(false)
    // And a write repairs it rather than compounding the corruption.
    recordDomainCalls('acme.com', 5, cfg, SEP)
    expect(callsThisMonth('acme.com', cfg, SEP)).toBe(5)
  })

  it('ignores a nonsense call count rather than writing it', () => {
    recordDomainCalls('acme.com', 0, cfg, SEP)
    recordDomainCalls('acme.com', -5, cfg, SEP)
    recordDomainCalls('acme.com', Number.NaN, cfg, SEP)
    recordDomainCalls('', 10, cfg, SEP)
    expect(callsThisMonth('acme.com', cfg, SEP)).toBe(0)
  })

  it('treats a hand-edited negative or non-numeric entry as zero', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(cfg.ledgerFile, JSON.stringify({ '2026-09': { 'acme.com': -400, 'b.com': 'lots' } }))
    // A negative would otherwise buy an attacker headroom by hand-editing.
    expect(callsThisMonth('acme.com', cfg, SEP)).toBe(0)
    expect(callsThisMonth('b.com', cfg, SEP)).toBe(0)
  })
})

describe('the default is a backstop, not the operating limit', () => {
  it('leaves room for more than one full five-engine scan', () => {
    // 17 prompts x 5 engines = 85. The ceiling must not fire on a domain's
    // SECOND legitimate scan, or it is a feature limit wearing a safety label.
    expect(DEFAULT_MAX_CALLS_PER_DOMAIN_PER_MONTH).toBeGreaterThanOrEqual(170)
  })

  it('is below what one domain would need to exhaust a free engine tier', () => {
    // The free tier is 50 requests per engine per month; a full scan draws 17
    // from each. The property that matters is that no single domain can empty
    // one engine's allowance on its own.
    const perEngine = Math.floor(DEFAULT_MAX_CALLS_PER_DOMAIN_PER_MONTH / 5)
    expect(perEngine).toBeLessThan(50)
  })

  it('reads its ceiling from the environment, so it can be raised deliberately', () => {
    const c = defaultDomainCeilingConfig(dir, { GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH: '9' } as NodeJS.ProcessEnv)
    expect(c.maxCallsPerMonth).toBe(9)
  })
})
