/**
 * One raw diagnostic call per engine, with EVERYTHING the provider returned.
 *
 * `--doctor` truncates the body to 500 chars and drops the response headers,
 * and the headers are where quota, plan and rate-limit state normally live. On
 * a 403 the body is also the only place the provider names which product it
 * thinks is unsubscribed, which is the fact that decides what to do next.
 *
 * ⚠️ IT SPENDS, SO IT IS BUDGETED LIKE EVERYTHING ELSE THAT SPENDS (R3). Every
 * probe is charged to the store's own `ledger.json` through the collector's
 * `Budget` BEFORE the request leaves — the same ledger, the same cap and the
 * same per-run allowance a scan gets (here: one attempt per engine, no
 * retries). The 2026-09-09 audit found this file reaching all five paid
 * endpoints with the key behind nothing but `COLLECTION_ENABLED`, which every
 * agent session injects. It now also needs `GRADER_LIVE_SCAN=true`, like every
 * other live path, and the pre-spend hook blocks it from an agent session
 * regardless.
 *
 *   COLLECTION_ENABLED=true GRADER_LIVE_SCAN=true pnpm grader:diagnose            # all five
 *   COLLECTION_ENABLED=true GRADER_LIVE_SCAN=true pnpm grader:diagnose -- chatgpt # just one
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Budget, BudgetExceeded, PRICE_USD_PER_CALL, type OwnPlan } from '@bliprank/collector'
import { ENGINES, type EngineId } from '@bliprank/contracts'
import { DEFAULT_BASE_URL } from '../../collector/src/adapters/openwebninja.js'
import { ledgerCapUsd } from './live-gate.js'
import { loadApiKey, readFlag } from './load-key.js'

const REQ: Record<EngineId, { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; query?: Record<string, string> }> = {
  chatgpt: { method: 'POST', path: '/chatgpt/chat', body: { message: 'What is the best CRM for a small business?', markdown: true } },
  gemini: { method: 'POST', path: '/gemini/chat', body: { message: 'What is the best CRM for a small business?', markdown: true } },
  copilot: { method: 'POST', path: '/copilot/copilot', body: { message: 'What is the best CRM for a small business?', mode: 'CHAT', markdown: true } },
  'google-ai-mode': { method: 'GET', path: '/google-ai-mode/ai-mode', query: { prompt: 'What is the best CRM for a small business?', gl: 'us', hl: 'en' } },
  'google-ai-overviews': { method: 'GET', path: '/ai-overviews/ai-overviews', query: { q: 'What is the best CRM for a small business?', gl: 'us', hl: 'en' } },
}

export interface DiagnoseDeps {
  /** Charged once per probe, before the request. A refusal stops the run. */
  readonly budget: Pick<Budget, 'charge'>
  readonly fetchImpl?: typeof fetch
  readonly log?: (line: string) => void
}

async function probe(engine: EngineId, key: string, deps: DiagnoseDeps): Promise<void> {
  const log = deps.log ?? console.log
  const doFetch = deps.fetchImpl ?? fetch
  const spec = REQ[engine]
  const url = new URL(DEFAULT_BASE_URL + spec.path)
  for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.set(k, v)

  const started = Date.now()
  try {
    const res = await doFetch(url.toString(), {
      method: spec.method,
      headers: {
        'x-api-key': key,
        Accept: 'application/json',
        'User-Agent': 'bliprank-diagnose',
        ...(spec.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(spec.body ? { body: JSON.stringify(spec.body) } : {}),
    })
    const text = await res.text()
    log(`\n=== ${engine} — ${spec.method} ${spec.path} ===`)
    log(`  status  ${res.status} ${res.statusText}  (${Date.now() - started}ms)`)
    // Everything except the echo of our own credential.
    const shown = [...res.headers.entries()].filter(([k]) => !/^(set-cookie|x-api-key|authorization)$/i.test(k))
    for (const [k, v] of shown.sort()) log(`  ${k}: ${v}`)
    log(`  body: ${text.slice(0, 900)}`)
  } catch (e) {
    log(`\n=== ${engine} ===\n  network error: ${(e as Error).message}`)
  }
}

/**
 * Probe each engine in turn, charging the budget first. The first refusal
 * ends the run: a ledger that will not pay for the next probe is a fact worth
 * more than the probe, and nothing after it is attempted.
 */
export async function runDiagnose(engines: readonly EngineId[], key: string, deps: DiagnoseDeps): Promise<{ probed: EngineId[]; refused: EngineId[] }> {
  const log = deps.log ?? console.log
  const probed: EngineId[] = []
  const refused: EngineId[] = []
  for (const engine of engines) {
    try {
      deps.budget.charge(engine)
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e
      log(`\n=== ${engine} ===\n  refused before the request: ${e.message}`)
      refused.push(engine, ...engines.slice(engines.indexOf(engine) + 1))
      break
    }
    await probe(engine, key, deps)
    probed.push(engine)
  }
  return { probed, refused }
}

async function main(): Promise<void> {
  const env = process.env
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  for (const flag of ['COLLECTION_ENABLED', 'GRADER_LIVE_SCAN']) {
    if (readFlag(root, flag, env).value !== 'true') {
      console.error(`refusing: this makes real provider calls. ${flag} is not "true" in the environment or the repo-root .env.local.`)
      process.exit(2)
    }
  }
  const found = loadApiKey(root, env)
  if (!found) {
    console.error('refusing: no OPENWEBNINJA_API_KEY in the environment, .env.local or .env')
    process.exit(2)
  }
  console.log(`key: ${found.key.length} chars, from ${found.from}, prefix ${found.key.slice(0, 4)}...`)

  const plan = (env['OPENWEBNINJA_PLAN'] ?? 'payg') as OwnPlan
  if (!(plan in PRICE_USD_PER_CALL)) {
    console.error(`refusing: unknown OPENWEBNINJA_PLAN "${plan}"`)
    process.exit(2)
  }
  const arg = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0]
  const engines = arg ? [arg as EngineId] : [...ENGINES]
  for (const e of engines) {
    if (!(ENGINES as readonly string[]).includes(e)) {
      console.error(`unknown engine: ${e}`)
      process.exit(2)
    }
  }

  // The store's own ledger and its own cap (see `ledgerCapUsd`): a diagnostic
  // probe is a provider attempt like any other, and it is booked where every
  // other attempt is booked. The allowance is one attempt per engine.
  const dataDir = env['GRADER_DATA_DIR'] ?? join(root, 'services', 'grader', 'data-live')
  const budget = new Budget(join(dataDir, 'ledger.json'), ledgerCapUsd(dataDir, env), (engine) => PRICE_USD_PER_CALL[plan][engine as EngineId], () => new Date(), engines.length)
  const outcome = await runDiagnose(engines, found.key, { budget })
  console.log(`\nprobed ${outcome.probed.length}, refused ${outcome.refused.length} · ledger now $${budget.state.spentUsd.toFixed(4)} of $${budget.state.capUsd.toFixed(2)} (${budget.state.calls} calls)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(String(e))
    process.exit(1)
  })
}
