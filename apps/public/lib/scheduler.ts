/**
 * THE IN-APP DAILY SCHEDULER (MVP_PLAN P1): while the local app is running,
 * the day's checks run once, at a fixed LOCAL time (default 06:15,
 * `GRADER_TICK_HOUR`), through `runLocalTick`, which is `runTick` and nothing
 * else. The owner decided on 2026-09-16 that until the directors' review there
 * is no machine-level scheduled task and no hosted copy: the app the owner
 * already has open is the scheduler.
 *
 * WHEN IT FIRES. When the clock CROSSES the tick time while this process is
 * alive: the previous poll was before today's tick time and this poll is at or
 * after it. A laptop asleep at 06:15 that wakes at 08:00 crosses it on waking
 * and runs. An app STARTED at 09:00 has not crossed it and does not run:
 * starting the app is not an instruction to spend, the record says the
 * morning's check did not run (P2), and the button runs it on a person's
 * word. That is also what makes opening the app during a meeting safe.
 *
 * NEVER TWICE. A crossing can happen once per local day per process. Across
 * processes (a restart at 06:14, a second dev server) the day is CLAIMED in a
 * document beside the ledgers, under that document's lock, before the tick
 * runs: the second claimant is refused and does nothing. And were both of
 * those to fail, the tick itself holds: one cycle per host per UTC day, one
 * tick lease per store, one daily cap.
 *
 * This file decides WHEN. Whether anything may be spent is `localArming`'s
 * and `runTick`'s: with the cap, the live flag or a tracked domain absent the
 * run is refused with a fixed sentence and nothing is asked of anyone.
 */

import { CORRUPT } from '../../../services/grader/src/ledger-doc.js'
import type { LedgerStores } from '../../../services/grader/src/ledger-stores.js'
import { localEnv, runLocalTick, type Env, type LocalTickResult } from './local-tick'
import { workspaceAccess } from './workspace-access'

export const DEFAULT_TICK_TIME = { hour: 6, minute: 15 } as const
export const SCHEDULER_DOC = 'local-scheduler.json'
const POLL_MS = 30_000

export interface TickTime {
  readonly hour: number
  readonly minute: number
}

/** `GRADER_TICK_HOUR` as `HH:MM` or `H`. Anything else keeps the default: a typo must not move the day's spend to midnight, or switch it off in silence. */
export function tickTimeOf(raw: string | undefined): TickTime {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec((raw ?? '').trim())
  if (!m) return DEFAULT_TICK_TIME
  const hour = Number(m[1])
  const minute = m[2] === undefined ? 0 : Number(m[2])
  return hour <= 23 && minute <= 59 ? { hour, minute } : DEFAULT_TICK_TIME
}

export const tickTimeWords = (t: TickTime): string => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`

/** The instant of the tick time on the LOCAL day `now` falls in. */
export function tickInstantOn(now: Date, at: TickTime): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.hour, at.minute, 0, 0)
}

/** The local calendar day, `YYYY-MM-DD`: what "once a day" means to the person whose machine this is. */
export function localDayOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** THE CROSSING, pure. No previous poll means the process has only just started, and a start is never a crossing. */
export function crossed(previous: Date | null, now: Date, at: TickTime): boolean {
  if (previous === null) return false
  const t = tickInstantOn(now, at).getTime()
  return previous.getTime() < t && t <= now.getTime()
}

/** Claim the local day for a scheduled run, under the document's lock. False when it is already claimed, or when the document cannot be written: no claim, no run. */
export async function claimLocalDay(ledgers: LedgerStores, day: string): Promise<boolean> {
  let mine = false
  try {
    await ledgers.doc(SCHEDULER_DOC).update((current) => {
      const held = current !== CORRUPT && typeof current === 'object' && current !== null ? (current as { lastScheduledDay?: unknown }).lastScheduledDay : undefined
      mine = held !== day
      return { lastScheduledDay: day }
    })
  } catch {
    return false
  }
  return mine
}

export interface SchedulerDeps {
  readonly now?: () => Date
  readonly env?: () => Env
  /** The run. The default is `runLocalTick('schedule')`; a test counts the calls. */
  readonly run?: () => Promise<LocalTickResult>
  /** The ledgers the day is claimed in. The default is this machine's, through `workspaceAccess`; null when this is not a machine, and then nothing is scheduled. */
  readonly ledgers?: () => Promise<LedgerStores | null>
  readonly log?: (s: string) => void
  readonly pollMs?: number
}

/** One poll. Exported so a test can drive the clock without a timer. Returns what happened, for the log and the test. */
export async function pollOnce(state: { previous: Date | null; running: boolean }, deps: SchedulerDeps = {}): Promise<'idle' | 'busy' | 'not-local' | 'claimed-elsewhere' | 'ran'> {
  const now = (deps.now ?? (() => new Date()))()
  const previous = state.previous
  state.previous = now
  const env = (deps.env ?? (() => localEnv()))()
  if (!crossed(previous, now, tickTimeOf(env['GRADER_TICK_HOUR']))) return 'idle'
  if (state.running) return 'busy'
  state.running = true
  try {
    const ledgers = await (deps.ledgers ?? (async () => {
      const access = await workspaceAccess(env as NodeJS.ProcessEnv)
      return access.ok && access.backend === 'file' ? access.ledgers : null
    }))()
    if (!ledgers) return 'not-local'
    if (!(await claimLocalDay(ledgers, localDayOf(now)))) return 'claimed-elsewhere'
    const result = await (deps.run ?? (() => runLocalTick('schedule', deps.now ? { now: deps.now } : {})))()
    ;(deps.log ?? console.log)(`[scheduler] ${localDayOf(now)} ${result.ok ? `ran: ${result.report.domains.length} tracked domain(s), $${result.report.spentUsd.toFixed(3)} of $${result.report.capUsd.toFixed(3)}${result.report.refused ? `; refused: ${result.report.refused}` : ''}` : `did not run (${result.kind}): ${result.message}`}`)
    return 'ran'
  } finally {
    state.running = false
  }
}

const HANDLE = Symbol.for('bliprank.local-scheduler')

/** Start the poll, once per process however many times the module is evaluated (a dev server re-evaluates modules; a second timer would be a second scheduler). Returns the stop function. */
export function startLocalScheduler(deps: SchedulerDeps = {}): () => void {
  const g = globalThis as unknown as Record<symbol, { stop: () => void } | undefined>
  g[HANDLE]?.stop()
  const state = { previous: null as Date | null, running: false }
  const timer = setInterval(() => {
    void pollOnce(state, deps).catch((e: unknown) => (deps.log ?? console.error)(`[scheduler] ${(e as Error).message}`))
  }, deps.pollMs ?? POLL_MS)
  // Never the reason the process stays alive.
  timer.unref?.()
  const stop = () => clearInterval(timer)
  g[HANDLE] = { stop }
  // The first poll only records "now": a start is never a crossing.
  void pollOnce(state, deps).catch(() => {})
  // Said once, so the person who started the app can see the scheduler exists and when it will act. It states a time, not a promise
  // to spend: whether a run may start is decided when the time comes, by the owner's two acts and every gate of the tick.
  ;(deps.log ?? console.log)(`[scheduler] started: while this app is open, the day's checks are attempted at ${tickTimeWords(tickTimeOf((deps.env ?? (() => localEnv()))()['GRADER_TICK_HOUR']))} by this machine's clock. Starting the app never starts a check.`)
  return stop
}
