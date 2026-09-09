/**
 * The per-prompt, per-engine view of one cycle — pure, and it refuses to draw
 * anything it cannot reconcile with the headline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
 *
 * `services/grader/src/scan.ts` now keeps the `ScoreRow` it already computed for
 * every answer (`PromptRow`), instead of summing it away. This file turns that
 * flat list into the two shapes a reader actually asks for — "which questions am
 * I in" and "which engines answer with me" — and nothing else. There is no new
 * measurement here, no threshold, no weighting and no estimate. Every number
 * below is a count of rows.
 *
 * ⚠️ IT RETURNS NULL RATHER THAN A PLAUSIBLE TABLE, in three cases, and the
 * third is the one that matters.
 *
 *   1. The file carries no `promptRows`. Every result written before 2026-09-02
 *      is such a file. Absent is absent: a surface must say "this cycle's stored
 *      payload does not carry the split", never render an empty grid that reads
 *      as "mentioned nowhere".
 *
 *   2. Every row is malformed. `localStorage` is a trust boundary — the same one
 *      `isScanResultFile` guards — so rows are shape-checked and bad ones
 *      dropped.
 *
 *   3. ⚠️ THE TOTALS DISAGREE WITH THE HEADLINE. `mentions` and `n` on the
 *      subject's metric are derived from exactly the same pass that produced
 *      these rows, so a correct file reconciles EXACTLY: one row per scored
 *      answer, and a mentioned row for every mention counted. If it does not —
 *      a hand-edited file, a truncated write, a row dropped by rule 2 — then the
 *      table and the rate above it would be two different measurements shown as
 *      one, which is the specific failure this product exists to argue against.
 *      A number nobody can reconcile is worse than a number nobody has.
 *
 * The refusal is HERE and not in the component, so every surface that renders
 * this gets the same answer. Two components asking the same question two ways is
 * how they come to disagree.
 */

import { subjectOf, type ScanResultFile } from '@/lib/scan-result'

/**
 * One scored answer, as stored. Mirrors `PromptRow` in
 * `services/grader/src/scan.ts` — declared rather than imported because the
 * public app compiles without the services tree on its path, and the shape
 * arrives from JSON and from `localStorage` either way, so it has to be
 * validated at runtime regardless of what a type says.
 */
export interface StoredPromptRow {
  readonly prompt: string
  readonly engine: string
  readonly mentioned: boolean
  readonly mentionCount: number
  readonly position: number | null
  readonly brandsDetected: number
  readonly cited: boolean
  readonly competitorsMentioned: readonly string[]
  /**
   * The bank's classification of the question: `discovery` or `problem-led`.
   *
   * ⚠️ ABSENT IS NOT A CATEGORY. It means either a custom prompt, which nobody
   * classified, or a result written before 2026-09-07. A by-type view must
   * report what it could not classify rather than bucketing it — `undefined` is
   * not a third intent, and a chart with an "other" slice built from it would
   * be showing the age of a file as if it were a property of the market.
   */
  readonly intent?: string
}

/** One answer, in the cell of the grid where its prompt row meets its engine column. */
export interface BreakdownCell extends StoredPromptRow {}

export interface BreakdownLine {
  readonly prompt: string
  /**
   * The bank's classification for this question, when the file records one.
   *
   * Taken from the first row that carries it: every answer to one prompt comes
   * from one bank entry, so they agree by construction. Absent when the file
   * predates the field or the prompt is the customer's own.
   */
  readonly intent?: string
  /** One per answer to this prompt, in engine order. May be shorter than the engine list. */
  readonly cells: readonly BreakdownCell[]
  readonly answers: number
  readonly mentionedIn: number
}

export interface PromptBreakdown {
  /** Column order: every engine that answered anything, sorted for stability. */
  readonly engines: readonly string[]
  /** Row order: first appearance, which is bank order — the order a cycle asks. */
  readonly prompts: readonly BreakdownLine[]
  readonly answers: number
  readonly mentionedIn: number
  /**
   * TRACKED competitors the engines named in these answers, with the number of
   * answers each appeared in. Empty for a generated or fallback bank, which
   * carries no leaders — and that emptiness is a fact about the bank, not about
   * the market. See `promote-competitors.ts` for the mechanism that fills it.
   */
  readonly competitors: readonly { readonly name: string; readonly answers: number }[]
}

/**
 * Shape guard. Storage and JSON are both trust boundaries and a malformed row
 * would reach arithmetic (`position`, `brandsDetected`) that has no defence of
 * its own — the same defect `isScanBrand` was written for after `brands:[{}]`
 * white-screened every record surface on `undefined - undefined`.
 */
function isStoredPromptRow(r: unknown): r is StoredPromptRow {
  if (typeof r !== 'object' || r === null) return false
  const x = r as Partial<StoredPromptRow>
  return (
    typeof x.prompt === 'string' &&
    x.prompt !== '' &&
    typeof x.engine === 'string' &&
    x.engine !== '' &&
    typeof x.mentioned === 'boolean' &&
    Number.isFinite(x.mentionCount) &&
    (x.position === null || Number.isFinite(x.position)) &&
    Number.isFinite(x.brandsDetected) &&
    typeof x.cited === 'boolean' &&
    // Optional, so absent passes; present-and-not-a-string does not.
    (x.intent === undefined || typeof x.intent === 'string') &&
    Array.isArray(x.competitorsMentioned) &&
    x.competitorsMentioned.every((c) => typeof c === 'string')
  )
}

