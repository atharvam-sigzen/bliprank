'use client'

import { useState } from 'react'
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
 * tomorrow. Said once, visibly, under the heading — not only in the aria-label
 * (review MINOR d).
 *
 * WHAT THE PICTURE DELIBERATELY DROPS. A cell here answers one question: named,
 * not named, or no answer collected. It does not carry the exact citation mark
 * the full table does — that needs a "¶" to state precisely, and a matrix
 * dense enough to be readable at a glance has no room for it without becoming
 * the table it replaces. Rank still decides the FILL of a named cell (three
 * tiers, not a gradient — see `rankClass`), so the pattern of "where are you
 * strongest" reads before any number is parsed; the exact figures are one
 * press away, in the same table this component sits above, or one tap away,
 * in the panel below this picture (review MINOR f).
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
 * has. The three named tiers ALSO print the exact rank as a numeral inside the
 * cell (review MINOR e): the three fills are real, contrast-checked inks from
 * the sheet's own data vocabulary (primary, secondary, neutral) and each
 * clears 3:1 against the card on its own, but two of them sit close enough to
 * each other in LIGHTNESS that a reader relying on the fill alone could not
 * always tell rank 1 from rank 3 apart — measured, not assumed, in review. The
 * numeral is what makes rank legible independent of any colour vision at all;
 * the fill remains a fast at-a-glance cue on top of it, not the only carrier.
 *
 * ⚠️ MORE THAN ONE RUN PER CELL (review MAJOR 2). A cell is `prompt x engine x
 * day`, and `services/grader/src/scan.ts` is explicit that `runsPerCell` may
 * exceed one, so two rows can legitimately share a prompt and an engine —
 * `promptBreakdown.ts`'s own docstring calls aggregating them "the reader's
 * job". `cellsFor` collects every run for a cell rather than taking the first
 * and dropping the rest; the tier is decided by the BEST rank among the runs
 * that named the subject, and the tooltip states "k of r runs" whenever r > 1
 * so a multi-run cell never reads as though only one answer existed.
 */
