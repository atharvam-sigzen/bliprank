/**
 * THE DAY'S CHECKS, RUN FROM THE APP THE OWNER HAS OPEN (MVP_PLAN P1; owner
 * decision 2026-09-16: no machine scheduler and no hosted copy until after the
 * review).
 *
 * ONE PATH. The in-app scheduler and the "Run today's checks now" button both
 * come here, and here calls `runTick`, the function the operator's command
 * calls, in the mode that command calls live, over the same store and the
 * same ledgers. So the daily cap, the tick lease, the per-domain reservation,
 * the quota and burst gates, the per-run allowance and the runner's lifetime
 * ledger are all the ones that already exist, met in the same order. Nothing
 * about spending is decided in this file except what follows.
 *
 * ⚠️ WHAT THIS FILE DECIDES, AND IT IS SPEND CONTROL (HUMAN REVIEW REQUIRED).
 * `runTick` refuses a live run unless `GRADER_DAILY_LOOP=armed`: the owner's
 * go-ahead under ADR-0017. For THIS path the owner defined the go-ahead
 * differently on 2026-09-16: arming on the machine is two acts and nothing
 * else, `COLLECTION_BUDGET_USD_DAILY` and `GRADER_LIVE_SCAN=true` in the
 * repo-root `.env.local`, plus a tracked domain in the store. So when, and
 * only when, all of these hold:
 *
 *   - identity is off and the runtime is a declared single process (a machine;
 *     never a deployment, never a fleet),
 *   - the hard daily ceiling is set to a positive number,
 *   - the live-scan flag is true,
 *   - at least one domain is tracked and not past its last day,
 *   - `GRADER_DAILY_LOOP` is not set to anything other than `armed` (an
 *     explicit other value, `off` for instance, is the owner's off switch and
 *     is obeyed),
 *
 * the environment handed to `runTick` carries `GRADER_DAILY_LOOP=armed`. Every
 * OTHER refusal `liveGates` makes still stands and is returned as it is
 * written: the master collection flag, the provider key, the named plan, the
 * runner ledger's room. With the cap, the flag or a tracked domain absent the
 * answer is one of three fixed sentences and `runTick` is never called.
 *
 * ⚠️ RECORDED RISK, BOUNDED (the row's own words): an agent session that
 * starts the dev server on this machine runs this too, bounded by the daily
 * cap and the tracked set; the pre-spend hook cannot see a timer or a button.
 */

import { hardCeilingUsd, runTick, type TickDeps } from '../../../services/grader/src/daily-loop.js'
import { readTrackedIn } from '../../../services/grader/src/due.js'
import { readFlag } from '../../../services/grader/src/load-key.js'
import { utcDay } from '../../../services/grader/src/live-gate.js'
import { recordTickReport, reportOf, type TickReport, type TickTrigger } from '../../../services/grader/src/tick-outcomes.js'
import { ROOT } from './data-dir'
import { workspaceAccess, type WorkspaceAccess } from './workspace-access'

const NOTHING_SPENT = 'Nothing was collected and nothing was spent.'
export const NOT_LOCAL = 'Daily checks are run from this page only on the machine that holds the data, with sign-in switched off.'
export const NO_CAP = `Today's checks did not run: no daily spending limit is set on this machine. Set COLLECTION_BUDGET_USD_DAILY to a number of dollars in the .env.local file at the top of the project, then restart the app. ${NOTHING_SPENT}`
export const NOT_LIVE = `Today's checks did not run: live collection is switched off on this machine. Set GRADER_LIVE_SCAN=true in the .env.local file at the top of the project, then restart the app. ${NOTHING_SPENT}`
export const NOBODY_TRACKED = `Today's checks did not run: no domain is being re-checked daily. Enter a domain and choose for how many days, and it joins the daily checks. ${NOTHING_SPENT}`
export const SWITCHED_OFF = `Today's checks did not run: the daily loop is switched off on this machine (GRADER_DAILY_LOOP is set to something other than "armed"). ${NOTHING_SPENT}`

/** An environment as a test can write one. `NodeJS.ProcessEnv` in this app requires NODE_ENV (Next's typing), which a literal never has. */
export type Env = Record<string, string | undefined>
const asProcessEnv = (env: Env): NodeJS.ProcessEnv => env as NodeJS.ProcessEnv

/** The variables the local tick may take from the repo-root dotenv, exactly as `/api/scan` takes its flags: the environment first, then the file. */
const FROM_FILE = ['COLLECTION_ENABLED', 'GRADER_LIVE_SCAN', 'COLLECTOR_TOPOLOGY', 'COLLECTION_BUDGET_USD_DAILY', 'OPENWEBNINJA_PLAN', 'GRADER_DAILY_LOOP', 'GRADER_TICK_HOUR'] as const

