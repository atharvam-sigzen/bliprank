import type { Metadata } from 'next'
import { ProductBar } from '@/components/chrome'
import { RangeRail } from '@/components/range-rail'
import { CONCEPT_NOTICE, PORTFOLIO } from '@/lib/agency-fixture'
import { PREVIEW_SCORE_CAPTION } from '@/lib/preview-score'
import { assertProvisionalAllowed, confidenceGrade } from '@bliprank/stats'

// Same build-time guard the Grader carries: the Confidence Grade thresholds are
// provisional, and a page that renders one must fail `next build` rather than
// discover the block in front of an audience.
assertProvisionalAllowed('The agency portfolio concept')

export const metadata: Metadata = {
  title: 'Agency portfolio (concept) — BlipRank',
  description: 'A concept preview of the portfolio view an agency would use across its clients. Illustrative data only.',
}

/**
 * THE AGENCY VIEW, AS A CONCEPT.
 *
 * ⚠️ MOCKUP. No accounts, no tenancy, no cross-workspace query. Tenancy is
 * human-owned (CLAUDE.md §4) and a real portfolio crosses a workspace boundary
 * on every row — that needs the RLS model and `tenancy-auditor` before any of it
 * is built. This is a picture of a screen, and it says so three times: in the
 * letterhead margin, in the table caption, and on every row's own disclosure.
 *
 * It is built on the record grid like every other page: a letterhead, the
 * portfolio as one continuous sheet rather than a grid of client cards, and the
 * basis in the provenance margin. The per-row rail is the plan's signature
 * device appearing in a table range cell — the same instrument, at portfolio
 * scale, so an agency sees the same honesty its clients see.
 */
export default function AgencyConcept() {
  return (
    <main className="shell shell--grader">
      <ProductBar current="agency" />

      <header className="annotated masthead">
        <div className="annotated__body">
          <h1>Agency portfolio</h1>
          <p className="lede">Every client, every category, with the interval attached — one sheet.</p>
        </div>
        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">Concept preview</span>
          <span className="note__gloss">{CONCEPT_NOTICE}</span>
          <span className="note__line">{PORTFOLIO.length} illustrative clients</span>
        </aside>
      </header>

      <section className="record">
        <div className="annotated">
          <div className="annotated__body">
            {/*
              One sheet, not a grid of client cards. The plan dissolves cards
              into paper, and a portfolio is exactly where the template instinct
              (six boxed tiles with a big number each) is strongest — and worst,
              because boxing them invites reading the numbers as scores out of
              ten rather than as measurements with ranges.
            */}
            <ul className="portfolio">
              {PORTFOLIO.map((row) => {
                const { grade } = confidenceGrade(row.metric)
                return (
                  <li className="portfolio__row" key={row.client}>
                    <div className="portfolio__head">
                      <span className="portfolio__client">{row.client}</span>
                      <span className="portfolio__category">{row.categoryName}</span>
                    </div>

                    {/* The signature device, in a table cell. Same rail, same
                        fixed 0-100 scale, same settle — so a row cannot show a
                        figure without showing how much it does not know. */}
                    <div className="portfolio__rail">
                      <RangeRail label="Mention rate" metric={row.metric} />
                    </div>

                    <div className="portfolio__marks">
                      <span className="portfolio__mark">
                        <span className="readout__cap">Visibility</span>
                        <span className="score">
                          <span className="score__value num">{row.preview.score}</span>
                          <span className="score__of">/ 100</span>
                          <span className="score__flag">preview</span>
                        </span>
                      </span>
                      <span className="portfolio__mark">
                        <span className="readout__cap">Precision</span>
                        <span className="portfolio__grade num">{grade}</span>
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <aside className="note">
            <span className="note__cap">Basis</span>
            <span className="note__line">wilson-95 · algo det-1</span>
            <span className="note__line">5 engines · unprompted set</span>
            <span className="note__gloss">
              Every interval on this page is real arithmetic over invented counts. The figures are made up; the maths that turns them into a
              range is the same code the Grader runs, so no row shows a shape that could not occur.
            </span>
            <span className="note__gloss">
              {PREVIEW_SCORE_CAPTION}. Precision grades how much each sample knows; the score is a separate, provisional read on visibility.
            </span>
          </aside>
        </div>
      </section>

      <section className="section">
        <h2>What an agency would actually get</h2>
        <p className="prose">
          One row per client, each carrying its own interval rather than a league table of point estimates. A portfolio is where the temptation to
          rank is strongest and where ranking is least defensible: two clients whose ranges overlap are not first and second, and this view says so
          instead of sorting them.
        </p>
        <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
          <strong>quillbase.app</strong> is deliberately in this list on a thin sample. Its range is visibly wider than the others, which is what a
          small sample looks like when nobody hides it — and the reason a portfolio built on point estimates alone would rank it confidently and
          wrongly.
        </p>
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
          None of this is wired to anything. There are no agency accounts, no client workspaces and no cross-client queries in this build. Client
          isolation is the one thing a trust-positioned product cannot prototype casually, so the data model behind this screen gets designed
          before the screen does.
        </p>
      </section>
    </main>
  )
}
