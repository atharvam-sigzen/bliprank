'use client'

import { useState } from 'react'
import { assertProvisionalAllowed, confidenceGrade, formatInterval, formatProvenance } from '@bliprank/stats'
import { ProductBar } from '@/components/chrome'
import { HeadToHeadSection } from '@/components/head-to-head-section'
import { RangeRail } from '@/components/range-rail'
import { ScanProgress, ScanRefusal } from '@/components/scan-progress'
import { runLiveScan } from '@/lib/live-scan'
import { PREVIEW_SCORE_CAPTION, missingNote, previewScore } from '@/lib/preview-score'
import { BUNDLED_SCANS, IS_LIVE, SCAN, rememberScan, runInfoOf, scanFor, subjectOf, type ScanResultFile } from '@/lib/scan-result'
import { writeActiveDomain, writeRole } from '@/lib/workspace'

// Module scope on purpose: the grade is only computed after a user submits, so
// relying on confidenceGrade to throw would mean discovering the block in front
// of a customer rather than at build time. This fails `next build` instead.
assertProvisionalAllowed('The AI Visibility Grader')

/** The reference scan's run block, read once. It HAS one; a live-scanned file
 * cached by /api/scan does not, which is why every read goes through runInfoOf. */
const MASTHEAD_RUN = runInfoOf(SCAN)

/**
 * The free Grader — P3.3, the acquisition path.
 *
 * Three states, one screen: enter a domain, wait, read the result. G3 wants
 * domain to first scored benchmark in under 90 seconds at p95, so the flow has
 * no steps that could be removed: no signup before the number, no category
 * picker, no wizard. The email gate belongs on the *gap list* (P3.5), after the
 * visitor has seen something true and free.
 *
 * THE PAGE IS A MEASUREMENT RECORD. Letterhead, then the one instrument you
 * operate (the domain field), then the result typeset on the paper — words in
 * the serif, figures in the mono, and everything that used to sit UNDER a
 * number (provenance, n, the algorithm version, the fixture disclosure) set
 * BESIDE it in the margin. R8 made spatial: on a desktop the number cannot
 * appear without its papers, and on a phone the notes fold back inline in the
 * same DOM position they always had.
 *
 * The grade is a confidence grade, not a performance grade. A brand with a D is
 * not doing badly — we do not yet know enough about it to say. Calling that out
 * on the acquisition surface is the whole positioning: the competitor tools
 * show a confident number here, and confidence is exactly what a free sample of
 * this size cannot support.
 */

