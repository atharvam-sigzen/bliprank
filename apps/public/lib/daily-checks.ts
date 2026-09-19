/**
 * WHAT THE DAILY CHECKS DID, IN WORDS (MVP_PLAN P2). Browser-safe: the shapes
 * the status route returns and the sentences the panel prints, with nothing
 * here that reads a store. The server half is `daily-checks-status.ts`.
 *
 * The reader is the person running the loop on their own machine, the morning
 * after. For each tracked domain they need one of four answers: collected,
 * refused and why, not due, or ended. Every sentence below restates what the
 * loop recorded (`services/grader/src/tick-outcomes.ts`); none of them is a
 * measurement and none carries a rate, so there is no interval to carry.
 */

import type { DomainOutcome, TickReport } from '../../../services/grader/src/tick-outcomes.js'

export type { DomainOutcome, TickReport }

export interface DailyChecksStatus {
  /** False on a deployment, a fleet, or with identity on: the panel renders nothing and the button's route is 404. */
  readonly local: boolean
  /** The local time the in-app scheduler runs at, `HH:MM`. */
  readonly tickAt: string
  /** Whether a run would be allowed to start now, and the fixed sentence when not. */
  readonly armed: boolean
  readonly notArmed?: string
  /** Hosts being re-checked daily and still inside their days. */
  readonly tracked: readonly string[]
  readonly todayDay: string
  readonly yesterdayDay: string
  readonly today: DayView | null
  readonly yesterday: DayView | null
  /** Today's scheduled time has passed, a run would be allowed, and no run has happened since that time. */
  readonly missedToday: boolean
  /** Domain jobs a hosted fan-out could not queue, per day, only when non-zero (ADR-0018). Always empty on a machine; shown when it is not. */
  readonly failedPublishes: readonly { readonly day: string; readonly failed: number }[]
}

/** One day as the panel shows it: every tick of the day folded to one line per domain. */
export interface DayView {
  readonly day: string
  /** How the day's runs were started, in order. */
  readonly triggers: readonly TickReport['trigger'][]
  /** Set when EVERY run of the day was refused whole, with the last refusal. */
  readonly refused?: string
  readonly domains: readonly DomainOutcome[]
}

const RANK: Record<DomainOutcome['kind'], number> = { collected: 3, 'ran-without-result': 2, refused: 1, 'not-due': 0 }

/**
 * Fold a day's reports to one outcome per domain: what was ACHIEVED wins over
 * what came after it. A domain collected at 06:15 is "collected" even though
 * a press of the button at noon found it not due; without this the later,
 * emptier report would hide the morning's result. Between equals the later
 * one stands.
 */
export function dayViewOf(day: string, reports: readonly TickReport[]): DayView | null {
  const ofDay = reports.filter((r) => r.day === day).sort((a, b) => a.at.localeCompare(b.at))
  if (ofDay.length === 0) return null
  const best = new Map<string, DomainOutcome>()
  for (const r of ofDay) {
    for (const o of r.domains) {
      const held = best.get(o.host)
      if (!held || RANK[o.kind] >= RANK[held.kind]) best.set(o.host, o)
    }
  }
  const allRefused = ofDay.every((r) => r.refused !== undefined)
  return {
    day,
    triggers: ofDay.map((r) => r.trigger),
    ...(allRefused ? { refused: ofDay[ofDay.length - 1]!.refused! } : {}),
    domains: [...best.values()].sort((a, b) => a.host.localeCompare(b.host)),
  }
}

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 3 : 2)}`

const NOT_DUE: Record<string, (detail: string) => string> = {
  'cycle-today': () => 'already checked that day, so it was not checked again',
  expired: (d) => `its daily checks have ended (${d})`,
  'no-record': () => 'not checked: it has no category on record, so there is nothing to check it under',
  'no-bank': (d) => `not checked: ${d}`,
  'basis-moved': (d) => `not checked: ${d}`,
}

/** One domain's outcome as a sentence fragment that follows "example.com: ". */
export function outcomeWords(o: DomainOutcome): string {
  switch (o.kind) {
    case 'collected':
      return `checked, and the day’s answers were collected (${o.calls} ${o.calls === 1 ? 'request' : 'requests'}, ${usd(o.spentUsd)})${o.unsettled ? '. The spending record could not be updated afterwards, so it still shows the estimate; it needs a look' : ''}`
    case 'ran-without-result':
      return `checked, but nothing could be measured that day (the run ended as "${o.status}"; ${o.calls} ${o.calls === 1 ? 'request' : 'requests'}, ${usd(o.spentUsd)})`
    case 'refused':
      return `not checked: ${o.reason}`
    case 'not-due':
      return (NOT_DUE[o.reason] ?? ((d: string) => `not checked: ${d || o.reason}`))(o.detail)
  }
}

const TRIGGER_WORDS: Record<TickReport['trigger'], string> = { schedule: 'on schedule', button: 'from this page', cli: 'from the command line' }

/** "on schedule", "from this page", "on schedule and from this page". */
export function triggersWords(triggers: readonly TickReport['trigger'][]): string {
  const distinct = [...new Set(triggers)].map((t) => TRIGGER_WORDS[t])
  return distinct.length <= 1 ? (distinct[0] ?? '') : `${distinct.slice(0, -1).join(', ')} and ${distinct[distinct.length - 1]}`
}
