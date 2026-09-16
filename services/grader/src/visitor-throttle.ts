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

import { CORRUPT, fileLedgerDoc, type LedgerDoc } from './ledger-doc.js'
import type { LedgerStores } from './ledger-stores.js'
import { isIP } from 'node:net'
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
  /** Where the ledger lives; the file at `ledgerFile` when absent (MVP_PLAN B3b). */
  readonly ledger?: LedgerDoc
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

const docOf = (cfg: VisitorThrottleConfig): LedgerDoc => cfg.ledger ?? fileLedgerDoc(cfg.ledgerFile)
const shapeLedger = (raw: unknown): VisitorLedger => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as VisitorLedger) : {})
const readLedger = async (cfg: VisitorThrottleConfig): Promise<VisitorLedger> => {
  try {
    return shapeLedger(await docOf(cfg).read())
  } catch {
    // A corrupt ledger fails closed: treat as unknown/full rather than ignoring.
    return { __corrupt: [] } as unknown as VisitorLedger
  }
}

/** The visitor key when no proxy is trusted, or the trusted header is missing or malformed. */
export const DIRECT = 'direct'

/**
 * The one header each edge sets from the connection and strips or overwrites
 * from the client, checked against the provider's own documentation on
 * 2026-09-09:
 *
 *   cloudflare  `cf-connecting-ip` "provides the client IP address connecting to
 *               Cloudflare"; `X-Forwarded-For` is APPENDED to when the client
 *               already sent one, which is why Cloudflare recommends this header
 *               over it. (developers.cloudflare.com/fundamentals/reference/http-headers)
 *   vercel      Vercel overwrites `x-forwarded-for` and "do[es] not forward
 *               external IPs"; `x-vercel-forwarded-for` is the same value and
 *               survives a proxy placed on top of Vercel.
 *               (vercel.com/docs/headers/request-headers, last updated 2025-12-13)
 */
const TRUSTED_HEADER = { cloudflare: 'cf-connecting-ip', vercel: 'x-vercel-forwarded-for' } as const

/**
 * The visitor key for the throttle.
 *
 * ⚠️ A HEADER IS ONLY READ WHEN THE DEPLOYMENT NAMES THE PROXY THAT SETS IT.
 * `TRUSTED_PROXY=cloudflare|vercel` in the environment says which edge this
 * process sits behind, and only that edge's header is read. Anything else —
 * unset, misspelt, a local demo with no proxy — reads NO header and returns
 * `direct`, so every caller shares one bucket. That is fail-closed: a caller
 * who could choose their own header could be as many visitors as they liked
 * (the 2026-09-09 audit's top defect), whereas one shared bucket only ever
 * refuses too early. The preview route's global cap carries the real bound
 * either way.
 *
 * A trusted header whose value is not an IP address is treated as absent.
 */
export function extractClientIp(headersOrReq: Headers | Request, env: NodeJS.ProcessEnv = process.env): string {
  const headers = headersOrReq instanceof Request ? headersOrReq.headers : headersOrReq
  const proxy = env['TRUSTED_PROXY']
  if (proxy !== 'cloudflare' && proxy !== 'vercel') return DIRECT
  const value = headers.get(TRUSTED_HEADER[proxy])?.split(',')[0]?.trim() ?? ''
  return isIP(value) ? value : DIRECT
}

/** Timestamps of live scans within the rolling window for this visitor IP. */
export async function visitorScansInWindow(
  ip: string,
  cfg: VisitorThrottleConfig,
  now: Date = new Date(),
): Promise<readonly number[]> {
  const l = await readLedger(cfg)
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
export async function checkVisitorThrottle(
  ip: string,
  cfg: VisitorThrottleConfig,
  now: Date = new Date(),
): Promise<VisitorVerdict> {
  const active = await visitorScansInWindow(ip, cfg, now)
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
export async function recordVisitorScan(
  ip: string,
  cfg: VisitorThrottleConfig,
  now: Date = new Date(),
): Promise<void> {
  await docOf(cfg).update((raw) => {
    const base: VisitorLedger = raw === CORRUPT ? {} : shapeLedger(raw)
    const cutoff = now.getTime() - cfg.windowMs
    const current = (base[ip] ?? []).filter((t) => typeof t === 'number' && t > cutoff)
    current.push(now.getTime())
    const next: VisitorLedger = { ...base, [ip]: current }
    return next
  })
}

export const defaultVisitorThrottleConfig = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  ledgers?: LedgerStores,
): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_SCANS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_SCANS_PER_VISITOR_PER_HOUR),
  windowMs: Number(env['GRADER_VISITOR_WINDOW_MS'] ?? DEFAULT_VISITOR_WINDOW_MS),
  ledgerFile: join(dataDir, 'visitor-throttle.json'),
  ...(ledgers ? { ledger: ledgers.doc('visitor-throttle.json') } : {}),
})
