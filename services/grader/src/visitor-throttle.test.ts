import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DIRECT,
  checkVisitorThrottle,
  defaultVisitorThrottleConfig,
  extractClientIp,
  recordVisitorScan,
  visitorScansInWindow,
  type VisitorThrottleConfig,
} from './visitor-throttle.js'

/**
 * Per-visitor rate limiting, tested against the states it exists to enforce.
 *
 * Rules:
 *   1. Allows live scans under the configured limit per rolling window.
 *   2. Refuses once the limit is reached with an honest, specific message.
 *   3. Expiry is rolling: timestamps older than windowMs drop off.
 *   4. Refusal costs nothing and never touches the shared global ledger.
 *   5. Fails closed on a corrupt ledger.
 *   6. Respects proxy headers across Cloudflare and Vercel environments.
 */

const tempDir = () => mkdtempSync(join(tmpdir(), 'visitor-throttle-'))
const createCfg = (over: Partial<VisitorThrottleConfig> = {}): VisitorThrottleConfig => ({
  ...defaultVisitorThrottleConfig(tempDir(), {} as NodeJS.ProcessEnv),
  ...over,
})

const NOW = new Date('2026-08-25T12:00:00.000Z')

describe('the client IP is read only from the header the named proxy sets', () => {
  // Every header a caller could write, all at once. Only the trusted one may be read.
  const everything = () =>
    new Headers({
      'cf-connecting-ip': '203.0.113.195',
      'x-vercel-forwarded-for': '198.51.100.42, 10.0.0.1',
      'x-real-ip': '198.51.100.99',
      'x-forwarded-for': '192.0.2.55, 10.0.0.2',
    })
  const env = (proxy?: string) => ({ ...(proxy === undefined ? {} : { TRUSTED_PROXY: proxy }) }) as NodeJS.ProcessEnv

  it('⚠️ with no trusted proxy, NO header is read: every caller is one bucket', () => {
    expect(extractClientIp(everything(), env())).toBe(DIRECT)
    expect(extractClientIp(new Headers(), env())).toBe(DIRECT)
  })

  it('a misspelt or unknown proxy name fails closed, not open', () => {
    expect(extractClientIp(everything(), env('cloudfare'))).toBe(DIRECT)
    expect(extractClientIp(everything(), env('nginx'))).toBe(DIRECT)
  })

  it('behind Cloudflare only cf-connecting-ip counts', () => {
    expect(extractClientIp(everything(), env('cloudflare'))).toBe('203.0.113.195')
    const without = everything()
    without.delete('cf-connecting-ip')
    expect(extractClientIp(without, env('cloudflare'))).toBe(DIRECT)
  })

  it('behind Vercel only x-vercel-forwarded-for counts, first entry', () => {
    expect(extractClientIp(everything(), env('vercel'))).toBe('198.51.100.42')
    const without = everything()
    without.delete('x-vercel-forwarded-for')
    expect(extractClientIp(without, env('vercel'))).toBe(DIRECT)
  })

  it('a trusted header that is not an IP address is treated as absent', () => {
    expect(extractClientIp(new Headers({ 'cf-connecting-ip': 'not-an-ip' }), env('cloudflare'))).toBe(DIRECT)
    expect(extractClientIp(new Headers({ 'cf-connecting-ip': '' }), env('cloudflare'))).toBe(DIRECT)
    expect(extractClientIp(new Headers({ 'cf-connecting-ip': '2001:db8::1' }), env('cloudflare'))).toBe('2001:db8::1')
  })

  it('accepts a Request object directly', () => {
    const req = new Request('http://localhost/api/scan', { headers: { 'cf-connecting-ip': '198.51.100.77' } })
    expect(extractClientIp(req, env('cloudflare'))).toBe('198.51.100.77')
  })
})

