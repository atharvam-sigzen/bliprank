/**
 * Per-visitor rate limiting for live Grader scans.
 *
 * WHY A PER-VISITOR THROTTLE IS NEEDED ON TOP OF THE GLOBAL GATE.
 *
 * `live-gate.ts` enforces the global rules: live provider quota and a daily
 * shared burst cap. But without per-visitor throttling, a single aggressive
 * browser or rapid re-submission can consume the entire shared daily budget
 * alone, locking out other demo visitors.
 *
 * This layer enforces a small rolling-window limit per visitor IP. It runs
 * BEFORE `checkGate`, so a throttled visitor:
 *
 *   1. never performs a provider `/usage` HTTP check;
 *   2. never touches the shared daily burst ledger;
 *   3. incurs zero spend and leaves the global budget intact for others.
 *
 * Repeat scans of already-cached domains bypass this throttle entirely because
 * cached results are answered before this check is reached.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_MAX_SCANS_PER_VISITOR_PER_HOUR = 3
export const DEFAULT_VISITOR_WINDOW_MS = 60 * 60 * 1000 // 1 rolling hour

export interface VisitorThrottleConfig {
  /** Maximum live (non-cached) scans allowed per visitor per rolling window. */
  readonly maxScansPerHour: number
  /** Rolling window duration in milliseconds. */
  readonly windowMs: number
  /** Path to the JSON ledger file. */
  readonly ledgerFile: string
}

export type VisitorVerdict =
  | { readonly ok: true; readonly remaining: number; readonly limit: number }
  | {
      readonly ok: false
      readonly reason: 'visitor-rate-limit'
      readonly message: string
      readonly used: number
      readonly limit: number
      readonly resetInMinutes: number
    }

interface VisitorLedger {
  [ip: string]: number[]
}

const readLedger = (f: string): VisitorLedger => {
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as VisitorLedger) : {}
  } catch {
    // A corrupt ledger fails closed: treat as unknown/full rather than ignoring.
    return { __corrupt: [] } as unknown as VisitorLedger
  }
}

/**
 * Resolves the client IP address from standard and platform-specific proxy headers.
 * - Cloudflare Pages / Workers: `cf-connecting-ip` (ADR-0002 deployment target)
 * - Vercel: `x-vercel-forwarded-for`, `x-real-ip`
 * - Standard reverse proxies: `x-forwarded-for` (client is the first entry)
 */
export function extractClientIp(headersOrReq: Headers | Request): string {
  const headers = headersOrReq instanceof Request ? headersOrReq.headers : headersOrReq

  const cf = headers.get('cf-connecting-ip')
  if (cf?.trim()) return cf.trim()

  const vercel = headers.get('x-vercel-forwarded-for')
  if (vercel?.trim()) return vercel.split(',')[0]!.trim()

  const realIp = headers.get('x-real-ip')
  if (realIp?.trim()) return realIp.trim()

  const xff = headers.get('x-forwarded-for')
  if (xff?.trim()) return xff.split(',')[0]!.trim()

  return '127.0.0.1'
}

/** Timestamps of live scans within the rolling window for this visitor IP. */
export function visitorScansInWindow(
  ip: string,
  cfg: VisitorThrottleConfig,
  now: Date = new Date(),
): readonly number[] {
  const l = readLedger(cfg.ledgerFile)
  if ('__corrupt' in l) {
    return Array.from({ length: cfg.maxScansPerHour }, () => now.getTime())
  }
  const cutoff = now.getTime() - cfg.windowMs
  const timestamps = l[ip] ?? []
  return timestamps.filter((t) => typeof t === 'number' && t > cutoff)
}

/**
 * Checks whether this visitor IP is permitted to start a new live scan.
 *
 * Runs before `checkGate`: a refused request returns an honest explanation,
 * costs nothing, and does not touch the shared global ledger.
 */
export function checkVisitorThrottle(
  ip: string,
  cfg: VisitorThrottleConfig,
  now: Date = new Date(),
): VisitorVerdict {
  const active = visitorScansInWindow(ip, cfg, now)
  if (active.length >= cfg.maxScansPerHour) {
    const oldest = Math.min(...active)
    const resetMs = Math.max(0, oldest + cfg.windowMs - now.getTime())
    const resetInMinutes = Math.max(1, Math.ceil(resetMs / 60_000))
    return {
      ok: false,
      reason: 'visitor-rate-limit',
      message: `You have reached the per-visitor limit of ${cfg.maxScansPerHour} live scan(s) per hour. This is an individual rate limit for this visitor, not the shared daily demo budget. Your limit resets in ~${resetInMinutes} minute(s). Nothing was collected and nothing was charged. Domains that have already been scanned are cached and still load instantly.`,
      used: active.length,
      limit: cfg.maxScansPerHour,
      resetInMinutes,
    }
  }

  return {
    ok: true,
    remaining: cfg.maxScansPerHour - active.length,
    limit: cfg.maxScansPerHour,
  }
}

/** Record a successful or attempted spend by this visitor IP in the rolling window. */
export function recordVisitorScan(
  ip: string,
  cfg: VisitorThrottleConfig,
  now: Date = new Date(),
): void {
  const l = readLedger(cfg.ledgerFile)
  const base: VisitorLedger = '__corrupt' in l ? {} : l
  const cutoff = now.getTime() - cfg.windowMs
  const current = (base[ip] ?? []).filter((t) => typeof t === 'number' && t > cutoff)
  current.push(now.getTime())
  const next: VisitorLedger = { ...base, [ip]: current }
  mkdirSync(dirname(cfg.ledgerFile), { recursive: true })
  writeFileSync(cfg.ledgerFile, JSON.stringify(next, null, 2) + '\n')
}

export const defaultVisitorThrottleConfig = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_SCANS_PER_VISITOR_PER_HOUR),
  windowMs: Number(env['GRADER_VISITOR_WINDOW_MS'] ?? DEFAULT_VISITOR_WINDOW_MS),
  ledgerFile: join(dataDir, 'visitor-throttle.json'),
})
