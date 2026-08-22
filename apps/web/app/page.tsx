import { compare, formatInterval, formatValue } from '@bliprank/stats'
import { MetricCard, DeltaBadge } from '@/components/metric-card'
import { CiTrendChart } from '@/components/ci-trend-chart'
import { BY_ENGINE, HEADLINE, SOURCE_MIX, TREND } from '@/lib/fixtures'

export default function Dashboard() {
  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1>Acme CRM — AI search visibility</h1>
          <p className="cycle">Cycle 2026-08-15 · 30 prompts × 5 runs × 5 engines · compared with 2026-08-01</p>
        </div>
      </header>

      {/* Scaffold honesty: this must not be mistaken for a measurement. */}
      <p className="notice">
        <strong>Scaffold, not data.</strong> Every number on this page is fixture data used to build and review the interface. No answers have been collected — gate
        G0 has not run.
      </p>

      <section className="grid" aria-label="Headline metrics">
        <MetricCard label="Mention rate" metric={HEADLINE.mentionRate.current} previous={HEADLINE.mentionRate.previous} />
        <MetricCard label="Citation rate" metric={HEADLINE.citationRate.current} previous={HEADLINE.citationRate.previous} />
        <MetricCard label="Share of voice" metric={HEADLINE.shareOfVoice.current} previous={HEADLINE.shareOfVoice.previous} />
      </section>

      <section className="section">
        <h2>Mention rate over cycles</h2>
        <div className="card">
          <CiTrendChart points={TREND} title="Mention rate over cycles, with 95% confidence band" />
        </div>
      </section>

      <section className="section">
        <h2>By engine</h2>
        <div className="card table-wrap">
          <table>
            <caption className="visually-hidden">Mention rate per engine with confidence intervals and change versus the previous cycle</caption>
            <thead>
              <tr>
                <th scope="col">Engine</th>
                <th scope="col">Mention rate</th>
                <th scope="col">95% interval</th>
                <th scope="col">n</th>
                <th scope="col">vs previous cycle</th>
              </tr>
            </thead>
            <tbody>
              {BY_ENGINE.map((row) => (
                <tr key={row.engine}>
                  <th scope="row" style={{ fontWeight: 400 }}>
                    {row.engine}
                  </th>
                  <td className="num">{formatValue(row.current)}</td>
                  <td className="num">{formatInterval(row.current)}</td>
                  <td className="num">{row.current.n}</td>
                  <td>
                    <DeltaBadge comparison={compare(row.current, row.previous)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
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
                  <th scope="col" style={{ width: '50%' }}>
                    <span className="visually-hidden">Bar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {SOURCE_MIX.map((s) => (
                  <tr key={s.label}>
                    <th scope="row" style={{ fontWeight: 400 }}>
                      {s.label}
                    </th>
                    <td className="num">{(s.share * 100).toFixed(0)}%</td>
                    <td>
                      <div
                        aria-hidden="true"
                        style={{
                          height: 8,
                          width: `${s.share * 100}%`,
                          background: 'var(--color-secondary)',
                          borderRadius: 2,
                          minWidth: 2,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  )
}
