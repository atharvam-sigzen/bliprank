import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENGINES } from '@bliprank/contracts'
import { classifyDomain } from '@bliprank/taxonomy'
import { defaultGateConfig } from '../../../../../services/grader/src/live-gate.js'
import { bankAuthorConfig } from '../../../../../services/grader/src/bank-author.js'
import { loadApiKey } from '../../../../../services/grader/src/load-key.js'
import { UNPROMPTED_INTENTS, subjectFor } from '../../../../../services/grader/src/scan.js'
import { allBanks, allCategories, readCategoryRecord, resolveCategory } from '../../../../../services/grader/src/resolve-category.js'
import { competitorsFor } from '../../../../../services/grader/src/competitor-overrides.js'
import { DEFAULT_MAX_PREVIEWS_PER_HOUR, type PreviewResponse } from '@/lib/preview-contract'
import {
  DEFAULT_VISITOR_WINDOW_MS,
  checkVisitorThrottle,
  extractClientIp,
  recordVisitorScan,
  type VisitorThrottleConfig,
} from '../../../../../services/grader/src/visitor-throttle.js'

/**
 * THE PROMPT PREVIEW — what a scan would ask, before it is allowed to ask it.
 *
 * The Grader used to submit straight to collection: type a domain, press a
 * button, and seventeen prompts across five engines were bought. Which category
 * you had been put in, and which questions had been asked on your behalf, were
 * discoverable only afterwards, on a settings page, on a different screen. That
 * is backwards for the two reasons that matter here.
 *
 * FOR THE VISITOR: the category IS the measurement. "You are mentioned in 12% of
 * answers" means nothing until you know which answers, and a reader who
 * disagrees with the category should find that out before the number is drawn,
 * not while trying to reconcile it. Provenance travels with the number (R8) —
 * this is the same rule applied one step earlier, to the thing the number is
 * about.
 *
 * FOR THE QUOTA: this is the confirmation step whose absence three separate
 * comments in this repo lament ("on a public box with no confirmation step,
 * that turns one fat-fingered paste into the rest of the month's quota"). A
 * preview is a free, reversible look at exactly what the expensive step will
 * do.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THIS ROUTE SPENDS NO PROVIDER QUOTA, AND IT IS NOT FREE.
 *
 * It makes at most one outbound GET to the visitor's own domain (through the
 * SSRF boundary in `fetch-site.ts`) and, for a domain in no known category, one
 * model call to author a bank. Neither touches OpenWeb Ninja, so neither is
 * governed by `checkGate` — which is exactly why it needs its own limit rather
 * than inheriting one. An unthrottled endpoint that fetches an arbitrary URL on
 * request is a traffic amplifier pointed at whoever the caller names.
 *
 * So it reuses `checkVisitorThrottle` against a SEPARATE ledger with a higher
 * ceiling: previewing is meant to be cheap and repeatable, scanning is not, and
 * one shared counter would make looking at your prompts cost you a scan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE VISITOR THROTTLE TRUSTS A HEADER THE CALLER WRITES, so it is not the
 * bound. `extractClientIp` reads `cf-connecting-ip` / `x-forwarded-for`, which
 * a real edge sets and strips, and which on the local demo — or any deployment
 * without a proxy in front — are whatever the request says they are. A loop
 * that changes the header per request is as many "visitors" as it likes, and
 * the throttle above sees each of them once. Found by the ADR-0014 review on
 * `/api/gaps` and fixed there first; this is the same fix.
 *
 * What a caller could make the machine do, unbounded: read one homepage per
 * distinct domain named (a fetch proxy for arbitrary hosts, one GET each) and
 * author a bank for each (a free-tier model call, and a record and a bank file
 * on disk, per domain). Not twice per domain — a failed read still records a
 * fallback, records are write-once, and a recorded domain resolves at rung 0
 * with no fetch — so the vector is breadth, not depth.
 *
 * So the bound that does not trust the caller is GLOBAL: this many previews
 * that would actually cost — an unrecorded domain the host alone cannot
 * classify — per rolling hour, across everyone, on one ledger, plus a cap on
 * how many may be in flight at once. A recorded or host-classified domain
 * costs nothing outbound and is not counted against it, so the ordinary path
 * (preview the domain you are about to scan) is unaffected until an attack is
 * actually under way, and the refusal says which limit it hit.
 */

