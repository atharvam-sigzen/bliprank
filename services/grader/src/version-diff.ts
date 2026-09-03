/**
 * `pnpm grader:version-diff` — the complete flip list for a scoring version
 * bump. Rule R5; the bar in ADR-0012; the command in `/score-version`.
 *
 *   pnpm grader:version-diff -- --snapshot          every stored answer's row under the CURRENT code,
 *                                                   written to <data>/version-snapshots/<version>.json
 *   pnpm grader:version-diff -- --against det-2     every stored answer scored by the current code,
 *                                                   against that snapshot: every row that differs, by field
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY. R5 says a rule change bumps the version, and ADR-0012 set the bar for
 * the one exception: every stored answer scored under BOTH rule sets, not a
 * sample. That check was done once, by hand, and `/score-version` promised a
 * diff it had no tool for. The code holds one rule set at a time, so "both"
 * means: snapshot the rows BEFORE editing a rule, bump and edit, then diff.
 * Every row that changed is the changelog's content; a row that changed and
 * the summary does not explain is a second rule change, or a bug.
 *
 * The golden set rides along. The snapshot records its agreement per field
 * under the old rules and the diff prints it beside the new, so a regression
 * against human labels is visible even at seven cases. At that size the G2
 * gate is NOT RUN and this tool says so; for a bump, the flip list is the gate.
 *
 * Reads the store and the golden files. Writes one file under
 * `version-snapshots/`, never a result (the blob store creates its own
 * directory on open, which is the only other write). No provider, no model,
 * no network. The snapshot sits in the ignored data directory: the flip list
 * pasted into the changelog is the durable record, as in ADR-0012.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCORING_ALGO_VERSION, runGoldenSet, type GoldenCase, type GoldenReport } from '@bliprank/scorer'
import { scoreStoredCycle, type ScoredCycle } from './answers.js'
import { listCycles, storedResults } from './cycles.js'

/** One stored answer's deterministic row, reduced to what a rule change can move. */
export interface SnapshotRow {
  readonly domain: string
  readonly day: string
  readonly engine: string
  readonly prompt: string
  /** Index of the run within its cell, so two runs of one cell stay distinct. */
  readonly run: number
  readonly mentioned: boolean
  readonly mentionCount: number
  readonly brandsDetected: number
  readonly cited: boolean
  readonly citedAtPositions: readonly number[]
  readonly position: number | null
  readonly competitorsMentioned: readonly string[]
  readonly citations: readonly { readonly url: string; readonly domain: string; readonly sourceClass: string }[]
}

/** The golden set's agreement, per field, as rates. Enough to see a regression; the disagreements themselves print live. */
export interface GoldenSummary {
  readonly cases: number
  readonly fields: Readonly<Record<string, number>>
  readonly citationClass: number
  readonly silentOwned: number
  readonly gateStatus: GoldenReport['gateStatus']
}

export interface Snapshot {
  readonly algoVersion: string
  readonly takenAt: string
  readonly cycles: number
  readonly rows: readonly SnapshotRow[]
  readonly golden: GoldenSummary
}

export interface Flip {
  readonly key: string
  readonly field: string
  readonly before: unknown
  readonly after: unknown
}

export const rowKey = (r: Pick<SnapshotRow, 'domain' | 'day' | 'engine' | 'run' | 'prompt'>): string => `${r.domain}|${r.day}|${r.engine}|${r.run}|${r.prompt}`

/** Every ScoreRow field a rule can move. `algoVersion`, `brandId` and `collectionPath` are provenance, not derivation. */
const FIELDS = ['mentioned', 'mentionCount', 'brandsDetected', 'cited', 'citedAtPositions', 'position', 'competitorsMentioned', 'citations'] as const

