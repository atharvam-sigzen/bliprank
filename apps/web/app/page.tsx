import { compare, formatInterval, formatProvenance, formatValue } from '@bliprank/stats'
import { Headline } from '@/components/headline'
import { MetricCard, DeltaBadge } from '@/components/metric-card'
import { CiTrendChart } from '@/components/ci-trend-chart'
import { ProductBar } from '@/components/chrome'
import { BY_ENGINE, ENGINES, HEADLINE, SOURCE_MIX, TREND } from '@/lib/fixtures'
import { NO_SCHEDULER_NOTE, PLANNED_CAPTION, Planned } from '@/lib/planned'

export default function Dashboard() {
  return (
    <main className="shell">
      <ProductBar current="dashboard" />

      <header className="masthead">
        <div>
          <h1>Acme CRM — AI search visibility</h1>
          {/* THE SAMPLE SHAPE IS DETAIL; THE DATES ARE NOT.
              "30 prompts × 5 runs × 5 engines" is mono technical shorthand — the
              auditor's field. The dates either side of it are the reader's, and
              "compared with 2026-08-01" explains the delta badges below, which
              stay drawn at both depths, so by ADR-0010's rule it stays too.

              The comment sits OUT here rather than inside the element:
              planned.test.ts asserts `<Planned />` within 240 characters of the
              cycle date, because the marker must be legibly ON the claim it
              qualifies, and a comment wedged between them pushed it out of that
              window without changing the rendered page. The test was right and
              the first version of this edit was not. */}
          <p className="cycle">
            Cycle 2026-08-15<span className="detail"> · 30 prompts × 5 runs × 5 engines</span> · compared with 2026-08-01 <Planned />
          </p>
        </div>
      </header>

      {/* A disclosure that looks like an error teaches a reader to dismiss it.
          This is the product's own claim about itself, so it is set as a mark of
          provenance rather than a warning label. */}
      <aside className="stamp">
        <span className="stamp__eyebrow">Illustrative data</span>
        <p className="stamp__body">
          Every number here is fixture data, shaped to exercise the interface. <strong>No answers have been collected and no provider has been called.</strong> The
          intervals, the significance rules and the provenance lines are the real ones.
        </p>
      </aside>

      {/* THE LEDE, AND IT ANSWERS THE THREE-CARD PROBLEM RATHER THAN HIDING IT.

          IT SITS ABOVE THE TIMER NOTICE AND BELOW THE FIXTURE STAMP, and the
          order is the whole point. Modelled against the prerendered HTML, the
          simple reading of this page opened with ~135 words of disclosure
          before it reached a number — a brand owner read two paragraphs of
          caveat before "am I doing well". Neither may be hidden, but nothing
          fixes their ORDER except the rule that no claim precedes its own
          qualifier.

          The stamp stays first because it discloses that every figure here is
          fixture data, and a number before that disclosure is exactly the
          substitution this product argues against. The timer notice qualifies
          the CADENCE — the delta badges, the "compared with" dates and the
          trend — and the lede makes no cadence claim at all, so moving it below
          the lede leaves no claim unqualified. It is still above every delta
          badge and above the trend, which is the property its own comment
          asks for.

          Three cards is three headline numbers and no answer to "am I doing
          well" — the same defect the Grader had. The cards stay at both depths:
          citation rate and share of voice are different BUSINESS questions, not
          technical depth, and hiding them would be removing features rather than
          simplifying. What was missing is a statement of which one is the
          headline, in words. Same component and same wording as the Grader's,
          because it is the same file. */}
      <Headline subject="Acme CRM" metric={HEADLINE.mentionRate.current} engines={ENGINES.length} />

      {/* THE TIMER CLAIM IS A PAGE-LEVEL CLAIM, SO THE MARKER IS TOO.
          The stamp above discloses the DATA: none of these numbers came from a
          provider. The claim a reader actually takes from this page is a
          CAPABILITY claim, that something has been running on a timer, and it is
          not made by the chart alone. It is made by the masthead's two dated
          cycles, by every delta badge below ("vs previous"), by the "vs previous
          cycle" column in the by-engine table, and by six dated points on the
          trend. Marking one of those five taught a reader that the other four
          were real. So the notice sits here, above all of them, and each of the
          headings that carries the claim keeps the `planned` marker so a reader
          scrolled past this paragraph still sees it. */}
      <p className="notice">
        <strong>{PLANNED_CAPTION}.</strong> {NO_SCHEDULER_NOTE} Nothing on this page was collected on a timer, so the cycle dates above, every
        comparison with a previous cycle, and the trend below describe the intended cadence rather than a record of it.
      </p>

      <section className="grid" aria-label="Headline metrics">
        <MetricCard label="Mention rate" metric={HEADLINE.mentionRate.current} previous={HEADLINE.mentionRate.previous} />
        <MetricCard label="Citation rate" metric={HEADLINE.citationRate.current} previous={HEADLINE.citationRate.previous} />
        <MetricCard label="Share of voice" metric={HEADLINE.shareOfVoice.current} previous={HEADLINE.shareOfVoice.previous} />
      </section>

      {/* The chart stays, and carries the marker; the wording of the gap is the
          page-level notice above rather than a second copy here. */}
      <section className="section">
        <h2>
          Mention rate over cycles <Planned />
        </h2>
        <div className="card">
          <CiTrendChart points={TREND} title="Mention rate over cycles, with 95% confidence band" />
        </div>
      </section>

      {/* DETAIL. A per-engine breakdown with an interval and an n on every row
          is the shape of a question an agency asks — which surface is weak, and
          is the difference real. The headline cards above already carry the
          answer to "am I doing well", each with its own range, so hiding this
          removes no mark a simple reader was relying on. */}
      <section className="section detail">
        <h2>By engine</h2>
        <div className="card table-wrap">
          <table>
            <caption className="visually-hidden">Mention rate per engine with confidence intervals and change versus the previous cycle</caption>
            <thead>
              <tr>
                <th scope="col">Engine</th>
                <th scope="col">Mention rate</th>
                {/* The verdict sits second, not last. As the fifth column of a
                    nowrap table it scrolled off a 375px screen entirely, so a
                    phone reader saw four numbers and never the one conclusion
                    the product exists to draw. */}
                {/* The one column on this page that is purely a timer claim:
                    it exists only if a second cycle was collected, and none
                    was. Marked at the column rather than the section, because
                    the rest of the table is fixture data the stamp already
                    discloses. */}
                <th scope="col">
                  vs previous cycle <Planned />
                </th>
                <th scope="col">95% interval</th>
                <th scope="col">n</th>
              </tr>
            </thead>
            <tbody>
              {BY_ENGINE.map((row) => (
                <tr key={row.engine}>
                  <th scope="row" style={{ fontWeight: 400 }}>
                    {row.engine}
                  </th>
                  <td className="num">{formatValue(row.current)}</td>
                  <td>
                    <DeltaBadge comparison={compare(row.current, row.previous)} />
                  </td>
                  <td className="num">{formatInterval(row.current)}</td>
                  <td className="num">{row.current.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* DETAIL. Source classification is a methodology surface: it explains how
          a citation was attributed, which is the auditor's question rather than
          the owner's. Its own caption opens by naming the ADR. */}
      <section className="section detail">
        <h2>Where the citations come from</h2>
        <div className="card">
          <p className="metric__interval" style={{ marginBottom: 'var(--space-3)' }}>
            Deterministic source classification (ADR-0005). Most citations are earned media the customer does not own — which is where the work is.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Source class</th>
                  <th scope="col">Share of citations</th>
                  <th scope="col">95% interval</th>
                  <th scope="col" style={{ width: '40%' }}>
                    <span className="visually-hidden">Proportional bar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {SOURCE_MIX.map((s) => (
                  <tr key={s.label}>
                    <th scope="row" style={{ fontWeight: 400 }}>
                      {s.label}
                    </th>
                    <td className="num">{formatValue(s.metric, 0)}</td>
                    <td className="num">{formatInterval(s.metric, 0)}</td>
                    <td>
                      {/* The bar shows the interval as well as the estimate:
                          a solid bar alone would reassert the precision the
                          number next to it just disclaimed. */}
                      <div aria-hidden="true" className="range">
                        <div
                          className="range__span"
                          style={{ left: `${s.metric.ci_low * 100}%`, width: `${(s.metric.ci_high - s.metric.ci_low) * 100}%` }}
                        />
                        <div className="range__tick" style={{ left: `${s.metric.value * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Marked even though the whole section already is: the depth of a
              provenance line should be legible where it is written, not
              inferred from an ancestor six elements up. */}
          <p className="metric__provenance detail">{formatProvenance(SOURCE_MIX[0]!.metric)} · shares of 412 observed citations</p>
        </div>
      </section>
    </main>
  )
}
