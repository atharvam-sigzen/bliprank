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

/**
 * Prompts one scan sends to EVERY engine, when `GRADER_PROMPTS_PER_SCAN` is not
 * set. Named because the per-domain ceiling derives its default from it: a
 * cycle is this many prompts times the engine count, and a ceiling that did not
 * know the number silently shrank to one cycle a month when the number grew.
 */
export const DEFAULT_PROMPTS_PER_SCAN = 17

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

interface UsageQuota {
  readonly used: number
  readonly limit: number
  readonly remaining: number
  readonly reset_at: string
}
interface UsageItem {
  readonly api_id: string
  readonly quotas?: readonly UsageQuota[]
}

/**
 * Every quota row in a `/usage` body, whichever shape the provider is serving.
 *
 * ⚠️ THIS ENDPOINT HAS ALREADY CHANGED SHAPE ONCE UNDER US, which is why it is
 * parsed defensively rather than destructured. It is undocumented — found by
 * probing while diagnosing a 403 — and on 2026-09-01 it began answering the
 * bare URL with `400 Missing required parameter: api_id`. Every live scan was
 * refused from that moment, correctly and uselessly, because the aggregate call
 * this was written against no longer exists.
 *
 *   OLD  { data: { items: [ { api_id, quotas: [...] }, ... ] } }   one call, all
 *   NEW  { data: { api_id, plan, status, quotas: [...] } }         one call each
 *
 * Both are accepted. The old branch costs four lines and is not dead weight: a
 * provider that changed this once can change it back, and the failure mode is
 * total — no quota read means no scan runs at all.
 */
function usageItems(body: unknown): readonly UsageItem[] {
  const data = (body as { data?: unknown })?.data
  if (typeof data !== 'object' || data === null) return []
  const items = (data as { items?: unknown }).items
  if (Array.isArray(items)) return items as readonly UsageItem[]
  return typeof (data as UsageItem).api_id === 'string' ? [data as UsageItem] : []
}

/**
 * Live remaining quota per engine, one call per product.
 *
 * The provider publishes no quota headers on its answer endpoints, so this is
 * the only way to know what is left without spending to find out. `/usage` is
 * free and not itself metered, so five calls cost exactly what one did.
 *
 * ⚠️ FAILS CLOSED, AND THE TWO FAILURES ARE KEPT APART.
 *
 * A transport error or a non-2xx THROWS, naming the product — not knowing the
 * remaining quota is not permission to spend it, and `checkGate` turns that
 * into "could not read the quota, refused rather than run blind".
 *
 * A clean 2xx carrying no quota row is DIFFERENT and is not an error here: it
 * means the account holds no active subscription for that product. It is left
 * out of the result, and `checkGate` already reports exactly that, with the
 * action attached ("Subscribe on the provider dashboard"). Collapsing the two
 * would answer a subscription problem with a network message.
 */
export async function readQuota(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<readonly EngineQuota[]> {
  const bodies = await Promise.all(
    // The map's own keys: the set of products we collect from is defined once,
    // and a sixth engine added to API_ID is queried here without a second edit.
    Object.keys(API_ID).map(async (apiId) => {
      const url = `${USAGE_URL}?api_id=${encodeURIComponent(apiId)}`
      const res = await fetchImpl(url, { headers: { 'x-api-key': apiKey, Accept: 'application/json' } })
      // Named, because a partial failure is otherwise indistinguishable from a
      // total one and they need different fixes.
      if (!res.ok) throw new Error(`usage endpoint returned ${res.status} for ${apiId}`)
      return res.json()
    }),
  )

  const out: EngineQuota[] = []
  for (const body of bodies) {
    for (const item of usageItems(body)) {
      const engine = API_ID[item.api_id]
      const q = item.quotas?.[0]
      // `ai_answers` is a separate aggregate subscription this pipeline never
      // calls. Counting it would report quota we cannot actually spend.
      if (!engine || !q) continue
      // One product answers once. A duplicate would double-count nothing useful
      // and could only come from the old aggregate shape overlapping the new.
      if (out.some((e) => e.engine === engine)) continue
      out.push({ engine, used: q.used, limit: q.limit, remaining: q.remaining, resetAt: q.reset_at })
    }
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
    // Says what ran out, by how much, when it comes back, AND what still works.
    // A refusal that leaves someone with nothing to do next reads as a crash
    // even when it is correct — and this one will most likely be read by
    // somebody standing in front of an audience.
    return {
      ok: false,
      reason: 'quota',
      message: `The provider quota for this cycle is used up: a full scan needs ${needed} requests per engine and ${detail}. Quota resets ${short[0]!.resetAt.slice(0, 10)}. Nothing was collected and nothing was charged. Domains that have already been scanned are cached and still load instantly.`,
      short,
    }
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
  /*
   * Raised from 2 on 2026-08-25, deliberately, and it is now a RUNAWAY BACKSTOP
   * rather than the operating limit.
   *
   * The instruction was that the provider's own quota should be what stops a
   * scan, so the honest "quota exhausted, try again next cycle" message is what
   * a visitor sees. A local cap of 2 would pre-empt that with a different
   * refusal — accurate, but answering a question nobody asked. It is not removed
   * entirely: a cap of zero is a loop with no floor, and only SUCCESSFUL scans
   * are counted, so this cannot fire before the quota does under any normal
   * sequence.
   */
  maxNewPerDay: Number(env['GRADER_MAX_NEW_SCANS_PER_DAY'] ?? 12),
  callsPerEngine: Number(env['GRADER_PROMPTS_PER_SCAN'] ?? DEFAULT_PROMPTS_PER_SCAN),
  ledgerFile: join(dataDir, 'live-cap.json'),
  engines: [...ENGINES],
})
