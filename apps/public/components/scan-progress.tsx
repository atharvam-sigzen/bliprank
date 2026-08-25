'use client'

/**
 * What a 90-second scan looks like while it runs.
 *
 * G3 allows p95 ≤ 90 seconds domain-to-first-insight. For most of that the
 * screen has nothing to say, and a screen with nothing to say reads as broken —
 * so it says the true thing instead: how many cells are done, which engine
 * answered last, and how many provider calls have actually been spent.
 *
 * The spend counter is deliberate. This is the one screen where a viewer can
 * watch quota being consumed in real time, and on a free tier of 50 requests a
 * month that is information they should have rather than a detail hidden in a
 * log.
 */
export function ScanProgress({ stage, done, total, engines, prompts, lastCell }: { stage: string; done: number; total: number; engines: number; prompts: number; lastCell: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="annotated">
      <section className="card annotated__body" aria-live="polite" aria-busy="true">
        <div className="rail__head">
          <h2 className="panel__title">Scanning</h2>
          <span className="rail__n">{total > 0 ? `${done} / ${total} answers` : stage}</span>
        </div>

        <p className="rail__value">{total > 0 ? `${pct}%` : '—'}</p>

      {/* The same rail the results use, so the loading state is the product's
          own visual language rather than a borrowed spinner. The band is
          `--plain`: a loading bar must not perform the settle — that motion
          means "an interval opening around an estimate", and this is neither. */}
        <div className="rail__track" aria-hidden="true">
          <div className="rail__band rail__band--plain" style={{ left: '0%', width: `${Math.max(2, pct)}%` }} />
        </div>

        <p className="rail__bounds" aria-hidden="true">
          <span>{total > 0 ? `${engines} engines × ${prompts} prompts` : 'preparing'}</span>
          <span>{total > 0 ? `${total} answers` : ''}</span>
        </p>

        <p className="panel__status">{lastCell ? <>Last: {lastCell}</> : <>{stage || 'Starting'}…</>}</p>
      </section>

      {/* The spend disclosure moves to the margin with every other piece of
          provenance on this page, rather than sitting under the panel as loose
          small print. */}
      <aside className="note">
        <span className="note__cap">Collecting</span>
        <span className="note__line">{total > 0 ? `${engines} engines × ${prompts} prompts` : 'preparing'}</span>
        <span className="note__line">{total > 0 ? `${done} / ${total} answers` : stage}</span>
        <span className="note__gloss">
          Real answers are being collected from five engines now. This takes up to 90 seconds, and the page will not show a number until it has
          one.
        </span>
      </aside>
    </div>
  )
}

/**
 * A refusal, stated plainly.
 *
 * Every path that cannot produce a real number ends here rather than in a
 * substituted one. The distinction between "the cap stopped this", "the quota is
 * gone" and "this domain is not in the demo taxonomy" matters to whoever is
 * standing in front of the screen, so each says which it is.
 */
export function ScanRefusal({ kind, message, onReset }: { kind: string; message: string; onReset: () => void }) {
  const TITLE: Record<string, string> = {
    'burst-cap': 'Daily demo cap reached',
    quota: 'Provider quota exhausted',
    unreadable: 'Could not verify remaining quota',
    disabled: 'Live scanning is off',
    config: 'Not configured for live scanning',
    unclassified: 'That is not a domain',
    ambiguous: 'More than one category matches',
    network: 'Could not reach the scan service',
    http: 'The scan service returned an error',
    failed: 'Answers came back, none could be scored',
    'collection-failed': 'Nothing was collected',
    input: 'Check the domain',
  }

  /*
   * A REFUSAL IS CHASSIS, NOT PAPER — and that is the plan's rule, not a
   * shortcut. The PANELS block reserves the panel material for instruments:
   * "the form, the progress readout, a refusal, the plan panels, the splitter.
   * Results are typeset on the paper and get none of this." A refusal is the
   * instrument answering, not a record of a measurement, because there is no
   * measurement. Setting it on the paper would say the opposite.
   *
   * What was genuinely missing is everything INSIDE it. The message was
   * unstyled body text, the reasoning was a provenance line under the panel,
   * and the spacing was inline. Now the message takes the serif prose voice
   * every other caveat on the page uses, and the reasoning moves to the margin
   * as an annotation — the same treatment the rail's provenance gets, so the
   * refusal is annotated exactly like a result is.
   */
  return (
    <div className="annotated">
      <section className="card card--refusal annotated__body" role="alert">
        <h2 className="panel__title">{TITLE[kind] ?? 'Cannot scan this domain'}</h2>
        <p className="prose">{message}</p>
        <button type="button" onClick={onReset} className="btn btn--quiet panel__action">
          Try another domain
        </button>
      </section>
      <aside className="note note--flag">
        <span className="note__cap note__cap--flag">Why no number</span>
        <span className="note__gloss">
          No number is shown because there is no measurement behind one. Nothing here falls back to sample data.
        </span>
        <span className="note__line">refused · {kind}</span>
      </aside>
    </div>
  )
}