/** The process environment with those variables resolved. Nothing is defaulted and nothing is invented. */
export function localEnv(env: Env = process.env, root: string = ROOT): Env {
  const out: Env = { ...env }
  for (const name of FROM_FILE) {
    const v = readFlag(root, name, asProcessEnv(env)).value
    if (v !== undefined) out[name] = v
  }
  return out
}

export type LocalArming =
  | { readonly armed: true; readonly env: Env; readonly tracked: number }
  | { readonly armed: false; readonly kind: 'no-cap' | 'not-live' | 'nobody-tracked' | 'switched-off'; readonly message: string; readonly tracked: number }

/** THE ARMING DECISION, pure over the resolved environment and the number of live tracked hosts. In the order a person fixes them. */
export function localArming(env: Env, tracked: number): LocalArming {
  if (hardCeilingUsd(asProcessEnv(env)) === null) return { armed: false, kind: 'no-cap', message: NO_CAP, tracked }
  if (env['GRADER_LIVE_SCAN'] !== 'true') return { armed: false, kind: 'not-live', message: NOT_LIVE, tracked }
  if (tracked < 1) return { armed: false, kind: 'nobody-tracked', message: NOBODY_TRACKED, tracked }
  const loop = env['GRADER_DAILY_LOOP']
  if (loop !== undefined && loop !== '' && loop !== 'armed') return { armed: false, kind: 'switched-off', message: SWITCHED_OFF, tracked }
  return { armed: true, env: { ...env, GRADER_DAILY_LOOP: 'armed' }, tracked }
}

export type LocalTickResult =
  | { readonly ok: true; readonly report: TickReport }
  | { readonly ok: false; readonly status: 404 | 409 | 503; readonly kind: 'not-local' | LocalArmingRefusal | 'ledger'; readonly message: string }
type LocalArmingRefusal = Exclude<LocalArming, { armed: true }>['kind']

export interface LocalTickDeps {
  readonly env?: Env
  readonly root?: string
  readonly now?: () => Date
  readonly access?: (env: Env) => Promise<WorkspaceAccess>
  /** Handed to `runTick` untouched: a test injects the collector and the quota gate, so the real tick path runs and nothing is asked of a provider. */
  readonly tickDeps?: TickDeps
  readonly log?: (s: string) => void
}

/** How many of this machine's tracked hosts are still inside their days. The same predicate the ceiling and the status count use. */
export const liveTracked = (entries: readonly { readonly until?: string }[], today: string): number => entries.filter((t) => t.until === undefined || today <= t.until).length

export async function runLocalTick(trigger: Extract<TickTrigger, 'schedule' | 'button'>, deps: LocalTickDeps = {}): Promise<LocalTickResult> {
  const now = deps.now ?? (() => new Date())
  const env = localEnv(deps.env ?? process.env, deps.root ?? ROOT)
  const access = await (deps.access ?? ((e: Env) => workspaceAccess(asProcessEnv(e))))(env)
  // A deployment, a fleet, or identity on: this path does not exist there. The signed QStash route is that world's transport (ADR-0018).
  if (!access.ok || access.backend !== 'file') return { ok: false, status: 404, kind: 'not-local', message: NOT_LOCAL }

  let tracked: number
  try {
    tracked = liveTracked(await readTrackedIn(access.ledgers), utcDay(now()))
  } catch (e) {
    ;(deps.log ?? console.error)(`[local-tick] ${(e as Error).message}`)
    return { ok: false, status: 503, kind: 'ledger', message: `Today's checks did not run: the list of tracked domains on this machine cannot be read until a person repairs it. ${NOTHING_SPENT}` }
  }
  const arming = localArming(env, tracked)
  if (!arming.armed) return { ok: false, status: 409, kind: arming.kind, message: arming.message }

  const at = now().toISOString()
  let result: Awaited<ReturnType<typeof runTick>>
  try {
    result = await runTick({ dataDir: access.dataDir, env: asProcessEnv(arming.env), apply: true, mode: 'live', root: deps.root ?? ROOT, ledgers: access.ledgers, store: access.store }, { ...deps.tickDeps, now, ...(deps.log ? { log: deps.log } : {}) })
  } catch (e) {
    // A ledger that could not be read, locked or written before a domain ran: the loop fails closed and says so in one line (C2r).
    ;(deps.log ?? console.error)(`[local-tick] ${(e as Error).message}`)
    result = { refuse: `the day's ledger could not be read or written, so the loop stopped before collecting: ${(e as Error).message}` }
  }
  const report = reportOf(result, trigger, 'live', at, utcDay(now()))
  // What it did is kept for the morning after (P2). This document gates nothing, so failing to write it never fails the tick.
  await recordTickReport(access.ledgers, report).catch((e: unknown) => (deps.log ?? console.error)(`[local-tick] the outcome could not be recorded: ${(e as Error).message}`))
  return { ok: true, report }
}
