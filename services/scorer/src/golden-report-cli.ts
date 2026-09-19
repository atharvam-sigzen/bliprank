/**
 * `pnpm scorer:golden-report` — the golden set's agreement report. MVP_PLAN E4.
 *
 *   (no flag)             the verdict, the three G2 figures with what each is a rate OF, whose
 *                         labels, where the spot-check stands, the figures by engine and by
 *                         category, and EVERY disagreement with both sides and the labeller's
 *                         evidence for its side
 *   --write-sheet         write docs/runbooks/golden-spot-check.md for the current set. Refuses
 *                         to replace a sheet somebody has started filling in (use --force)
 *   --write-disagreements write golden/disagreements.json: the recorded list the test suite
 *                         holds the live report against
 *
 * Reads the golden cases and the spot-check sheet. Runs the deterministic
 * scorer over the cases, which is the point: this is where the scorer and the
 * labels finally meet. No provider, no model, no network, no data directory.
 *
 * ⚠️ A DISAGREEMENT IS A FINDING FOR THE SCORING-RULE OWNER. Nothing here edits a
 * label or a rule. A label changes only by re-reading the answer (and records
 * that in `evidence.revisions`); a rule changes only under `/score-version`.
 *
 * ⚠️ WHAT THE HEADLINE IS NOT (E4 stats review). One pooled percentage hides the
 * things this set was stratified to show, so the report never prints it alone:
 * the real answers are reported apart from the seven hand-built fixtures; every
 * engine and every category gets its own row and a row under the bar is marked;
 * the citation figure is shown beside the share of citations labelled `other`
 * (a classifier that answered `other` to everything would score that share) and
 * beside agreement on the rest; a zero carries its upper bound; and the set's
 * composition (how many brands, questions, days, runs per cell) is on the page.
 * The pooled deterministic rate is six checks per case that move together, so
 * it gets NO interval here; the case-level count does.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GOLDEN_SET_TARGET, runGoldenSet, type GoldenCase, type GoldenReport, type GoldenSetReport } from './golden.js'
import { parseSpotCheckSheet, renderSpotCheckSheet } from './golden-spot-check.js'
import { SCORING_ALGO_VERSION } from './score.js'

const here = dirname(fileURLToPath(import.meta.url))
export const GOLDEN_ANSWERS_DIR = join(here, '..', 'golden', 'answers')
export const DISAGREEMENTS_FILE = join(here, '..', 'golden', 'disagreements.json')
export const SPOT_CHECK_SHEET = join(here, '..', '..', '..', 'docs', 'runbooks', 'golden-spot-check.md')

export function loadGoldenCases(dir: string = GOLDEN_ANSWERS_DIR): GoldenCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as GoldenCase)
}

/** The report for the set as it stands on disk: the cases, and the sheet if there is one, exactly as a person left it. */
export function currentReport(cases: readonly GoldenCase[] = loadGoldenCases(), sheetFile: string = SPOT_CHECK_SHEET): GoldenSetReport {
  return runGoldenSet(cases, existsSync(sheetFile) ? parseSpotCheckSheet(readFileSync(sheetFile, 'utf8')) : undefined)
}

export interface RecordedDisagreement {
  readonly caseId: string
  readonly field: string
  /** What the label says. */
  readonly expected: unknown
  /** What the scorer said. */
  readonly actual: unknown
}

/** Every disagreement of a report, flat and sorted, so the recorded file diffs cleanly. */
export function disagreementsOf(report: GoldenReport): RecordedDisagreement[] {
  const rows = [...report.deterministic.flatMap((f) => f.disagreements.map((d) => ({ caseId: d.caseId, field: f.field, expected: d.expected, actual: d.actual }))), ...report.citationClass.disagreements.map((d) => ({ caseId: d.caseId, field: 'sourceClass', expected: d.expected, actual: d.actual }))]
  return rows.sort((a, b) => (a.caseId + a.field + JSON.stringify(a.expected) < b.caseId + b.field + JSON.stringify(b.expected) ? -1 : 1))
}

export interface Breakdown {
  readonly name: string
  readonly cases: number
  readonly deterministic: { readonly agreed: number; readonly total: number }
  readonly citations: { readonly agreed: number; readonly total: number }
  readonly casesFullyAgreed: number
}

