'use client'

import { useState } from 'react'
import { formatInterval, formatProvenance, formatValue } from '@bliprank/stats'
import { loadAnswers, type ScanAnswers } from '@/lib/answers'
import { citationMix, type CitationMix } from '@/lib/citations'
import { subjectOf, type ScanResultFile } from '@/lib/scan-result'

/**
 * WHAT THE ENGINES CITED — the sources behind the answers, by class and by site.
 *
 * The scorer has classified every citation since P2.1b (ADR-0005) and the
 * result reported one number about it: how many answers cited the subject's
 * own domain. The rest was summed away. This section reads the same evidence
 * file the per-question table reads and shows where the engines actually sent
 * readers: how much of it was the subject's own site, a rival's, a review
 * site, a thread — with a Wilson interval on every share, because a share of
 * citations is a proportion of a sample like any other (R8) — and which sites
 * were cited most.
 *
 * ⚠️ WHAT THIS DOES NOT CLAIM. A citation is where an engine pointed a reader,
 * not where it got its facts, and being cited is not a measured cause of being
 * mentioned. The section says so beside the table. It generates nothing and
 * recommends nothing; it is the evidence, arranged.
 *
 * Loaded on request, like the answers, and from the same download: the
 * evidence file is memoised in `loadAnswers`, so opening this and the answers
 * costs one fetch.
 */
export function CitedSources({ scan }: { scan: ScanResultFile }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'refused'>('idle')
  const [mix, setMix] = useState<CitationMix | null>(null)
  const [answers, setAnswers] = useState<ScanAnswers | null>(null)
  const [message, setMessage] = useState('')
  const subject = subjectOf(scan)

  async function open() {
    setState('loading')
    const got = await loadAnswers(scan)
    if (!got.ok) {
      setMessage(got.message)
      setState('refused')
      return
    }
    setAnswers(got.answers)
    setMix(citationMix(got.answers))
    setState('ready')
  }

  return (
    <section className="section" id="sources">
      <h2>What the engines cited</h2>
      {state === 'ready' && mix && answers ? (
        <CitedSourcesBody mix={mix} answers={answers} subjectName={subject.name} scan={scan} />
      ) : state === 'refused' ? (
        <p className="prose prose--flag">{message}</p>
      ) : (
        <div>
          <button type="button" className="btn btn--quiet" onClick={() => void open()} disabled={state === 'loading'}>
            {state === 'loading' ? 'Opening the sources…' : 'Show the cited sources'}
          </button>
          <p className="prose" style={{ marginTop: 'var(--space-2)' }}>
            Every answer behind the numbers above cited its sources, or cited none. This reads them back from the same evidence as the
            per-question table and shows where the engines sent readers: your own pages, a rival&apos;s, review sites, threads. Nothing is loaded
            until you ask.
          </p>
        </div>
      )}
    </section>
  )
}

