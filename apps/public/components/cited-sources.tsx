'use client'

import { useState } from 'react'
import { loadAnswers, type ScanAnswers } from '@/lib/answers'
import { citationMix, type CitationMix } from '@/lib/citations'
import { engineName } from '@/lib/engines'
import { subjectOf, type ScanResultFile } from '@/lib/scan-result'

/**
 * WHAT THE ENGINES CITED — the sources behind the answers, by class and by site.
 *
 * The scorer has classified every citation since P2.1b (ADR-0005) and the
 * result reported one number about it: how many answers cited the subject's
 * own domain. The rest was summed away. This section reads the same evidence
 * file the per-question table reads and shows where the engines actually sent
 * readers: how much of it was the subject's own site, a rival's, a review
 * site, a thread — and which sites were cited most.
 *
 * ⚠️ IT PLOTS REACH, NOT VOLUME, and the first version plotted volume. Share of
 * citations ran 0.4% to 87.2% on the shipped scan — a 218:1 range — so six of
 * seven classes drew as slivers two to eight pixels wide and the chart spent its
 * whole width on the one class nobody acts on. No scale fixes that honestly: a
 * log axis on a proportion makes 1% look like a third of 87%, and this sheet's
 * rule is that a scale is fixed, never fitted.
 *
 * So the STATISTIC changed rather than the scale. Reach — the answers in which a
 * class was cited at all — spans 1.2% to 48.2% instead, is the question a reader
 * actually has, shares the record's own denominator, and carries an honest
 * interval where share-of-citations does not. The reasoning is on
 * ClassShare.answers, where the data is.
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
            {mix.enginesWithNone.map(engineName).join(', ')} returned no sources on any answer, which is a fact about that engine&apos;s output and
            not about{' '}
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
              <caption className="visually-hidden">
                How many answers each source class was cited in, with 95% intervals, and its share of all citations
              </caption>
              <thead>
                <tr>
                  <th scope="col">Source class</th>
                  <th scope="col">Answers reached</th>
                  <th scope="col" style={{ width: '32%' }}>
                    <span className="visually-hidden">Reach with its 95% interval</span>
                  </th>
                  <th scope="col">Citations</th>
                  <th scope="col">Share</th>
                </tr>
              </thead>
              <tbody>
                {mix.classes.map((c) => (
                  <tr key={c.sourceClass}>
                    <th scope="row" style={{ fontWeight: c.sourceClass === 'owned' ? 600 : 400 }}>
                      {c.label}
                    </th>
                    <td className="num">
                      {c.answers} of {mix.answersInSample}
                    </td>
                    <td>
                      {/* The bar shows the interval as well as the estimate; a solid
                          bar alone would reassert the precision the number beside
                          it just disclaimed. Same device as the rail.

                          INDEPENDENT BARS, NEVER STACKED: reaches do not sum to
                          one, because one answer can cite several classes. */}
                      <div aria-hidden="true" className="range">
                        <div className="range__span" style={{ left: `${c.reach.ci_low * 100}%`, width: `${(c.reach.ci_high - c.reach.ci_low) * 100}%` }} />
                        <div className="range__tick" style={{ left: `${c.reach.value * 100}%` }} />
                      </div>
                    </td>
                    {/* Volume, as text and WITHOUT an interval. See the note on
                        ClassShare.answers: citations cluster within answers, so a
                        Wilson interval over the citation total is narrower than
                        the evidence supports. The counts are facts and stay; the
                        interval that overstated them does not. */}
                    <td className="num">{c.count}</td>
                    {/* A plain share, formatted here rather than through
                        packages/stats/format. That helper takes a `Metric` and
                        exists so an estimate can never be printed without its
                        interval; this number has none to print, and dressing it
                        as a Metric to reach the formatter is what created the
                        trap this change removes. */}
                    <td className="num">{Math.round(c.share * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="metric__interval">
            The bars are ANSWERS REACHED, out of the <span className="num">{mix.answersInSample}</span> behind the headline: how often an
            engine pointed anywhere in that class while answering about {subjectName}. They do not sum to 100%, because one answer can cite
            several classes. The two columns after them are volume — how many citations, and their share of all{' '}
            <span className="num">{mix.total}</span> — and they carry no interval on purpose: citations cluster inside answers, so twenty
            citations in one answer are twenty correlated observations and a Wilson interval over the citation total would be narrower than
            the evidence supports. A class is assigned by rule from the URL alone
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
      {mix.total > 0 ? (
        <p className="metric__provenance detail">
          {mix.provenance} · classes by the scan&apos;s own rules · reach out of {mix.answersInSample} answers, shares out of {mix.total} citations
        </p>
      ) : null}
    </>
  )
}

/** Distinct sites cited, counting every host and not only the top of the table. */
const hostCount = (answers: ScanAnswers): number => new Set(answers.answers.flatMap((a) => a.citations.map((k) => k.domain)).filter(Boolean)).size

const c = (sourceClass: string): string =>
  ({ owned: 'your own site', competitor: 'a competitor', review: 'review site', community: 'community', video: 'video', earned_media: 'earned media', reference: 'reference', other: 'other' })[sourceClass] ?? sourceClass