/** The figures over one slice of the set. The slice is scored on its own, with no sheet: a breakdown is never a verdict. */
export function breakdown(name: string, cases: readonly GoldenCase[]): Breakdown {
  const r = runGoldenSet(cases)
  return {
    name,
    cases: cases.length,
    deterministic: { agreed: r.deterministic.reduce((n, f) => n + f.agreed, 0), total: r.deterministic.reduce((n, f) => n + f.total, 0) },
    citations: { agreed: r.citationClass.agreed, total: r.citationClass.total },
    casesFullyAgreed: r.casesFullyAgreed.agreed,
  }
}

/** One row per value of `key`, sorted by name. */
export function breakdownBy(cases: readonly GoldenCase[], key: (c: GoldenCase) => string): Breakdown[] {
  const groups = new Map<string, GoldenCase[]>()
  for (const c of cases) groups.set(key(c), [...(groups.get(key(c)) ?? []), c])
  return [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, list]) => breakdown(name, list))
}

/** How the labelled citation classes are distributed: the base rate the citation figure has to be read against. */
export function citationClassShares(cases: readonly GoldenCase[]): { readonly total: number; readonly byClass: Readonly<Record<string, number>>; readonly hosts: number } {
  const byClass: Record<string, number> = {}
  const hosts = new Set<string>()
  let total = 0
  for (const c of cases) {
    for (const k of c.answer.citations) {
      const cls = c.label.citationClasses[String(k.position)]
      if (cls === undefined) continue
      total += 1
      byClass[cls] = (byClass[cls] ?? 0) + 1
      try {
        hosts.add(new URL(k.url).hostname.replace(/^www\./, ''))
      } catch {
        hosts.add('(no host)')
      }
    }
  }
  return { total, byClass, hosts: hosts.size }
}

const pct = (k: number, n: number): string => (n === 0 ? 'not measured' : `${((k / n) * 100).toFixed(1)}%`)
const frac = (k: number, n: number): string => `${pct(k, n)} (${k}/${n})`
const isReal = (c: GoldenCase): boolean => !!c.source.cell