describe('per-visitor throttle window and limit logic', () => {
  it('allows scans under the limit and tracks remaining quota', () => {
    const cfg = createCfg({ maxScansPerHour: 3 })
    const ip = '198.51.100.1'

    expect(checkVisitorThrottle(ip, cfg, NOW)).toEqual({ ok: true, remaining: 3, limit: 3 })

    recordVisitorScan(ip, cfg, NOW)
    expect(checkVisitorThrottle(ip, cfg, NOW)).toEqual({ ok: true, remaining: 2, limit: 3 })

    recordVisitorScan(ip, cfg, NOW)
    expect(checkVisitorThrottle(ip, cfg, NOW)).toEqual({ ok: true, remaining: 1, limit: 3 })
  })

  it('refuses once the limit is exhausted and explains why honestly', () => {
    const cfg = createCfg({ maxScansPerHour: 2, windowMs: 3600_000 })
    const ip = '198.51.100.2'

    recordVisitorScan(ip, cfg, NOW)
    recordVisitorScan(ip, cfg, new Date(NOW.getTime() + 10 * 60_000))

    const verdict = checkVisitorThrottle(ip, cfg, new Date(NOW.getTime() + 15 * 60_000))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('visitor-rate-limit')
      expect(verdict.used).toBe(2)
      expect(verdict.limit).toBe(2)
      // Oldest scan was at NOW, so reset is at NOW + 60m (45m left)
      expect(verdict.resetInMinutes).toBe(45)
      expect(verdict.message).toContain('per-visitor limit of 2 live scan(s) per hour')
      expect(verdict.message).toContain('individual rate limit for this visitor, not the shared daily demo budget')
      expect(verdict.message).toContain('resets in ~45 minute(s)')
      expect(verdict.message).toContain('Domains that have already been scanned are cached and still load instantly')
    }
  })

  it('resets as scans age out of the rolling window', () => {
    const cfg = createCfg({ maxScansPerHour: 2, windowMs: 3600_000 })
    const ip = '198.51.100.3'

    // First scan at T=0
    recordVisitorScan(ip, cfg, NOW)
    // Second scan at T=30m
    recordVisitorScan(ip, cfg, new Date(NOW.getTime() + 30 * 60_000))

    // At T=45m: both inside window -> blocked
    expect(checkVisitorThrottle(ip, cfg, new Date(NOW.getTime() + 45 * 60_000)).ok).toBe(false)

    // At T=65m: first scan (at T=0) has rolled off, second scan (at T=30m) is still active -> allowed (1 active)
    const at65m = checkVisitorThrottle(ip, cfg, new Date(NOW.getTime() + 65 * 60_000))
    expect(at65m).toEqual({ ok: true, remaining: 1, limit: 2 })

    // At T=95m: second scan (at T=30m) has also rolled off -> fully open (2 remaining)
    const at95m = checkVisitorThrottle(ip, cfg, new Date(NOW.getTime() + 95 * 60_000))
    expect(at95m).toEqual({ ok: true, remaining: 2, limit: 2 })
  })

  it('keeps visitor IP tallies isolated from each other', () => {
    const cfg = createCfg({ maxScansPerHour: 1 })
    const ipA = '192.0.2.10'
    const ipB = '192.0.2.20'

    recordVisitorScan(ipA, cfg, NOW)
    expect(checkVisitorThrottle(ipA, cfg, NOW).ok).toBe(false)
    expect(checkVisitorThrottle(ipB, cfg, NOW).ok).toBe(true)
  })

  it('FAILS CLOSED on a corrupt ledger file', () => {
    const cfg = createCfg({ maxScansPerHour: 3 })
    writeFileSync(cfg.ledgerFile, '{ corrupt json')

    const verdict = checkVisitorThrottle('127.0.0.1', cfg, NOW)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('visitor-rate-limit')
      expect(verdict.used).toBe(3)
    }
  })

  it('is configurable via environment variables', () => {
    const custom = defaultVisitorThrottleConfig('/tmp', {
      GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR: '5',
      GRADER_VISITOR_WINDOW_MS: '1800000',
    } as unknown as NodeJS.ProcessEnv)
    expect(custom.maxScansPerHour).toBe(5)
    expect(custom.windowMs).toBe(1800_000)
  })
})

describe('visitor throttle persistence and isolation from global ledger', () => {
  it('persists timestamps in the visitor ledger file', () => {
    const cfg = createCfg({ maxScansPerHour: 3 })
    const ip = '198.51.100.5'

    recordVisitorScan(ip, cfg, NOW)
    expect(existsSync(cfg.ledgerFile)).toBe(true)

    const raw = JSON.parse(readFileSync(cfg.ledgerFile, 'utf8')) as Record<string, number[]>
    expect(raw[ip]).toEqual([NOW.getTime()])
  })

  it('refusal never writes to the visitor ledger or touches the shared gate ledger', () => {
    const dir = tempDir()
    const cfg = defaultVisitorThrottleConfig(dir, {} as NodeJS.ProcessEnv)
    const ip = '198.51.100.9'

    // Fill the limit
    for (let i = 0; i < cfg.maxScansPerHour; i++) {
      recordVisitorScan(ip, cfg, NOW)
    }

    const beforeStats = readFileSync(cfg.ledgerFile, 'utf8')

    // Check throttle while full: refused
    const verdict = checkVisitorThrottle(ip, cfg, NOW)
    expect(verdict.ok).toBe(false)

    // Ledger file must be unchanged
    const afterStats = readFileSync(cfg.ledgerFile, 'utf8')
    expect(afterStats).toBe(beforeStats)

    // Global burst-cap ledger must not even exist
    const globalLedger = join(dir, 'live-cap.json')
    expect(existsSync(globalLedger)).toBe(false)
  })
})
