/**
 * The server half of the daily-checks panel (MVP_PLAN P2): what the machine's
 * own store says the loop did today and yesterday, whether a run would be
 * allowed to start now, and whether this morning's scheduled run was missed.
 * Reads only. Nothing here can start a run, and nothing here spends.
 */

import { readDailyLedger } from '../../../services/grader/src/daily-loop.js'
import { readTrackedIn } from '../../../services/grader/src/due.js'
import { utcDay } from '../../../services/grader/src/live-gate.js'
import { readTickReports } from '../../../services/grader/src/tick-outcomes.js'
import { dayViewOf, type DailyChecksStatus } from './daily-checks'
import { localArming, localEnv, type Env } from './local-tick'
import { tickInstantOn, tickTimeOf, tickTimeWords } from './scheduler'
import { workspaceAccess, type WorkspaceAccess } from './workspace-access'

const NOT_LOCAL: DailyChecksStatus = { local: false, tickAt: '', armed: false, tracked: [], todayDay: '', yesterdayDay: '', today: null, yesterday: null, missedToday: false, failedPublishes: [] }

export interface StatusDeps {
  readonly env?: Env
  readonly root?: string
  readonly now?: () => Date
  readonly access?: (env: Env) => Promise<WorkspaceAccess>
}

export async function dailyChecksStatus(deps: StatusDeps = {}): Promise<DailyChecksStatus> {
  const now = (deps.now ?? (() => new Date()))()
  const env = localEnv(deps.env ?? process.env, deps.root)
  const access = await (deps.access ?? ((e: Env) => workspaceAccess(e as NodeJS.ProcessEnv)))(env)
  if (!access.ok || access.backend !== 'file') return NOT_LOCAL

  const todayDay = utcDay(now)
  const yesterdayDay = utcDay(new Date(now.getTime() - 86_400_000))
  // A list or a ledger that cannot be read is nothing to show, never a guess; the run path states the same fault in its own words when pressed.
  const trackedEntries = await readTrackedIn(access.ledgers).catch(() => [])
  const tracked = trackedEntries.filter((t) => t.until === undefined || todayDay <= t.until).map((t) => t.host)
  const reports = await readTickReports(access.ledgers)
  const ledger = await readDailyLedger(access.dataDir, access.ledgers).catch(() => ({}) as Awaited<ReturnType<typeof readDailyLedger>>)

  const arming = localArming(env, tracked.length)
  const at = tickTimeOf(env['GRADER_TICK_HOUR'])
  const due = tickInstantOn(now, at)
  const ranSince = reports.some((r) => Date.parse(r.at) >= due.getTime())
  return {
    local: true,
    tickAt: tickTimeWords(at),
    armed: arming.armed,
    ...(arming.armed ? {} : { notArmed: arming.message }),
    tracked,
    todayDay,
    yesterdayDay,
    today: dayViewOf(todayDay, reports),
    yesterday: dayViewOf(yesterdayDay, reports),
    missedToday: arming.armed && now.getTime() >= due.getTime() && !ranSince,
    failedPublishes: [todayDay, yesterdayDay].flatMap((day) => ((ledger[day]?.fanOut?.failed ?? 0) > 0 ? [{ day, failed: ledger[day]!.fanOut!.failed }] : [])),
  }
}
