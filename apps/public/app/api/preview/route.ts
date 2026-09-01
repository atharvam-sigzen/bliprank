import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENGINES } from '@bliprank/contracts'
import { defaultGateConfig } from '../../../../../services/grader/src/live-gate.js'
import { bankAuthorConfig } from '../../../../../services/grader/src/bank-author.js'
import { loadApiKey } from '../../../../../services/grader/src/load-key.js'
import { UNPROMPTED_INTENTS } from '../../../../../services/grader/src/scan.js'
import { resolveCategory } from '../../../../../services/grader/src/resolve-category.js'
import { DEFAULT_MAX_PREVIEWS_PER_HOUR, type PreviewResponse } from '@/lib/preview-contract'
import {
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
 */

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
const DATA = join(ROOT, 'services', 'grader', 'data-live')

const normalise = (d: string): string =>
  d.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '')

const previewThrottleConfig = (env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_PREVIEWS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_PREVIEWS_PER_HOUR),
  windowMs: Number(env['GRADER_VISITOR_WINDOW_MS'] ?? 60 * 60 * 1000),
  // A DIFFERENT FILE from the scan throttle's. Sharing one would mean three
  // previews used up the hour's three scans, so the feature that exists to make
  // scanning safer would instead make it impossible.
  ledgerFile: join(DATA, 'preview-throttle.json'),
})

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const { domain: raw } = (await req.json().catch(() => ({}))) as { domain?: string }
  const domain = normalise(String(raw ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Enter a domain, for example pipedrive.com' }, 400)

  const cfg = previewThrottleConfig(env)
  const verdict = checkVisitorThrottle(extractClientIp(req), cfg, new Date())
  if (!verdict.ok) {
    return json(
      {
        kind: 'preview-rate-limit',
        message: `You have looked up ${verdict.limit} domains in the last hour. Nothing was collected and nothing was charged; this limit resets in about ${verdict.resetInMinutes} minutes.`,
      },
      429,
    )
  }
  // Recorded BEFORE the work, not after. The cost this limit exists to bound is
  // the outbound fetch and the authoring call, and both happen below — counting
  // afterwards would let a burst of concurrent requests all pass the check and
  // then all spend. The scan route counts after for the opposite and equally
  // correct reason: there, a refusal genuinely spends nothing.
  mkdirSync(DATA, { recursive: true })
  recordVisitorScan(extractClientIp(req), cfg, new Date())

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
      ...(resolved.fallback ? { fallback: resolved.fallback } : {}),
      prompts: unprompted.slice(0, gate.callsPerEngine).map((p) => ({ text: p.text, intent: p.intent })),
      engines: [...ENGINES],
      competitors: resolved.bank.leaders.map((l) => l.name),
    }
    return json(body)
  } catch (e) {
    // Never a blank screen and never an invented category: say what broke.
    return json({ kind: 'failed', message: `The preview could not be built: ${(e as Error).message}` }, 500)
  }
}