/** The presentational half, pure, so it can be rendered in a test without a browser. */
export function CitedSourcesBody({ mix, answers, subjectName, scan }: { mix: CitationMix; answers: ScanAnswers; subjectName: string; scan: ScanResultFile }) {
  const own = mix.classes.find((c) => c.sourceClass === 'owned')
  return (
    <>
      <p className="prose">
        Across the <span className="num">{answers.answers.filter((a) => !a.custom).length}</span> answers the engines made <span className="num">{mix.total}</span>{' '}
        {mix.total === 1 ? 'citation' : 'citations'} to <span className="num">{mix.hosts.length === 0 ? 0 : hostCount(answers)}</span> distinct sites:{' '}
        <span className="num">{mix.answersWithAny}</span> answers cited at least one source and <span className="num">{mix.answersWithout}</span>{' '}
        cited none.
        {mix.unresolvable > 0 ? (
          <>
            {' '}
            <span className="num">{mix.unresolvable}</span> of the citations {mix.unresolvable === 1 ? 'was' : 'were'} an engine&apos;s own redirect link
            naming no site; {mix.unresolvable === 1 ? 'it is' : 'they are'} counted above and listed nowhere.
          </>
        ) : null}
        {mix.enginesWithNone.length > 0 ? (
          <>
            {' '}
            {mix.enginesWithNone.join(', ')} returned no sources on any answer, which is a fact about that engine&apos;s output and not about{' '}
            {subjectName}.
          </>
        ) : null}
        {own ? (
          <>
            {' '}
            <span className="num">{own.count}</span> of the {mix.total} pointed at {subjectName}&apos;s own site.
          </>
        ) : mix.total > 0 ? (
          <> None of them pointed at {subjectName}&apos;s own site.</>
        ) : null}
      </p>

      {mix.total === 0 ? (
        <p className="prose prose--flag">No answer in this cycle cited a source, so there is nothing to classify. That is a finding about the engines, not a gap on the page.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Share of citations by source class, with 95% intervals</caption>
              <thead>
                <tr>
                  <th scope="col">Source class</th>
                  <th scope="col">Citations</th>
                  <th scope="col">Share</th>
                  <th scope="col">95% interval</th>
                  <th scope="col" style={{ width: '32%' }}>
                    <span className="visually-hidden">Proportional bar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {mix.classes.map((c) => (
                  <tr key={c.sourceClass}>
                    <th scope="row" style={{ fontWeight: c.sourceClass === 'owned' ? 600 : 400 }}>
                      {c.label}
                    </th>
                    <td className="num">{c.count}</td>
                    <td className="num">{formatValue(c.metric, 0)}</td>
                    <td className="num">{formatInterval(c.metric, 0)}</td>
                    <td>
                      {/* The bar shows the interval as well as the estimate; a solid
                          bar alone would reassert the precision the number beside
                          it just disclaimed. Same device as the worked example. */}
                      <div aria-hidden="true" className="range">
                        <div className="range__span" style={{ left: `${c.metric.ci_low * 100}%`, width: `${(c.metric.ci_high - c.metric.ci_low) * 100}%` }} />
                        <div className="range__tick" style={{ left: `${c.metric.value * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="metric__interval">
            Shares of <span className="num">{mix.total}</span> citations, not of answers. A class is assigned by rule from the URL alone
            (ADR-0005): a review site is a review site whatever it says. &ldquo;Earned media&rdquo; means one of 52 named editorial outlets,
            admitted only if it has a masthead, is independent of the vendors it covers, is not primarily an affiliate directory, and covers a
            market we track (ADR-0015). &ldquo;Other sites&rdquo; means a site none of our tables name: not yours, not a tracked rival&apos;s,
            not a video, community, review or reference platform we know, and not on that list.
          </p>

          <h3 style={{ marginTop: 'var(--space-4)' }}>Most cited sites</h3>
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">The sites cited most often across the answers</caption>
              <thead>
                <tr>
                  <th scope="col">Site</th>
                  <th scope="col">Class</th>
                  <th scope="col">Citations</th>
                  <th scope="col">In answers</th>
                </tr>
              </thead>
              <tbody>
                {mix.hosts.map((h) => (
                  <tr key={h.domain}>
                    <th scope="row" style={{ fontWeight: h.sourceClass === 'owned' ? 600 : 400 }}>
                      {h.domain}
                      {h.sourceClass === 'owned' ? <span className="flag">yours</span> : null}
                    </th>
                    <td>{c(h.sourceClass)}</td>
                    <td className="num">{h.count}</td>
                    <td className="num">{h.answers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
        A citation is where an engine sent a reader, not where it got its facts, and being cited is not a measured cause of being named. Nothing
        here has been through a holdout. Treat it as a map of who the engines point at in {scan.categoryName.toLowerCase()}, not as a list of
        things that work.
      </p>
      {mix.classes[0] ? (
        <p className="metric__provenance detail">
          {formatProvenance(mix.classes[0].metric)} · classes by the scan&apos;s own rules · shares of {mix.total} citations
        </p>
      ) : null}
    </>
  )
}

/** Distinct sites cited, counting every host and not only the top of the table. */
const hostCount = (answers: ScanAnswers): number => new Set(answers.answers.flatMap((a) => a.citations.map((k) => k.domain)).filter(Boolean)).size

const c = (sourceClass: string): string =>
  ({ owned: 'your own site', competitor: 'a competitor', review: 'review site', community: 'community', video: 'video', earned_media: 'earned media', reference: 'reference', other: 'other' })[sourceClass] ?? sourceClass
