/**
 * WHAT THE LOOP DID, KEPT WHERE A PERSON CAN READ IT (MVP_PLAN P2).
 *
 * A tick's outcome lived in the value `runTick` returned and in whatever the
 * terminal printed. Run from the app the owner has open (P1), it lived
 * nowhere: a domain the day's cap refused, or one the quota gate turned away,
 * left no trace at all, because the day's spend ledger records only what was
 * ADMITTED. So the morning after, nothing could say "collected", "refused, and
 * why", "not due" or "expired" for each tracked domain, which is the first
 * thing the person running a daily loop needs to know.
 *
 * ⚠️ A SEPARATE DOCUMENT, NOT A FIELD ON THE SPEND LEDGER. `daily-spend.json`
 * is what the cap is enforced against, written under its own lock by
 * `reserve`/`settle`, and refused whole when it does not parse. A display
 * concern does not get to write into it: a bug here must never be able to
 * cost a day its cap. This file is `tick-outcomes.json`, beside it, read by
 * nothing that spends. If it is lost or corrupt the loop runs exactly as
 * before and the surface says it has nothing to show.
 *
 * Pure where it can be: `reportOf` turns a tick's outcome into the day's
 * report; `recordTickReport` folds one into the document; `readTickReports`
 * reads it back, shaped, never trusted.
 */

import type { TickOutcome } from './daily-loop.js'
import type { DueList } from './due.js'
import { CORRUPT } from './ledger-doc.js'
import type { LedgerStores } from './ledger-stores.js'

export const TICK_OUTCOMES = 'tick-outcomes.json'
/** Days kept. The surface reads today and yesterday; a fortnight is enough to look back over a missed weekend and small enough to stay a document. */
export const TICK_OUTCOME_DAYS = 14

export type TickTrigger = 'schedule' | 'button' | 'cli'

export type DomainOutcome =
  /** a cycle was collected and filed */
  | { readonly host: string; readonly kind: 'collected'; readonly calls: number; readonly spentUsd: number; readonly unsettled?: string }
  /** the runner ran and produced no measurable cycle (`no-answers`, `unclassified`, ...): the status, as the runner named it */
  | { readonly host: string; readonly kind: 'ran-without-result'; readonly status: string; readonly calls: number; readonly spentUsd: number }
  /** admitted by nothing, or turned away by a gate: the reason, as the loop stated it */
  | { readonly host: string; readonly kind: 'refused'; readonly reason: string }
  /** tracked, and not due today: already collected, expired, no record, no bank, or a moved basis */
  | { readonly host: string; readonly kind: 'not-due'; readonly reason: string; readonly detail: string }

export interface TickReport {
  /** The UTC day the tick ran for: the day its cycles are filed under. */
  readonly day: string
  readonly at: string
  readonly trigger: TickTrigger
  readonly mode: 'live' | 'fixture'
  /** Set when the whole tick was refused before any domain was considered; `domains` is then what the due list said, with nothing run. */
  readonly refused?: string
  readonly capUsd: number
  readonly spentUsd: number
  readonly domains: readonly DomainOutcome[]
}

type TickResult = TickOutcome | { readonly refuse: string; readonly list?: DueList }

const notDueOf = (list: DueList | undefined): DomainOutcome[] => (list?.notDue ?? []).map((n) => ({ host: n.host, kind: 'not-due' as const, reason: n.reason, detail: n.detail }))

/** THE REPORT, pure: one tick's result as the day's per-domain outcomes. Nothing here decides anything; it restates what the loop returned. */
export function reportOf(result: TickResult, trigger: TickTrigger, mode: 'live' | 'fixture', at: string, day: string): TickReport {
  if ('refuse' in result) {
    // Refused whole: every domain that WAS due is reported refused for that one reason, so the surface never shows a due domain with no line.
    const due: DomainOutcome[] = (result.list?.due ?? []).map((d) => ({ host: d.host, kind: 'refused' as const, reason: result.refuse }))
    return { day, at, trigger, mode, refused: result.refuse, capUsd: 0, spentUsd: 0, domains: [...due, ...notDueOf(result.list)] }
  }
  const ran: DomainOutcome[] = result.ran.map((r) =>
    r.status === 'scanned'
      ? { host: r.host, kind: 'collected' as const, calls: r.calls, spentUsd: r.spentUsd, ...(r.unsettled ? { unsettled: r.unsettled } : {}) }
      : { host: r.host, kind: 'ran-without-result' as const, status: r.status, calls: r.calls, spentUsd: r.spentUsd },
  )
  const refused: DomainOutcome[] = result.refused.map((r) => ({ host: r.host, kind: 'refused' as const, reason: r.reason }))
  return { day: result.day, at, trigger, mode, capUsd: result.capUsd, spentUsd: result.spentAfter, domains: [...ran, ...refused, ...notDueOf(result.list)] }
}

const isOutcome = (x: unknown): x is DomainOutcome => {
  if (typeof x !== 'object' || x === null) return false
  const o = x as { host?: unknown; kind?: unknown }
  return typeof o.host === 'string' && (o.kind === 'collected' || o.kind === 'ran-without-result' || o.kind === 'refused' || o.kind === 'not-due')
}

const isReport = (x: unknown): x is TickReport => {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Partial<TickReport>
  return typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && typeof r.at === 'string' && (r.trigger === 'schedule' || r.trigger === 'button' || r.trigger === 'cli') && Array.isArray(r.domains) && r.domains.every(isOutcome)
}

/** Every report the document holds, oldest first. A missing or unreadable document is no reports: this file gates nothing, so it fails toward silence, never toward a guess. */
export async function readTickReports(ledgers: LedgerStores): Promise<readonly TickReport[]> {
  let raw: unknown
  try {
    raw = await ledgers.doc(TICK_OUTCOMES).read()
  } catch {
    return []
  }
  return Array.isArray(raw) ? raw.filter(isReport) : []
}

/**
 * Fold one report into the document, under the document's own lock. Every
 * tick of a day is kept (a scheduled run and a press of the button are two
 * facts), and days older than `TICK_OUTCOME_DAYS` before the newest are
 * dropped. A corrupt document is replaced rather than refused: it holds
 * nothing a spend depends on, and refusing would leave it corrupt for good.
 */
export async function recordTickReport(ledgers: LedgerStores, report: TickReport): Promise<void> {
  await ledgers.doc(TICK_OUTCOMES).update((current) => {
    const kept = current === CORRUPT || !Array.isArray(current) ? [] : (current as unknown[]).filter(isReport)
    const all = [...kept, report]
    const newest = all.reduce((d, r) => (r.day > d ? r.day : d), report.day)
    const floor = new Date(Date.parse(`${newest}T00:00:00.000Z`) - TICK_OUTCOME_DAYS * 86_400_000).toISOString().slice(0, 10)
    return all.filter((r) => r.day > floor)
  })
}