/** Previews that would fetch a homepage or author a bank, per hour, across every caller. */
const DEFAULT_MAX_COSTING_PREVIEWS_PER_HOUR = 60
const MAX_IN_FLIGHT = 2
let inFlight = 0

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const resolveRoot = (): string => {
  let curr = process.cwd()
  while (curr && curr !== dirname(curr)) {
    if (existsSync(join(curr, 'services', 'grader'))) return curr
    curr = dirname(curr)
  }
  return join(process.cwd(), '..', '..')
}
const ROOT = resolveRoot()
/** Per request, so a test can point the route at a scratch directory through `GRADER_DATA_DIR`. */
const dataDir = (env: NodeJS.ProcessEnv): string => env['GRADER_DATA_DIR'] || join(ROOT, 'services', 'grader', 'data-live')

const normalise = (d: string): string =>
  d.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '')

const previewThrottleConfig = (DATA: string, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_PREVIEWS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_PREVIEWS_PER_HOUR),
  windowMs: Number(env['GRADER_VISITOR_WINDOW_MS'] ?? 60 * 60 * 1000),
  // A DIFFERENT FILE from the scan throttle's. Sharing one would mean three
  // previews used up the hour's three scans, so the feature that exists to make
  // scanning safer would instead make it impossible.
  ledgerFile: join(DATA, 'preview-throttle.json'),
})

/** The same rolling-window machinery under one shared key: the bound that does not care who asked. */
const globalCapConfig = (DATA: string, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_COSTING_PREVIEWS_PER_HOUR'] ?? DEFAULT_MAX_COSTING_PREVIEWS_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: join(DATA, 'preview-global-cap.json'),
})
const GLOBAL_KEY = '*'

/**
 * Would previewing this domain fetch a page or call a model? Rung 0 (a
 * record) and rungs 1 and 2 (the host alone classifies it) cost nothing
 * outbound; everything else reaches the homepage and, failing that, the
 * author. Decided the way `resolveCategory` decides it, from the same inputs.
 */