type State =
  | { phase: 'idle' }
  | { phase: 'scanning'; domain: string; stage: string; done: number; total: number; engines: number; prompts: number; lastCell: string; cached: boolean }
  | { phase: 'done'; domain: string; scan: ScanResultFile }
  | { phase: 'refused'; domain: string; kind: string; message: string }

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
    setState({ phase: 'scanning', domain: value, stage: 'starting', done: 0, total: 0, engines: 0, prompts: 0, lastCell: '', cached: false })

    // The committed scan is checked first and costs nothing. Only a domain with
    // no stored result reaches the server, and the server checks its own cache
    // again before it is allowed to spend.
    const local = scanFor(value)
    if (local) {
      setTimeout(() => setState({ phase: 'done', domain: value, scan: local }), 300)
      return
    }

    void runLiveScan(value, (e) => {
      if (e.kind === 'stage') setState((s) => (s.phase === 'scanning' ? { ...s, stage: e.stage } : s))
      else if (e.kind === 'cached') setState((s) => (s.phase === 'scanning' ? { ...s, cached: true, stage: 'already collected' } : s))
      else if (e.kind === 'begin') setState((s) => (s.phase === 'scanning' ? { ...s, total: e.total, engines: e.engines, prompts: e.prompts, stage: 'collecting' } : s))
      else if (e.kind === 'progress')
        setState((s) => (s.phase === 'scanning' ? { ...s, done: e.done, total: e.total, lastCell: e.cell } : s))
      else if (e.kind === 'error') setState({ phase: 'refused', domain: value, kind: e.errorKind, message: e.message })
      else if (e.kind === 'result') {
        const r = e.result as { status?: string; reason?: string; counts?: { cellsRequested: number; failed: number; collected: number; cacheHits: number } }
        // Only a string that is not a domain reaches this now. A real domain we
        // cannot categorise is scanned against the fallback bank instead — see
        // `scan.ts`. Saying "not in the demo categories" here would be wrong.
        if (r.status === 'unclassified')
          setState({ phase: 'refused', domain: value, kind: 'unclassified', message: r.reason ?? `${value} does not look like a domain, so nothing was collected for it.` })
        else if (r.status === 'ambiguous')
          setState({ phase: 'refused', domain: value, kind: 'ambiguous', message: `${value} matches more than one category and could not be resolved.` })
        else if (r.status === 'no-answers') {
          /*
           * TWO DIFFERENT FACTS, AND THE OLD COPY CONFLATED THEM.
           *
           * "No engine returned a usable answer" reads as "the engines never
           * mention you" — a real, publishable finding. But the same status is
           * returned when every cell FAILED, which means we learned nothing at
           * all. Reporting a collection failure as a zero mention rate is the
           * exact substitution this product exists not to make, and it is the
           * likely shape of running out of quota part-way through.
           */
          const c = r.counts
          const allFailed = c !== undefined && c.failed > 0 && c.collected === 0 && c.cacheHits === 0
          setState({
            phase: 'refused',
            domain: value,
            kind: allFailed ? 'collection-failed' : 'failed',
            message: allFailed
              ? `All ${c.cellsRequested} requests for ${value} failed, so nothing was collected and there is nothing to measure. This is a collection failure, not a score of zero — the most likely cause is the provider quota running out part-way through. Try again after the quota resets.`
              : `The engines returned answers for ${value} but none could be scored. Nothing is shown because there is nothing measured.`,
          })
        } else {
          // The dashboard and the agency portfolio decide `hasData` through
          // `scanFor`, and neither can read the directory /api/scan cached this
          // into. Without this, the visitor reads a full record here and then a
          // "no cycle collected" page one click later, for the domain they just
          // paid to measure.
          const scan = e.result as ScanResultFile
          rememberScan(scan)
          setState({ phase: 'done', domain: value, scan })
        }
      }
    })
  }

  return (
    <main className="shell shell--grader">
      <ProductBar current="grader" />

      {/* THE LETTERHEAD. The title in the record's serif; beside it, in the
          margin, the record block — where these numbers came from, stated
          before a single one is shown. A disclosure set as provenance rather
          than as a warning label, because a warning is a thing readers learn
          to dismiss and this one is the product's central claim about itself. */}
      <div className="annotated masthead">
        <div className="annotated__body">
          <h1>AI Visibility Grader</h1>
          <p className="lede">How often do AI answers mention your brand? Free, no signup.</p>
        </div>
        {/* NOT RENDERED OVER A RESULT. These are the REFERENCE scan's figures,
            and sigzen's record happens to match every one of them except the
            cost - so above that record the money line read as sigzen's, for a
            scan whose file records no spend at all. A result carries its own
            provenance in its own margin; this block belongs to the states that
            have no record on screen.

            The FIXTURE flag below is not scoped away: it is a disclosure about
            the whole build, not a figure belonging to one scan, and a result on
            screen is exactly when it most needs to be visible. */}
        {state.phase === 'done' && IS_LIVE ? null : (
        <aside className={`note${IS_LIVE ? '' : ' note--flag'}`} aria-label="Where these numbers come from">
          {IS_LIVE ? (
            <>
              <span className="note__cap">Reference scan</span>
              <span className="note__line">
                <strong>{SCAN.domain}</strong>
              </span>
              <span className="note__line">
                {SCAN.counts.answersScored} answers
                {MASTHEAD_RUN.engines.length > 0 ? ` · ${MASTHEAD_RUN.engines.length} engines` : ''}
              </span>
              {MASTHEAD_RUN.day ? <span className="note__line">day {MASTHEAD_RUN.day}</span> : null}
              {/* No cost line when the run block does not record spend. A
                  `$0.0000` for a scan that spent real money is a lie, and a
                  dash in a money slot still reads as a measurement. */}
              {MASTHEAD_RUN.spentUsd === null ? null : <span className="note__line">cost ${MASTHEAD_RUN.spentUsd.toFixed(4)}</span>}
              <span className="note__gloss">
                A domain this build already holds is served from that record and costs nothing. Anything else is collected by a budgeted runner
                under a hard cap, or refused - never collected from this form directly.
              </span>
            </>
          ) : (
            <>
              <span className="note__cap note__cap--flag">Fixture answers</span>
              <span className="note__gloss">
                <strong>Real pipeline, fixture answers.</strong> Every number below was classified, collected, scored and given its interval by the
                production code path; the answers came from the offline fixture adapter rather than a provider.
              </span>
            </>
          )}
        </aside>
        )}
      </div>

      {state.phase === 'refused' ? (
        <ScanRefusal kind={state.kind} message={state.message} onReset={() => setState({ phase: 'idle' })} />
      ) : state.phase === 'scanning' && state.total > 0 ? (
        <ScanProgress stage={state.stage} done={state.done} total={state.total} engines={state.engines} prompts={state.prompts} lastCell={state.lastCell} />
      ) : state.phase === 'idle' || state.phase === 'scanning' ? (
        <div className="annotated">
          {/* The one instrument you operate, so the one panel on the page. */}
          <form className="card annotated__body" onSubmit={submit} noValidate>
            {/* Visible label, not a placeholder: a placeholder disappears the
                moment it is needed, which is when the user starts typing. */}
            <label className="field__label" htmlFor="domain">
              Your domain
            </label>
            <p id="domain-help" className="metric__interval" style={{ marginTop: 0, marginBottom: 'var(--space-2)' }}>
              We check the prompts buyers in your category actually ask.
            </p>
            <div className="field__row">
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
                // Class, not an inline style. Inline colours are invisible to the
                // contrast suite — that is exactly how a 1.39:1 bar shipped once —
                // and an inline `transition` cannot be reached by
                // prefers-reduced-motion at all.
                className={`field${error ? ' field--invalid' : ''}`}
              />
              <button type="submit" disabled={state.phase === 'scanning'} className="btn btn--primary">
                {state.phase === 'scanning' ? 'Checking…' : 'Grade my brand'}
              </button>
            </div>

            {/* Error next to the field it belongs to, announced when it appears. */}
            {error ? (
              <p id="domain-error" role="alert" className="field__error">
                {error}
              </p>
            ) : null}

            {/* Progress is announced, not just animated. */}
            <p aria-live="polite" className="metric__interval">
              {state.phase === 'scanning' ? `Checking ${state.domain} across five answer engines…` : ''}
            </p>
          </form>
          {/* THE COUNT IS THE REGISTRY'S, NOT A LITERAL. This said "one
              collected scan" while the build shipped two, on the acquisition
              surface, as a statement of fact about what it contains. */}
          <aside className="note">
            <span className="note__cap">This build</span>
            <span className="note__line">
              holds {BUNDLED_SCANS.length} collected {BUNDLED_SCANS.length === 1 ? 'scan' : 'scans'}:
            </span>
            {BUNDLED_SCANS.map((s) => (
              <span className="note__line" key={s.domain}>
                <strong>{s.domain}</strong> · {s.categoryName} · {s.counts.answersScored} answers
              </span>
            ))}
            <span className="note__gloss">Try either to see a full record.</span>
          </aside>
        </div>
      ) : (
        <Result scan={state.scan} onReset={() => setState({ phase: 'idle' })} />
      )}
    </main>
  )
}

