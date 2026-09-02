'use client'

import { byEngine, promptBreakdown } from '@/lib/prompt-breakdown'
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
      <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
        There is no per-question breakdown for this cycle. The answers were scored together into one rate of{' '}
        <span className="num">{scan.counts.answersScored}</span> answers, and this file does not carry which question or which engine each of
        them came from. That is a statement about this stored payload, not a finding: it does not mean the questions went unanswered, and
        splitting the total five ways to fill the gap would be arithmetic presented as evidence.
      </p>
    )
  }

  const engines = byEngine(breakdown)
  const subject = subjectOf(scan)

  return (
    <section className="section" aria-labelledby="breakdown-heading">
      <h2 id="breakdown-heading">Which questions you appear in</h2>

      <p className="prose">
        {subject.name} was named in <span className="num">{breakdown.mentionedIn}</span> of{' '}
        <span className="num">{breakdown.answers}</span> answers — the same numerator and the same denominator as the rate above, listed out
        rather than summarised. {breakdown.prompts.length} questions, each asked on {breakdown.engines.length}{' '}
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
                  {engine}
                </th>
              ))}
              <th scope="col">Named in</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.prompts.map((line) => (
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
                        className={cell.mentioned ? 'mark mark--hit' : 'mark'}
                        title={
                          cell.mentioned
                            ? `named ${cell.mentionCount}x, ${cell.position} of ${cell.brandsDetected} brands in this answer${cell.cited ? ', and cited' : ''}`
                            : `not named; ${cell.brandsDetected} other ${cell.brandsDetected === 1 ? 'brand was' : 'brands were'} named in this answer`
                        }
                      >
                        {cell.mentioned ? `${cell.position}/${cell.brandsDetected}` : '—'}
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
        A cell reads <span className="num">2/6</span> when {subject.name} was the second of six brands the answer named, counted by where each
        first appears. <span className="num">—</span> means the answer named other brands and not this one, <span className="num">·</span> means
        no answer was collected for that cell, and <span className="num">¶</span> marks an answer that cited one of this domain&apos;s own
        pages.
      </p>

      {/*
        THE PER-ENGINE FOOTER IS NOT A PER-ENGINE RATE, and the difference is
        worth a sentence. Ten answers per engine is a Wilson interval roughly
        three times wider than the fifty-answer one above, so a gap between two
        engines here is almost never a finding at this sample size. The counts
        are shown because they are facts; a per-engine percentage with a green
        arrow on it would not be (R8).
      */}
      <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
        The engine columns are counts, not rates, and carry no interval. Each holds{' '}
        <span className="num">{engines[0]?.answers ?? 0}</span> answers against the headline&apos;s{' '}
        <span className="num">{breakdown.answers}</span>, so an interval around any one of them would be wide enough to overlap all the others.
        A difference between two columns at this sample size is not yet a difference between two engines.
      </p>

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

      <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
        There is no sentiment column. Sentiment is the one signal a model is allowed to produce here, on a sampled basis, and that pass is not
        built — so no answer in this cycle carries one. An empty column would read as &ldquo;neutral&rdquo;, which is a finding this scan did
        not make.
      </p>
    </section>
  )
}
