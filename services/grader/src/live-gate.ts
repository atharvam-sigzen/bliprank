/**
 * The gate a live Grader scan must pass before it may spend anything.
 *
 * WHY A DAILY COUNTER ALONE IS THE WRONG SHAPE. A cap of "2 new domains a day"
 * permits 60 scans a month. Each engine's free tier is 50 REQUESTS a month and a
 * full scan draws 17 from every engine, so the real ceiling is two scans for the
 * WHOLE month, not two a day. A counter that cannot see the quota would wave
 * through the run that exhausts it, on the morning of the demo.
 *
 * So there are two independent limits and a scan needs both:
 *
 *   1. the provider's own remaining quota, read live from `/usage` — free, and
 *      authoritative in a way a local tally never is (it survives a deleted
 *      ledger, a second checkout, another machine sharing the key);
 *   2. a local burst cap, which is what stops a double-submit or a rehearsal
 *      click from eating the month before anyone is watching.
 *
 * Neither substitutes for the other. The quota check is the truth; the burst cap
 * is the thing that catches the accident before the truth has to.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENGINES, type EngineId } from '@bliprank/contracts'

export const USAGE_URL = 'https://api.openwebninja.com/usage'

/**
 * The USD ceiling both entry points open the ledger with.
 *
 * `Budget` refuses to widen a cap silently, which is correct — but it means the
 * CLI and the route have to agree or the second one to run is refused. They did
 * not: the route defaulted to 2 and the documented CLI command passes 5, so
 * whichever ran second failed. It surfaced as a dead scan rather than a review
 * comment, which is the wrong place to find out.
 */
export const DEFAULT_CAP_USD = 5

/** Provider api_id -> our EngineId. `ai_answers` is a separate aggregate product. */
const API_ID: Record<string, EngineId> = {
  chatgpt: 'chatgpt',
  gemini: 'gemini',
  copilot: 'copilot',
  google_ai_mode: 'google-ai-mode',
  ai_overviews: 'google-ai-overviews',
}

export interface EngineQuota {
  readonly engine: EngineId
  readonly used: number
  readonly limit: number
  readonly remaining: number
  readonly resetAt: string
}

/**
 * Live remaining quota per engine.
 *
 * Undocumented endpoint, found by probing while diagnosing a 403 — the provider
 * publishes no quota headers on its answer endpoints, so this is the only way to
 * know what is left without spending to find out. It costs nothing and is not
 * itself metered.
 */
export async function readQuota(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<readonly EngineQuota[]> {
  const res = await fetchImpl(USAGE_URL, { headers: { 'x-api-key': apiKey, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`)
  const body = (await res.json()) as { data?: { items?: readonly { api_id: string; quotas?: readonly { used: number; limit: number; remaining: number; reset_at: string }[] }[] } }
  const out: EngineQuota[] = []
  for (const item of body.data?.items ?? []) {
    const engine = API_ID[item.api_id]
    const q = item.quotas?.[0]
    if (!engine || !q) continue
    out.push({ engine, used: q.used, limit: q.limit, remaining: q.remaining, resetAt: q.reset_at })
  }
  return out
}

export interface GateConfig {
  /** New (uncached) domains allowed per UTC day. */
  readonly maxNewPerDay: number
  /** Calls one scan will draw from EVERY engine — prompts x runs. */
  readonly callsPerEngine: number
  readonly ledgerFile: string
  readonly engines: readonly EngineId[]
}

export type GateVerdict =
  | { readonly ok: true; readonly quota: readonly EngineQuota[] }
  | { readonly ok: false; readonly reason: 'burst-cap'; readonly message: string; readonly used: readonly string[]; readonly limit: number }
  | { readonly ok: false; readonly reason: 'quota'; readonly message: string; readonly short: readonly EngineQuota[] }
  | { readonly ok: false; readonly reason: 'unreadable'; readonly message: string }

interface Ledger {
  [utcDay: string]: string[]
}

const readLedger = (f: string): Ledger => {
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Ledger) : {}
  } catch {
    // A corrupt ledger must not open the gate. Treat it as "today is unknown",
    // which the burst cap then reads as a full day already spent.
    return { __corrupt: [] } as unknown as Ledger
  }
}

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10)

/** Domains already scanned live today, in order. */
export function scannedToday(cfg: GateConfig, now: Date): readonly string[] {
  const l = readLedger(cfg.ledgerFile)
  if ('__corrupt' in l) return Array.from({ length: cfg.maxNewPerDay }, (_, i) => `unknown-${i}`)
  return l[utcDay(now)] ?? []
}

/**
 * May this domain be collected live right now?
 *
 * A domain already scanned today passes the burst cap — re-running it is what
 * the cache serves anyway, and refusing a repeat would be refusing the free path.
 */
export async function checkGate(
  domain: string,
  cfg: GateConfig,
  apiKey: string,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<GateVerdict> {
  const today = scannedToday(cfg, now)
  if (!today.includes(domain) && today.length >= cfg.maxNewPerDay) {
    return {
      ok: false,
      reason: 'burst-cap',
      message: `The demo cap of ${cfg.maxNewPerDay} new domains a day has been reached (${today.join(', ')}). Those are cached and can be re-shown for free; a different domain needs the cap raised.`,
      used: today,
      limit: cfg.maxNewPerDay,
    }
  }

  let quota: readonly EngineQuota[]
  try {
    quota = await readQuota(apiKey, fetchImpl)
  } catch (e) {
    // Fail CLOSED. Not knowing the remaining quota is not permission to spend it.
    return { ok: false, reason: 'unreadable', message: `Could not read the provider's remaining quota (${(e as Error).message}), so this scan is refused rather than run blind.` }
  }

  const needed = cfg.callsPerEngine
  const covered = quota.filter((q) => cfg.engines.includes(q.engine))
  const short = covered.filter((q) => q.remaining < needed)
  const missing = cfg.engines.filter((e) => !covered.some((q) => q.engine === e))
  if (missing.length > 0) {
    return { ok: false, reason: 'quota', message: `No active subscription found for: ${missing.join(', ')}. Subscribe on the provider dashboard, then try again.`, short: [] }
  }
  if (short.length > 0) {
    const detail = short.map((q) => `${q.engine} has ${q.remaining} of ${q.limit} left`).join(', ')
    return { ok: false, reason: 'quota', message: `A full scan needs ${needed} requests per engine and ${detail}. Quota resets ${short[0]!.resetAt.slice(0, 10)}.`, short }
  }
  return { ok: true, quota }
}

/** Record a domain as collected today. Called only after a scan actually spends. */
export function recordScan(domain: string, cfg: GateConfig, now: Date = new Date()): void {
  const l = readLedger(cfg.ledgerFile)
  const day = utcDay(now)
  const list = ('__corrupt' in l ? {} : l)[day] ?? []
  if (!list.includes(domain)) list.push(domain)
  const next: Ledger = { ...('__corrupt' in l ? {} : l), [day]: list }
  mkdirSync(dirname(cfg.ledgerFile), { recursive: true })
  writeFileSync(cfg.ledgerFile, JSON.stringify(next, null, 2) + '\n')
}

export const defaultGateConfig = (dataDir: string, env: NodeJS.ProcessEnv = process.env): GateConfig => ({
  maxNewPerDay: Number(env['GRADER_MAX_NEW_SCANS_PER_DAY'] ?? 2),
  callsPerEngine: Number(env['GRADER_PROMPTS_PER_SCAN'] ?? 17),
  ledgerFile: join(dataDir, 'live-cap.json'),
  engines: [...ENGINES],
})