function print(cases: readonly GoldenCase[], report: GoldenSetReport): void {
  const out = (s: string) => process.stdout.write(s)
  out(`golden set · ${report.cases} of ${GOLDEN_SET_TARGET} cases · ${SCORING_ALGO_VERSION} · gate ${report.gateStatus}\n  ${report.gateNote}\n`)
  out(`  labels: ${report.labels.human} hand-built or human · ${report.labels.proposed} agent-proposed, unverified · ${report.labels.verified} agent-proposed, verified by a person\n`)
  const sc = report.spotCheck
  out(
    `  spot-check: ${sc.status}` +
      (sc.status === 'not-needed' ? '' : ` · ${sc.agreed} agreed of ${sc.checked} answered, ${sc.required} required, ${sc.minAgree} must agree` + (sc.interval ? ` · 95% interval ${(sc.interval.low * 100).toFixed(1)}% to ${(sc.interval.high * 100).toFixed(1)}%` : '') + (sc.checkedBy ? ` · by ${sc.checkedBy}` : '')) +
      '\n',
  )
  for (const p of sc.problems) out(`      ${p}\n`)
  for (const d of sc.disputed) out(`      disputed by the person, still counted: ${d.id}${d.note ? ` — ${d.note}` : ''}\n`)
  for (const n of sc.notes.filter((x) => x.verdict !== 'disagree')) out(`      note beside ${n.verdict}: ${n.id} — ${n.note}\n`)

  // What the figures rest on. A rate over three brands says so on the page.
  const real = cases.filter(isReal)
  const distinct = (f: (c: GoldenCase) => string | undefined) => new Set(real.map(f).filter(Boolean)).size
  const cells = new Map<string, number>()
  for (const c of real) cells.set(`${c.source.domain}|${c.source.cell!.key}`, (cells.get(`${c.source.domain}|${c.source.cell!.key}`) ?? 0) + 1)
  const runs = [...new Set(cells.values())].sort().join(' or ')
  out(
    `\nWHAT THE SET IS\n` +
      `  ${real.length} real stored answers + ${cases.length - real.length} hand-built fixtures (synthetic text written to pin an edge)\n` +
      `  the real answers: ${distinct((c) => c.source.domain)} brand(s), ${distinct((c) => c.source.category)} categor(ies), ${distinct((c) => c.source.prompt)} distinct question(s), ${distinct((c) => c.source.engine)} engine(s), ${distinct((c) => c.source.day)} collection day(s), ${runs || 'no'} run(s) per cell\n` +
      `  every real answer the corpus could trace to a stored cycle is here, so this is a census of what has been scored, not a sample of what could be\n`,
  )

  out(`\nTHE THREE G2 FIGURES · every case\n`)
  const det = report.deterministic.reduce((a, f) => ({ k: a.k + f.agreed, n: a.n + f.total }), { k: 0, n: 0 })
  out(`  deterministic agreement   ${frac(det.k, det.n)} field checks = 6 per case, which move together: no interval is honest on this line   (need 95%)\n`)
  const full = report.casesFullyAgreed
  out(`    the same, by case       ${frac(full.agreed, full.total)} cases with all six checks right` + (full.interval ? ` · 95% interval ${(full.interval.low * 100).toFixed(1)}% to ${(full.interval.high * 100).toFixed(1)}%` : '') + '\n')
  out(`  citation-class agreement  ${frac(report.citationClass.agreed, report.citationClass.total)} labelled citations   (need 97%)\n`)
  const shares = citationClassShares(cases)
  const other = shares.byClass['other'] ?? 0
  const rest = breakdown('not-other', cases.map((c) => ({ ...c, label: { ...c.label, citationClasses: Object.fromEntries(Object.entries(c.label.citationClasses).filter(([, cls]) => cls !== 'other')) } })))
  out(`    read it against this    ${frac(other, shares.total)} of those citations are labelled other, which is what answering "other" to everything would score\n`)
  out(`    on the rest             ${frac(rest.citations.agreed, rest.citations.total)} citations labelled with a real class · ${shares.hosts} distinct hosts in all\n`)
  out(`    by labelled class       ${Object.entries(shares.byClass).sort(([, a], [, b]) => b - a).map(([cls, n]) => `${cls} ${n}`).join(' · ')}\n`)
  out(
    `  silently bucketed owned   ${report.measured.citations ? `${report.silentOwned.length} of ${report.citationClass.total}` : 'not measured: no labelled citation'}` +
      (report.silentOwnedUpper !== null ? ` · zero seen is not zero proven: the 95% upper bound is ${(report.silentOwnedUpper * 100).toFixed(2)}%` : '') +
      `   (need 0)\n`,
  )
  out(`  ⚠️ G2 compares these point estimates to its bars. Where a bar sits inside the uncertainty shown above, that is the owner's call, not this report's.\n`)

  const fixtures = breakdown('hand-built fixtures', cases.filter((c) => !isReal(c)))
  const reals = breakdown('real stored answers', real)
  out(`\nREAL ANSWERS APART FROM THE FIXTURES\n`)
  for (const b of [reals, fixtures]) out(`  ${b.name.padEnd(22)} ${String(b.cases).padStart(4)} cases · deterministic ${frac(b.deterministic.agreed, b.deterministic.total)} · by case ${frac(b.casesFullyAgreed, b.cases)} · citations ${frac(b.citations.agreed, b.citations.total)}\n`)

  const table = (title: string, rows: readonly Breakdown[]) => {
    out(`\n${title}\n`)
    for (const b of rows) {
      const under = b.deterministic.total > 0 && b.deterministic.agreed / b.deterministic.total < 0.95
      out(`  ${b.name.padEnd(26)} ${String(b.cases).padStart(4)} cases · deterministic ${frac(b.deterministic.agreed, b.deterministic.total).padEnd(18)} · by case ${frac(b.casesFullyAgreed, b.cases).padEnd(15)} · citations ${frac(b.citations.agreed, b.citations.total)}${under ? '   ⚠️ under the 95% bar' : ''}\n`)
    }
  }
  table('BY ENGINE · real answers', breakdownBy(real, (c) => c.source.engine))
  table('BY CATEGORY · real answers (one brand each, so this is also by brand)', breakdownBy(real, (c) => `${c.source.category} · ${c.source.domain}`))

  out(`\nPER FIELD · every case\n`)
  for (const f of [...report.deterministic, report.citationClass]) out(`  ${f.field.padEnd(22)} ${frac(f.agreed, f.total)}\n`)

  if (sc.disputed.length) {
    const kept = breakdown('all', cases)
    const without = breakdown('without', cases.filter((c) => !sc.disputed.some((d) => d.id === c.id)))
    out(`\nBOTH WAYS · the ${sc.disputed.length} label(s) the person disputed are counted above; without them: deterministic ${frac(without.deterministic.agreed, without.deterministic.total)} against ${frac(kept.deterministic.agreed, kept.deterministic.total)}, citations ${frac(without.citations.agreed, without.citations.total)} against ${frac(kept.citations.agreed, kept.citations.total)}\n`)
  }

  const byCase = new Map<string, RecordedDisagreement[]>()
  for (const d of disagreementsOf(report)) byCase.set(d.caseId, [...(byCase.get(d.caseId) ?? []), d])
  out(`\nDISAGREEMENTS · ${byCase.size} case(s) · each is a finding for the scoring-rule owner, not a defect in either side until a person has read it\n`)
  const byId = new Map(cases.map((c) => [c.id, c]))
  for (const [id, list] of [...byCase].sort()) {
    const c = byId.get(id)!
    out(`\n  ${id}  [${c.source.engine}] ${c.source.prompt ? `"${c.source.prompt}"` : ''}\n`)
    for (const d of list) out(`    ${d.field.padEnd(20)} label ${JSON.stringify(d.expected)}  ·  scorer ${JSON.stringify(d.actual)}\n`)
    const ev = c.evidence
    if (!ev) continue
    const nameOf = new Map([[c.brand.id, c.brand.name], ...(c.competitors ?? []).map((b) => [b.id, b.name] as [string, string])])
    if (list.some((d) => d.field !== 'sourceClass')) {
      out(`    evidence · order: ${ev.order.join(' > ') || '(no brand)'}\n`)
      for (const m of [...ev.mentions].sort((a, b) => a.offset - b.offset)) {
        const s = Math.max(0, m.offset - 40)
        const ctx = c.answer.text.slice(s, m.offset + m.span.length + 40).replace(/\s+/g, ' ')
        out(`      ${(nameOf.get(m.brand) ?? m.brand).padEnd(28)} @${String(m.offset).padEnd(6)} "${m.span}"   …${ctx}…\n`)
      }
    }
    for (const d of list.filter((x) => x.field === 'sourceClass')) {
      const url = String(d.expected).split(' => ')[0]
      const cit = c.answer.citations.find((k) => k.url === url)
      if (cit) out(`    evidence · citation ${cit.position}: ${ev.citations[String(cit.position)] ?? ''}\n`)
    }
    if (ev.notes) out(`    notes: ${ev.notes}\n`)
    for (const r of ev.revisions ?? []) out(`    revised on re-reading: ${r.field} ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)} — ${r.reason}\n`)
  }
}