export function PromptGrid({ rows, engines, subjectName }: { rows: readonly BreakdownLine[]; engines: readonly string[]; subjectName: string }) {
  const [active, setActive] = useState<number | null>(null)
  if (rows.length === 0 || engines.length === 0) return null

  const total = rows.length
  const zero = rows.filter((r) => r.mentionedIn === 0).length
  const cols = engines.length

  /*
   * ⚠️ AN ENGINE THAT NEVER ANSWERED ANYTHING THIS CYCLE (review MAJOR 1, part
   * two). The summary sentence used to say "on any engine", which is FALSE
   * for an engine that returned no answer at all: absence of an answer is not
   * evidence the subject was not named, and the sentence must not read as
   * though it were. Named here, in the same words `citations.tsx` already
   * uses for the identical fact about a source class.
   */
  const enginesWithNoAnswers = engines.filter((e) => !rows.some((r) => r.cells.some((c) => c.engine === e)))

  const CELL = 14
  const ROW_H = 22
  const PAD_TOP = 26
  const PAD_BOTTOM = 6
  const PAD_LEFT = 188
  const PAD_RIGHT = 58
  const W = 600
  const H = PAD_TOP + total * ROW_H + PAD_BOTTOM
  const plotW = W - PAD_LEFT - PAD_RIGHT
  const colStep = plotW / cols
  const colX = (i: number) => PAD_LEFT + colStep * i + colStep / 2
  const rowY = (i: number) => PAD_TOP + i * ROW_H + ROW_H / 2

  const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

  // A PLAIN STRING for the SVG's accessible name, and JSX for the visible
  // prose below it — both built from the same two counts (and the same
  // engine-absence fact), so the words a screen reader hears and the words a
  // sighted reader sees never drift.
  const summaryPlain = summarySentence(zero, total, subjectName, enginesWithNoAnswers)
  const describe = `${subjectName}: ${total} tracked questions against ${cols} ${cols === 1 ? 'engine' : 'engines'}, least covered first. ${summaryPlain}`

  return (
    <figure style={{ margin: 0, marginTop: 'var(--space-4)' }}>
      <h3 id="pgrid-heading">Every question, every engine</h3>
      <p className="prose" style={{ marginTop: 0, marginBottom: 'var(--space-2)' }}>
        Least-covered questions first.
      </p>

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
        {/* MAJOR 3: the fraction column had no visible head at all — its only
            explanation sat inside the full table's `.detail` wrapper, so a
            simple-depth reader met a bare "3/5" with nothing to say it was a
            count of engines rather than a score. */}
        <text className="pgrid__head" x={W - PAD_RIGHT + 8} y={PAD_TOP - 12} textAnchor="start">
          Named in
        </text>

        {rows.map((row, ri) => {
          const y = rowY(ri)
          return (
            <g key={row.prompt}>
              <text className="pgrid__label" x={PAD_LEFT - 10} y={y + 3.5} textAnchor="end">
                {truncate(row.prompt, 30)}
              </text>
              {engines.map((e, ci) => {
                const cells = cellsFor(row, e)
                const tier = tierOf(cells)
                const x = colX(ci)
                const named = tier === 'rank1' || tier === 'rank2' || tier === 'rank3'
                return (
                  <g key={e}>
                    <rect className={`pgrid__cell pgrid__cell--${tier}`} x={x - CELL / 2} y={y - CELL / 2} width={CELL} height={CELL} rx={2.5}>
                      <title>{cellTitle(cells, e, subjectName)}</title>
                    </rect>
                    {/* MINOR e: the numeral, not the fill alone, is what makes
                        the rank legible independent of colour vision. */}
                    {named ? (
                      <text className="pgrid__rank" x={x} y={y + 2.8} textAnchor="middle" aria-hidden="true">
                        {rankNumeral(bestRun(cells)!.position)}
                      </text>
                    ) : null}
                  </g>
                )
              })}
              <text className="pgrid__count num" x={W - PAD_RIGHT + 10} y={y + 3.5} textAnchor="start">
                {row.mentionedIn}/{row.answers}
              </text>
            </g>
          )
        })}

        {/*
          MINOR f, PART TWO. The truncated label and the per-cell `<title>`
          are a mouse-only affordance — hover has no equivalent on touch, and
          neither is reachable by keyboard. A real hit target per row, styled
          exactly like the head-to-head chart's own row-hit rectangles, makes
          the FULL question and the per-engine breakdown reachable by tab and
          by tap; the panel that shows it sits below the picture.
        */}
        {rows.map((row, ri) => (
          <rect
            key={`hit-${row.prompt}`}
            className="pgrid__row-hit"
            x={2}
            y={rowY(ri) - ROW_H / 2}
            width={W - 4}
            height={ROW_H}
            rx={3}
            tabIndex={0}
            role="button"
            aria-label={rowSummary(row, engines, subjectName)}
            aria-pressed={active === ri}
            onMouseEnter={() => setActive(ri)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(ri)}
            onBlur={() => setActive(null)}
            onClick={() => setActive((c) => (c === ri ? null : ri))}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault()
                setActive((c) => (c === ri ? null : ri))
              }
              if (ev.key === 'Escape') setActive(null)
            }}
          />
        ))}
      </svg>

      <RowTip rows={rows} engines={engines} active={active} subjectName={subjectName} />

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
                  const cells = cellsFor(row, e)
                  return <td key={e}>{cellTitle(cells, e, subjectName)}</td>
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
        <SummarySentence zero={zero} total={total} subjectName={subjectName} enginesWithNoAnswers={enginesWithNoAnswers} />
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

      {/* MINOR f, PART ONE: the three-letter column heads have no visible key
          anywhere else on the page — only the hidden table spells them out,
          which a sighted reader never opens. */}
      <p className="prose" style={{ marginTop: 'var(--space-2)' }}>
        {engines.map((e) => `${shortEngine(e)} = ${engineName(e)}`).join(', ')}.
      </p>
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

