import { engineName } from '@/lib/engines'
import type { BreakdownCell, BreakdownLine } from '@/lib/prompt-breakdown'
import { rankClass, rankLabel } from './prompt-breakdown'

/**
 * THE MATRIX — every tracked question against every engine, at a glance.
 *
 * MVP_PLAN D4 (goal points 4 and 5). This is the purpose-built replacement for
 * what used to be the ONLY reading of the per-question grid: a literal
 * `<table>` of glyphs, visible at both depths, that a non-technical reader had
 * no plain sentence for. The exact table survives — it is the auditor's
 * record, kept in `.detail` in `prompt-breakdown.tsx` — but the picture and its
 * one-sentence reading are new, and they are what a simple-depth reader now
 * gets for the heading "Which questions you appear in".
 *
 * ⚠️ ONE ORDER, DRAWN ONCE. `rows` arrives pre-sorted least-covered-first from
 * `prompt-breakdown.tsx`, the same order the full table below renders in. A
 * second sort here — even one that produced the identical order today — would
 * be a second place for "worst first" to mean something slightly different
 * tomorrow.
 *
 * WHAT THE PICTURE DELIBERATELY DROPS. A cell here answers one question: named,
 * not named, or no answer collected. It does not carry the exact rank or the
 * citation mark the full table does — those need the "#2 of 6" phrasing and a
 * "¶" to state precisely, and a matrix dense enough to be readable at a glance
 * has no room for either without becoming the table it replaces. Rank still
 * decides the FILL of a named cell (three tiers, not a gradient — see
 * `rankClass`), so the pattern of "where are you strongest" reads before any
 * number is parsed; the exact figures are one press away, in the same table
 * this component sits above.
 *
 * NO METRIC, NO INTERVAL. A cell is a fact about one collected answer, not an
 * estimate of anything — the same reason the existing "Named in" fraction
 * carries no Wilson interval. R8 does not apply because there is nothing here
 * that claims to generalise beyond what was actually collected.
 *
 * THREE STATES, NEVER BY COLOUR ALONE. A named cell is FILLED; a collected miss
 * is a plain outline; an uncollected cell is a DASHED outline — shape carries
 * the "was there even an answer" distinction, so a greyscale print or a
 * colour-blind reader loses nothing a sighted reader with full colour vision
 * has. The three named tiers reuse the sheet's own three data inks (primary,
 * secondary, neutral) rather than one hue at three opacities, because a tint
 * thin enough to read as "third tier" also reads as "no contrast" against the
 * card — the same trap `CONFIDENCE_GRADE` avoids by never dimming a colour to
 * mean less certain.
 */
export function PromptGrid({ rows, engines, subjectName }: { rows: readonly BreakdownLine[]; engines: readonly string[]; subjectName: string }) {
  if (rows.length === 0 || engines.length === 0) return null

  const total = rows.length
  const zero = rows.filter((r) => r.mentionedIn === 0).length
  const cols = engines.length

  const CELL = 14
  const ROW_H = 22
  const PAD_TOP = 26
  const PAD_BOTTOM = 6
  const PAD_LEFT = 188
  const PAD_RIGHT = 50
  const W = 600
  const H = PAD_TOP + total * ROW_H + PAD_BOTTOM
  const plotW = W - PAD_LEFT - PAD_RIGHT
  const colStep = plotW / cols
  const colX = (i: number) => PAD_LEFT + colStep * i + colStep / 2
  const rowY = (i: number) => PAD_TOP + i * ROW_H + ROW_H / 2

  const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

  // A PLAIN STRING for the SVG's accessible name, and JSX for the visible
  // prose below it — both built from the same two counts, so the words a
  // screen reader hears and the words a sighted reader sees never drift.
  const summaryPlain = summarySentence(zero, total, subjectName)
  const describe = `${subjectName}: ${total} tracked questions against ${cols} ${cols === 1 ? 'engine' : 'engines'}, least covered first. ${summaryPlain}`

  return (
    <figure style={{ margin: 0, marginTop: 'var(--space-4)' }}>
      <h3 id="pgrid-heading">Every question, every engine</h3>

      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby="pgrid-heading"
        aria-label={describe}
        preserveAspectRatio="xMidYMid meet"
      >
        {engines.map((e, i) => (
          <text key={e} className="pgrid__head" x={colX(i)} y={PAD_TOP - 12} textAnchor="middle">
            {shortEngine(e)}
          </text>
        ))}

        {rows.map((row, ri) => {
          const y = rowY(ri)
          return (
            <g key={row.prompt}>
              <title>{row.prompt}</title>
              <text className="pgrid__label" x={PAD_LEFT - 10} y={y + 3.5} textAnchor="end">
                {truncate(row.prompt, 30)}
              </text>
              {engines.map((e, ci) => {
                const cell = row.cells.find((c) => c.engine === e)
                const tier = tierOf(cell)
                const x = colX(ci)
                return (
                  <rect
                    key={e}
                    className={`pgrid__cell pgrid__cell--${tier}`}
                    x={x - CELL / 2}
                    y={y - CELL / 2}
                    width={CELL}
                    height={CELL}
                    rx={2.5}
                  >
                    <title>{cellTitle(cell, e, subjectName)}</title>
                  </rect>
                )
              })}
              <text className="pgrid__count num" x={W - PAD_RIGHT + 10} y={y + 3.5} textAnchor="start">
                {row.mentionedIn}/{row.answers}
              </text>
            </g>
          )
        })}
      </svg>

      {/* Real, navigable and complete — the same reason ci-trend-chart keeps a
          hidden table beside its picture. A `<title>` on an SVG rect is not
          reliably announced row by row, and a wall of text in one aria-label
          cannot be tabbed through a cell at a time. */}
      <div className="visually-hidden">
        <table>
          <caption>
            Which of {subjectName}&apos;s tracked questions are named on which engine, least covered first
          </caption>
          <thead>
            <tr>
              <th scope="col">Question</th>
              {engines.map((e) => (
                <th scope="col" key={e}>
                  {engineName(e)}
                </th>
              ))}
              <th scope="col">Named in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.prompt}>
                <th scope="row">{row.prompt}</th>
                {engines.map((e) => {
                  const cell = row.cells.find((c) => c.engine === e)
                  return <td key={e}>{cellTitle(cell, e, subjectName)}</td>
                })}
                <td>
                  {row.mentionedIn} of {row.answers}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
        <SummarySentence zero={zero} total={total} subjectName={subjectName} />
      </p>

      <figcaption className="chart__legend">
        <span>
          <Swatch tier="rank1" /> Named, ranked first
        </span>
        <span>
          <Swatch tier="rank2" /> Named, ranked second
        </span>
        <span>
          <Swatch tier="rank3" /> Named, lower rank
        </span>
        <span>
          <Swatch tier="miss" /> Not named
        </span>
        <span>
          <Swatch tier="none" /> No answer collected
        </span>
      </figcaption>
    </figure>
  )
}

