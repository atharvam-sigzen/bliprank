'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { REASON_MAX, REASON_MIN, fileCorrection, loadCategoryStatus, type CategoryStatus, type StatusResult } from '@/lib/category-request'

/**
 * THE CATEGORY, AS A RECORD WITH ITS HISTORY, AND THE ONE WAY TO ASK FOR A
 * DIFFERENT ONE. ADR-0016, decisions 2 and 5.
 *
 * Three facts this surface keeps straight, because each is the kind that a
 * form under a button quietly gets wrong:
 *
 *   - The category was decided once and is never re-derived. A correction is a
 *     person choosing from the list; the classifier does not run again.
 *   - Filing a request changes nothing. It is stored where the record is and
 *     shown as pending until a person applies or declines it.
 *   - Applying one changes what the NEXT cycle measures and no collected
 *     cycle. The next cycle is a fresh collection, and its size and cost are
 *     printed before anyone asks.
 *
 * On a deployment with no category service the section says so and offers no
 * form: a control that files nowhere is worse than none.
 */

type Phase = { kind: 'loading' } | { kind: 'ready'; status: CategoryStatus } | { kind: 'away'; message: string }

export function CategoryCorrection({ domain }: { domain: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let live = true
    void loadCategoryStatus(domain).then((r: StatusResult) => {
      if (!live) return
      setPhase(r.ok ? { kind: 'ready', status: r.status } : { kind: 'away', message: r.message })
    })
    return () => {
      live = false
    }
  }, [domain, reload])

  if (phase.kind === 'loading') return null
  if (phase.kind === 'away') return <CategoryUnavailable message={phase.message} />
  return <CategoryCorrectionBody status={phase.status} onFiled={() => setReload((n) => n + 1)} />
}

export function CategoryUnavailable({ message }: { message: string }) {
  return (
    <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
      Think the category is wrong? {message} A correction is filed on the machine that holds the record and applied by a person; nothing here can
      change a category on its own.
    </p>
  )
}

const day = (iso: string) => (iso ? iso.slice(0, 10) : 'an unrecorded date')
const PLAN_WORDS: Record<string, string> = { payg: 'pay-as-you-go', pro: 'Pro', ultra: 'Ultra', mega: 'Mega' }

/** The pure surface: everything it says comes from the status it is handed. */
export function CategoryCorrectionBody({ status, onFiled, file = fileCorrection }: { status: CategoryStatus; onFiled?: () => void; file?: typeof fileCorrection }) {
  const [slug, setSlug] = useState('')
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const { record, pending, categories, nextCycle, history } = status
  const choices = categories.filter((c) => c.slug !== record.slug)
  const last = record.corrections[record.corrections.length - 1]

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (sending) return
    setSending(true)
    const r = await file(status.domain, slug, reason)
    setSending(false)
    if (r.ok) {
      const name = categories.find((c) => c.slug === r.slug)?.name ?? r.slug
      setOutcome({
        ok: true,
        message: r.applied
          ? `Applied: ${status.domain} is now measured as ${name}. Every earlier record is kept; the next cycle collects under the new category and is not compared with the last.`
          : `Filed: ${status.domain} should be measured as ${name}. Nothing changes until a person applies it.`,
      })
      setOpen(false)
      setReason('')
      onFiled?.()
    } else setOutcome({ ok: false, message: r.message })
  }

  return (
    <div className="annotated" style={{ marginTop: 'var(--space-3)' }} data-category-correction>
      <div className="annotated__body">
        <p className="prose">
          <strong>{record.name}</strong>, record version <span className="num">{record.version}</span>.{' '}
          {last
            ? `Corrected on ${day(last.at)} from ${categories.find((c) => c.slug === last.from)?.name ?? last.from} by ${last.by}: ${last.reason}.`
            : `Decided on ${day(record.decidedAt)} and reused since; it is never re-derived.`}
          {record.corrections.length > 1 ? ` ${record.corrections.length} corrections in all; every earlier record is kept.` : ''}
        </p>

        {pending ? (
          <p className="prose prose--flag" data-pending>
            A correction to <strong>{pending.name}</strong> was requested on {day(pending.requestedAt)} and has not been applied. It changes nothing
            until a person applies it. Filing again replaces it.
          </p>
        ) : null}

        {history.filter((h) => h.status === 'declined').length ? (
          <p className="prose prose--flag">
            {history
              .filter((h) => h.status === 'declined')
              .map((h) => `A request for ${categories.find((c) => c.slug === h.slug)?.name ?? h.slug} was declined on ${day(h.resolvedAt)}${h.note ? `: ${h.note}` : ''}`)
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
          <button type="button" className="btn btn--quiet record__action" onClick={() => setOpen(true)} disabled={choices.length === 0}>
            {pending ? 'Change the request' : 'Wrong category?'}
          </button>
        ) : (
          <form onSubmit={submit} className="field__row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
            <label className="field__label" htmlFor="category-correction-slug">
              The category this domain should be measured as
            </label>
            <select id="category-correction-slug" className="field" value={slug} onChange={(e) => setSlug(e.target.value)} required>
              <option value="">Choose a category</option>
              {choices.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                  {c.generated ? ' (authored by a model, not reviewed)' : ''}
                </option>
              ))}
            </select>
            <label className="field__label" htmlFor="category-correction-reason">
              Why, in a sentence a person can check ({REASON_MIN} to {REASON_MAX} characters)
            </label>
            <textarea
              id="category-correction-reason"
              className="field"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={REASON_MIN}
              maxLength={REASON_MAX}
              rows={3}
              required
            />
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button type="submit" className="btn btn--primary record__action" disabled={sending || !slug || reason.trim().length < REASON_MIN}>
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
        <span className="note__cap">What a correction does</span>
        <span className="note__gloss">
          Nothing until a person applies it. Then the next cycle asks the new category&apos;s prompts and, where the category has a competitor
          set, ranks you against it: a fresh collection of <span className="num">{nextCycle.prompts}</span> prompts across{' '}
          <span className="num">{nextCycle.engines}</span> engines, <span className="num">{nextCycle.cells}</span> requests, about{' '}
          <span className="num">${nextCycle.usd.toFixed(2)}</span> of our collection budget at the {PLAN_WORDS[nextCycle.plan] ?? nextCycle.plan} rate,
          before retries.
          {nextCycle.earlierCycles > 0
            ? ` The ${nextCycle.earlierCycles} cycle${nextCycle.earlierCycles === 1 ? '' : 's'} already collected ${nextCycle.earlierCycles === 1 ? 'keeps' : 'keep'} the category ${nextCycle.earlierCycles === 1 ? 'it was' : 'they were'} measured under and ${nextCycle.earlierCycles === 1 ? 'is' : 'are'} left off the new trend: a changed category is a changed question.`
            : ''}{' '}
          The category is never re-derived: the choice is yours, from the list.
        </span>
      </aside>
    </div>
  )
}
