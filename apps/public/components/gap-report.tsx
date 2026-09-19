'use client'

import { useState } from 'react'
import { loadGaps, type GapCoverage, type GapReport as Report } from '@/lib/gaps'
import type { ScanResultFile } from '@/lib/scan-result'

/**
 * WHAT IS ON YOUR PAGE — the gap report, on the result page at last.
 *
 * `services/grader/src/aeo-audit.ts` has produced this since 2026-09-02 and
 * only a terminal could see it. It is the one part of the product that answers
 * "so what do I do", and it answers with the checkable kind of thing only: nine
 * facts about the homepage's structure, and for each prompt the engines were
 * asked, which of its terms the page never uses.
 *
 * ⚠️ THREE THINGS THE SURFACE MUST KEEP, because the module's honesty is in its
 * wording and a surface can undo wording by omission:
 *
 *   1. Every `why` is hedged and is printed as written. No finding is a
 *      measured cause of anything, and the footer says so in one sentence.
 *   2. A truncated page changes what a gap MEANS: "never on the page" becomes
 *      "not in the part we read". The flag is read and the words change.
 *   3. It diagnoses and never generates. There is no draft, no suggested copy,
 *      no button that writes anything (ADR-0014; the `--draft` path was
 *      removed the day it was reviewed).
 *
 * Loaded on request. The bundled reference scan ships its report as a static
 * file; a scan this machine collected asks `/api/gaps`, which reads the
 * homepage once through the SSRF boundary and audits it against the prompts
 * THIS cycle was measured over. The report says when the page was read.
 */
export function GapReport({ scan }: { scan: ScanResultFile }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'refused'>('idle')
  const [report, setReport] = useState<Report | null>(null)
  const [message, setMessage] = useState('')

  async function open() {
    setState('loading')
    const got = await loadGaps(scan)
    if (!got.ok) {
      setMessage(got.message)
      setState('refused')
      return
    }
    setReport(got.report)
    setState('ready')
  }

  return (
    <section className="section" id="gaps">
      <h2>What is on your page</h2>
      {state === 'ready' && report ? (
        <GapReportBody report={report} />
      ) : state === 'refused' ? (
        <p className="prose prose--flag">{message}</p>
      ) : (
        <div>
          <button type="button" className="btn btn--quiet" onClick={() => void open()} disabled={state === 'loading'}>
            {state === 'loading' ? 'Reading the page…' : 'Read the gap report'}
          </button>
          <p className="prose" style={{ marginTop: 'var(--space-2)' }}>
            Your homepage, read once, against the questions the engines were asked about it:
            what the page states about itself in structured data, and which words from each question it never uses. Facts about a document, with
            no claim that changing one changes a number.
          </p>
        </div>
      )}
    </section>
  )
}

const STATUS: Record<Report['findings'][number]['status'], string> = { present: 'ok', weak: 'weak', missing: 'missing' }
const NAMES: Record<string, string> = {
  'json-ld': 'Structured data',
  'entity-schema': 'Names itself as an entity',
  faq: 'Questions and answers',
  'meta-description': 'Description',
  title: 'Title',
  h1: 'One main heading',
  'content-depth': 'Enough text to read',
  robots: 'Open to indexing',
  canonical: 'Canonical URL',
}

