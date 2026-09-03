'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { REASON_MAX, REASON_MIN, fileCompetitorChange, loadCompetitorStatus, type CompetitorStatus, type StatusResult } from '@/lib/competitor-request'

/**
 * THE COMPETITOR SET, AS A RECORD, AND THE ONE WAY TO ASK FOR A DIFFERENT
 * ONE. ADR-0016, decision 3.
 *
 * What it keeps straight: the set is the category's own unless a person has
 * applied an override for this domain; an exclusion is always allowed and an
 * inclusion only from the reviewed list; filing changes nothing until a person
 * applies it; and applying moves the basis, so the next cycle is not
 * comparable with the last and the record says why. No cost changes.
 */

type Phase = { kind: 'loading' } | { kind: 'ready'; status: CompetitorStatus } | { kind: 'away'; message: string }

export function CompetitorOverrides({ domain }: { domain: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    void loadCompetitorStatus(domain).then((r: StatusResult) => {
      if (!live) return
      setPhase(r.ok ? { kind: 'ready', status: r.status } : { kind: 'away', message: r.message })
    })
    return () => {
      live = false
    }
  }, [domain, reload])
  if (phase.kind === 'loading') return null
  if (phase.kind === 'away') return <CompetitorsUnavailable message={phase.message} />
  return <CompetitorOverridesBody status={phase.status} onFiled={() => setReload((n) => n + 1)} />
}

export function CompetitorsUnavailable({ message }: { message: string }) {
  return (
    <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
      Ranked against the wrong rivals? {message} An adjustment is filed on the machine that holds the record and applied by a person; nothing here
      can change the set on its own.
    </p>
  )
}

const day = (iso: string) => (iso ? iso.slice(0, 10) : 'an unrecorded date')