/** The rows a scored cycle contributes. Pure. */
export function snapshotRows(cycle: Pick<ScoredCycle, 'domain' | 'day' | 'runs'>): SnapshotRow[] {
  const seen = new Map<string, number>()
  return cycle.runs.map((r) => {
    const cellKey = `${r.engine}|${r.prompt}`
    const run = seen.get(cellKey) ?? 0
    seen.set(cellKey, run + 1)
    return {
      domain: cycle.domain,
      day: cycle.day,
      engine: r.engine,
      prompt: r.prompt,
      run,
      mentioned: r.row.mentioned,
      mentionCount: r.row.mentionCount,
      brandsDetected: r.row.brandsDetected,
      cited: r.row.cited,
      citedAtPositions: r.row.citedAtPositions,
      position: r.row.position,
      competitorsMentioned: r.row.competitorsMentioned,
      citations: r.row.citations.map((k) => ({ url: k.url, domain: k.domain, sourceClass: k.sourceClass })),
    }
  })
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Every field of every row that differs between two row sets, plus the rows
 * only one side has (a cycle added or removed between snapshot and diff, which
 * is a different fact from a flip and is reported as one).
 */
export function diffRows(before: readonly SnapshotRow[], after: readonly SnapshotRow[]): { readonly compared: number; readonly flips: readonly Flip[]; readonly onlyBefore: readonly string[]; readonly onlyAfter: readonly string[] } {
  const b = new Map(before.map((r) => [rowKey(r), r]))
  const a = new Map(after.map((r) => [rowKey(r), r]))
  const flips: Flip[] = []
  let compared = 0
  for (const [key, x] of b) {
    const y = a.get(key)
    if (!y) continue
    compared += 1
    for (const f of FIELDS) if (!same(x[f], y[f])) flips.push({ key, field: f, before: x[f], after: y[f] })
  }
  return {
    compared,
    flips,
    onlyBefore: [...b.keys()].filter((k) => !a.has(k)).sort(),
    onlyAfter: [...a.keys()].filter((k) => !b.has(k)).sort(),
  }
}

export function goldenSummary(report: GoldenReport): GoldenSummary {
  return {
    cases: report.cases,
    fields: Object.fromEntries(report.deterministic.map((f) => [f.field, f.rate])),
    citationClass: report.citationClass.rate,
    silentOwned: report.silentOwned.length,
    gateStatus: report.gateStatus,
  }
}

/** Per field: the old rate, the new rate, and whether it fell. A fall on any field is the command's stop condition. */
export function diffGolden(before: GoldenSummary, after: GoldenSummary): readonly { readonly field: string; readonly before: number; readonly after: number; readonly regressed: boolean }[] {
  const names = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])]
  const rows = names.map((field) => ({ field, before: before.fields[field] ?? 0, after: after.fields[field] ?? 0 }))
  rows.push({ field: 'citationClass', before: before.citationClass, after: after.citationClass })
  return rows.map((r) => ({ ...r, regressed: r.after < r.before }))
}

// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
export const snapshotPath = (dataDir: string, version: string): string => join(dataDir, 'version-snapshots', `${version}.json`)

/** The hand-labelled cases, read the way `golden.test.ts` reads them. The labels are human work; nothing here edits them. */
function loadGoldenCases(): GoldenCase[] {
  const dir = join(here, '..', '..', 'scorer', 'golden', 'answers')
  // An empty set would make every rate 0 on both sides and the STOP condition vacuously pass. Refuse instead.
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith('.json'))) {
    process.stderr.write(`refusing: no golden cases at ${dir}. With none, agreement is 0 → 0 and a regression could not show.\n`)
    process.exit(2)
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as GoldenCase)
}

async function currentRows(dataDir: string, log: (s: string) => void): Promise<{ cycles: number; rows: SnapshotRow[] }> {
  const rows: SnapshotRow[] = []
  let cycles = 0
  for (const domain of storedResults(dataDir)) {
    const stored = listCycles(dataDir, domain)
    if (stored.length === 0) log(`  skip ${domain}: no readable cycle\n`)
    for (const c of stored) {
      const got = await scoreStoredCycle(dataDir, domain, c.day)
      if ('refuse' in got) {
        log(`  skip ${domain} ${c.day}: ${got.refuse}\n`)
        continue
      }
      cycles += 1
      const got_rows = snapshotRows(got)
      // A blob the store no longer holds drops silently in the reader; the result's own count says how many rows there should be.
      const expected = (c.result as { counts?: { answersScored?: unknown } }).counts?.answersScored
      if (typeof expected === 'number' && expected !== got_rows.length) log(`  ⚠️ ${domain} ${c.day}: ${got_rows.length} rows scored, the result counts ${expected} answers — a stored answer is missing from the blob store\n`)
      rows.push(...got_rows)
    }
  }
  return { cycles, rows }
}

const pct = (r: number) => `${(r * 100).toFixed(1)}%`

