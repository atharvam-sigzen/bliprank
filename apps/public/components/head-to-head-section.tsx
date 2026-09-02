'use client'

import { HeadToHeadChart } from '@/components/head-to-head-chart'
import { buildHeadToHead, reasonFor } from '@/lib/head-to-head'
import { subjectOf, type ScanResultFile } from '@/lib/scan-result'

/**
 * PHASES 3.4 — the head-to-head, sitting directly under the caveat it proves.
 *
 * The paragraph above it already promises the number "cannot separate you from
 * a competitor whose range overlaps yours". This is the picture of it, drawn
 * from the same scan: every brand here was scored over the SAME answers, so
 * they share one `comparison_basis` and `compare()` will actually compare them.
 * The margin carries the basis; the prose under the chart carries the reading.
 *
 * Extracted from the Grader result page so the measured record (the brand
 * dashboard and the agency client pages) can render the same comparison from
 * the same scan file. One component, one wording, every surface.
 */
export function HeadToHeadSection({ scan }: { scan: ScanResultFile }) {
  const subject = subjectOf(scan)
  const competitors = scan.brands.filter((b) => !b.isSubject)

  /*
   * NO COMPETITORS IS NOT AN EMPTY CHART. The fallback bank carries no leaders
   * by design, so a domain we could not categorise is measured alone. Drawing
   * the chart anyway put one row on it and printed "not one brand in the
   * category can be told apart from you" — which is a claim about a comparison
   * that never happened. The absence is stated instead.
   */
  if (competitors.length === 0) {
    /*
     * ⚠️ TWO CAUSES, AND THIS USED TO ASSERT THE WRONG ONE.
     *
     * The copy here said, unconditionally, that the domain "was measured against
     * the general business-software prompt set" and was "a business we could not
     * categorise". That was true when the fallback bank was the only thing that
     * carried no leaders. ADR-0009 added a second: a GENERATED category has
     * `leaders: []` by design, because we will not name rivals nobody measured —
     * and it is a SUCCESSFUL classification, into a bank authored for that
     * business.
     *
     * So thecosmicbyte.com, correctly placed in an authored "Gaming Peripherals
     * India" and measured against its own seventeen prompts, was told on its own
     * dashboard that we could not categorise it and had fallen back to the
     * general set. Both halves false, under a heading a customer reads as a
     * verdict. The reason is now derived from the same record the rest of the
     * sheet is drawn from.
     */
    const fellBack = scan.fallback !== undefined
    const authored = scan.categorySource?.signal === 'generated'
    return (
      <section className="section" aria-labelledby="h2h-heading">
        <h2 id="h2h-heading">How that compares</h2>
        <p className="prose prose--flag">
          There is no comparison on this scan.{' '}
          {fellBack ? (
            <>
              {scan.domain} was measured against the general business-software prompt set, which carries no competitor list, so there is no brand
              to rank it against. No rivals are named for a business we could not categorise.
            </>
          ) : authored ? (
            <>
              {scan.domain} was measured against {scan.categoryName}, a category authored for it because the taxonomy had no home for this
              business. An authored category never carries a competitor set: naming rivals we have not measured is the one thing this product
              will not do, so they can only ever arrive from brands the engines actually name in collected answers.
            </>
          ) : (
            <>
              {scan.categoryName} carries no competitor set in this build, so there is no brand to rank {scan.domain} against.
            </>
          )}{' '}
          An empty chart is not drawn in its place — the mention rate above stands on its own.
        </p>
      </section>
    )
  }

  const data = buildHeadToHead(
    { label: subject.name, metric: subject.metric },
    competitors.map((b) => ({ label: b.name, metric: b.metric })),
  )
  const uncompared = data.rows.filter((r) => r.verdict === 'insufficient-data' || r.verdict === 'not-comparable')

  return (
    <section className="section" aria-labelledby="h2h-heading">
      <h2 id="h2h-heading">How that compares in {scan.categoryName.toLowerCase()}</h2>

      <div className="annotated">
        <div className="annotated__body">
          <HeadToHeadChart data={data} subjectLabel={subject.name} />
        </div>
        {/* DETAIL. The comparison basis is the auditor's field: it says why
            these brands may be compared at all. The chart it annotates keeps
            every one of its marks at simple depth, and the two paragraphs under
            it — which explain the shaded band and the dashed rows a simple
            reader can still see — stay with them. */}
        <aside className="note detail">
          <span className="note__cap">Basis</span>
          <span className="note__line">every brand scored over</span>
          <span className="note__line">the same {scan.counts.answersScored} answers</span>
          <span className="note__gloss">
            {/* The prompt subset is the honest part: a share-of-voice number
                taken from prompts that name brands would measure our own
                phrasing. */}
            From prompts that name no brand — the unprompted set. Comparison and verification prompts are excluded from this number by
            construction.
          </span>
        </aside>
      </div>

      <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
        {data.allIndistinguishable
          ? `On this scan, not one brand in the category can be told apart from ${subject.name}. That is a fact about the sample size, not about the brands.`
          : `Where a range crosses the shaded band, that brand and ${subject.name} cannot be told apart on this scan — whatever order they appear in.`}
      </p>

      {uncompared.length > 0 ? (
        <p className="prose" style={{ marginTop: 'var(--space-2)' }}>
          {/* The reason is DERIVED, not guessed. This previously printed
              "different engine set" for every uncompared row, which was simply
              false for the common case: these brands share the engine set
              exactly, and what compare() refused was a pair whose intervals are
              far too different in width to separate honestly. Stating a wrong
              reason on a page about measurement integrity is worse than stating
              none. */}
          Not ranked against you: {uncompared.map((r) => `${r.label} (${reasonFor(r)})`).join(', ')}. Their ranges are drawn, dashed, because the
          measurement is real — it is the comparison that would not be. Every other tool in this category would give you a number here anyway.
        </p>
      ) : null}
    </section>
  )
}