const wouldCost = (DATA: string, domain: string): boolean =>
  readCategoryRecord(DATA, domain) === null && classifyDomain(domain, allBanks(DATA), allCategories(DATA)).status !== 'classified'

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const { domain: raw } = (await req.json().catch(() => ({}))) as { domain?: string }
  const domain = normalise(String(raw ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Enter a domain, for example pipedrive.com' }, 400)

  const DATA = dataDir(env)
  const now = new Date()
  const cfg = previewThrottleConfig(DATA, env)
  const verdict = checkVisitorThrottle(extractClientIp(req), cfg, now)
  if (!verdict.ok) {
    return json(
      {
        kind: 'preview-rate-limit',
        message: `You have looked up ${verdict.limit} domains in the last hour. Nothing was collected and nothing was charged; this limit resets in about ${verdict.resetInMinutes} minutes.`,
      },
      429,
    )
  }
  mkdirSync(DATA, { recursive: true })

  // THE BOUND THAT DOES NOT TRUST THE CALLER. Only for a preview that would
  // actually fetch or author; a recorded or host-classified domain is free and
  // passes untouched, so an exhausted cap never stops the ordinary path.
  const costs = wouldCost(DATA, domain)
  const global = globalCapConfig(DATA, env)
  if (costs) {
    const capVerdict = checkVisitorThrottle(GLOBAL_KEY, global, now)
    if (!capVerdict.ok) {
      return json(
        {
          kind: 'preview-global-cap',
          message: `This service has already read ${global.maxScansPerHour} new domains' homepages in the last hour, which is its ceiling for everyone combined. Nothing was fetched, collected or charged; it resets in about ${capVerdict.resetInMinutes} minutes. A domain that has already been looked up still previews instantly.`,
        },
        429,
      )
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      return json({ kind: 'preview-busy', message: 'The preview service is busy reading other homepages. Try again in a moment; nothing was fetched.' }, 503)
    }
  }
  // Recorded BEFORE the work, not after. The cost this limit exists to bound is
  // the outbound fetch and the authoring call, and both happen below — counting
  // afterwards would let a burst of concurrent requests all pass the check and
  // then all spend. The scan route counts after for the opposite and equally
  // correct reason: there, a refusal genuinely spends nothing.
  recordVisitorScan(extractClientIp(req), cfg, now)
  if (costs) recordVisitorScan(GLOBAL_KEY, global, now)

  if (costs) inFlight += 1
  try {
    const resolved = await resolveCategory(domain, {
      dataDir: DATA,
      // Model, provider and key all from the environment — ADR-0009 Amendment 1.
      // `loadApiKey` is passed as the reader so the author's key comes out of the
      // same repo-root `.env.local` as every other secret, with the same
      // precedence and the same CRLF handling.
      author: bankAuthorConfig(env, (n) => loadApiKey(ROOT, env, n)?.key) ?? undefined,
      /*
       * TO THE SERVER CONSOLE, NOT SWALLOWED.
       *
       * This used to be `() => {}`, which silenced the one diagnostic that
       * matters most here. Authoring runs against free tiers that get
       * rate-limited and withdrawn, and every failure degrades SILENTLY to the
       * general bucket by design — so with the log discarded, "the model has
       * been dead for a week" and "no domain happened to need a new category"
       * look identical from outside. The line names the model, the status and
       * the provider's own message.
       *
       * Server-side only. Nothing here reaches the response, and the response
       * already says which category was chosen and why.
       */
      log: (m) => console.warn(`[preview] ${m}`),
    })

    const gate = defaultGateConfig(DATA, env)
    // The same filter and the same slice `runScan` applies, so what is shown is
    // what runs. Deriving it a second way here is how a preview drifts from the
    // scan it previews and becomes worse than no preview at all.
    const unprompted = resolved.bank.prompts.filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent))

    const competitorSet = competitorsFor(DATA, domain, resolved.bank, subjectFor(domain, resolved.bank, resolved.record.brandName).spec.id) ?? { competitors: [], missing: [] }
    const body: PreviewResponse = {
      domain,
      category: resolved.bank.category,
      categoryName: resolved.bank.displayName,
      categoryDescription: resolved.bank.description,
      source: resolved.record.source,
      evidence: resolved.record.evidence,
      previouslyDecided: resolved.fromRecord,
      verified: resolved.bank.verified,
      generated: resolved.record.generated,
      decidedAt: resolved.record.decidedAt,
      version: resolved.record.version,
      ...(resolved.record.correction ? { correction: resolved.record.correction } : {}),
      ...(resolved.fallback ? { fallback: resolved.fallback } : {}),
      prompts: unprompted.slice(0, gate.callsPerEngine).map((p) => ({ text: p.text, intent: p.intent })),
      engines: [...ENGINES],
      // The subject is not its own rival. `runScan` drops the leader the domain
      // matched from the comparison set (scan.ts); a preview that listed it
      // promised an eight-bar chart the scan draws with seven, with the reader's
      // own brand named as one of the brands they will be ranked against.
      // The domain's override laid over the category's set, when one is in force (ADR-0016): what a scan would measure against.
      competitors: competitorSet.competitors.map((l) => l.name),
      ...(competitorSet.set !== undefined ? { competitorSet: competitorSet.set } : {}),
    }
    return json(body)
  } catch (e) {
    // Never a blank screen and never an invented category: say what broke.
    return json({ kind: 'failed', message: `The preview could not be built: ${(e as Error).message}` }, 500)
  } finally {
    if (costs) inFlight -= 1
  }
}
