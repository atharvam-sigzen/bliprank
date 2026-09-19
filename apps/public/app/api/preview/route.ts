import { mkdirSync } from 'node:fs'
import { ENGINES, normalisePrompt } from '@bliprank/contracts'
import { classifyDomain, normaliseHost } from '@bliprank/taxonomy'
import { defaultGateConfig } from '../../../../../services/grader/src/live-gate.js'
import { bankAuthorConfig } from '../../../../../services/grader/src/bank-author.js'
import { loadApiKey } from '../../../../../services/grader/src/load-key.js'
import { UNPROMPTED_INTENTS, subjectFor } from '../../../../../services/grader/src/scan.js'
import { allBanks, allCategories, resolveCategory } from '../../../../../services/grader/src/resolve-category.js'
import { competitorsIn } from '../../../../../services/grader/src/competitor-overrides.js'
import { categoryRecordIn, customPromptsIn, recordsIn } from '../../../../../services/grader/src/store/documents.js'
import type { WorkspaceStore } from '../../../../../services/grader/src/store/pg-store.js'
import { ROOT } from '@/lib/data-dir'
import { workspaceAccess, type WorkspaceAccess } from '@/lib/workspace-access'
import { DEFAULT_MAX_PREVIEWS_PER_HOUR, type PreviewResponse } from '@/lib/preview-contract'
import { PREVIEW_FAILED } from '@/lib/route-errors'
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
 * ⚠️ THE VISITOR THROTTLE IS ONLY AS GOOD AS `TRUSTED_PROXY`. `extractClientIp`
 * reads one header, and only the one the named edge sets; with no proxy named
 * (the local demo, or a deployment nobody configured) every caller is one
 * bucket, which refuses early rather than never. A loop that changes headers
 * per request is therefore one visitor, not many — but the global bound below
 * is still the one that does not depend on configuration at all. Found by the
 * ADR-0014 review on `/api/gaps` and fixed there first; this is the same fix.
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




type Access = WorkspaceAccess & { ok: true }
const previewThrottleConfig = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_PREVIEWS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_PREVIEWS_PER_HOUR),
  windowMs: Number(env['GRADER_VISITOR_WINDOW_MS'] ?? 60 * 60 * 1000),
  // A DIFFERENT FILE from the scan throttle's. Sharing one would mean three
  // previews used up the hour's three scans, so the feature that exists to make
  // scanning safer would instead make it impossible.
  ledgerFile: `${access.dataDir}/preview-throttle.json`,
  ledger: access.ledgers.doc('preview-throttle.json'),
})

/** The same rolling-window machinery under one shared key: the bound that does not care who asked. */
const globalCapConfig = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_COSTING_PREVIEWS_PER_HOUR'] ?? DEFAULT_MAX_COSTING_PREVIEWS_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/preview-global-cap.json`,
  ledger: access.ledgers.doc('preview-global-cap.json'),
})
const GLOBAL_KEY = '*'

/**
 * Would previewing this domain fetch a page or call a model? Rung 0 (a
 * record) and rungs 1 and 2 (the host alone classifies it) cost nothing
 * outbound; everything else reaches the homepage and, failing that, the
 * author. Decided the way `resolveCategory` decides it, from the same inputs.
 */
const wouldCost = async (store: WorkspaceStore, DATA: string, domain: string): Promise<boolean> =>
  (await categoryRecordIn(store, domain)) === null && classifyDomain(domain, allBanks(DATA), allCategories(DATA)).status !== 'classified'

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const { domain: raw } = (await req.json().catch(() => ({}))) as { domain?: string }
  const domain = normaliseHost(String(raw ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Enter a domain, for example pipedrive.com' }, 400)

  // THE WORKSPACE IS THE SESSION'S (MVP_PLAN B3b): the record a preview
  // reads, and the one it writes on a first look, are the session's store.
  const access = await workspaceAccess(env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  const { store, ledgers, dataDir: DATA } = access
  // Any member of the workspace may preview an unrecorded domain: the first
  // category record it writes is a measurement's precondition, not a
  // decision (migration 0006, B3d item 2).
  const now = new Date()
  const cfg = previewThrottleConfig(access, env)
  const visitorIp = extractClientIp(req, env)
  const verdict = await checkVisitorThrottle(visitorIp, cfg, now)
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
  const costs = await wouldCost(store, DATA, domain)
  const global = globalCapConfig(access, env)
  if (costs) {
    const capVerdict = await checkVisitorThrottle(GLOBAL_KEY, global, now)
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
  await recordVisitorScan(visitorIp, cfg, now)
  if (costs) await recordVisitorScan(GLOBAL_KEY, global, now)

  if (costs) inFlight += 1
  try {
    const resolved = await resolveCategory(domain, {
      dataDir: DATA,
      records: recordsIn(store),
      // Model, provider and key all from the environment — ADR-0009 Amendment 1.
      // `loadApiKey` is passed as the reader so the author's key comes out of the
      // same repo-root `.env.local` as every other secret, with the same
      // precedence and the same CRLF handling.
      author: bankAuthorConfig(env, (n) => loadApiKey(ROOT, env, n)?.key, DATA, ledgers) ?? undefined,
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

    const gate = defaultGateConfig(DATA, env, ledgers)
    // The same filter and the same slice `runScan` applies, so what is shown is
    // what runs. Deriving it a second way here is how a preview drifts from the
    // scan it previews and becomes worse than no preview at all.
    const unprompted = resolved.bank.prompts.filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent))
    // The domain's current set (ADR-0016 Amendment 1, C3 step 2): the person's
    // own latest version once one exists, the bank's on first entry. A kept
    // bank prompt keeps its intent; one the person wrote is theirs.
    const set = await customPromptsIn(store, domain)
    // Keyed by the ONE normaliser, the cache key's (C3r item 10): the scan decides "this is the bank's prompt" with it (`scan.ts`
    // `intentOf`), and trim-and-lowercase here disagreed with it on a trailing "?" or a doubled space, so the preview called a
    // prompt the person's own and the record then filed it under the bank's question type.
    const bankIntent = new Map(resolved.bank.prompts.map((p) => [normalisePrompt(p.text), p.intent]))
    const shown = set && set.prompts.length ? set.prompts.map((text) => ({ text, intent: bankIntent.get(normalisePrompt(text)) ?? 'own' })) : unprompted.slice(0, gate.callsPerEngine).map((p) => ({ text: p.text, intent: p.intent }))

    const competitorSet = (await competitorsIn(store, DATA, domain, resolved.bank, subjectFor(domain, resolved.bank, resolved.record.brandName).spec.id)) ?? { competitors: [], missing: [] }
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
      prompts: shown,
      ...(set && set.prompts.length ? { promptSet: { version: set.version, count: set.prompts.length } } : {}),
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
    // Never a blank screen and never an invented category, and never the raw
    // error: the cause is logged server-side, the visitor gets a fixed line.
    console.error('[preview] failed', domain, e)
    return json({ kind: 'failed', message: PREVIEW_FAILED }, 500)
  } finally {
    if (costs) inFlight -= 1
  }
}
