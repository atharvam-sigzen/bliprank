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
    <section className="card" aria-live="polite" aria-busy="true">
      <div className="rail__head">
        <h2>Scanning</h2>
        <span className="rail__n">{total > 0 ? `${done} / ${total} answers` : stage}</span>
      </div>

      <p className="rail__value" style={{ marginBottom: 'var(--space-2)' }}>
        {total > 0 ? `${pct}%` : '—'}
      </p>

      {/* The same rail the results use, so the loading state is the product's
          own visual language rather than a borrowed spinner. */}
      <div className="rail__track" aria-hidden="true">
        <div className="rail__band" style={{ left: '0%', width: `${Math.max(2, pct)}%`, animation: 'none' }} />
      </div>

      <p className="rail__bounds" aria-hidden="true">
        <span>{total > 0 ? `${engines} engines × ${prompts} prompts` : 'preparing'}</span>
        <span>{total > 0 ? `${total} answers` : ''}</span>
      </p>

      <p className="metric__interval" style={{ marginTop: 'var(--space-3)' }}>
        {lastCell ? <>Last: {lastCell}</> : <>{stage || 'Starting'}…</>}
      </p>

      <p className="metric__provenance">
        Real answers are being collected from five engines now. This takes up to 90 seconds, and the page will not show a number until it has one.
      </p>
    </section>
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
    unclassified: 'Not in the demo categories',
    ambiguous: 'More than one category matches',
    network: 'Could not reach the scan service',
    http: 'The scan service returned an error',
    failed: 'The scan stopped',
    input: 'Check the domain',
  }

  return (
    <section className="card" role="alert">
      <div className="rail__head">
        <h2>{TITLE[kind] ?? 'Cannot scan this domain'}</h2>
      </div>
      <p style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>{message}</p>
      <p className="metric__provenance">
        No number is shown because there is no measurement behind one. Nothing here falls back to sample data.
      </p>
      <button
        type="button"
        onClick={onReset}
        style={{
          marginTop: 'var(--space-3)',
          minHeight: 44,
          padding: '0 var(--space-3)',
          background: 'transparent',
          color: 'var(--color-primary)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          fontWeight: 500,
        }}
      >
        Try another domain
      </button>
    </section>
  )
}