/**
 * The detail panel for the hovered, tapped or focused question — the full
 * text a 29-character truncated label cannot show, and the per-engine
 * breakdown in words, both reachable by keyboard and by touch (review
 * MINOR f). Same construction as `RowTip` in head-to-head-chart.tsx and
 * `TrendTip` in ci-trend-chart.tsx: a real block in the flow, not a floating
 * overlay, so it cannot be clipped by the viewBox and reflows on a narrow
 * screen; it reserves its height whether or not anything is active, so
 * hovering the chart does not shove the rest of the page down (CLS).
 */
function RowTip({
  rows,
  engines,
  active,
  subjectName,
}: {
  rows: readonly BreakdownLine[]
  engines: readonly string[]
  active: number | null
  subjectName: string
}) {
  if (active === null) {
    return (
      <div className="tip" aria-live="polite">
        <p className="tip__idle" style={{ margin: 0 }}>
          Hover, tap or tab to a question to read it in full, with what each engine did.
        </p>
      </div>
    )
  }
  const row = rows[active]!
  return (
    <div className="tip" aria-live="polite">
      <div className="tip__head">
        <span>{row.prompt}</span>
      </div>
      <p className="tip__row" style={{ margin: 0 }}>
        Named in {row.mentionedIn} of {row.answers} answers.
      </p>
      {engines.map((e) => (
        <p className="tip__row" style={{ margin: 0 }} key={e}>
          {cellTitle(cellsFor(row, e), e, subjectName)}
        </p>
      ))}
    </div>
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

/** Every run recorded for this prompt on this engine — MAJOR 2: never just the first. */
function cellsFor(row: BreakdownLine, engine: string): readonly BreakdownCell[] {
  return row.cells.filter((c) => c.engine === engine)
}

/** Lower sorts first; a recorded rank beats "named with no rank" beats nothing. */
const rankValue = (p: number | null): number => (p !== null && p > 0 ? p : Number.POSITIVE_INFINITY)

/** The best-ranked run that named the subject, or null when none did. */
function bestRun(cells: readonly BreakdownCell[]): BreakdownCell | null {
  const mentioned = cells.filter((c) => c.mentioned)
  if (mentioned.length === 0) return null
  return mentioned.reduce((a, b) => (rankValue(a.position) <= rankValue(b.position) ? a : b))
}

function tierOf(cells: readonly BreakdownCell[]): Tier {
  if (cells.length === 0) return 'none'
  const best = bestRun(cells)
  if (!best) return 'miss'
  const cls = rankClass(best.position)
  return cls === 'mark--rank1' ? 'rank1' : cls === 'mark--rank2' ? 'rank2' : 'rank3'
}

/** The numeral drawn inside a named cell: the real rank, or a dot when the pass recorded none. */
const rankNumeral = (position: number | null): string => (position !== null && position > 0 ? String(position) : '•')

/**
 * The same words the full table's title attribute already uses — one wording,
 * two surfaces — extended for MAJOR 2: when a cell holds more than one run,
 * the count of runs is stated explicitly so a multi-run cell never reads as
 * though only one answer existed.
 */
function cellTitle(cells: readonly BreakdownCell[], engine: string, subjectName: string): string {
  const name = engineName(engine)
  if (cells.length === 0) return `${name}: no answer was collected for this question`
  const mentioned = cells.filter((c) => c.mentioned)
  if (mentioned.length === 0) {
    const brands = Math.max(0, ...cells.map((c) => c.brandsDetected))
    return cells.length === 1
      ? `${name}: ${subjectName} not named; ${brands} other ${brands === 1 ? 'brand' : 'brands'} named in this answer`
      : `${name}: ${subjectName} not named in any of ${cells.length} runs`
  }
  const best = bestRun(cells)!
  const cited = mentioned.some((c) => c.cited)
  const rankPart = rankLabel(best.position, best.brandsDetected)
  return cells.length === 1
    ? `${name}: ${subjectName} named, ${rankPart}${cited ? ', and cited' : ''}`
    : `${name}: ${subjectName} named in ${mentioned.length} of ${cells.length} runs, best ${rankPart}${cited ? ', and cited' : ''}`
}

/** The full question and every engine's outcome, one string — the row hit target's accessible name. */
function rowSummary(row: BreakdownLine, engines: readonly string[], subjectName: string): string {
  const perEngine = engines.map((e) => cellTitle(cellsFor(row, e), e, subjectName)).join('. ')
  return `${row.prompt}. Named in ${row.mentionedIn} of ${row.answers} answers. ${perEngine}`
}

/**
 * "5 of the 17 questions were never named in a collected answer." — the plain
 * string, for the SVG's accessible name.
 *
 * ⚠️ PAST TENSE, AND "A COLLECTED ANSWER" RATHER THAN "ANY ENGINE" (review
 * MAJOR 1). The present tense ("never name X on any engine") turned one
 * cycle's counts into a standing property, when the section's own opener
 * already speaks in the past ("was named in…", prompt-breakdown.tsx). "On any
 * engine" is worse than a tense mismatch: it is FALSE the moment a cell was
 * never collected, because "no answer" is not evidence of "not named". Tying
 * the claim to "a collected answer" makes it exactly as true as the data
 * supports, whatever gaps this cycle has.
 *
 * Third person throughout, matching the section's own voice rather than a
 * second-person "your questions" — the same report is read by an agency about
 * a client as often as by the brand itself, and the heading above this
 * picture already carries the second person for the reader who is the brand.
 */
function summarySentence(zero: number, total: number, subjectName: string, enginesWithNoAnswers: readonly string[]): string {
  const engineNote = enginesWithNoAnswers.length > 0 ? ` ${engineAbsenceNote(enginesWithNoAnswers, subjectName)}` : ''
  if (total === 1) {
    return (
      (zero === 1
        ? `${subjectName} was never named in a collected answer to the one tracked question.`
        : `${subjectName} was named in at least one collected answer to the one tracked question.`) + engineNote
    )
  }
  if (zero === 0) return `${subjectName} was named in at least one collected answer for every one of the ${total} tracked questions.${engineNote}`
  if (zero === total) return `${subjectName} was never named in a collected answer for any of the ${total} tracked questions.${engineNote}`
  return `${subjectName} was never named in a collected answer for ${zero} of the ${total} tracked questions.${engineNote}`
}

/** The same words `citations.tsx` uses for the identical fact about a source class. */
function engineAbsenceNote(enginesWithNoAnswers: readonly string[], subjectName: string): string {
  const names = enginesWithNoAnswers.map(engineName).join(', ')
  return `${names} returned no answer in this cycle, which is a fact about ${enginesWithNoAnswers.length === 1 ? 'that engine' : 'those engines'}, not about ${subjectName}.`
}

/** The same sentence as `summarySentence`, typeset with the sheet's tabular-figure spans. */
function SummarySentence({
  zero,
  total,
  subjectName,
  enginesWithNoAnswers,
}: {
  zero: number
  total: number
  subjectName: string
  enginesWithNoAnswers: readonly string[]
}) {
  const engineNote = enginesWithNoAnswers.length > 0 ? (
    <>
      {' '}
      {enginesWithNoAnswers.map(engineName).join(', ')} returned no answer in this cycle, which is a fact about{' '}
      {enginesWithNoAnswers.length === 1 ? 'that engine' : 'those engines'}, not about {subjectName}.
    </>
  ) : null

  if (total === 1) {
    return zero === 1 ? (
      <>
        {subjectName} was never named in a collected answer to the one tracked question.{engineNote}
      </>
    ) : (
      <>
        {subjectName} was named in at least one collected answer to the one tracked question.{engineNote}
      </>
    )
  }
  if (zero === 0) {
    return (
      <>
        {subjectName} was named in at least one collected answer for every one of the <span className="num">{total}</span> tracked questions.
        {engineNote}
      </>
    )
  }
  if (zero === total) {
    return (
      <>
        {subjectName} was never named in a collected answer for any of the <span className="num">{total}</span> tracked questions.{engineNote}
      </>
    )
  }
  return (
    <>
      {subjectName} was never named in a collected answer for <span className="num">{zero}</span> of the <span className="num">{total}</span>{' '}
      tracked questions.{engineNote}
    </>
  )
}
