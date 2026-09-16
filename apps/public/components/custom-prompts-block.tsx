import { formatMetric, formatProvenance } from '@bliprank/stats'
import { RangeRail } from '@/components/range-rail'
import { customBlockOf, customMovement, customSubjectOf } from '@/lib/scan-result-custom'
import type { ScanResultFile } from '@/lib/scan-result'

/**
 * YOUR PROMPTS — the second measurement, rendered as a second record, never
 * folded into the first. ADR-0016, decision 4.
 *
 * What it keeps straight: the number here is over the customer's own prompts
 * only, on its own basis, with its own interval and n; it is not the headline
 * and it is not compared with the headline. A cycle that asked custom prompts
 * and got no answers says so. A cycle that asked none renders nothing here,
 * because absence of the block means the question was not asked, not that the
 * answer was zero.
 */
export function CustomPromptsBlock({ scan, cycles }: { scan: ScanResultFile; cycles: readonly ScanResultFile[] }) {
  const block = customBlockOf(scan)
  if (!block) return null
  const subject = customSubjectOf(scan)
  const movement = customMovement(cycles)
  return (
    <section className="section" id="your-prompts" data-custom-prompts>
      <h2>Your prompts</h2>
      <div className="annotated">
        <div className="annotated__body">
          {subject ? (
            <>
              <p className="prose">
                Across the <span className="num">{block.counts.answersScored}</span> answers to your own {block.prompts.length}{' '}
                {block.prompts.length === 1 ? 'prompt' : 'prompts'}, {scan.domain} was mentioned in{' '}
                <span className="num">{formatMetric(subject.metric)}</span>. This is a separate measurement from the headline above: different
                questions, its own sample, its own interval. The two are not compared with each other.
              </p>
              <RangeRail label="Mention rate, your prompts" metric={subject.metric} />
              {movement ? (
                <p className={`prose${movement.verdict.significance === 'not-comparable' ? ' prose--flag' : ''}`}>
                  {movement.verdict.significance === 'not-comparable'
                    ? `Against the cycle of ${movement.previous}: not comparable, ${movement.why ?? 'a different basis'}.`
                    : movement.verdict.significance === 'no-significant-change'
                      ? `Against the cycle of ${movement.previous}: no significant change.`
                      : `Against the cycle of ${movement.previous}: ${movement.verdict.significance}.`}
                </p>
              ) : null}
            </>
          ) : (
            <p className="prose prose--flag">
              Your {block.prompts.length} {block.prompts.length === 1 ? 'prompt was' : 'prompts were'} asked on this cycle ({block.counts.cellsRequested} requests) and no
              answer came back to score. That is a collection outcome, not a zero.
            </p>
          )}
          <ol className="promptlist" style={{ marginTop: 'var(--space-3)' }}>
            {block.prompts.map((p) => (
              <li className="promptlist__item" key={p}>
                <span className="promptlist__text">{p}</span>
                <span className="promptlist__intent">yours</span>
              </li>
            ))}
          </ol>
        </div>
        <aside className="note">
          <span className="note__cap">Basis</span>
          <span className="note__line">prompt set version {block.version}</span>
          <span className="note__line">
            {block.counts.answersScored} answers · {block.counts.cellsRequested} requests
          </span>
          {subject ? <span className="note__line detail">{formatProvenance(subject.metric)}</span> : null}
          <span className="note__gloss">
            Asked on the same engines, on the same day, through the same budgeted runner as the curated bank, and scored into rows of their own.
            Changing the set makes the next cycle a new question here; the headline and its trend are untouched.
          </span>
        </aside>
      </div>
    </section>
  )
}
