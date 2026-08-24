'use client'

import { useState } from 'react'
import { assertProvisionalAllowed, confidenceGrade, formatInterval, formatProvenance, formatValue } from '@bliprank/stats'
import { HeadToHeadChart } from '@/components/head-to-head-chart'
import { buildHeadToHead } from '@/lib/head-to-head'
import { IS_LIVE, SCAN, scanFor, subjectOf, type ScanResultFile } from '@/lib/scan-result'

// Module scope on purpose: the grade is only computed after a user submits, so
// relying on confidenceGrade to throw would mean discovering the block in front
// of a customer rather than at build time. This fails `next build` instead.
assertProvisionalAllowed('The AI Visibility Grader')

/**
 * The free Grader — P3.3, the acquisition path.
 *
 * Three states, one screen: enter a domain, wait, read the result. G3 wants
 * domain to first scored benchmark in under 90 seconds at p95, so the flow has
 * no steps that could be removed: no signup before the number, no category
 * picker, no wizard. The email gate belongs on the *gap list* (P3.5), after the
 * visitor has seen something true and free.
 *
 * The grade is a confidence grade, not a performance grade. A brand with a D is
 * not doing badly — we do not yet know enough about it to say. Calling that out
 * on the acquisition surface is the whole positioning: the competitor tools
 * show a confident number here, and confidence is exactly what a free sample of
 * this size cannot support.
 */

type State =
  | { phase: 'idle' }
  | { phase: 'scanning'; domain: string }
  | { phase: 'done'; domain: string; scan: ScanResultFile }
  | { phase: 'not-scanned'; domain: string }

