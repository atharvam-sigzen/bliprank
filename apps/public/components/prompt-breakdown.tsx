'use client'

import { useState } from 'react'
import { answerKey, indexAnswers, loadAnswers, type AnswerIndex, type StoredAnswer, type StoredCitation } from '@/lib/answers'
import { shortFor } from '@/lib/citations'
import { MIN_N_FOR_COMPARISON, wilson } from '@bliprank/stats'
import { engineName } from '@/lib/engines'
import { byEngine, byIntent, promptBreakdown, type BreakdownLine, type PromptBreakdown } from '@/lib/prompt-breakdown'
import { subjectOf, type ScanResultFile } from '@/lib/scan-result'

/**
 * PHASES 3.3 — WHICH QUESTIONS, ON WHICH ENGINE. One cycle, opened up.
 *
 * THE DEFECT THIS ENDS. The record published one rate over fifty answers and
 * then explained, in prose, that it could not break that rate down: "the
 * per-engine split is not in this cycle's stored payload. Splitting the total
 * five ways would be arithmetic presented as evidence." Both sentences were
 * true, and the second is still true — a total divided by five is not five
 * findings. What was wrong was the first: the split was computed for every
 * answer, by the same `scoreAnswer` pass that produced the rate, and then
 * discarded before the file was written. It is now kept (`PromptRow`), so this
 * table divides nothing. Every cell is one answer.
 *
 * ⚠️ IT DRAWS NOTHING IT CANNOT RECONCILE. `promptBreakdown` returns null unless
 * the rows total exactly the subject's `mentions` and `n`, so this table and the
 * rate above it are never two different measurements wearing one heading. On
 * null the honest sentence is rendered instead — including for every result file
 * collected before the rows existed, which is most of them.
 *
 * ⚠️ NO SENTIMENT COLUMN. PHASES 2.3 is unbuilt and no stored answer carries a
 * sentiment, so there is nothing to put in one. Said once, in words, rather than
 * shown as an empty column a reader would take for "neutral".
 */
