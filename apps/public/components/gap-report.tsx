'use client'

import { useState } from 'react'
import { loadGaps, type GapReport as Report } from '@/lib/gaps'
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
        Mean term coverage <span className="num">{Math.round(report.meanCoverage * 100)}%</span> across <span className="num">{report.coverage.length}</span>{' '}
        questions. A word check, not a relevance score: these are the terms in the questions we send the engines, and whether the page&apos;s own
        text uses them anywhere.
      </p>
      {report.truncated ? (
        <p className="prose prose--flag">
          This page is larger than the fetch ceiling and was cut off, so a term below is absent from what we read, not necessarily from the page.
        </p>
      ) : null}
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Term coverage per question, least covered first</caption>
          <thead>
            <tr>
              <th scope="col">Covered</th>
              <th scope="col">Question</th>
              <th scope="col">Terms {absent}</th>
            </tr>
          </thead>
          <tbody>
            {worst.map((c) => (
              <tr key={c.prompt}>
                <td className="num">{Math.round(c.ratio * 100)}%</td>
                <td>{c.prompt}</td>
                <td className="num">{c.missing.length ? c.missing.join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
        None of this is a measured cause of anything. Every line above is a fact about a document. Whether changing one moves a mention rate needs
        a holdout and a difference-in-differences, and we have not run one. Treat it as a checklist of things that are missing, not as a list of
        things that work. Nothing here writes or publishes anything.
      </p>
    </>
  )
}