/** The valid rows a file carries, or [] when it carries none. */
export function storedPromptRows(scan: ScanResultFile): readonly StoredPromptRow[] {
  const raw = (scan as { promptRows?: unknown }).promptRows
  return Array.isArray(raw) ? raw.filter(isStoredPromptRow) : []
}

export function promptBreakdown(scan: ScanResultFile): PromptBreakdown | null {
  const rows = storedPromptRows(scan)
  if (rows.length === 0) return null

  /*
   * THE RECONCILIATION, BEFORE ANYTHING IS BUILT.
   *
   * The subject's `n` is `answers.length` and its `mentions` is the count of
   * mentioned answers, both from the same loop that emitted these rows. So a
   * whole file agrees on the nose. Anything else is a file that has been through
   * something, and the honest response to that is the same one the workspace
   * record already gives for a file with no rows at all.
   */
  const subject = subjectOf(scan)
  const mentionedIn = rows.filter((r) => r.mentioned).length
  if (rows.length !== subject.metric.n || mentionedIn !== subject.mentions) return null

  const byPrompt = new Map<string, BreakdownCell[]>()
  const engines = new Set<string>()
  const competitorAnswers = new Map<string, number>()

  for (const row of rows) {
    engines.add(row.engine)
    const cells = byPrompt.get(row.prompt)
    if (cells) cells.push(row)
    else byPrompt.set(row.prompt, [row])
    // Counted per ANSWER, not per occurrence: "named in 12 of 50 answers" is a
    // rate over the same denominator as the subject's own, and so can sit
    // beside it. A count of occurrences cannot.
    for (const name of new Set(row.competitorsMentioned)) {
      competitorAnswers.set(name, (competitorAnswers.get(name) ?? 0) + 1)
    }
  }

  const engineOrder = [...engines].sort()
  const prompts: BreakdownLine[] = [...byPrompt.entries()].map(([prompt, cells]) => ({
    prompt,
    ...(cells.find((c) => c.intent)?.intent ? { intent: cells.find((c) => c.intent)!.intent! } : {}),
    cells: [...cells].sort((a, b) => engineOrder.indexOf(a.engine) - engineOrder.indexOf(b.engine)),
    answers: cells.length,
    mentionedIn: cells.filter((c) => c.mentioned).length,
  }))

  return {
    engines: engineOrder,
    prompts,
    answers: rows.length,
    mentionedIn,
    competitors: [...competitorAnswers.entries()]
      .map(([name, answers]) => ({ name, answers }))
      .sort((a, b) => b.answers - a.answers || (a.name < b.name ? -1 : 1)),
  }
}

/**
 * Answers from one engine, and how many named the subject.
 *
 * Derived from the rows rather than from the total, which is the whole point.
 * The record used to refuse a by-engine table on the grounds that "splitting
 * the total five ways would be arithmetic presented as evidence" — correct,
 * about a total. This divides nothing.
 */
export function byEngine(b: PromptBreakdown): readonly { readonly engine: string; readonly answers: number; readonly mentionedIn: number }[] {
  return b.engines.map((engine) => {
    const cells = b.prompts.flatMap((p) => p.cells).filter((c) => c.engine === engine)
    return { engine, answers: cells.length, mentionedIn: cells.filter((c) => c.mentioned).length }
  })
}

/** One buyer intent, aggregated over the questions the bank assigned to it. */
export interface IntentGroup {
  readonly intent: string
  /** Questions of this type in the cycle. */
  readonly questions: number
  /** Questions of this type the subject was named in at least one answer to. */
  readonly questionsNamedIn: number
  /** Answers those questions produced. */
  readonly answers: number
  /** Answers of this type naming the subject. */
  readonly mentionedIn: number
}

/**
 * The cycle split by the bank's own buyer intent — `discovery` against
 * `problem-led`.
 *
 * ⚠️ UNCLASSIFIED IS RETURNED SEPARATELY AND IS NOT A GROUP. A prompt carries
 * no intent for two reasons that are different facts and must not be merged:
 * it is the CUSTOMER'S OWN (ADR-0016 — nobody assigned it a buyer intent), or
 * the result predates 2026-09-07 when the field did not exist. Bucketing either
 * into an "other" slice would draw the age of a file as though it were a
 * property of the market. So they are counted, reported, and left out of the
 * comparison.
 *
 * Groups are ordered by the bank's own intent names rather than by rate: a
 * ranking that reorders itself between cycles is one a reader cannot compare
 * against last month's screenshot.
 */
export function byIntent(b: PromptBreakdown): { readonly groups: readonly IntentGroup[]; readonly unclassified: IntentGroup | null } {
  const held = new Map<string, { questions: number; questionsNamedIn: number; answers: number; mentionedIn: number }>()
  for (const p of b.prompts) {
    const key = p.intent ?? ''
    const v = held.get(key) ?? { questions: 0, questionsNamedIn: 0, answers: 0, mentionedIn: 0 }
    v.questions += 1
    if (p.mentionedIn > 0) v.questionsNamedIn += 1
    v.answers += p.answers
    v.mentionedIn += p.mentionedIn
    held.set(key, v)
  }
  const none = held.get('')
  held.delete('')
  const groups = [...held.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([intent, v]) => ({ intent, ...v }))
  return { groups, unclassified: none ? { intent: '', ...none } : null }
}