function main(): void {
  const flags = new Set(process.argv.slice(2))
  const cases = loadGoldenCases()

  if (flags.has('--write-sheet')) {
    if (existsSync(SPOT_CHECK_SHEET) && !flags.has('--force')) {
      const had = parseSpotCheckSheet(readFileSync(SPOT_CHECK_SHEET, 'utf8'))
      if (had.checkedBy || had.entries.some((e) => e.verdict !== 'unanswered' || e.note)) {
        process.stderr.write(`refusing: ${SPOT_CHECK_SHEET} has been started by ${had.checkedBy || 'somebody'}. Replacing it throws their answers away; pass --force if that is what you mean.\n`)
        process.exit(2)
      }
    }
    mkdirSync(dirname(SPOT_CHECK_SHEET), { recursive: true })
    const md = renderSpotCheckSheet(cases)
    writeFileSync(SPOT_CHECK_SHEET, md)
    process.stdout.write(`wrote ${SPOT_CHECK_SHEET} · ${parseSpotCheckSheet(md).entries.length} answers · ${(Buffer.byteLength(md) / 1024).toFixed(0)} KB\n`)
    return
  }

  if (flags.has('--write-disagreements')) {
    // WITHOUT the sheet, as the suite compares it: a person ticking a box must never move this file.
    const report = runGoldenSet(cases)
    const body = { algoVersion: SCORING_ALGO_VERSION, note: 'Every place the scorer and a golden label differ. A FINDING list for the scoring-rule owner: nothing here was resolved by editing a label to match the scorer. golden.test.ts fails when the live report and this file differ.', disagreements: disagreementsOf(report), silentOwned: report.silentOwned }
    writeFileSync(DISAGREEMENTS_FILE, JSON.stringify(body, null, 2) + '\n')
    process.stdout.write(`wrote ${DISAGREEMENTS_FILE} · ${body.disagreements.length} disagreement(s) · ${body.silentOwned.length} silent owned\n`)
    return
  }
  print(cases, currentReport(cases))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
