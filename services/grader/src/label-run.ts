/**
 * `pnpm grader:label` — the runner around `label.ts`.
 *
 * ⚠️ SPENDS NO PROVIDER QUOTA AND CALLS NO MODEL. Building a worklist makes one
 * bounded homepage GET per domain, through the same SSRF boundary the Grader
 * uses (`fetch-site.ts`), and nothing else leaves the machine. Rung 4 authoring
 * is off, so no bank is written and no model is called. `--import` and `--score`
 * read files only. There is no flag that makes any of this collect.
 *
 * ⚠️ AND IT WRITES NOTHING INTO `data-live`. The classifier's record store is
 * write-once by design, so classifying a hundred domains against the real data
 * directory would freeze a hundred unreviewed decisions. Every run gets a fresh
 * scratch directory and deletes it afterwards; `--keep-scratch` leaves it for
 * inspection.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CATEGORY_SLUGS,
  CORRECTION_CHOICES,
  G3_SAMPLE_SIZE,
  G3_TARGET,
  importLabels,
  propose,
  readDomainList,
  scoreLabels,
  toCsv,
  type WorklistRow,
} from './label.js'
import { reviewPage } from './label-page.js'

/** Domains fetched at once. Four is polite to remote hosts and turns ten minutes into three. */
const CONCURRENCY = 4

function args(argv: readonly string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    m.set(a.slice(2), argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true')
  }
  return m
}

async function build(a: Map<string, string>): Promise<void> {
  const listFile = a.get('domains')!
  const outDir = a.get('out') ?? 'labelling'
  if (!existsSync(listFile)) {
    process.stderr.write(`refusing: no domain list at ${listFile}\n`)
    process.exit(2)
  }
  const domains = readDomainList(readFileSync(listFile, 'utf8'))
  if (domains.length === 0) {
    process.stderr.write('refusing: the domain list is empty\n')
    process.exit(2)
  }

  const scratch = mkdtempSync(join(tmpdir(), 'grader-label-'))
  process.stdout.write(
    `label · ${domains.length} domains · one bounded homepage GET each\n` +
      `  no provider quota, no model call, nothing written to data-live\n` +
      `  category records go to a scratch dir (${scratch}) and are deleted\n` +
      (domains.length < G3_SAMPLE_SIZE ? `  ⚠️ G3 asks for ${G3_SAMPLE_SIZE}; this list has ${domains.length}, so the gate will read NOT MET on size alone\n` : '') +
      '\n',
  )

  const rows: WorklistRow[] = new Array(domains.length)
  let done = 0
  const worker = async (start: number): Promise<void> => {
    for (let i = start; i < domains.length; i += CONCURRENCY) {
      const domain = domains[i]!
      try {
        const p = await propose(domain, scratch)
        rows[i] = { domain, ...p, verdict: '?', correct: '', notes: '' }
      } catch (e) {
        // A domain that will not resolve is still a row: the labeller decides
        // what an unreachable homepage means, and a silently dropped domain
        // shrinks the sample without saying so.
        rows[i] = { domain, title: '', description: '', fetched: false, proposed: '', signal: 'unreachable', evidence: (e as Error).message.slice(0, 160), verdict: '?', correct: '', notes: '' }
      }
      done += 1
      if (done % 10 === 0 || done === domains.length) process.stdout.write(`  ${done}/${domains.length}\n`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, domains.length) }, (_, k) => worker(k)))

  if (a.has('keep-scratch')) process.stdout.write(`  scratch kept at ${scratch}\n`)
  else rmSync(scratch, { recursive: true, force: true })

  mkdirSync(outDir, { recursive: true })
  const csv = join(outDir, 'worklist.csv')
  const html = join(outDir, 'review.html')
  writeFileSync(csv, toCsv(rows))
  writeFileSync(html, reviewPage(rows, CORRECTION_CHOICES))

  const bySignal = new Map<string, number>()
  for (const r of rows) bySignal.set(r.signal, (bySignal.get(r.signal) ?? 0) + 1)
  process.stdout.write(
    `\nwrote ${csv}\n      ${html}\n\nWHAT THE CLASSIFIER PROPOSED (its answer, not a label):\n` +
      [...bySignal.entries()].sort((x, y) => y[1] - x[1]).map(([s, n]) => `  ${s.padEnd(16)} ${String(n).padStart(4)}\n`).join('') +
      `\nNEXT: open ${html} in a browser, or edit ${csv} in a spreadsheet. Both\n` +
      `produce the same nine columns. Set every "verdict" to ok / wrong / unsure,\n` +
      `and for wrong name the category that IS right (or "none").\n` +
      `Then: pnpm grader:label -- --import ${csv} --out ${join(outDir, 'labelled.json')} --sample "<where these domains came from>"\n`,
  )
}

