import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENGINES } from '@bliprank/contracts'
import { DEFAULT_CAP_USD, checkGate, defaultGateConfig, recordScan } from '../../../../../services/grader/src/live-gate.js'
import { bankAuthorConfig } from '../../../../../services/grader/src/bank-author.js'
import { checkDomainCeiling, defaultDomainCeilingConfig, recordDomainCalls } from '../../../../../services/grader/src/domain-ceiling.js'
import { loadApiKey, readFlag } from '../../../../../services/grader/src/load-key.js'
import { runGrader } from '../../../../../services/grader/src/run.js'
import {
  checkVisitorThrottle,
  defaultVisitorThrottleConfig,
  extractClientIp,
  recordVisitorScan,
} from '../../../../../services/grader/src/visitor-throttle.js'

/**
 * Live Grader scans, for a demo, over Server-Sent Events.
 *
 * ⚠️ OFF BY DEFAULT AND DELIBERATELY SO. A public form wired to collection is an
 * unauthenticated, unmetered spend trigger, and P3.6 — Turnstile and the per-IP
 * cap — does not exist. This route refuses unless BOTH `COLLECTION_ENABLED` and
 * `GRADER_LIVE_SCAN` are exactly 'true', which is two deliberate acts rather
 * than one forgotten flag. With either unset the page falls back to the
 * committed scan and nothing here can run.
 *
 * ⚠️ LOCAL DEMO ONLY. ADR-0002 puts this app on Cloudflare Pages as static
 * assets precisely because it sits on traffic nobody can forecast. A route
 * handler is a server, and shipping one changes that decision — which needs an
 * ADR and P3.6, not a flag.
 *
 * SSE rather than a request that returns in 90 seconds: G3 allows p95 ≤ 90s
 * domain-to-first-insight, and a browser staring at a pending fetch for that
 * long is indistinguishable from a hung page. Progress is emitted per cell.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

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
const RESULTS = join(DATA, 'results')

/**
 * Both flags, resolved the same way the API key is: environment first, then the
 * repo-root `.env.local`.
 *
 * ⚠️ THIS WAS BROKEN AND SILENT. It read `process.env` only, but Next loads env
 * files from the directory it runs in — `apps/public` — and never from the repo
 * root where `.env.local` actually lives. So editing the documented file
 * (CLAUDE.md §7) changed nothing, produced no error, and the page just went on
 * saying live scanning was off. A safety flag that cannot be turned on by the
 * documented method is not a safety property, it is a bug that happens to fail
 * closed.
 *
 * Still TWO flags, still both required, and `sources` records where each came
 * from so "is it on, and why" is answerable without guessing.
 */
const resolveFlags = (env: NodeJS.ProcessEnv) => {
  const collection = readFlag(ROOT, 'COLLECTION_ENABLED', env)
  const live = readFlag(ROOT, 'GRADER_LIVE_SCAN', env)
  return {
    enabled: collection.value === 'true' && live.value === 'true',
    sources: `COLLECTION_ENABLED=${collection.value ?? 'unset'} (${collection.from}), GRADER_LIVE_SCAN=${live.value ?? 'unset'} (${live.from})`,
  }
}

const normalise = (d: string): string =>
  d.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '')

const resultFile = (domain: string) => join(RESULTS, `${domain.replace(/[^a-z0-9.-]/g, '_')}.json`)