/** The pure surface: everything it says comes from the status it is handed. */
export function CompetitorOverridesBody({ status, onFiled, file = fileCompetitorChange }: { status: CompetitorStatus; onFiled?: () => void; file?: typeof fileCompetitorChange }) {
  const { competitors, excluded, includable, set, last, pending, history, category } = status
  // The form edits the WHOLE override: what is ticked out and picked in is what stands afterwards.
  const [out, setOut] = useState<Set<string>>(() => new Set(excluded.map((e) => e.id)))
  const [added, setAdded] = useState<Set<string>>(() => new Set(competitors.filter((c) => c.source === 'included').map((c) => c.id)))
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const categoryLeaders = [...competitors.filter((c) => c.source === 'category'), ...excluded.map((e) => ({ id: e.id, name: e.name, source: 'category' as const }))].sort((a, b) => a.name.localeCompare(b.name))
  const includeChoices = [...includable, ...competitors.filter((c) => c.source === 'included').map((c) => ({ id: c.id, name: c.name, bank: '' }))].sort((a, b) => a.name.localeCompare(b.name))
  const nameOf = (id: string) => [...competitors, ...excluded, ...includable].find((c) => c.id === id)?.name ?? id
  const changed = [...out].sort().join() !== excluded.map((e) => e.id).sort().join() || [...added].sort().join() !== competitors.filter((c) => c.source === 'included').map((c) => c.id).sort().join()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (sending) return
    setSending(true)
    const r = await file(status.domain, [...out], [...added], reason)
    setSending(false)
    if (r.ok) {
      setOutcome({ ok: true, message: 'Filed. Nothing changes until a person applies it; when one does, the next cycle measures against the new set and is not compared with the last.' })
      setOpen(false)
      setReason('')
      onFiled?.()
    } else setOutcome({ ok: false, message: r.message })
  }

  return (
    <div className="annotated" style={{ marginTop: 'var(--space-3)' }} data-competitor-overrides>
      <div className="annotated__body">
        <p className="prose">
          <strong>Measured against</strong>{' '}
          {competitors.length ? (
            competitors.map((c, i) => (
              <span key={c.id}>
                {i > 0 ? ', ' : ''}
                {c.name}
                {c.source === 'included' ? ' (added for this domain)' : ''}
              </span>
            ))
          ) : (
            <span>nobody: this category has no competitor set, so the number is a mention rate and not a ranking</span>
          )}
          .{' '}
          {set === null
            ? `The ${category.name} category's own set, bank version ${category.bankVersion}; no adjustment has been applied for this domain.`
            : `Adjusted for this domain, set version ${set}${last ? `, by ${last.by} on ${day(last.at)}: ${last.reason}` : ''}.`}
          {excluded.length ? ` Excluded for this domain: ${excluded.map((e) => e.name).join(', ')}.` : ''}
        </p>

        {pending ? (
          <p className="prose prose--flag" data-pending>
            An adjustment was requested on {day(pending.requestedAt)} and has not been applied
            {pending.exclude.length ? `: exclude ${pending.exclude.map(nameOf).join(', ')}` : ''}
            {pending.include.length ? `${pending.exclude.length ? ';' : ':'} include ${pending.include.map(nameOf).join(', ')}` : ''}. It changes nothing until a
            person applies it. Filing again replaces it.
          </p>
        ) : null}

        {history.filter((h) => h.status === 'declined').length ? (
          <p className="prose prose--flag">
            {history
              .filter((h) => h.status === 'declined')
              .map((h) => `A request was declined on ${day(h.resolvedAt)}${h.note ? `: ${h.note}` : ''}`)
              .join('. ')}
            .
          </p>
        ) : null}

        {outcome ? (
          <p className={`prose${outcome.ok ? '' : ' prose--flag'}`} role={outcome.ok ? 'status' : 'alert'}>
            {outcome.message}
          </p>
        ) : null}

        {!open ? (
          <button type="button" className="btn btn--quiet record__action" onClick={() => setOpen(true)} disabled={categoryLeaders.length === 0 && includeChoices.length === 0}>
            {pending ? 'Change the request' : 'Adjust the competitors?'}
          </button>
        ) : (
          <form onSubmit={submit} className="field__row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
            {categoryLeaders.length ? (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field__label">Rivals in the category&apos;s set. Untick one to exclude it for this domain.</legend>
                {categoryLeaders.map((c) => (
                  <label key={c.id} className="field__label" style={{ display: 'block' }}>
                    <input
                      type="checkbox"
                      checked={!out.has(c.id)}
                      onChange={(e) => {
                        const next = new Set(out)
                        if (e.target.checked) next.delete(c.id)
                        else next.add(c.id)
                        setOut(next)
                      }}
                    />{' '}
                    {c.name}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {includeChoices.length ? (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field__label">Reviewed rivals from other categories, by category. Tick one to include it. A name nobody has reviewed cannot be added.</legend>
                {[...new Set(includeChoices.map((c) => c.bank || 'added for this domain'))].sort().map((bank) => (
                  <details key={bank} open={includeChoices.some((c) => (c.bank || 'added for this domain') === bank && added.has(c.id))}>
                    <summary className="field__label">{bank}</summary>
                    {includeChoices
                      .filter((c) => (c.bank || 'added for this domain') === bank)
                      .map((c) => (
                        <label key={c.id} className="field__label" style={{ display: 'block', paddingLeft: 'var(--space-3)' }}>
                          <input
                            type="checkbox"
                            checked={added.has(c.id)}
                            onChange={(e) => {
                              const next = new Set(added)
                              if (e.target.checked) next.add(c.id)
                              else next.delete(c.id)
                              setAdded(next)
                            }}
                          />{' '}
                          {c.name}
                        </label>
                      ))}
                  </details>
                ))}
              </fieldset>
            ) : null}
            <label className="field__label" htmlFor="competitor-override-reason">
              Why, in a sentence a person can check ({REASON_MIN} to {REASON_MAX} characters)
            </label>
            <textarea id="competitor-override-reason" className="field" value={reason} onChange={(e) => setReason(e.target.value)} minLength={REASON_MIN} maxLength={REASON_MAX} rows={3} required />
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button type="submit" className="btn btn--primary record__action" disabled={sending || !changed || reason.trim().length < REASON_MIN}>
                {sending ? 'Filing…' : 'File the request'}
              </button>
              <button type="button" className="btn btn--quiet record__action" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
      <aside className="note">
        <span className="note__cap">What an adjustment does</span>
        <span className="note__gloss">
          Nothing until a person applies it. Then the next cycle is ranked against the adjusted set, and its basis records the set version, so it is
          not compared with the cycles before it: a changed competitor set is a changed question, and the record says so rather than drawing a
          line across it. The prompts, the engines and the cost do not change. An exclusion is always allowed; an inclusion only from rivals whose
          alias tables have been reviewed, because an unreviewed name produces false mentions and the set decides your rank.
        </span>
      </aside>
    </div>
  )
}