function doImport(a: Map<string, string>): void {
  const file = a.get('import')!
  const out = a.get('out') ?? join(dirname(file), 'labelled.json')
  const sample = a.get('sample') ?? ''
  if (!sample || sample === 'true') {
    process.stderr.write(
      'refusing: pass --sample "<where these domains came from>".\n' +
        '  A B2B SaaS list flatters this classifier; a global top-sites list depresses it;\n' +
        '  a customer list measures the population that matters and is not random. The rate\n' +
        '  is only interpretable beside the sample, so it is recorded with it.\n',
    )
    process.exit(2)
  }
  const got = importLabels(readFileSync(file, 'utf8'), sample)
  if ('refuse' in got) {
    process.stderr.write(`refusing: ${got.refuse.length} problem(s), nothing written.\n`)
    for (const p of got.refuse.slice(0, 40)) process.stderr.write(`  ${p}\n`)
    if (got.refuse.length > 40) process.stderr.write(`  ... and ${got.refuse.length - 40} more\n`)
    process.exit(2)
  }
  writeFileSync(out, JSON.stringify(got, null, 2) + '\n')
  process.stdout.write(`imported ${got.cases.length} labelled case(s) -> ${out}\n  sample: ${got.sample}\n`)
  report(scoreLabels(got))
}

function report(s: ReturnType<typeof scoreLabels>): void {
  const pct = (r: number) => `${(r * 100).toFixed(1)}%`
  process.stdout.write(
    `\nG3 · classifier agreement with human labels\n` +
      `  ${s.correct} of ${s.judged} judged = ${pct(s.rate)}   (target ${pct(G3_TARGET)} over ${G3_SAMPLE_SIZE} domains)\n` +
      (s.unsure ? `  ${s.unsure} marked unsure, excluded from the denominator rather than guessed\n` : '') +
      `  ${s.meetsGate ? '✅ MEETS the criterion' : `❌ NOT MET${s.judged < G3_SAMPLE_SIZE ? ` — ${s.judged} judged, the criterion is a proportion of ${G3_SAMPLE_SIZE}` : ''}`}\n` +
      `\nBY SIGNAL — which rung decided, and how often it was right:\n` +
      s.bySignal.map((b) => `  ${b.signal.padEnd(16)} ${String(b.correct).padStart(4)}/${String(b.judged).padEnd(4)} ${pct(b.judged ? b.correct / b.judged : 0).padStart(7)}\n`).join(''),
  )
  if (s.wrong.length) {
    process.stdout.write(`\nDISAGREEMENTS (${s.wrong.length}) — each one is evidence about a threshold:\n`)
    for (const w of s.wrong) process.stdout.write(`  ${w.domain.padEnd(28)} proposed ${w.proposed || '(none)'} via ${w.signal} · correct ${w.correct}${w.notes ? ` · ${w.notes}` : ''}\n`)
    process.stdout.write(
      `\n⚠️ These are the input to ADR-0009's open thresholds (MIN_SCORE, MIN_DISTINCT,\n` +
        `   MIN_MARGIN, MIN_SELF_DESCRIPTION_HITS). Changing them is a human's decision\n` +
        `   and changes what every future scan measures; nothing here touches them.\n`,
    )
  }
}

function main(): void {
  const a = args(process.argv.slice(2))
  if (a.has('domains')) return void build(a)
  if (a.has('import')) return doImport(a)
  if (a.has('score')) {
    const f = a.get('score')!
    if (!existsSync(f)) {
      process.stderr.write(`refusing: no labelled set at ${f}\n`)
      process.exit(2)
    }
    const set = JSON.parse(readFileSync(f, 'utf8')) as Parameters<typeof scoreLabels>[0]
    process.stdout.write(`labelled set · ${set.cases.length} case(s) · sample: ${set.sample || '(not recorded)'}\n`)
    return report(scoreLabels(set))
  }
  process.stderr.write(
    'usage:\n' +
      '  --domains <file> [--out <dir>] [--keep-scratch]   build the worklist (one GET per domain)\n' +
      '  --import <worklist.csv> --sample "<source>" [--out <file>]\n' +
      '  --score <labelled.json>\n' +
      `\ncategories a correction may name: ${CORRECTION_CHOICES.join(', ')}\n` +
      `(${CATEGORY_SLUGS.length} tracked categories, plus "none" for a domain no category fits)\n`,
  )
  process.exit(2)
}

// The same entry guard `version-diff.ts` uses: resolved paths, one comparison,
// no ternary whose precedence a reader has to work out.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
