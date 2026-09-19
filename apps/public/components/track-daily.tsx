'use client'

import { useEffect, useState } from 'react'
import { SCHEDULE_FACT } from '@/lib/planned'
import { DEFAULT_TRACK_DAYS, MAX_TRACK_DAYS, type TrackedStatus } from '@/lib/tracked'

type State = { phase: 'loading' } | { phase: 'ready'; status: TrackedStatus } | { phase: 'refused'; message: string } | { phase: 'unavailable'; message: string }

/**
 * THE DAILY RE-CHECK, AS A SWITCH ON THE RECORD (MVP_PLAN C3, ADR-0018 D6,
 * ADR-0016 Amendment 1).
 *
 * The record says whether this domain is re-checked daily, until which day and
 * how many days are left, and with which version of its prompt set; the
 * person can switch it on for a number of days, or off. Switching on writes an
 * entry into the deployment's tracked list with the SESSION's workspace,
 * account and role, and the next tick reads it; the body of the request names
 * the domain, a direction and a number of days and nothing else. It collects
 * nothing by itself: `SCHEDULE_FACT` stands beside the switch until a live
 * tick has filed a cycle, because a deployment that is not registered and
 * armed runs no loop, and this surface does not claim otherwise.
 *
 * On the machine's own store the person at the keyboard is its operator and
 * sees the switch. With identity on, the session-derived path is built and
 * tested and deliberately wired to no surface in this scope
 * (`TrackedStatus.backend`), so this component states the fact in words and
 * offers no control. The version it names is the set in force NOW, which is
 * what the next cycle will ask; the pending answer is words, never a
 * substituted state.
 */
export function TrackDaily({ domain }: { domain: string }) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [days, setDays] = useState<number>(DEFAULT_TRACK_DAYS)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await fetch(`/api/tracked?domain=${encodeURIComponent(domain)}`, { cache: 'no-store' })
        const body = (await res.json().catch(() => ({}))) as Partial<TrackedStatus> & { message?: string }
        if (!live) return
        if (res.ok && typeof body.tracked === 'boolean') setState({ phase: 'ready', status: body as TrackedStatus })
        else setState({ phase: 'unavailable', message: body.message ?? 'The daily list is not available here.' })
      } catch {
        if (live) setState({ phase: 'unavailable', message: 'The daily list is not available here.' })
      }
    })()
    return () => {
      live = false
    }
  }, [domain])

  async function flip(on: boolean) {
    setBusy(true)
    try {
      const res = await fetch('/api/tracked', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(on ? { domain, on, days } : { domain, on }) })
      const body = (await res.json().catch(() => ({}))) as Partial<TrackedStatus> & { message?: string }
      if (res.ok && typeof body.tracked === 'boolean') setState({ phase: 'ready', status: body as TrackedStatus })
      else setState({ phase: 'refused', message: body.message ?? 'The daily re-check was not changed.' })
    } catch {
      setState({ phase: 'refused', message: 'The daily re-check was not changed.' })
    } finally {
      setBusy(false)
    }
  }

  if (state.phase === 'loading') return <p className="prose prose--flag">Reading the daily list…</p>
  if (state.phase === 'unavailable') return <p className="prose prose--flag">Daily re-check: {state.message}</p>
  if (state.phase === 'refused') {
    return (
      <div role="alert">
        <p className="prose prose--flag">{state.message}</p>
        <button type="button" className="btn btn--quiet record__action" onClick={() => setState({ phase: 'loading' })}>
          Dismiss
        </button>
      </div>
    )
  }
  const s = state.status
  return (
    <div className="track-daily" data-track-daily>
      <p className="prose">
        Daily re-check: <strong>{s.tracked ? 'on' : 'off'}</strong>
        {s.tracked && s.until ? (
          <>
            , until <span className="num">{s.until}</span>
            {typeof s.daysLeft === 'number' ? ` (${s.daysLeft === 0 ? 'today is the last day' : `${s.daysLeft} more day${s.daysLeft === 1 ? '' : 's'}`})` : ''}
          </>
        ) : null}
        {s.tracked && s.prompts ? <>, asking your prompts, version {s.prompts}</> : null}. Schedule: {SCHEDULE_FACT}.
      </p>
      {s.backend !== 'file' ? null : s.may ? (
        s.tracked ? (
          <button type="button" className="btn btn--quiet record__action" disabled={busy} onClick={() => void flip(false)}>
            {busy ? 'Saving…' : 'Stop re-checking daily'}
          </button>
        ) : (
          <div className="field__row">
            <label className="field__label" htmlFor={`track-days-${domain}`}>
              Days
            </label>
            <input
              id={`track-days-${domain}`}
              className="field"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_TRACK_DAYS}
              value={days}
              onChange={(e) => setDays(Math.max(1, Math.min(MAX_TRACK_DAYS, Math.trunc(Number(e.target.value) || 1))))}
              disabled={busy}
            />
            <button type="button" className="btn btn--quiet record__action" disabled={busy} onClick={() => void flip(true)}>
              {busy ? 'Saving…' : `Re-check daily for ${days} day${days === 1 ? '' : 's'}`}
            </button>
          </div>
        )
      ) : (
        <p className="prose prose--flag">Only an owner or admin of this workspace switches the daily re-check.</p>
      )}
    </div>
  )
}