export function PromptBreakdown({ scan }: { scan: ScanResultFile }) {
  const breakdown = promptBreakdown(scan)

  if (!breakdown) {
    return (
      /*
       * WRAPPED, so the depth marking sits on the section rather than on the
       * flagged paragraph — and this is a judgement, not a way round the rule.
       *
       * depth.test.ts refuses any element carrying both `prose--flag` and
       * `detail`, because a flagged paragraph is normally a caveat that changes
       * how a VISIBLE number must be read, and hiding one of those would make
       * the page calmer by making it untrue. This paragraph is a different
       * animal: it explains why a section that is itself hidden has nothing in
       * it. It says nothing about the headline rate, which is exactly as valid
       * either way. At simple depth the breakdown is not offered, so an
       * explanation of its absence is noise.
       */
      <section className="section detail">
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
          There is no per-question breakdown for this cycle. The answers were scored together into one rate of{' '}
        <span className="num">{scan.counts.answersScored}</span> answers, and this file does not carry which question or which engine each of
        them came from. That is a statement about this stored payload, not a finding: it does not mean the questions went unanswered, and
          splitting the total five ways to fill the gap would be arithmetic presented as evidence.
        </p>
      </section>
    )
  }

  const engines = byEngine(breakdown)

  /*
   * LEAST COVERED FIRST, and the rows were in no order at all before this.
   *
   * `promptBreakdown` builds them from a Map's insertion order, so on the
   * shipped scan the "Named in" column ran 4,5,3,4,5,2,0,0,4,2,0,1,0,1,3,1,3 —
   * the questions a brand is absent from scattered through the middle of the
   * grid. The pattern a reader comes here for was present in the data and
   * invisible in the arrangement, which no amount of cell styling fixes.
   *
   * Worst first, matching the gap report's coverage table: the questions you do
   * not appear in are the ones the section exists to surface. `sort` is stable,
   * so ties keep the bank's own order.
   */
  const rows = [...breakdown.prompts].sort((a, b) => a.mentionedIn - b.mentionedIn)
  const subject = subjectOf(scan)

  /*
   * THE PLAIN READING — two counts, no estimate, no threshold.
   *
   * A question counts as one you appeared in when at least one engine named you
   * in its answer to it. That is a count of rows, exactly like everything else
   * in this component, and it is the shape of the question a brand owner
   * actually arrives with: not "what is my rate" but "where do I come up".
   *
   * ⚠️ THE SECOND COUNT IS LOAD-BEARING, NOT DECORATION. "Named in 4 of 6
   * questions" alone reads as "I am in two thirds of conversations", and it is
   * consistent with being named by one engine out of five each time — 4 of 30
   * answers, a rate of 13%. Printing both counts side by side is what stops the
   * first from overstating, and it costs one clause. The answers pair is also
   * the headline's own numerator and denominator, so the two readings of this
   * cycle are visibly the same measurement rather than two that must be
   * reconciled on trust.
   */
  const questionsNamedIn = breakdown.prompts.filter((p) => p.mentionedIn > 0).length
  const questions = breakdown.prompts.length
  const q = (n: number) => `${n} ${n === 1 ? 'question' : 'questions'}`

  return (
    <section className="section" aria-labelledby="breakdown-heading">
      <h2 id="breakdown-heading">Which questions you appear in</h2>

      {/* BOTH DEPTHS. Not a simple-only element — a rule that showed something
          only under `simple` would have to key on the attribute's absence or on
          `detailed`, and ADR-0010 forbids both so a no-JavaScript reader never
          loses anything. It reads as the section's opening sentence at either
          depth, which is what it is. */}
      <p className="prose">
        {questionsNamedIn === 0 ? (
          <>
            {subject.name} was not named in any of the <span className="num">{q(questions)}</span> we asked, across all{' '}
            <span className="num">{breakdown.answers}</span> answers they produced.
          </>
        ) : questionsNamedIn === questions ? (
          <>
            {subject.name} was named in all <span className="num">{q(questions)}</span> we asked, and in{' '}
            <span className="num">
              {breakdown.mentionedIn} of the {breakdown.answers}
            </span>{' '}
            answers they produced.
          </>
        ) : (
          <>
            {subject.name} was named in{' '}
            <span className="num">
              {questionsNamedIn} of the {q(questions)}
            </span>{' '}
            we asked, and in{' '}
            <span className="num">
              {breakdown.mentionedIn} of the {breakdown.answers}
            </span>{' '}
            answers they produced.
          </>
        )}
      </p>

      {/*
        EVERYTHING TECHNICAL, UNDER ONE MARK.

        Grouping rather than sprinkling `.detail` over six elements, and that is
        the rule's natural shape rather than a convenience: ADR-0010 says a block
        is detail when hiding it removes no mark, which is a statement about a
        mark AND ITS EXPLANATION travelling together. A wrapper says exactly
        that. It also means the two `prose--flag` caveats inside never carry
        `.detail` themselves — depth.test.ts refuses that pairing, because a
        flagged paragraph is normally a caveat about a VISIBLE number, and these
        two are caveats about the table above them, which goes when they do.
      */}
      {/* SIMPLE DEPTH, and that is a departure from the rule that a breakdown
          is agency territory. The difference is what it is a breakdown OF: the
          engine strip and the matrix are about our instrumentation, and this is
          about the reader's own content. "You are named in most of the buying
          questions and a quarter of the problem ones" is the most actionable
          thing on the page after the headline, and it is two bars and a
          sentence. */}
      <IntentSplit breakdown={breakdown} subjectName={subject.name} />

      <div className="detail">
        <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
          The same numerator and the same denominator as the rate above, listed out rather than summarised, least covered first.{' '}
          {breakdown.prompts.length} questions, each asked on {breakdown.engines.length}{' '}
          {breakdown.engines.length === 1 ? 'surface' : 'surfaces'}. Every cell below is one answer that was actually collected and scored.
        </p>

      <div className="table-wrap" style={{ marginTop: 'var(--space-4)' }}>
        <table>
          <caption className="visually-hidden">
            Per-question breakdown: for each prompt, whether {subject.name} was named in the answer from each engine.
          </caption>
          <thead>
            <tr>
              <th scope="col">Question</th>
              {breakdown.engines.map((engine) => (
                <th scope="col" key={engine}>
                  {engineName(engine)}
                </th>
              ))}
              <th scope="col">Named in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((line) => (
              <tr key={line.prompt}>
                {/* The prompt verbatim and unwrapped-in-full: this is the question
                    that was asked, and a truncated one is a different question. */}
                <th scope="row" style={{ whiteSpace: 'normal', minWidth: '18rem', fontWeight: 400 }}>
                  {line.prompt}
                </th>
                {breakdown.engines.map((engine) => {
                  const cell = line.cells.find((c) => c.engine === engine)
                  if (!cell) {
                    /* NOT COLLECTED IS NOT NOT-MENTIONED. A failed or skipped cell
                       has no answer to score, so it gets a mark that means "no
                       answer", never the one that means "you were absent from
                       it". */
                    return (
                      <td className="num" key={engine} title="no answer was collected for this cell">
                        <span aria-label="no answer collected">·</span>
                      </td>
                    )
                  }
                  return (
                    <td className="num" key={engine}>
                      <span
                        className={cell.mentioned ? `mark mark--hit ${rankClass(cell.position)}` : 'mark'}
                        title={
                          cell.mentioned
                            ? `named ${cell.mentionCount}x, ${cell.position} of ${cell.brandsDetected} brands in this answer${cell.cited ? ', and cited' : ''}`
                            : `not named; ${cell.brandsDetected} other ${cell.brandsDetected === 1 ? 'brand was' : 'brands were'} named in this answer`
                        }
                      >
                        {cell.mentioned ? rankLabel(cell.position, cell.brandsDetected) : '—'}
                        {cell.cited ? <span title="one of your own pages was cited"> ¶</span> : null}
                      </span>
                    </td>
                  )
                })}
                <td className="num">
                  {line.mentionedIn}/{line.answers}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" style={{ fontWeight: 600 }}>
                Named in
              </th>
              {engines.map((e) => (
                <td className="num" key={e.engine}>
                  {e.mentionedIn}/{e.answers}
                </td>
              ))}
              <td className="num">
                {breakdown.mentionedIn}/{breakdown.answers}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
        A cell reads <span className="num">#2 of 6</span> when {subject.name} was the second of six brands the answer named, counted by where
        each first appears. <strong>Lower is better</strong>: <span className="num">#1</span> is the first brand the engine reached for. The mark
        is heaviest at <span className="num">#1</span> and lightens as the rank falls, so the pattern reads without doing the arithmetic.{' '}
        <span className="num">—</span> means the answer named other brands and not this one, <span className="num">·</span> means no answer was
        collected for that cell, and <span className="num">¶</span> marks an answer that cited one of this domain&apos;s own pages. The last
        column is a plain fraction, not a rank: <span className="num">4/5</span> there means named in four of five answers.
      </p>

      {/*
        THE CAVEAT, DRAWN INSTEAD OF ASSERTED.

        This was a sentence saying an interval around any one engine "would be
        wide enough to overlap all the others". True, and a reader had to take
        it on trust while looking at a row of bare counts that invited exactly
        the comparison it was warning against. The intervals are now drawn, so
        the overlap is the thing you see rather than the thing you are told.
      */}
      <EngineIntervals engines={engines} overall={breakdown.mentionedIn / breakdown.answers} subjectName={subject.name} />

      {breakdown.competitors.length > 0 ? (
        <>
          <p className="prose" style={{ marginTop: 'var(--space-4)' }}>
            Tracked competitors the engines named in these same answers:
          </p>
          <ul className="promptlist" style={{ marginTop: 'var(--space-2)' }}>
            {breakdown.competitors.map((c) => (
              <li className="promptlist__item" key={c.name}>
                <span className="promptlist__text">{c.name}</span>
                <span className="promptlist__intent num">
                  {c.answers}/{breakdown.answers}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-4)' }}>
          No competitor is named in this list because this bank tracks none — a category authored for this business carries no competitor set,
          because a competitor nobody measured is a competitor somebody invented. The engines named other brands in these answers (the
          denominators above count them), and promoting one into the tracked set is a deliberate act with the collected evidence attached.
        </p>
      )}

      <Evidence scan={scan} lines={breakdown.prompts} subjectName={subject.name} />

      <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
        There is no sentiment column. Sentiment is the one signal a model is allowed to produce here, on a sampled basis, and that pass is not
        built — so no answer in this cycle carries one. An empty column would read as &ldquo;neutral&rdquo;, which is a finding this scan did
        not make.
      </p>
      </div>
    </section>
  )
}

/**
 * ⚠️ THE ACTUAL ANSWERS. Every number above is derived from these, and this is
 * where a reader stops trusting the derivation and reads the input.
 *
 * NOT LOADED UNTIL ASKED. Measured: this scan's answer text is 191 KB raw and
 * 64 KB gzipped, against 2.5 KB for the whole result file. It sits behind a
 * button and a dynamic import so a visitor who never opens it never downloads
 * it — see `lib/answers.ts` for why that trade is made rather than assumed.
 *
 * ⚠️ VERBATIM AND WHOLE. No excerpt, no highlight, no "relevant portion". An
 * excerpt is us choosing which part of the evidence a reader sees, and the
 * answers that do NOT name the brand are exactly as load-bearing as the ones
 * that do — they are the denominator.
 *
 * ⚠️ AND NO HIGHLIGHTING OF THE MATCH, which is a decision rather than an
 * omission. Marking where the scorer matched would mean re-running a matcher in
 * the browser over the RAW text, while the real one runs over a normalised form
 * with URL masking and whole-token boundaries. The two would disagree
 * eventually, and a highlight that contradicts the verdict beside it is worse
 * than no highlight: it teaches a reader that the evidence and the number are
 * two different things. The reader has ctrl-F, which is exactly as good and
 * cannot drift.
 *
 * ⚠️ WHICH MEANS THIS IS ALSO HOW WE GET CAUGHT. A reader who finds their brand
 * in an answer we scored as a miss has found a false zero — the defect that
 * published `thecosmicbyte.com` as mentioned in 0 of 50 answers while the
 * engines wrote "Cosmic Byte" 139 times. That is the point. It is the only
 * check on this instrument that does not come from us.
 */
function Evidence({ scan, lines, subjectName }: { scan: ScanResultFile; lines: readonly BreakdownLine[]; subjectName: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'refused'>('idle')
  const [index, setIndex] = useState<AnswerIndex | null>(null)
  const [message, setMessage] = useState('')

  async function open() {
    setState('loading')
    const got = await loadAnswers(scan)
    if (!got.ok) {
      setMessage(got.message)
      setState('refused')
      return
    }
    setIndex(indexAnswers(got.answers))
    setState('ready')
  }

  if (state === 'idle' || state === 'loading') {
    return (
      <div style={{ marginTop: 'var(--space-4)' }}>
        <button type="button" className="btn btn--quiet" onClick={() => void open()} disabled={state === 'loading'}>
          {state === 'loading' ? 'Opening the answers…' : 'Read what the engines actually said'}
        </button>
        <p className="prose" style={{ marginTop: 'var(--space-2)' }}>
          Every figure above is counted from these answers. They are not loaded until you ask, because they are considerably larger than the rest
          of this page — press the button and you can read any of the {lines.length} questions exactly as {scan.domain} was answered, word for
          word, including the ones where {subjectName} was not named.
        </p>
      </div>
    )
  }

  if (state === 'refused') {
    return (
      <p className="prose prose--flag" style={{ marginTop: 'var(--space-4)' }}>
        {message}
      </p>
    )
  }

  const held = index!
  const expected = lines.reduce((n, l) => n + l.answers, 0)
  const got = [...held.values()].reduce((n, a) => n + a.length, 0)

  return (
    <section style={{ marginTop: 'var(--space-4)' }}>
      <p className="prose">
        {/* Counted against what the rows expect, so a short evidence set is a
            stated shortfall rather than a quietly shorter list. */}
        {got === expected ? (
          <>
            All <span className="num">{expected}</span> answers behind the table above, verbatim. Open a question to read what each engine wrote.
          </>
        ) : (
          <>
            <span className="num">{got}</span> of the <span className="num">{expected}</span> answers behind the table above could be read back.
            The rest are not in this build&apos;s store; nothing is substituted for them.
          </>
        )}
      </p>

      {lines.map((line) => (
        <details key={line.prompt} className="evidence">
          <summary className="evidence__q">
            <span className="evidence__prompt">{line.prompt}</span>
            <span className="num evidence__count">
              {line.mentionedIn}/{line.answers}
            </span>
          </summary>
          {line.cells.map((cell, i) => {
            const found = held.get(answerKey(line.prompt, cell.engine)) ?? []
            const answer: StoredAnswer | undefined = found[0]
            return (
              <article className="evidence__a" key={`${cell.engine}-${i}`}>
                <p className="evidence__head">
                  <span className="evidence__engine">{engineName(cell.engine)}</span>
                  <span className="num">
                    {cell.mentioned ? `${subjectName} named — ${cell.position} of ${cell.brandsDetected} brands` : `${subjectName} not named`}
                    {cell.brandsDetected > 0 && !cell.mentioned ? ` · ${cell.brandsDetected} other named` : ''}
                  </span>
                </p>
                {!answer ? (
                  <p className="prose prose--flag">The text of this answer is not in this build&apos;s store, so it cannot be shown.</p>
                ) : answer.empty ? (
                  /* ⚠️ AN ABSENT ANSWER IS NOT A SILENT ONE, and a blank box
                     would say the wrong one of those. Every empty answer in this
                     corpus is a google-ai-overviews cell where Google showed no
                     overview at all. It is still counted in the denominator
                     above — a scoring rule, and a human's to change — so the
                     honest thing is to say exactly that, here, next to it. */
                  <p className="prose prose--flag">
                    This engine returned no answer at all for this question — there was no AI answer to be named in, rather than an answer that
                    did not name {subjectName}. It is still counted in the {line.answers} above, which is why the two facts are worth telling
                    apart.
                  </p>
                ) : (
                  /* tabIndex: the block scrolls, and a scrollable region that cannot be
                     reached by keyboard is unreachable for anyone not using a mouse
                     (WCAG 2.1.1). aria-label because "pre" announces nothing. */
                  <pre className="evidence__text" tabIndex={0} aria-label={`${engineName(cell.engine)} answer, verbatim`}>
                    {answer.text}
                  </pre>
                )}
                {/* The sources this answer cited, each with the class the scan's
                    own rules gave it. "None" is stated, because an engine that
                    cites nothing (gemini, in this corpus) is a fact worth a line
                    and not a blank. */}
                {answer && !answer.empty ? <Cites citations={answer.citations} /> : null}
              </article>
            )
          })}
        </details>
      ))}
    </section>
  )
}

/** How many citations one answer's list shows before it says "and N more". The corpus maximum is 11. */
const MAX_CITES_SHOWN = 40

function Cites({ citations }: { citations: readonly StoredCitation[] }) {
  if (citations.length === 0) return <p className="cites cites--none">No sources cited by this engine for this answer.</p>
  const shown = citations.slice(0, MAX_CITES_SHOWN)
  return (
    <ul className="cites" aria-label="Sources this answer cited">
      {shown.map((k) => (
        <li key={`${k.position}-${k.url}`}>
          {/* A link only for an absolute web URL that names a host. A provider's
              own redirect (`/goto?url=…`) is stored verbatim at collection and
              would resolve against THIS site; a `data:` or other scheme is not
              a place to send a reader. Those are named, not linked. */}
          {k.domain && /^https?:\/\//i.test(k.url) ? (
            <a className="cites__host" href={k.url} target="_blank" rel="noreferrer noopener nofollow">
              {k.domain}
            </a>
          ) : (
            <span className="cites__host cites__host--unresolvable">an engine redirect link naming no site</span>
          )}
          <span className="flag">{shortFor(k.sourceClass)}</span>
        </li>
      ))}
      {citations.length > shown.length ? <li className="cites--none">and {citations.length - shown.length} more</li> : null}
    </ul>
  )
}

/* ==========================================================================
   A RANK IS NOT A FRACTION — the defect this pair of helpers fixes
   ==========================================================================

   ⚠️ THIS SHIPPED, AND IT READ BACKWARDS. The cell printed
   `position/brandsDetected`, so "4/4" meant FOURTH OF FOUR — the worst
   available result — and "1/5" meant first of five, the best. Every reader
   convention says 4/4 is full marks and 1/5 is nearly nothing, so a reader
   scanning the grid for strong cells found precisely the weak ones. `.mark--hit`
   compounded it by setting every named cell in the same bold ink, so the
   typography agreed with the misreading.

   It was invisible in review for the same reason the mislabelled axis was: the
   code is correct, the arithmetic is correct, and only the rendered grid says
   what a reader will take from it.

   Two fixes, because either alone is thin. The `#` and the spelled "of" make
   the notation state a rank rather than imply a proportion; the weight makes
   the ranking legible without reading the number at all, which is what a matrix
   is for. Weight and ink only — never colour, which this sheet spends on data
   and which a colour-blind or greyscale reader would lose.
   ========================================================================== */

/** `#1 of 5`. Null position: named, but the pass recorded no rank for it. */
function rankLabel(position: number | null, brands: number): string {
  if (position === null || position <= 0) return 'named'
  return `#${position} of ${brands}`
}

/**
 * Three steps, not a gradient. The distinction a reader needs is "first",
 * "near the front" and "also mentioned"; grading every rank separately would
 * imply the sample can tell #4 from #5, which at these cell counts it cannot.
 */
function rankClass(position: number | null): string {
  if (position === null || position <= 0) return 'mark--rank3'
  if (position === 1) return 'mark--rank1'
  if (position === 2) return 'mark--rank2'
  return 'mark--rank3'
}

/* ==========================================================================
   PER-ENGINE INTERVALS — the caveat as a picture
   ==========================================================================

   THIS ONE MAY USE THE RAIL'S LANGUAGE, and the coverage strip next door may
   not. The difference is not taste: an engine's rate is a proportion of a
   SAMPLE — seventeen answers it actually returned — so it has sampling
   uncertainty and a Wilson interval is the honest way to draw it. Term coverage
   is a word check over one document with no sample at all, which is why that
   strip gets discrete ticks and no interval. Same sheet, opposite treatment,
   because they are different kinds of claim.

   FIXED 0-100, NEVER FITTED, like every other interval on this sheet. Fitting
   the axis to five engines that all sit between 15% and 60% would draw
   near-identical rates as dramatically separated bars, which is the chart lying
   by omission.

   ⚠️ NO VERDICT, AND THAT IS DELIBERATE. Two things could be tested here and
   only one of them honestly:

     - engine against engine is a legitimate comparison (their answers are
       disjoint, so the samples are independent) — but `compare()` keys on
       `comparison_basis`, and two engines have different bases BY DESIGN, so it
       would refuse a comparison that is actually valid. Resolving that is a
       methodology decision, not a rendering one (CLAUDE.md §4);
     - engine against the cycle-wide rate is NOT legitimate at all: the overall
       rate contains this engine's answers, so the two are not independent.

   So the overall rate is drawn as a REFERENCE, unlabelled by any verdict, and
   nothing here says "higher" or "lower" about anything. The reader sees five
   intervals that overlap each other and straddle the line, which is the finding.
   ========================================================================== */

function EngineIntervals({
  engines,
  overall,
  subjectName,
}: {
  engines: readonly { readonly engine: string; readonly answers: number; readonly mentionedIn: number }[]
  overall: number
  subjectName: string
}) {
  if (engines.length === 0) return null
  const rows = engines.map((e) => ({ ...e, w: wilson(e.mentionedIn, e.answers) }))

  return (
    <section className="estrip" aria-labelledby="estrip-heading">
      <h3 id="estrip-heading">Engine by engine, with what each one can actually tell you</h3>

      <ol className="estrip__rows">
        {rows.map((r) => (
          <li className="estrip__row" key={r.engine}>
            <span className="estrip__name">{engineName(r.engine)}</span>
            {/* aria-hidden: the bar is a picture of the numbers printed beside
                it, and announcing the geometry as well would be the same fact
                twice. */}
            <span className="estrip__track" aria-hidden="true">
              <span
                className="estrip__band"
                style={{ left: `${r.w.ci_low * 100}%`, width: `${(r.w.ci_high - r.w.ci_low) * 100}%` }}
              />
              <span className="estrip__needle" style={{ left: `calc((100% - 3px) * ${r.w.value})` }} />
              <span className="estrip__ref" style={{ left: `${overall * 100}%` }} />
            </span>
            <span className="estrip__count num">
              {r.mentionedIn} of {r.answers}
            </span>
          </li>
        ))}
      </ol>

      <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
        Each bar is one engine&apos;s own answers — <span className="num">{rows[0]?.answers ?? 0}</span> of them, against the{' '}
        <span className="num">{rows.reduce((t, r) => t + r.answers, 0)}</span> the headline is drawn from — so every one is a much smaller sample and
        every interval is correspondingly wider. The upright marks the rate across all engines together.
      </p>
      <p className="prose prose--flag" style={{ marginTop: 'var(--space-2)' }}>
        Where these bars overlap each other, the difference between those two engines is not something this cycle can show, whatever the counts
        beside them say. No engine is ranked against another here and none is called better: on a sample this size that would be a claim about
        {' '}{subjectName} the evidence does not support.
      </p>
    </section>
  )
}

/* ==========================================================================
   BY QUESTION TYPE — where the brand shows up, and where it does not
   ==========================================================================

   The bank classifies every question it authors as `discovery` ("which CRM
   should I buy") or `problem-led` ("how do I fix this"), and until 2026-09-07
   that classification was thrown away before the result was written. It is
   carried on the row now, so the split is drawable — and on the shipped scan it
   is the largest gap anywhere on the record: 58.0% of discovery answers name
   the subject against 25.7% of problem-led ones.

   THE SAME INSTRUMENT AS THE ENGINE STRIP, deliberately. A reader who has
   learnt the rail should not be taught a third vocabulary for the fourth
   interval on one page.

   ⚠️ IT STATES WHAT THE PICTURE SHOWS AND STOPS THERE. `compare()` would
   actually work on these two — discovery and problem-led are DISJOINT prompt
   sets, so unlike two engines they are independent samples — but
   `comparison_basis` is a CYCLE-level string carrying `unprompted=17`.
   Building a group metric with it claims seventeen prompts for a group that
   used ten; building an honest subset basis makes the two differ and
   `compare()` refuses a comparison that is genuinely valid. The basis cannot
   express a prompt-subset comparison, which is a real gap recorded in
   docs/PROGRESS.md and not solved here.

   So the wording is a fact about the marks — whether the ranges overlap — and
   never the word "significant", which is the claim `compare()` exists to gate.
   DERIVED EVERY TIME, never assumed: the separation on the shipped scan is
   44.2 against 42.1, two points wide, and one answer flipping would close it.
   A cycle where they overlap has to say so on its own.
   ========================================================================== */

function IntentSplit({ breakdown, subjectName }: { breakdown: PromptBreakdown; subjectName: string }) {
  const { groups, unclassified } = byIntent(breakdown)
  // Nothing classified at all — every result written before the field existed.
  // The section is absent rather than empty, like the breakdown itself.
  if (groups.length === 0) return null

  const rows = groups.map((g) => ({ ...g, w: wilson(g.mentionedIn, g.answers) }))
  const overall = breakdown.mentionedIn / breakdown.answers

  // Overlap, computed over every pair rather than assumed of two.
  const separated = rows.every((a, i) => rows.every((b, j) => i === j || a.w.ci_high < b.w.ci_low || b.w.ci_high < a.w.ci_low))
  const thin = rows.filter((r) => r.answers < MIN_N_FOR_COMPARISON)

  return (
    <section className="estrip" aria-labelledby="intent-heading">
      <h3 id="intent-heading">The kind of question matters more than the engine</h3>

      <ol className="estrip__rows">
        {rows.map((r) => (
          <li className="estrip__row" key={r.intent}>
            <span className="estrip__name">{INTENT_LABEL[r.intent] ?? r.intent}</span>
            <span className="estrip__track" aria-hidden="true">
              <span className="estrip__band" style={{ left: `${r.w.ci_low * 100}%`, width: `${(r.w.ci_high - r.w.ci_low) * 100}%` }} />
              <span className="estrip__needle" style={{ left: `calc((100% - 3px) * ${r.w.value})` }} />
              <span className="estrip__ref" style={{ left: `${overall * 100}%` }} />
            </span>
            <span className="estrip__count num">
              {r.mentionedIn} of {r.answers}
            </span>
          </li>
        ))}
      </ol>

      <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
        {/* BOTH DENOMINATORS, for the reason the sentence above the table gives:
            the question counts here are nearly level (8 of 10 against 5 of 7 on
            the shipped scan) while the answer rates are not, and showing only
            one pair hides that the gap is in how OFTEN rather than in whether. */}
        {rows.map((r) => `${INTENT_LABEL[r.intent] ?? r.intent}: named in ${r.questionsNamedIn} of ${r.questions} questions, and in ${r.mentionedIn} of the ${r.answers} answers they produced`).join('. ')}. The
        upright marks the rate across every question together.
      </p>

      <p className={separated ? 'prose' : 'prose prose--flag'} style={{ marginTop: 'var(--space-2)' }}>
        {separated ? (
          <>
            The ranges do not overlap on this scan, so the gap between these question types is one this cycle can actually show — which the
            engine columns above cannot say of themselves. It points at the questions {subjectName} is absent from rather than at a surface to
            chase.
          </>
        ) : (
          <>
            These ranges overlap, so the difference between the two kinds of question is not something this cycle can show. The counts beside them
            are real; the gap between them is not yet a finding.
          </>
        )}
        {thin.length > 0 ? (
          <>
            {' '}
            {thin.map((r) => INTENT_LABEL[r.intent] ?? r.intent).join(' and ')} rests on fewer than <span className="num">{MIN_N_FOR_COMPARISON}</span>{' '}
            answers, which is below the floor this product will compare on at all.
          </>
        ) : null}
      </p>

      {unclassified ? (
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-2)' }}>
          {/* NOT A THIRD BAR. Absent is not a category: these are the customer's
              own prompts, which nobody assigned a buyer intent, or a result
              written before the field existed. An "other" group would draw the
              age of a file as if it were a property of the market. */}
          <span className="num">{unclassified.questions}</span> {unclassified.questions === 1 ? 'question carries' : 'questions carry'} no type and
          {unclassified.questions === 1 ? ' is' : ' are'} left out of the split above: either your own prompts, which nobody classified, or a cycle
          collected before the type was recorded. {unclassified.mentionedIn} of their {unclassified.answers} answers named {subjectName}, and that
          is counted in the headline like every other answer.
        </p>
      ) : null}
    </section>
  )
}

/** The bank's two intents, in the reader's words. Unknown values surface as
 *  themselves, the same rule the engine map follows. */
const INTENT_LABEL: Readonly<Record<string, string>> = {
  discovery: 'Choosing a tool',
  'problem-led': 'Solving a problem',
}
