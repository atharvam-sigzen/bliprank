import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINES } from '@bliprank/contracts'
import { DEFAULT_CAP_USD, checkGate, defaultGateConfig, recordScan } from '../../../../../services/grader/src/live-gate.js'
import { loadApiKey, readFlag } from '../../../../../services/grader/src/load-key.js'
import { runGrader } from '../../../../../services/grader/src/run.js'

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

const ROOT = join(process.cwd(), '..', '..')
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

        // 2. THE GATE. Burst cap and the provider's own remaining quota, both
        //    checked before anything is spent, both failing closed.
        const cfg = defaultGateConfig(DATA, env)
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
          dataDir: DATA,
          outFile: join(DATA, 'latest.json'),
          log: () => {},
          onProgress: (e) => send(c, 'progress', e),
        })

        // 3. Only a scan that actually reached the provider counts against the
        //    burst cap. A classification refusal spends nothing and must not
        //    consume the day's allowance.
        if (result.status === 'scanned' || result.status === 'no-answers') recordScan(domain, cfg, new Date())

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