async function main(): Promise<void> {
  const args = new Map<string, string>()
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(a.slice(2), v)
  }
  const dataDir = args.get('data') ?? join(here, '..', 'data-live')
  const out = (s: string) => process.stdout.write(s)

  const golden = goldenSummary(runGoldenSet(loadGoldenCases()))
  const goldenLine = (g: GoldenSummary) => `${g.cases} cases · gate ${g.gateStatus}` + (g.gateStatus === 'NOT_RUN' ? ' (agreement is reported, not gated, at this size)' : '')

  if (args.has('snapshot')) {
    const file = snapshotPath(dataDir, SCORING_ALGO_VERSION)
    if (existsSync(file) && !args.has('force')) {
      process.stderr.write(`refusing: ${file} exists. A snapshot is the rows under ${SCORING_ALGO_VERSION} as they were; pass --force to replace it, knowing the old one is gone.\n`)
      process.exit(2)
    }
    const { cycles, rows } = await currentRows(dataDir, out)
    const snap: Snapshot = { algoVersion: SCORING_ALGO_VERSION, takenAt: new Date().toISOString(), cycles, rows, golden }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(snap, null, 2) + '\n')
    out(`version-diff · snapshot ${SCORING_ALGO_VERSION} · ${cycles} cycle(s) · ${rows.length} rows · golden ${goldenLine(golden)}\n  wrote ${file}\n`)
    return
  }

  const against = args.get('against')
  if (!against || against === 'true') {
    process.stderr.write('usage: --snapshot | --against <version> [--data <dir>]\n')
    process.exit(2)
  }
  const file = snapshotPath(dataDir, against)
  if (!existsSync(file)) {
    process.stderr.write(`refusing: no snapshot for ${against} at ${file}. Snapshots are taken with --snapshot BEFORE the rule edit; one taken after is the new rules against themselves.\n`)
    process.exit(2)
  }
  const snap = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
  const { cycles, rows } = await currentRows(dataDir, out)
  const d = diffRows(snap.rows, rows)

  out(
    `version-diff · current ${SCORING_ALGO_VERSION} · against ${snap.algoVersion} (snapshot ${snap.takenAt.slice(0, 19)}Z, ${snap.cycles} cycles, ${snap.rows.length} rows)\n` +
      (SCORING_ALGO_VERSION === snap.algoVersion ? `  NOTE: the same version on both sides. Zero flips proves the tool, not a rule change.\n` : '') +
      `  now ${cycles} cycle(s), ${rows.length} rows · compared ${d.compared} · only in snapshot ${d.onlyBefore.length} · only now ${d.onlyAfter.length}\n`,
  )
  for (const k of d.onlyBefore) out(`    only in snapshot: ${k}\n`)
  for (const k of d.onlyAfter) out(`    only now:         ${k}\n`)

  const byField = new Map<string, number>()
  for (const f of d.flips) byField.set(f.field, (byField.get(f.field) ?? 0) + 1)
  out(`\nFLIPS: ${d.flips.length}` + (d.flips.length ? ` (${[...byField.entries()].map(([f, n]) => `${f} ${n}`).join(', ')})` : '') + '\n')
  for (const f of d.flips) {
    const [domain, day, engine, run, ...rest] = f.key.split('|')
    out(`  ${f.field.padEnd(20)} ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}\n` + `                       ${domain} ${day} ${engine} #${run} "${rest.join('|')}"\n`)
  }

  out(`\nGOLDEN SET · before ${goldenLine(snap.golden)} · now ${goldenLine(golden)}\n`)
  const g = diffGolden(snap.golden, golden)
  for (const r of g) out(`  ${r.field.padEnd(20)} ${pct(r.before).padStart(6)} → ${pct(r.after).padStart(6)}${r.regressed ? '   ⚠️ REGRESSED' : ''}\n`)
  out(`  ${'silentOwned'.padEnd(20)} ${String(snap.golden.silentOwned).padStart(6)} → ${String(golden.silentOwned).padStart(6)}${golden.silentOwned > snap.golden.silentOwned ? '   ⚠️ REGRESSED' : ''}\n`)
  const regressed = g.some((r) => r.regressed) || golden.silentOwned > snap.golden.silentOwned
  const sameVersion = SCORING_ALGO_VERSION === snap.algoVersion
  out(
    `\n${
      regressed
        ? '⚠️ STOP: agreement against human labels regressed. Do not bump.'
        : d.flips.length
          ? `${d.flips.length} row(s) flipped: each must be explained by the change summary, and the list goes in the changelog.`
          : sameVersion
            ? 'Same version on both sides and no flips: this run proves the tool, not a rule change.'
            : 'No stored row changes under the new rules.'
    }\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