/**
 * THE HANDOFF. The Grader is where a domain becomes a subject; the dashboard is
 * where it becomes a workspace. Writing the domain and the role IS the
 * transfer: the dashboard reads both back out of storage on load, so it opens
 * on this domain instead of asking for it a second time.
 *
 * Nothing is collected by pressing this. A workspace is offline arithmetic —
 * category, prompt bank, engine list — until a budgeted runner says otherwise
 * (R3), so it is exactly as safe to press for an unmeasured domain as for a
 * measured one. The label is what has to differ, not the behaviour.
 */
function OpenWorkspaceButton({ domain, label }: { domain: string; label: string }) {
  return (
    <button
      type="button"
      className="btn btn--primary record__action"
      // Layout only, and it belongs to the pair rather than to the control: JSX
      // drops the whitespace between two sibling elements, so without this the
      // two buttons touch.
      style={{ marginRight: 'var(--space-3)' }}
      onClick={() => {
        writeActiveDomain(domain)
        writeRole('brand')
        // Full navigation rather than a router push: the dashboard reads the
        // role and the domain out of storage as it loads.
        window.location.href = '/dashboard'
      }}
    >
      {label}
    </button>
  )
}

function ResetButton({ onReset }: { onReset: () => void }) {
  return (
    <button type="button" onClick={onReset} className="btn btn--quiet record__action">
      Check another domain
    </button>
  )
}