export default function Grader() {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const [domain, setDomain] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const value = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
    // >>> CORRECTION, 2026-08-24 <<<
    //
    // What stood here said a '.' test had accepted 'hello.txt' and that "the
    // shape is checked properly before it can" cost a collection call. The
    // second half was false: this regex accepts 'hello.txt' and 'report.pdf'
    // too, because '.txt' is only "not a TLD" if you carry a 1,500-entry TLD
    // list. Verified, not assumed — packages/taxonomy has the failing case.
    //
    // The check is kept because it does reject the common junk (no dot, spaces,
    // 'localhost'). But the guard that actually protects spend is downstream and
    // holds regardless of what gets through here: an unclassified domain has no
    // category, so it has no prompt bank, so no cycle is ever published.
    const looksLikeDomain = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(value)
    if (!looksLikeDomain) {
      setError('Enter a domain, for example acme.com')
      return
    }
    setError(null)
    setState({ phase: 'scanning', domain: value })
    // No collection happens here. `scanFor` looks up the result a runner already
    // produced under an explicit budget (see lib/scan-result.ts); an unscanned
    // domain says so rather than inventing a number for it.
    const found = scanFor(value)
    setTimeout(() => setState(found ? { phase: 'done', domain: value, scan: found } : { phase: 'not-scanned', domain: value }), 400)
  }

  return (
    <main className="shell" style={{ maxWidth: 860 }}>
      <header className="masthead">
        <div>
          <h1>AI Visibility Grader</h1>
          <p className="cycle">How often do AI answers mention your brand? Free, no signup.</p>
        </div>
      </header>

      <p className="notice notice--info">
        {IS_LIVE ? (
          <>
            <strong>Real answers.</strong> {SCAN.counts.answersScored} answers collected across {SCAN.run.engines.length} engines on {SCAN.run.day}, at a
            cost of ${SCAN.run.spentUsd.toFixed(4)}. Nothing is collected when you press the button: this page renders a scan a runner already produced under
            an explicit budget.
          </>
        ) : (
          <>
            <strong>Fixture answers, real pipeline.</strong> Every number below was classified, collected, scored and given its interval by the production
            code path, but the answers came from the offline fixture adapter rather than a provider. Re-run with a live plan to replace them.
          </>
        )}
      </p>

      {state.phase === 'idle' || state.phase === 'scanning' ? (
        <form className="card" onSubmit={submit} noValidate>
          {/* Visible label, not a placeholder: a placeholder disappears the
              moment it is needed, which is when the user starts typing. */}
          <label htmlFor="domain" style={{ display: 'block', fontWeight: 600, marginBottom: 'var(--space-1)' }}>
            Your domain
          </label>
          <p id="domain-help" className="metric__interval" style={{ marginTop: 0, marginBottom: 'var(--space-2)' }}>
            We check the prompts buyers in your category actually ask. This build holds one collected scan: <strong>{SCAN.domain}</strong>.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <input
              id="domain"
              name="domain"
              type="text"
              inputMode="url"
              autoComplete="url"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              aria-describedby={error ? 'domain-help domain-error' : 'domain-help'}
              aria-invalid={error ? true : undefined}
              placeholder={SCAN.domain}
              disabled={state.phase === 'scanning'}
              style={{
                flex: '1 1 260px',
                minHeight: 44,
                padding: '0 var(--space-2)',
                fontFamily: 'var(--font-mono)',
                fontSize: '1rem',
                border: `1px solid ${error ? 'var(--color-destructive)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius)',
                background: '#fff',
                color: 'var(--color-foreground)',
              }}
            />
            <button
              type="submit"
              disabled={state.phase === 'scanning'}
              style={{
                minHeight: 44,
                padding: '0 var(--space-4)',
                background: 'var(--color-primary)',
                color: 'var(--color-on-primary)',
                border: 'none',
                borderRadius: 'var(--radius)',
                fontWeight: 600,
                fontSize: '0.9375rem',
                transition: 'background 200ms',
              }}
            >
              {state.phase === 'scanning' ? 'Checking…' : 'Grade my brand'}
            </button>
          </div>

          {/* Error next to the field it belongs to, announced when it appears. */}
          {error ? (
            <p id="domain-error" role="alert" style={{ color: 'var(--color-destructive)', fontSize: '0.8125rem', marginBottom: 0 }}>
              {error}
            </p>
          ) : null}

          {/* Progress is announced, not just animated. */}
          <p aria-live="polite" className="metric__interval">
            {state.phase === 'scanning' ? `Checking ${state.domain} across five answer engines…` : ''}
          </p>
        </form>
      ) : state.phase === 'not-scanned' ? (
        <NotScanned domain={state.domain} onReset={() => setState({ phase: 'idle' })} />
      ) : (
        <Result scan={state.scan} onReset={() => setState({ phase: 'idle' })} />
      )}
    </main>
  )
}

function NotScanned({ domain, onReset }: { domain: string; onReset: () => void }) {
  return (
    <section className="card" aria-live="polite">
      <h2>{domain}</h2>
      {/* No number is invented for an unscanned domain. Showing a placeholder
          here would be the same dishonesty as a point estimate with no interval:
          a shape that looks like a measurement and is not one. */}
      <p style={{ marginTop: 'var(--space-2)' }}>
        This build has no scan for {domain}. Collection runs in a budgeted runner, not from this form, so nothing was bought when you pressed the button.
      </p>
      <p className="metric__interval" style={{ marginTop: 'var(--space-2)' }}>
        Scanned in this build: <strong>{SCAN.domain}</strong> — {SCAN.categoryName}, {SCAN.counts.answersScored} answers. Try that one to see a full result.
      </p>
      <ResetButton onReset={onReset} />
    </section>
  )
}

function ResetButton({ onReset }: { onReset: () => void }) {
  return (
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
      Check another domain
    </button>
  )
}

function Result({ scan, onReset }: { scan: ScanResultFile; onReset: () => void }) {
  const subject = subjectOf(scan)
  const metric = subject.metric
  const { grade, note } = confidenceGrade(metric)

  return (
    <section className="card" aria-live="polite">
      <h2>{scan.domain}</h2>
      <p className="metric__interval" style={{ marginTop: 2 }}>
        {scan.categoryName} · {scan.counts.answersScored} answers · {scan.run.engines.length} engines
      </p>

      <p className="metric__value">{formatValue(metric)}</p>
      <p className="metric__interval">
        <span className="visually-hidden">95% confidence interval: </span>
        {formatInterval(metric)} · n={metric.n} answers
      </p>
      {/* The free surface is the one most likely to be screenshotted and
          compared against another tool, so it is the last place provenance
          should be missing. */}
      <p className="metric__provenance">{formatProvenance(metric)}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
        <span
          aria-hidden="true"
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 56,
            height: 56,
            borderRadius: 'var(--radius)',
            background: 'var(--color-muted)',
            border: '1px solid var(--color-border)',
            fontFamily: 'var(--font-mono)',
            fontSize: '1.75rem',
            fontWeight: 600,
            lineHeight: 1,
            flexDirection: 'column',
          }}
        >
          {/* Labelled, because a bare A-D badge is the PageSpeed/security-score
              pattern and reads as "you scored B". This grades how much the
              sample knows, not how the brand is doing. */}
          <span style={{ fontSize: '0.5rem', letterSpacing: '0.08em', fontWeight: 500 }}>PRECISION</span>
          {grade}
        </span>
        <div>
          <p style={{ margin: 0, fontWeight: 600 }}>Precision {grade}</p>
          <p className="metric__interval" style={{ marginTop: 2 }}>{note}</p>
        </div>
      </div>

      {/* The honest caveat, on the acquisition surface rather than buried in a
          methodology page nobody opens. */}
      <p className="notice" style={{ marginTop: 'var(--space-4)', marginBottom: 0 }}>
        This is a measure of how much {metric.n} answers can tell us, not a mark out of ten. At this sample the interval is wide: it places you in a range, and
        cannot separate you from a competitor whose range overlaps yours. Anyone quoting a precise number off a sample this size is guessing.
      </p>

      {subject.mentions === 0 ? (
        <p className="metric__interval" style={{ marginTop: 'var(--space-3)' }}>
          {/* Zero is a finding, not a missing value, and it still carries an
              interval: the upper bound is what says how confidently zero. */}
          Not mentioned in any of the {metric.n} answers. That is a real result with a real upper bound of {formatInterval(metric).split('–')[1]}, not an error.
          {scan.subjectSource === 'domain-label'
            ? ' Note the brand was identified from the domain label alone, so a trading name that differs from the domain would be undercounted.'
            : ''}
        </p>
      ) : null}

      <HeadToHead scan={scan} />

      <ResetButton onReset={onReset} />
    </section>
  )
}

/**
 * PHASES 3.4 — the head-to-head, sitting directly under the caveat it proves.
 *
 * The paragraph above it already promises the number "cannot separate you from
 * a competitor whose range overlaps yours". This is the picture of it, drawn
 * from the same scan: every brand here was scored over the SAME answers, so
 * they share one `comparison_basis` and `compare()` will actually compare them.
 */
/**
 * Why a row could not be ranked, taken from what `compare()` actually decided
 * rather than assumed. `format.ts` is HUMAN-OWNED, so its wording is read, not
 * rewritten — see the note in PROGRESS.md about its "(n=… then n=…)" phrasing
 * being misleading for brand-vs-brand, where the cause is interval width.
 */
function reasonFor(row: { verdict: string; comparison: { label: string } | null }): string {
  if (row.verdict === 'insufficient-data') return 'too few answers to compare'
  const label = row.comparison?.label ?? ''
  if (label.includes('precision')) return 'its range is far tighter than yours'
  if (label.includes('engine set') || label.includes('locale') || label.includes('geo')) return 'measured over a different engine set'
  if (label.includes('scored by')) return 'scored by a different algorithm version'
  if (label.includes('collected via')) return 'collected by a different path'
  return 'measured on a different basis'
}

function HeadToHead({ scan }: { scan: ScanResultFile }) {
  const subject = subjectOf(scan)
  const data = buildHeadToHead(
    { label: subject.name, metric: subject.metric },
    scan.brands.filter((b) => !b.isSubject).map((b) => ({ label: b.name, metric: b.metric })),
  )
  const uncompared = data.rows.filter((r) => r.verdict === 'insufficient-data' || r.verdict === 'not-comparable')

  return (
    <section className="section" aria-labelledby="h2h-heading">
      <h2 id="h2h-heading">How that compares in {scan.categoryName.toLowerCase()}</h2>

      <HeadToHeadChart data={data} subjectLabel={subject.name} />

      <p className="metric__interval" style={{ marginTop: 'var(--space-3)' }}>
        {data.allIndistinguishable
          ? `On this scan, not one brand in the category can be told apart from ${subject.name}. That is a fact about the sample size, not about the brands.`
          : `Where a range crosses the shaded band, that brand and ${subject.name} cannot be told apart on this scan — whatever order they appear in.`}
      </p>

      <p className="metric__interval">
        {/* The prompt subset is the honest part: a share-of-voice number taken
            from prompts that name brands would measure our own phrasing. */}
        Measured on {scan.counts.answersScored} answers from prompts that name no brand — the unprompted set. Comparison and verification prompts are excluded
        from this number by construction.
      </p>

      {uncompared.length > 0 ? (
        <p className="metric__interval">
          {/* The reason is DERIVED, not guessed. This previously printed
              "different engine set" for every uncompared row, which was simply
              false for the common case: these brands share the engine set
              exactly, and what compare() refused was a pair whose intervals are
              far too different in width to separate honestly. Stating a wrong
              reason on a page about measurement integrity is worse than stating
              none. */}
          Not ranked against you: {uncompared.map((r) => `${r.label} (${reasonFor(r)})`).join(', ')}. Their ranges are drawn, dashed, because the measurement is
          real — it is the comparison that would not be. Every other tool in this category would give you a number here anyway.
        </p>
      ) : null}
    </section>
  )
}