/** The presentational half, pure, so it can be rendered in a test without a browser. */
export function GapReportBody({ report }: { report: Report }) {
  const absent = report.truncated ? 'not in the part of the page we read' : 'never on the page'
  const worst = [...report.coverage].sort((a, b) => a.ratio - b.ratio)
  const missingCount = report.findings.filter((f) => f.status === 'missing').length
  const weakCount = report.findings.filter((f) => f.status === 'weak').length

  return (
    <>
      <div className="annotated">
        <div className="annotated__body">
          <h3>Structure and self-description</h3>
          <p className="prose">
            <span className="num">{report.findings.length}</span> checks: <span className="num">{missingCount}</span> missing,{' '}
            <span className="num">{weakCount}</span> weak, <span className="num">{report.findings.length - missingCount - weakCount}</span> present.
            Each is a fact about the page as read; the note under each says why it plausibly matters and how weak that link is.
          </p>
          <ul className="findings" aria-label="Structure checks">
            {report.findings.map((f) => (
              <li key={f.id} className={`finding finding--${f.status}`}>
                <span className="finding__status num">{STATUS[f.status]}</span>
                <div>
                  <p className="finding__what">
                    <strong>{NAMES[f.id] ?? f.id}.</strong> {f.what}
                  </p>
                  {f.evidence ? <p className="finding__evidence num">{f.evidence.length > 140 ? `${f.evidence.slice(0, 140)}…` : f.evidence}</p> : null}
                  {f.status !== 'present' && f.why ? <p className="finding__why prose">{f.why}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <aside className="note">
          <span className="note__cap">Page as read</span>
          <span className="note__line">{report.finalUrl}</span>
          <span className="note__line">read {report.fetchedAt.slice(0, 10)}</span>
          <span className="note__line">
            {report.bytes.toLocaleString()} bytes{report.truncated ? ' · truncated at the fetch ceiling' : ''}
          </span>
          <span className="note__line">about {report.words.toLocaleString()} words</span>
          <span className="note__line detail">cycle of {report.day} · {report.promptCount} prompts</span>
          <span className="note__gloss">
            One read of the homepage, through the same boundary the classifier uses. The page is the page as it was at that moment; it may have
            changed since.
          </span>
        </aside>
      </div>

      <h3 style={{ marginTop: 'var(--space-5)' }}>Does the page address the questions being asked about it?</h3>
      <p className="prose">
        <CoveragePlainReading report={report} />
      </p>
      {report.truncated ? (
        <p className="prose prose--flag">
          This page is larger than the fetch ceiling and was cut off, so a term below is absent from what we read, not necessarily from the page.
        </p>
      ) : null}

      {/* THE VISUAL. A list of the sheet's own segmented strips (CoverageStrip,
          unchanged below), worst first — the "table of glyphs" this replaces
          was the same content wrapped in <table><td>, with no synthesis above
          it and a missing-terms column dense enough to read as a data dump
          rather than a picture. The exact terms stay, in .detail. */}
      <CoverageLadder coverage={worst} mean={report.meanCoverage} />

      <div className="detail">
        <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
          The same rows, with the exact terms the page never uses.
        </p>
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Term coverage per question, least covered first</caption>
            <thead>
              <tr>
                <th scope="col">Terms covered</th>
                <th scope="col">Question</th>
                <th scope="col">Terms {absent}</th>
              </tr>
            </thead>
            <tbody>
              {worst.map((c) => (
                <tr key={c.prompt}>
                  <td>
                    <CoverageStrip covered={c.covered.length} missing={c.missing.length} mean={report.meanCoverage} />
                  </td>
                  <td>{c.prompt}</td>
                  <td className="num">{c.missing.length ? c.missing.join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
        None of this is a measured cause of anything. Every line above is a fact about a document. Whether changing one moves a mention rate needs
        a holdout and a difference-in-differences, and we have not run one. Treat it as a checklist of things that are missing, not as a list of
        things that work. Nothing here writes or publishes anything.
      </p>
    </>
  )
}

/**
 * THE PLAIN READING OF THE COVERAGE SECTION — built only from `report.coverage`
 * and `report.meanCoverage`, the same numbers the ladder below draws.
 *
 * Zero and small-n get their own branch rather than falling through the
 * general one: a report with no questions is not "0 of 0 questions are
 * missing more than half their terms", it is a statement that there was
 * nothing to check, and a report with exactly one question can never land in
 * the "N of M" branch without the plural reading of "1 questions".
 */
function CoveragePlainReading({ report }: { report: Report }) {
  const total = report.coverage.length
  if (total === 0) return <>There were no questions to check this page&apos;s coverage against.</>

  const meanPct = Math.round(report.meanCoverage * 100)
  const noun = total === 1 ? 'question' : 'questions'
  const bad = report.coverage.filter((c) => c.ratio < 0.5).length
  // The worst NAMED question skips a prompt with no content terms at all —
  // CoverageStrip's own "nothing to divide" case. Such a row still carries
  // ratio 0 and would otherwise win the sort by a tie a real, badly-covered
  // question loses, silencing the one fact this sentence exists to surface.
  const withTerms = report.coverage.filter((c) => c.covered.length + c.missing.length > 0)
  const worstOne = withTerms.length > 0 ? [...withTerms].sort((a, b) => a.ratio - b.ratio)[0]! : null
  const worstTotal = worstOne ? worstOne.covered.length + worstOne.missing.length : 0

  return (
    <>
      On average the page uses about <span className="num">{meanPct}%</span> of the words across the <span className="num">{total}</span> {noun}{' '}
      we checked it against.{' '}
      {bad === 0 ? (
        <>Every one of them reaches at least half.</>
      ) : bad === total ? (
        <>None of them reach half.</>
      ) : (
        <>
          <span className="num">{bad}</span> of the {total} {noun} are missing more than half their terms.
        </>
      )}
      {worstOne && worstTotal > 0 ? (
        <>
          {' '}
          The least covered is &ldquo;{worstOne.prompt}&rdquo;, using <span className="num">{worstOne.covered.length}</span> of its{' '}
          <span className="num">{worstTotal}</span> terms.
        </>
      ) : null}
    </>
  )
}

/**
 * THE LADDER — every question's `CoverageStrip`, worst first, without the
 * table scaffolding around it. `CoverageStrip` itself is unchanged: it was
 * already the right instrument (discrete segments, no invented interval — see
 * the note on it below), the table wrapped around it was the defect.
 *
 * The exact missing terms are not repeated here — they stay in the `.detail`
 * table below, next to the same strip, so a technical reader gets the terms
 * beside the picture rather than the picture appearing twice.
 */
function CoverageLadder({ coverage, mean }: { coverage: readonly GapCoverage[]; mean: number }) {
  if (coverage.length === 0) return null
  return (
    <ol className="covladder" aria-label="Term coverage per question, least covered first">
      {coverage.map((c) => (
        <li className="covladder__row" key={c.prompt}>
          <span className="covladder__q">{c.prompt}</span>
          <CoverageStrip covered={c.covered.length} missing={c.missing.length} mean={mean} />
        </li>
      ))}
    </ol>
  )
}

/**
 * COVERAGE AS SEGMENTS, NOT AS A BAR — and the difference is the honesty.
 *
 * THE SHAPE OF THE DATA DECIDED THIS. Rendered, the seventeen rows read 17, 43,
 * 43, 50, 67 ×5, 71, 75, 80, 83, 86, 88, 89, 100 — one real outlier and a heavy
 * cluster the ordered table buries. That is the case for drawing it. But every
 * one of those figures is a ratio of SMALL INTEGERS WITH DIFFERENT
 * DENOMINATORS: 1/6, 3/7, 1/2, 2/3, 5/7, 3/4, 4/5, 5/6, 6/7, 7/8, 8/9, 1/1,
 * because a question carries five to nine content terms. A continuous bar
 * invites a reader to compare lengths across rows whose granularity differs by
 * half, which is a precision the number does not have.
 *
 * So each row is divided into ITS OWN term count and filled for the terms the
 * page uses. The fill fraction is the ratio, the number of divisions is the
 * denominator, and a row of sixths visibly cannot say what a row of ninths can.
 *
 * ⚠️ NOT THE RAIL'S LANGUAGE, DELIBERATELY. The rail is a continuous Prussian
 * band with a needle and printed bounds, and it means "a measurement, and here
 * is how much it does not know". This is neither measured nor uncertain: it is
 * a word check over one document, with no sample and therefore no interval. It
 * gets discrete ticks in the neutral ink, no needle and no bounds, so the two
 * cannot be read as the same kind of claim. R8 does not apply because there is
 * no estimate here to carry one — and inventing an interval for a word count
 * would be the exact error in the opposite direction.
 *
 * THE COUNT IS PRINTED, so nothing meaningful rests on seeing the empty
 * segments (WCAG 1.4.11). The filled ink and the mean rule both clear 3:1; the
 * empty divisions are allowed to be quiet because the text beside them says the
 * same thing.
 */
function CoverageStrip({ covered, missing, mean }: { covered: number; missing: number; mean: number }) {
  const total = covered + missing
  // A prompt with no content terms at all: aeo-audit gives it ratio 0 and there
  // is nothing to divide, so the strip is omitted rather than drawn as a single
  // empty box that would read as "none of one term".
  if (total === 0) return <span className="cov__count num">no terms</span>

  return (
    <span className="cov">
      <span className="cov__strip" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span className={i < covered ? 'cov__seg cov__seg--on' : 'cov__seg'} key={i} />
        ))}
        <span className="cov__mean" style={{ left: `${mean * 100}%` }} />
      </span>
      <span className="cov__count num">
        {covered} of {total}
      </span>
    </span>
  )
}