function Result({ scan, onReset }: { scan: ScanResultFile; onReset: () => void }) {
  // Never `scan.run`: a result cached by /api/scan before this fix has no run
  // block at all, and reading through it is what crashed this page.
  const run = runInfoOf(scan)
  const subject = subjectOf(scan)
  const metric = subject.metric
  const { grade, note } = confidenceGrade(metric)
  const preview = previewScore(subject, scan.brands.filter((b) => !b.isSubject))
  // Counted once. The zero-competitor branch of HeadToHeadSection computes the same
  // thing, and the caveat above it may not imply a comparison it refuses.
  const competitors = scan.brands.filter((b) => !b.isSubject).length

  return (
    <section className="record" aria-live="polite">
      {/* The scanned domain is the subject of the whole record, so it is set
          as its headline — on the paper, not in a box. */}
      <h2 className="record__domain">{scan.domain}</h2>

      {/*
        A SHORT SAMPLE SAYS SO. If the provider stopped answering part-way — the
        likeliest shape of running out of quota mid-scan — the scan still returns
        a real number over the answers it did get, and the interval widens
        correctly. What it cannot do on its own is tell the reader that the
        sample is short ON PURPOSE rather than because the brand is rarely
        mentioned. A wider interval is the honest consequence; saying why it is
        wider is the honest disclosure.
      */}
      {scan.counts.failed > 0 ? (
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
          {scan.counts.failed} of {scan.counts.cellsRequested} requests did not come back, so this is measured on a smaller sample than a full
          scan and the interval below is correspondingly wider. The number is real; there is just less of it.
        </p>
      ) : null}

      {/*
        THE FALLBACK, DECLARED. The category was not identified, so there is no
        competitor set and no ranking — and the reader is told that rather than
        being shown an empty chart to interpret.
      */}
      {scan.fallback ? (
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
          {scan.fallback.reason === 'ambiguous'
            ? `${scan.domain} leads more than one category at once (${scan.fallback.candidates.join(', ')}), so picking one would be inventing a fact.`
            : `We could not identify a category for ${scan.domain}.`}{' '}
          It was measured against a general business-software prompt set instead. That mention rate is real, but there is no competitor set to
          rank it against — we will not name rivals for a business we could not categorise. This number is also not comparable with a scan run on
          a category prompt set.
        </p>
      ) : null}

      {/* The rail, with its papers in the margin beside it. This is the surface
          most likely to be screenshotted beside a competitor's tool: their
          headline is a confident figure; this one cannot be photographed
          without the range around it — or without its provenance. */}
      <div className="annotated" style={{ marginTop: 'var(--space-2)' }}>
        <div className="annotated__body">
          <RangeRail label="Mention rate" metric={metric} />
        </div>
        <aside className="note">
          <span className="note__cap">Record</span>
          <span className="note__line">{scan.categoryName}</span>
          <span className="note__line">
            {scan.counts.answersScored} answers{run.engines.length > 0 ? ` · ${run.engines.length} engines` : ''}
          </span>
          {run.day ? <span className="note__line">day {run.day}</span> : null}
          <span className="note__line">{formatProvenance(metric)}</span>
        </aside>
      </div>

      {/*
        THE PREVIEW SCORE — on the paper, annotated in the margin, and NOT on a
        rail.
        
        The rail means "this is a measurement and here is its interval". This
        number has no interval, because nobody has derived one for it, so it gets
        a plain figure and the composition of that figure sits beside it. Same
        provenance discipline as everything else on the sheet: the number cannot
        be read without the working.
        
        It sits ABOVE the Precision grade rather than beside it, so the two are
        never scanned as one compound verdict. They answer different questions —
        how visible, and how much the sample knows.
      */}
      <div className="annotated" style={{ marginTop: 'var(--space-5)' }}>
        <div className="annotated__body">
          <p className="readout__cap">Visibility</p>
          <p className="score">
            <span className="score__value num">{preview.score}</span>
            <span className="score__of">/ 100</span>
            <span className="score__flag">preview</span>
          </p>
          <p className="prose prose--flag" style={{ marginTop: 'var(--space-2)' }}>
            {PREVIEW_SCORE_CAPTION}. It combines the mention rate with competitive position on placeholder weights, carries no confidence
            interval, and is not comparable with anyone else&apos;s score — including a later version of this one.
          </p>
        </div>
        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">How it is made</span>
          {preview.parts.map((part) => (
            <span className="note__line" key={part.label}>
              {part.label} {(part.weight * 100).toFixed(0)}% · {part.points.toFixed(1)} pts
            </span>
          ))}
          {preview.parts.map((part) => (
            <span className="note__line" key={`${part.label}-detail`}>
              {part.detail}
            </span>
          ))}
          <span className="note__gloss">{missingNote(preview)}</span>
        </aside>
      </div>

      <div className="gradeline">
        <span className="gradebadge" aria-hidden="true">
          {/* Labelled, because a bare A-D badge is the PageSpeed/security-score
              pattern and reads as "you scored B". This grades how much the
              sample knows, not how the brand is doing. */}
          <span className="gradebadge__cap">PRECISION</span>
          {grade}
        </span>
        <div>
          <p style={{ margin: 0, fontWeight: 600 }}>Precision {grade}</p>
          <p className="metric__interval" style={{ marginTop: 2 }}>{note}</p>
        </div>
      </div>

      {/* The honest caveat, in the record's own voice, on the acquisition
          surface rather than buried in a methodology page nobody opens.

          DERIVED, NOT ASSERTED. This used to say "the interval is wide" and
          "cannot separate you from a competitor" unconditionally - directly
          under a Precision A reading "tight enough to act on", on a scan with
          no competitors at all. Two contradictions on one screen, and the
          second implies a comparison set that does not exist. Both clauses now
          come from the same metric and brand list the rest of the record does. */}
      <p className="prose" style={{ marginTop: 'var(--space-4)' }}>
        This is a measure of how much <span className="num">{metric.n}</span> answers can tell us, not a mark out of ten. It places you in a range,{' '}
        <span className="num">{formatInterval(metric)}</span>, and the Precision grade above says how much of one
        {competitors > 0 ? '. A competitor whose range overlaps yours cannot be told apart from you on this sample' : ''}. Anyone quoting a precise
        number off a sample this size is guessing.
      </p>

      {subject.mentions === 0 ? (
        <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
          {/* Zero is a finding, not a missing value, and it still carries an
              interval: the upper bound is what says how confidently zero. */}
          Not mentioned in any of the <span className="num">{metric.n}</span> answers. That is a real result with a real upper bound of{' '}
          <span className="num">{formatInterval(metric).split('–')[1]}</span>, not an error.
          {scan.subjectSource === 'domain-label'
            ? ' Note the brand was identified from the domain label alone, so a trading name that differs from the domain would be undercounted.'
            : ''}
        </p>
      ) : null}

      <HeadToHeadSection scan={scan} />

      <OpenWorkspaceButton domain={scan.domain} label="Open in dashboard" />
      <ResetButton onReset={onReset} />
    </section>
  )
}

