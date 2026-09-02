import { compare, formatInterval, formatProvenance, formatValue } from '@bliprank/stats'
import { MetricCard, DeltaBadge } from '@/components/metric-card'
import { CiTrendChart } from '@/components/ci-trend-chart'
import { ProductBar } from '@/components/chrome'
import { BY_ENGINE, HEADLINE, SOURCE_MIX, TREND } from '@/lib/fixtures'
import { NO_SCHEDULER_NOTE, PLANNED_CAPTION, Planned } from '@/lib/planned'

export default function Dashboard() {
  return (
    <main className="shell">
      <ProductBar current="dashboard" />

      <header className="masthead">
        <div>
          <h1>Acme CRM — AI search visibility</h1>
          <p className="cycle">
            Cycle 2026-08-15 · 30 prompts × 5 runs × 5 engines · compared with 2026-08-01 <Planned />
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
          <p className="metric__provenance">{formatProvenance(SOURCE_MIX[0]!.metric)} · shares of 412 observed citations</p>
        </div>
      </section>
    </main>
  )
}
