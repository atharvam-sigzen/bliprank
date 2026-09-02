'use client'

import { useState } from 'react'
import { ScanProgress } from '@/components/scan-progress'
import { cycleDayOf, nextCycleDay } from '@/lib/cycles'
import { runLiveScan } from '@/lib/live-scan'
import { rememberScan, type ScanResultFile } from '@/lib/scan-result'
import { SCHEDULE_FACT } from '@/lib/planned'

type State =
  | { phase: 'idle' }
  | { phase: 'running'; stage: string; done: number; total: number; engines: number; prompts: number; lastCell: string }
  | { phase: 'refused'; kind: string; message: string }

/**
 * THE ONLY WAY A SECOND CYCLE STARTS: a person, pressing this, on this record.
 *
 * Stated on the surface because the alternative reading — that cycles recur on
 * a schedule — is the one every competitor's dashboard invites and this build
 * cannot honour. `SCHEDULE_FACT` is printed beside the button for that reason.
 *
 * What the press does is POST `{ domain, cycle: 'new' }` to `/api/scan`, which
 * runs the SAME gates as a first scan — both flags, the key, the per-visitor
 * throttle, the per-domain ceiling, the live quota check — and then collects a
 * new UTC day's cells through the budgeted runner. When live scanning is on,
 * that spends real provider quota, and the button says so. When it is off, or
 * on a static deployment where the route does not exist, the refusal is shown
 * in words and nothing is substituted.
 *
 * The result comes back over the same SSE stream the Grader reads, is
 * remembered in this browser's registry beside the earlier cycles, and the
 * record re-reads the registry — which is how the trend acquires its point.
 */
export function NewCycle({
  domain,
  cycles,
  excluded = 0,
  onCollected,
}: {
  domain: string
  cycles: readonly ScanResultFile[]
  /** Dated cycles measured under an earlier category, kept but not on the trend. */
  excluded?: number
  onCollected: (scan: ScanResultFile) => void
}) {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const today = new Date().toISOString().slice(0, 10)
  const next = nextCycleDay(cycles, today)
  const latest = cycles[cycles.length - 1]

  function start() {
    setState({ phase: 'running', stage: 'starting', done: 0, total: 0, engines: 0, prompts: 0, lastCell: '' })
    void runLiveScan(
      domain,
      (e) => {
        if (e.kind === 'stage') setState((s) => (s.phase === 'running' ? { ...s, stage: e.stage } : s))
        else if (e.kind === 'begin') setState((s) => (s.phase === 'running' ? { ...s, total: e.total, engines: e.engines, prompts: e.prompts, stage: 'collecting' } : s))
        else if (e.kind === 'progress') setState((s) => (s.phase === 'running' ? { ...s, done: e.done, total: e.total, lastCell: e.cell } : s))
        else if (e.kind === 'cached') {
          // Cannot happen for a new cycle — the route skips its cache — but if
          // it ever did, a replayed cycle must not be presented as a new one.
          setState({ phase: 'refused', kind: 'cached', message: 'The scan service replayed a stored cycle instead of collecting a new one, so no new cycle was added.' })
        } else if (e.kind === 'error') setState({ phase: 'refused', kind: e.errorKind, message: e.message })
        else if (e.kind === 'result') {
          const r = e.result as ScanResultFile & { reason?: string }
          if (r.status !== 'scanned') {
            setState({ phase: 'refused', kind: r.status, message: r.reason ?? `The scan ended with status ${r.status}, so no new cycle was added.` })
            return
          }
          rememberScan(r)
          setState({ phase: 'idle' })
          onCollected(r)
        }
      },
      { newCycle: true },
    )
  }

  return (
    <section className="section" id="cycles">
      <h2>Cycles</h2>
      {latest ? (
        <p className="prose">
          This record holds <span className="num">{cycles.length}</span> {cycles.length === 1 ? 'cycle' : 'cycles'} under its current category, the
          latest collected on <span className="num">{cycleDayOf(latest)}</span>. A cycle is one scan of the recorded category&apos;s prompts on one
          UTC day, and every cycle is kept: a new one is filed beside the earlier ones, never over them.
        </p>
      ) : (
        <p className="prose prose--flag">
          This record&apos;s scan does not record the day its answers were bought, so it cannot be placed on a trend. A new cycle will be.
        </p>
      )}
      {excluded > 0 ? (
        <p className="prose prose--flag">
          <span className="num">{excluded}</span> earlier {excluded === 1 ? 'cycle was' : 'cycles were'} collected under a different category and{' '}
          {excluded === 1 ? 'is' : 'are'} kept but not drawn: a changed category is a changed question, and a number is never read under another
          question&apos;s name.
        </p>
      ) : null}

      {state.phase === 'running' ? (
        <ScanProgress stage={state.stage} done={state.done} total={state.total} engines={state.engines} prompts={state.prompts} lastCell={state.lastCell} />
      ) : state.phase === 'refused' ? (
        <div className="annotated">
          <section className="record record--refused annotated__body" role="alert">
            <h3 className="record__title">No new cycle was collected</h3>
            <p className="prose">{state.message}</p>
            <button type="button" className="btn btn--quiet record__action" onClick={() => setState({ phase: 'idle' })}>
              Dismiss
            </button>
          </section>
          <aside className="note note--flag">
            <span className="note__cap note__cap--flag">Why no new point</span>
            <span className="note__gloss">The trend shows only cycles that were actually collected. Nothing here falls back to sample data.</span>
            <span className="note__line">refused · {state.kind}</span>
          </aside>
        </div>
      ) : next.possible ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <button type="button" className="btn btn--primary record__action" onClick={start}>
            Collect a new cycle
          </button>
        </div>
      ) : (
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
          Today&apos;s cycle is already collected. The answer cache is keyed by UTC day, so a second scan today would read the same answers back
          and add nothing. The next cycle can be collected from <span className="num">{next.from}</span>.
        </p>
      )}

      <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
        Started by a person, here. Schedule: {SCHEDULE_FACT}. A new cycle passes exactly the gates a first scan passes and, when live scanning is
        on, spends real provider quota{latest ? ` for ${latest.counts.cellsRequested} requests, as the latest cycle did` : ''}. On a deployment
        with no scan service the request is refused and nothing is added.
      </p>
    </section>
  )
}
