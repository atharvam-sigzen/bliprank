import Link from 'next/link'
import { assertProvisionalAllowed, confidenceGrade, formatProvenance } from '@bliprank/stats'
import { RangeRail } from '@/components/range-rail'
import { zeroMentionsWords } from '@/components/zero-mentions'
import type { PortfolioRowModel } from '@/lib/portfolio'

// Module scope on purpose, as on the page that renders these rows: the grade is
// PROVISIONAL, and a live-facing build must fail at `next build`, not in front
// of an audience when the first client is added.
assertProvisionalAllowed('The agency portfolio')

/**
 * ONE CLIENT, ONE ROW, DRAWN FROM ITS REAL LATEST CYCLE (MVP_PLAN D1).
 *
 * What the row carries, and why each is here:
 *
 *   - the rate WITH its range and its n, and the noun a percentage needs
 *     ("of answers"), beside the rail: a row cannot show a figure without
 *     showing how much it does not know (R8);
 *   - a ZERO in words, with its range: the reader who most needs the number
 *     explained must not get a bare 0.0% rail (the defect C3r item 3 fixed on
 *     the record, which this row would otherwise have reintroduced). One
 *     shared sentence, `zeroMentionsWords`, no new copy;
 *   - what KIND of cycle it is when it is not a check this machine collected
 *     (the bundled reference scan, a fixture cycle), and that its category
 *     was not identified when it was not: the record flags all three, and a
 *     row that did not would be the one surface printing them bare;
 *   - whose questions produced it, when they were the client's own;
 *   - the trend as `compare()`'s verdict in words: no arrow, no delta;
 *   - the daily re-check as the INSTRUCTION it is, and the days remaining;
 *   - when the row is near the top, WHY.
 *
 * Pure: every sentence is decided in `lib/portfolio.ts` from the client's own
 * cycles. The remove button stays a SIBLING of the link, never a child.
 */
export function PortfolioClientRow({ row, onRemove }: { row: PortfolioRowModel; onRemove?: (domain: string) => void }) {
  const { grade } = confidenceGrade(row.metric)
  // No set is passed: the row's own label says whose questions, in agency words, and "your prompts" here would be ambiguous.
  const zero = zeroMentionsWords(row.metric)
  return (
    <li className="portfolio__row" data-portfolio-row={row.domain} data-attention={row.attention.rank} data-origin={row.origin}>
      <div className="portfolio__head">
        <Link className="portfolio__link" href={`/agency/client/${encodeURIComponent(row.domain)}`}>
          <span className="portfolio__client">{row.domain}</span>
          <span className="portfolio__category">
            {row.categoryName}
            {row.categoryNote ? ' · category not confirmed' : ''} · latest check {row.day || 'undated'} · {row.cycles} {row.cycles === 1 ? 'check' : 'checks'} so
            far · mentioned in <span className="num">{row.stated}</span>
          </span>
        </Link>
        {/* Whose questions, at BOTH depths, like the sample size: it changes what the number is a measurement OF. */}
        {row.ownSetWords ? (
          <span className="portfolio__category prose--flag" data-prompt-set>
            measured over {row.ownSetWords}, not the category&apos;s questions
          </span>
        ) : null}
        <span className="portfolio__category detail">{formatProvenance(row.metric)}</span>
        {onRemove ? (
          <button type="button" className="btn btn--quiet" onClick={() => onRemove(row.domain)} style={{ marginTop: 'var(--space-2)' }}>
            Remove {row.domain}
          </button>
        ) : null}
      </div>

      <div className="portfolio__rail">
        <RangeRail label="Mention rate" metric={row.metric} />
        {zero ? (
          <p className="prose" data-zero-mentions>
            {zero.found} {zero.range}
          </p>
        ) : null}
        {row.originNote ? (
          <p className="prose prose--flag" data-origin-note>
            {row.originNote}
          </p>
        ) : null}
        {row.categoryNote ? (
          <p className="prose prose--flag" data-category-note>
            {row.categoryNote}
          </p>
        ) : null}
        <p className="prose" data-movement>
          Trend: {row.movement}. Daily re-check: {row.tracking}.
        </p>
        {row.attention.why ? (
          <p className="prose prose--flag" data-attention-why>
            Needs a look: {row.attention.why}.
          </p>
        ) : null}
      </div>

      <div className="portfolio__marks">
        <span className="portfolio__mark">
          <span className="readout__cap">Precision</span>
          <span className="portfolio__grade num">{grade}</span>
        </span>
      </div>
    </li>
  )
}
