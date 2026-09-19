'use client'

import { useEffect, useState } from 'react'
import { outcomeWords, triggersWords, type DailyChecksStatus, type DayView, type TickReport } from '@/lib/daily-checks'
import { dayViewOf } from '@/lib/daily-checks'

/**
 * THE DAILY CHECKS, ON THE RECORD (MVP_PLAN P1 and P2).
 *
 * P1: a button, "Run today's checks now", for the room. It posts to
 * `/api/tick/run-now`, which runs the same tick the in-app scheduler runs at
 * its hour and the operator's command runs by hand, under the same daily cap.
 * When a run is not allowed to start, the panel says which of the owner's
 * acts is missing, in the one fixed sentence the server uses, and the button
 * is not offered: a button that can only refuse is a worse explanation than
 * the sentence.
 *
 * P2: the loop tells the owner what it did. For each tracked domain,
 * yesterday's outcome (collected, refused and why, not due, ended) and
 * today's when there is one; a morning run that did not happen is said on
 * opening, not discovered from a flat trend three days later.
 *
 * NOT `.detail`. These sentences are the plain reading ("was my domain
 * checked yesterday?"), which is the first thing a person running a daily
 * loop asks, and they carry no rate, so there is no interval to carry. The
 * panel renders NOTHING off the owner's machine (identity on, a fleet): there
 * is no local loop there to report on, and the status route answers 404.
 */

export function DayReport({ heading, view, tracked }: { heading: string; view: DayView | null; tracked: readonly string[] }) {
  if (!view) {
    return tracked.length > 0 ? (
      <p className="prose" data-day-report="none">
        {heading}: no check ran.
      </p>
    ) : null
  }
  return (
    <div data-day-report={view.day}>
      <p className="prose">
        {heading} (<span className="num">{view.day}</span>), run {triggersWords(view.triggers)}
        {view.refused ? ': the run did not start.' : ':'}
      </p>
      {view.refused ? <p className="prose prose--flag">{view.refused}</p> : null}
      {view.domains.length > 0 ? (
        <ul className="daylist">
          {view.domains.map((o) => (
            <li className="daylist__item" key={o.host} data-outcome={o.kind}>
              <span className="num">{o.host}</span>: {outcomeWords(o)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function DailyChecksView({
  status,
  busy,
  refusal,
  onRun,
}: {
  status: DailyChecksStatus
  busy: boolean
  /** The server's sentence when a press was refused. */
  refusal: string | null
  onRun: () => void
}) {
  if (!status.local) return null
  return (
    <section className="section" id="daily-checks" data-daily-checks>
      <h2>Daily checks</h2>
      <p className="prose">
        {status.tracked.length === 0
          ? 'No domain is being re-checked daily on this machine.'
          : `${status.tracked.length === 1 ? 'One domain is' : `${status.tracked.length} domains are`} re-checked daily on this machine: ${status.tracked.join(', ')}.`}{' '}
        {status.armed
          ? `While this app is open, the day's checks run at ${status.tickAt} by this machine's clock, once, under the daily spending limit.`
          : 'They are not switched on:'}
      </p>
      {!status.armed && status.notArmed ? (
        <p className="prose prose--flag" data-not-armed>
          {status.notArmed}
        </p>
      ) : null}
      {status.missedToday ? (
        <p className="prose prose--flag" role="status" data-missed>
          Today&apos;s {status.tickAt} check has not run: this app was not open at that time, and opening it later does not start a check by
          itself. Press the button below to run it now.
        </p>
      ) : null}
      {status.failedPublishes.map((f) => (
        <p className="prose prose--flag" key={f.day} data-failed-publishes>
          On <span className="num">{f.day}</span>, <span className="num">{f.failed}</span> scheduled {f.failed === 1 ? 'check' : 'checks'} could not be
          queued, so {f.failed === 1 ? 'it was' : 'they were'} never started. Nothing was spent on {f.failed === 1 ? 'it' : 'them'}.
        </p>
      ))}
      <DayReport heading="Yesterday's checks" view={status.yesterday} tracked={status.tracked} />
      <DayReport heading="Today's checks" view={status.today} tracked={[]} />
      {status.armed ? (
        <button type="button" className="btn btn--quiet record__action" disabled={busy} onClick={onRun} data-run-now>
          {busy ? 'Running today’s checks…' : 'Run today’s checks now'}
        </button>
      ) : null}
      {refusal ? (
        <p className="prose prose--flag" role="alert" data-run-refused>
          {refusal}
        </p>
      ) : null}
    </section>
  )
}

export function DailyChecks() {
  const [status, setStatus] = useState<DailyChecksStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      const res = await fetch('/api/tick/status', { cache: 'no-store' })
      setStatus(res.ok ? ((await res.json()) as DailyChecksStatus) : null)
    } catch {
      setStatus(null)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const run = async (): Promise<void> => {
    setBusy(true)
    setRefusal(null)
    try {
      const res = await fetch('/api/tick/run-now', { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as { message?: string; report?: TickReport }
      if (!res.ok) setRefusal(body.message ?? 'Today’s checks did not run.')
      else if (body.report && status) {
        // Shown at once from the answer; the reload below replaces it with the store's own account.
        const today = dayViewOf(body.report.day, [body.report])
        setStatus({ ...status, ...(body.report.day === status.todayDay && today ? { today } : {}), missedToday: false })
      }
    } catch {
      setRefusal('Today’s checks did not run: this page could not reach the app.')
    } finally {
      setBusy(false)
      void load()
    }
  }

  if (!status) return null
  return <DailyChecksView status={status} busy={busy} refusal={refusal} onRun={() => void run()} />
}
