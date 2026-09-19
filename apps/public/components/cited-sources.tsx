'use client'

import { useState } from 'react'
import { headlineAnswers, loadAnswers, type ScanAnswers } from '@/lib/answers'
import { citationMix, SOURCE_ORDER, type CitationMix } from '@/lib/citations'
import { engineName } from '@/lib/engines'
import { subjectOf, type ScanResultFile } from '@/lib/scan-result'
import { formatFrequency, formatInterval, formatValue, MIN_N_FOR_COMPARISON, type Metric } from '@bliprank/stats'

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
  /*
   * ⚠️ THE HEADLINE'S OWN ANSWERS ONLY (review MAJOR 5). `mix` is already built
   * from `headlineAnswers` inside `citationMix`, so `mix.total` and every reach
   * are headline-only — but this count was taken over `answers` whole, custom
   * prompts included, mixing two samples in one sentence: N and T count one
   * thing, K counted a bigger one. `headlineAnswers` is the same filter
   * `citationMix` itself applies, so this is the one denominator the rest of
   * the sentence already assumes.
   */
  const distinctSites = mix.hosts.length === 0 ? 0 : hostCount(headlineAnswers(answers))
  return (
    <>
      <p className="prose">
        Across the <span className="num">{answers.answers.filter((a) => !a.custom).length}</span> answers the engines made <span className="num">{mix.total}</span>{' '}
        {mix.total === 1 ? 'citation' : 'citations'} to <span className="num">{distinctSites}</span> distinct sites:{' '}
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
          <SourceReach mix={mix} subjectName={subjectName} />
          <MostCited mix={mix} distinctSites={distinctSites} />
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

/**
 * A plain share, rounded — and `Math.round` alone is the bug (review MINOR a):
 * a class with real, counted citations rounded to "0%" reads as "none",
 * which is a different claim than "less than one in two hundred". This is
 * NOT a `Metric` and carries no interval (see the note at its call site), so
 * this stays a plain function rather than a `packages/stats/format` export.
 */
const formatShare = (share: number): string => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`)

const c = (sourceClass: string): string =>
  ({ owned: 'your own site', competitor: 'a competitor', review: 'review site', community: 'community', video: 'video', earned_media: 'earned media', reference: 'reference', other: 'other' })[sourceClass] ?? sourceClass

/* ==========================================================================
   SOURCE-CLASS REACH — the primitive built once, composed here
   ==========================================================================

   REUSES `.estrip`, THE SAME TRACK EngineIntervals AND IntentSplit DRAW.
   Reach genuinely is what those two are: a Wilson proportion of the record's
   own answers, so it earns the same band-and-needle instrument rather than a
   new one invented for this section. Constraint 1 is "build the primitive
   once, properly" — this is that rule holding two files apart.

   THE EXACT TABLE SURVIVES, IN .detail. Every number the old table printed —
   the precise reach fraction, the raw citation count, the share, the 52-outlet
   definition of "earned media" — stays, for the reader who wants the ledger
   rather than the picture. What moves to `.detail` is the LITERAL TABLE
   MARKUP; the reach itself, and one sentence about it, are now visible at
   every depth, because a reach with an interval is exactly the kind of number
   this file's own docstring says a client must be able to read unaided.
   ========================================================================== */

function SourceReach({ mix, subjectName }: { mix: CitationMix; subjectName: string }) {
  const own = mix.classes.find((cl) => cl.sourceClass === 'owned')
  const others = mix.classes.filter((cl) => cl.sourceClass !== 'owned')
  const topCandidate = others.length > 0 ? [...others].sort((a, b) => b.reach.value - a.reach.value)[0]! : null
  /*
   * ⚠️ NAMING A "TOP" CLASS IS A CLAIM OF SEPARATION (review MAJOR 4). Picking
   * by point estimate alone and bolding it is exactly the emphasis-inside-the-
   * interval R8 exists to refuse — IntentSplit already refuses it the same way
   * (prompt-breakdown.tsx) for two groups; this generalises the same test to
   * N: the candidate is named only when its own interval clears every OTHER
   * class's, i.e. nothing else could plausibly reach further. When it does
   * not, no one class is emphasised — they are listed in the sheet's own
   * SOURCE_ORDER, which is not a ranking of anything.
   */
  const topSeparated = topCandidate ? others.every((cl) => cl.sourceClass === topCandidate.sourceClass || topCandidate.reach.ci_low > cl.reach.ci_high) : false
  const top = topSeparated ? topCandidate : null
  // Same fallback as `citationMix`'s own class ordering: a class nobody has
  // named yet sorts last rather than throwing `indexOf` off the front.
  const orderOf = (k: string) => {
    const i = (SOURCE_ORDER as readonly string[]).indexOf(k)
    return i === -1 ? SOURCE_ORDER.length : i
  }
  const bySourceOrder = [...others].sort((a, b) => orderOf(a.sourceClass) - orderOf(b.sourceClass))
  // The same floor `compare()` itself refuses below — not a comparison here,
  // but the same honest admission that a handful of answers makes any range
  // this wide unstable, and a reader should be told rather than left to guess.
  const thin = mix.answersInSample > 0 && mix.answersInSample < MIN_N_FOR_COMPARISON

  return (
    <section className="estrip" aria-labelledby="reach-heading">
      <h3 id="reach-heading">What kind of site the engines pointed to</h3>
      <ol className="estrip__rows">
        {mix.classes.map((cl) => (
          <li className="estrip__row" key={cl.sourceClass}>
            <span className="estrip__name">{cl.label}</span>
            <span className="estrip__track" aria-hidden="true">
              <span className="estrip__band" style={{ left: `${cl.reach.ci_low * 100}%`, width: `${(cl.reach.ci_high - cl.reach.ci_low) * 100}%` }} />
              <span className="estrip__needle" style={{ left: `calc((100% - 3px) * ${cl.reach.value})` }} />
            </span>
            <span className="estrip__count num">
              {cl.answers} of {mix.answersInSample}
            </span>
          </li>
        ))}
      </ol>

      <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
        {top ? (
          <>
            Engines pointed at <strong>{top.label.toLowerCase()}</strong> <ReachClause metric={top.reach} n={mix.answersInSample} />.{' '}
          </>
        ) : others.length > 1 ? (
          <>
            No one kind of site clearly leads by reach: {bySourceOrder.map((cl) => cl.label.toLowerCase()).join(', ')}.{' '}
          </>
        ) : null}
        {own ? (
          <>
            They pointed at {subjectName}&apos;s own site <ReachClause metric={own.reach} n={mix.answersInSample} />.
          </>
        ) : (
          <>They never pointed at {subjectName}&apos;s own site in this cycle.</>
        )}
      </p>
      {thin ? (
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-2)' }}>
          This reads from only <span className="num">{mix.answersInSample}</span> answers, so these ranges are wide and could move a lot with a
          larger sample.
        </p>
      ) : null}

      <div className="detail">
        <div className="table-wrap" style={{ marginTop: 'var(--space-4)' }}>
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
              {mix.classes.map((cl) => (
                <tr key={cl.sourceClass}>
                  <th scope="row" style={{ fontWeight: cl.sourceClass === 'owned' ? 600 : 400 }}>
                    {cl.label}
                  </th>
                  <td className="num">
                    {cl.answers} of {mix.answersInSample}
                  </td>
                  <td>
                    {/* The bar shows the interval as well as the estimate; a solid
                        bar alone would reassert the precision the number beside
                        it just disclaimed. Same device as the rail.

                        INDEPENDENT BARS, NEVER STACKED: reaches do not sum to
                        one, because one answer can cite several classes. */}
                    <div aria-hidden="true" className="range">
                      <div className="range__span" style={{ left: `${cl.reach.ci_low * 100}%`, width: `${(cl.reach.ci_high - cl.reach.ci_low) * 100}%` }} />
                      <div className="range__tick" style={{ left: `${cl.reach.value * 100}%` }} />
                    </div>
                  </td>
                  {/* Volume, as text and WITHOUT an interval. See the note on
                      ClassShare.answers: citations cluster within answers, so a
                      Wilson interval over the citation total is narrower than
                      the evidence supports. The counts are facts and stay; the
                      interval that overstated them does not. */}
                  <td className="num">{cl.count}</td>
                  {/* A plain share, formatted here rather than through
                      packages/stats/format. That helper takes a `Metric` and
                      exists so an estimate can never be printed without its
                      interval; this number has none to print, and dressing it
                      as a Metric to reach the formatter is what created the
                      trap this change removes. */}
                  <td className="num">{formatShare(cl.share)}</td>
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
      </div>
    </section>
  )
}

/**
 * One class's reach, spoken. `formatFrequency` refuses outside the band where a
 * frequency is both faithful and legible (packages/stats/format), so the
 * fallback is the percentage and its interval — never a rounded guess written
 * here instead.
 *
 * ⚠️ THE BOUNDS ARE PART OF THE CLAUSE, NOT LEFT TO THE GEOMETRY (review
 * BLOCKER). The `ratio` branch used to print only the point estimate — every
 * OTHER place this reach's bounds exist was `aria-hidden` positioning on the
 * `.estrip` track, so a sighted reader saw a bare figure and a screen reader
 * heard none of it. Mirrors `Headline`'s own collides guard exactly
 * (headline.tsx): a tight interval can round its estimate onto one of its own
 * bounds, and stating both then plus a third identical number is worse than
 * stating the range once.
 *
 * ⚠️ THE DENOMINATOR IS NAMED, NOT IMPLIED (review MINOR h). Some engines cite
 * nothing at all by construction (`mix.enginesWithNone`, stated once above),
 * so "of answers" alone reads as though every engine's answers counted evenly
 * toward this reach; naming `n` is the same discipline `formatFrequency`'s own
 * `from` clauses use elsewhere on this product.
 */
function ReachClause({ metric, n }: { metric: Metric; n: number }) {
  const spoken = formatFrequency(metric)
  if (spoken.kind === 'ratio') {
    const collides = spoken.pointK === spoken.highK || spoken.pointK === spoken.lowK
    if (collides) {
      return (
        <>
          in <span className="num">{spoken.low}</span> to <span className="num">{spoken.high}</span> of the <span className="num">{n}</span> answers
        </>
      )
    }
    return (
      <>
        in about <span className="num">{spoken.point}</span> of the <span className="num">{n}</span> answers (could be as few as{' '}
        <span className="num">{spoken.low}</span>, or as many as <span className="num">{spoken.high}</span>)
      </>
    )
  }
  if (spoken.kind === 'none') {
    return (
      <>
        in none of the <span className="num">{n}</span> answers (could be as many as <span className="num">{spoken.high}</span> at this sample size)
      </>
    )
  }
  return (
    <>
      in <span className="num">{formatValue(metric)}</span> of the <span className="num">{n}</span> answers (range{' '}
      <span className="num">{formatInterval(metric)}</span>)
    </>
  )
}

/* ==========================================================================
   MOST CITED SITES — magnitude, not a proportion
   ==========================================================================

   ⚠️ AUTO-FIT IS THE RIGHT CALL HERE, AND IT IS THE ONE PLACE ON THIS SHEET
   IT IS. Every proportion axis on this product is fixed at 0-100% and never
   fitted, because fitting a proportion magnifies noise into a mountain range.
   A count of citations is not a proportion: there is no uncertainty band to
   misrepresent by scaling it, and a "top sites" ranking scaled to its own
   largest bar is the ordinary, honest way to draw one. The exact counts are
   printed beside every bar, so nothing here trades on the eye alone.
   ========================================================================== */

function MostCited({ mix, distinctSites }: { mix: CitationMix; distinctSites: number }) {
  if (mix.hosts.length === 0) {
    return (
      <section aria-labelledby="most-cited-heading" style={{ marginTop: 'var(--space-5)' }}>
        <h3 id="most-cited-heading">Most cited sites</h3>
        <p className="prose prose--flag">
          Every citation in this cycle was an engine&apos;s own redirect link naming no site, so no individual site can be ranked. They are still
          counted in the classes and the total above.
        </p>
      </section>
    )
  }

  const top = mix.hosts[0]!
  const max = top.count

  return (
    <section aria-labelledby="most-cited-heading" style={{ marginTop: 'var(--space-5)' }}>
      <h3 id="most-cited-heading">Most cited sites</h3>
      {/* MINOR g: the list is a TOP, not the whole picture — `citationMix`
          caps it at 12 (`topHosts`), and a reader comparing this count with
          the "distinct sites" figure above without being told so would take
          a partial list for a complete one. */}
      <p className="prose">
        The <span className="num">{mix.hosts.length}</span> {mix.hosts.length === 1 ? 'site' : 'sites'} cited most often, of{' '}
        <span className="num">{distinctSites}</span> in total:
      </p>
      <ol className="hostbars">
        {mix.hosts.map((h) => (
          <li className="hostbar" key={h.domain}>
            <span className="hostbar__name">
              {h.domain}
              {h.sourceClass === 'owned' ? <span className="flag">yours</span> : null}
            </span>
            <span className="hostbar__track" aria-hidden="true">
              <span className="hostbar__fill" style={{ width: `${(h.count / max) * 100}%` }} />
            </span>
            <span className="hostbar__count num">
              {h.count} in {h.answers} {h.answers === 1 ? 'answer' : 'answers'}
            </span>
          </li>
        ))}
      </ol>
      <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
        Cited most often: <strong>{top.domain}</strong>, <span className="num">{top.count}</span> {top.count === 1 ? 'time' : 'times'} across{' '}
        <span className="num">{top.answers}</span> {top.answers === 1 ? 'answer' : 'answers'}.
      </p>
      {mix.hosts.length > 1 ? (
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-2)' }}>
          A gap of one or two citations between neighbouring sites is not a finding at this sample size — the order above is a fact about this
          count, not a ranking to read weight into.
        </p>
      ) : null}

      <div className="detail">
        <div className="table-wrap" style={{ marginTop: 'var(--space-3)' }}>
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
      </div>
    </section>
  )
}