function Swatch({ tier }: { tier: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: '4px' }}>
      <rect className={`pgrid__cell pgrid__cell--${tier}`} x={1} y={1} width={10} height={10} rx={2} />
    </svg>
  )
}

/** The reader's names, kept short so a column stays narrow at up to five engines. */
const SHORT_ENGINE: Readonly<Record<string, string>> = {
  chatgpt: 'GPT',
  gemini: 'Gem',
  copilot: 'Cop',
  'google-ai-mode': 'AIM',
  'google-ai-overviews': 'AIO',
}

/** An id nobody has named yet still gets a label, from the full name rather than the slug. */
const shortEngine = (id: string): string => SHORT_ENGINE[id] ?? engineName(id).slice(0, 3)

type Tier = 'none' | 'miss' | 'rank1' | 'rank2' | 'rank3'

function tierOf(cell: BreakdownCell | undefined): Tier {
  if (!cell) return 'none'
  if (!cell.mentioned) return 'miss'
  const cls = rankClass(cell.position)
  return cls === 'mark--rank1' ? 'rank1' : cls === 'mark--rank2' ? 'rank2' : 'rank3'
}

/** The same words the full table's title attribute already uses — one wording, two surfaces. */
function cellTitle(cell: BreakdownCell | undefined, engine: string, subjectName: string): string {
  const name = engineName(engine)
  if (!cell) return `${name}: no answer was collected for this question`
  if (!cell.mentioned) {
    return `${name}: ${subjectName} not named; ${cell.brandsDetected} other ${cell.brandsDetected === 1 ? 'brand' : 'brands'} named in this answer`
  }
  return `${name}: ${subjectName} named, ${rankLabel(cell.position, cell.brandsDetected)}${cell.cited ? ', and cited' : ''}`
}

/**
 * "5 of the 17 questions never name acme.com on any engine." — the plain
 * string, for the SVG's accessible name.
 *
 * Third person throughout, matching the section's own voice (`subject.name was
 * named in…`) rather than a second-person "your questions" — the same report
 * is read by an agency about a client as often as by the brand itself, and the
 * heading above this picture already carries the second person for the reader
 * who is the brand.
 */
function summarySentence(zero: number, total: number, subjectName: string): string {
  if (total === 1) {
    return zero === 1 ? `The one tracked question never names ${subjectName} on any engine.` : `The one tracked question names ${subjectName} on at least one engine.`
  }
  if (zero === 0) return `Every one of the ${total} tracked questions names ${subjectName} on at least one engine.`
  if (zero === total) return `None of the ${total} tracked questions name ${subjectName} on any engine.`
  return `${zero} of the ${total} questions never name ${subjectName} on any engine.`
}

/** The same sentence as `summarySentence`, typeset with the sheet's tabular-figure spans. */
function SummarySentence({ zero, total, subjectName }: { zero: number; total: number; subjectName: string }) {
  if (total === 1) {
    return zero === 1 ? (
      <>The one tracked question never names {subjectName} on any engine.</>
    ) : (
      <>The one tracked question names {subjectName} on at least one engine.</>
    )
  }
  if (zero === 0) {
    return (
      <>
        Every one of the <span className="num">{total}</span> tracked questions names {subjectName} on at least one engine.
      </>
    )
  }
  if (zero === total) {
    return (
      <>
        None of the <span className="num">{total}</span> tracked questions name {subjectName} on any engine.
      </>
    )
  }
  return (
    <>
      <span className="num">{zero}</span> of the <span className="num">{total}</span> questions never name {subjectName} on any engine.
    </>
  )
}