/** A finished scan for this domain, if one was ever produced. */
function cached(domain: string): unknown | null {
  const f = resultFile(domain)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const visitorIp = extractClientIp(req)
  const { domain: raw } = (await req.json().catch(() => ({}))) as { domain?: string }
  const domain = normalise(String(raw ?? ''))

  // A browser that closes the tab mid-scan closes the stream, and every
  // subsequent enqueue throws. Unguarded, that exception unwound the whole scan
  // — discarding answers already PAID FOR and leaving the run lock held, so
  // every later scan was refused with "another scan holds run.lock". The work is
  // bought: it finishes and caches whether or not anyone is still watching.
  let open = true
  const send = (stream: ReadableStreamDefaultController, event: string, data: unknown) => {
    if (!open) return
    try {
      stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    } catch {
      open = false
    }
  }
  const done = (stream: ReadableStreamDefaultController) => {
    if (!open) return
    open = false
    try {
      stream.close()
    } catch {
      /* the client already went away */
    }
  }

  const stream = new ReadableStream({
    async start(c) {
      try {
        if (!domain) {
          send(c, 'error', { kind: 'input', message: 'Enter a domain, for example pipedrive.com' })
          return done(c)
        }

        // 1. CACHE FIRST, ALWAYS. A repeat of the same domain must never re-spend
        //    quota — with 50 requests a month and 17 per engine per scan, one
        //    accidental re-submit is a sixth of the month.
        const hit = cached(domain)
        if (hit) {
          send(c, 'cached', { domain })
          send(c, 'result', hit)
          return done(c)
        }

        const flags = resolveFlags(env)
        if (!flags.enabled) {
          send(c, 'error', {
            kind: 'disabled',
            // Says WHICH flag is off and where it was read from. The previous
            // message could not distinguish "deliberately off" from "your edit
            // never loaded", which is the failure that actually happened.
            message: `Live scanning is off, so nothing was collected. Resolved: ${flags.sources}. Both must be "true" in the environment or in the repo-root .env.local.`,
          })
          return done(c)
        }

        const found = loadApiKey(ROOT, env)
        if (!found) {
          send(c, 'error', { kind: 'config', message: 'No provider key is configured, so a live scan cannot run.' })
          return done(c)
        }

        // 2. PER-VISITOR THROTTLE. Checked before checkGate so that a throttled
        //    visitor never touches the provider-quota check or the shared daily
        //    burst cap. Rejection here costs nothing and touches no shared state.
        const visitorCfg = defaultVisitorThrottleConfig(DATA, env)
        const visitorVerdict = checkVisitorThrottle(visitorIp, visitorCfg, new Date())
        if (!visitorVerdict.ok) {
          send(c, 'error', { kind: visitorVerdict.reason, message: visitorVerdict.message })
          return done(c)
        }

        // 3. THE PER-DOMAIN CEILING. Between the visitor throttle and the
        //    gate, because it is cheaper than the gate (no HTTP) and narrower
        //    than the visitor throttle (one subject, not one browser). A retry
        //    storm on one domain is many scans from many IPs over many hours,
        //    which is invisible to both of its neighbours here.
        const cfg = defaultGateConfig(DATA, env)
        const ceilingCfg = defaultDomainCeilingConfig(DATA, env)
        const ceiling = checkDomainCeiling(domain, cfg.callsPerEngine * ENGINES.length, ceilingCfg, new Date())
        if (!ceiling.ok) {
          send(c, 'error', { kind: ceiling.reason, message: ceiling.message })
          return done(c)
        }

        // 4. THE GATE. Burst cap and the provider's own remaining quota, both
        //    checked before anything is spent, both failing closed.
        send(c, 'stage', { stage: 'checking quota' })
        const gate = await checkGate(domain, cfg, found.key, new Date())
        if (!gate.ok) {
          send(c, 'error', { kind: gate.reason, message: gate.message })
          return done(c)
        }

        send(c, 'stage', { stage: 'classifying' })

        const total = cfg.callsPerEngine * ENGINES.length
        send(c, 'begin', { domain, total, engines: ENGINES.length, prompts: cfg.callsPerEngine })

        // runGrader, not a hand-rolled orchestrator: it carries the run lock,
        // the spend ledger, the rate budget and the topology declaration. A
        // second wiring of those here would be a second thing to keep correct,
        // and the one most likely to drift is the one that spends money.
        const result = await runGrader({
          domain,
          engines: [...ENGINES],
          day: new Date().toISOString().slice(0, 10),
          plan: (env['OPENWEBNINJA_PLAN'] as 'payg' | 'pro' | 'ultra' | 'mega') ?? 'payg',
          mode: 'live',
          apiKey: found.key,
          capUsd: Number(env['GRADER_CAP_USD'] ?? DEFAULT_CAP_USD),
          maxPrompts: cfg.callsPerEngine,
          // Authoring a category, when the taxonomy has none for this domain.
          // Almost always a no-op by the time a scan runs: the preview step has
          // already resolved and RECORDED the category, so `resolveCategory`
          // stops at rung 0 and no model is called. It is passed anyway because
          // a scan reached directly — a client that skips the preview — must not
          // silently get a worse classification than one that did not.
          author: bankAuthorConfig(env, (n) => loadApiKey(ROOT, env, n)?.key) ?? undefined,
          dataDir: DATA,
          outFile: join(DATA, 'latest.json'),
          // Progress is streamed to the client through `onProgress` below, so a
          // second copy on stdout would be noise. The resolver's own log is lost
          // with it, and that is acceptable HERE and only here: by the time a
          // scan runs, the preview has already resolved and recorded the
          // category, so authoring is a no-op on this path. A client that skips
          // the preview loses the diagnostic, not the degradation.
          log: () => {},
          onProgress: (e) => send(c, 'progress', e),
        })

        // 5. Only a scan that actually reached the provider counts against the
        //    burst cap and visitor rate limit. A classification refusal spends
        //    nothing and must not consume allowances.
        //
        //    The domain ceiling books the REALISED call count, not the planned
        //    one — retries included — because under-counting retries is exactly
        //    the failure it exists to catch. It is booked whenever any call was
        //    made, including on a failed scan: a scan that burned 40 requests
        //    and returned nothing still burned 40 requests.
        if (result.status === 'scanned' || result.status === 'no-answers') {
          recordScan(domain, cfg, new Date())
          recordVisitorScan(visitorIp, visitorCfg, new Date())
        }
        if ('counts' in result && result.counts.providerCalls > 0) {
          recordDomainCalls(domain, result.counts.providerCalls, ceilingCfg, new Date())
        }

        // 6. CACHE THE ENVELOPE, NOT A BARE RESULT. What is written here is
        //    read back by the Grader, the dashboard and the agency portfolio,
        //    and it must carry a run block or those pages cannot say which day,
        //    which engines or what it cost. `runGrader` returns one — mode,
        //    plan, day, engines, cap, and the spend its own ledger recorded,
        //    which is the only place that figure exists. It is written whole or
        //    not at all: a partial block with an invented spentUsd would print
        //    a cost this scan did not incur.
        if (result.status === 'scanned') {
          mkdirSync(RESULTS, { recursive: true })
          writeFileSync(resultFile(domain), JSON.stringify(result, null, 2) + '\n')
        }

        send(c, 'result', result)
        done(c)
      } catch (e) {
        // Never a blank screen and never a substituted number: say what broke.
        send(c, 'error', { kind: 'failed', message: `The scan stopped: ${(e as Error).message}` })
        done(c)
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive' },
  })
}
