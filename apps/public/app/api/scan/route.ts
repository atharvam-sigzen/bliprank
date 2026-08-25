import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINES } from '@bliprank/contracts'
import { checkGate, defaultGateConfig, recordScan } from '../../../../../services/grader/src/live-gate.js'
import { loadApiKey } from '../../../../../services/grader/src/load-key.js'
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

const enabled = (env: NodeJS.ProcessEnv) => env['COLLECTION_ENABLED'] === 'true' && env['GRADER_LIVE_SCAN'] === 'true'

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

  const send = (stream: ReadableStreamDefaultController, event: string, data: unknown) =>
    stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))

  const stream = new ReadableStream({
    async start(c) {
      try {
        if (!domain) {
          send(c, 'error', { kind: 'input', message: 'Enter a domain, for example pipedrive.com' })
          return c.close()
        }

        // 1. CACHE FIRST, ALWAYS. A repeat of the same domain must never re-spend
        //    quota — with 50 requests a month and 17 per engine per scan, one
        //    accidental re-submit is a sixth of the month.
        const hit = cached(domain)
        if (hit) {
          send(c, 'cached', { domain })
          send(c, 'result', hit)
          return c.close()
        }

        if (!enabled(env)) {
          send(c, 'error', {
            kind: 'disabled',
            message: 'Live scanning is off. This build serves scans a runner already produced; nothing here contacts a provider.',
          })
          return c.close()
        }

        const found = loadApiKey(ROOT, env)
        if (!found) {
          send(c, 'error', { kind: 'config', message: 'No provider key is configured, so a live scan cannot run.' })
          return c.close()
        }

        // 2. THE GATE. Burst cap and the provider's own remaining quota, both
        //    checked before anything is spent, both failing closed.
        const cfg = defaultGateConfig(DATA, env)
        send(c, 'stage', { stage: 'checking quota' })
        const gate = await checkGate(domain, cfg, found.key, new Date())
        if (!gate.ok) {
          send(c, 'error', { kind: gate.reason, message: gate.message })
          return c.close()
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
          capUsd: Number(env['GRADER_CAP_USD'] ?? 2),
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
        c.close()
      } catch (e) {
        // Never a blank screen and never a substituted number: say what broke.
        send(c, 'error', { kind: 'failed', message: `The scan stopped: ${(e as Error).message}` })
        c.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive' },
  })
}
