/**
 * `pnpm scorer:golden-worklist` — the golden set's labelling worklist, built
 * from a data directory's stored cycles. MVP_PLAN E4.
 *
 *   --data <dir> --out <dir> [--target 300] [--seed <s>]
 *        read every stored cycle under <dir>, select up to the target stratified
 *        by engine x category (golden-worklist.ts), and write one UNLABELLED
 *        case file per answer plus `manifest.json` into <out>
 *   --apply <labels.json> --from <worklist dir> [--to <answers dir>]
 *        attach a labeller's proposed labels to their worklist cases, validate
 *        each with the harness's own validator, and write the ones that pass
 *        into the golden set as `agent-proposed`, `verifiedBy: null`
 *
 * READS ONLY. It opens the data directory's result files, its category records,
 * its banks and its answer objects, and writes nowhere but <out> (or the golden
 * set, on --apply). It refuses a directory that is not a grader data directory
 * rather than let a store constructor create one. No provider, no model, no
 * network: the answer store is opened as FILES, never through the R2/Upstash
 * chooser, whatever the environment holds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ IT NEVER CALLS THE SCORER, and that is the point of the row. The evidence
 * reader (`services/grader/src/answers.ts`) derives the same cells and the same
 * specs and then scores each answer; this derives them and stops. The label a
 * case gets later is what a reader says is in the text, made without the
 * scorer's opinion anywhere in reach.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE REACHES INTO services/grader. "The specs the scan used" are the
 * grader's derivation: the bank, `subjectFor`, the competitor set at the
 * version the cycle's basis records. A second copy here would drift, and a case
 * built from drifted specs measures a scorer nobody runs. The imports are by
 * path because the grader depends on this package, not the reverse; nothing in
 * `index.ts` exports this file, so the package graph has no cycle. Its natural
 * home is beside `version-diff.ts`; row E4's limits put it here.
 *
 * THE PUBLISHER REGISTRY IS READ AS DATA, from `golden/publisher-registry.json`.
 * The grader guards the registry constant: only the scan and the evidence
 * reader may read it, because a third reader is a third opinion about which
 * sites are publishers (`publisher-wiring.test.ts`). This tool scores nothing,
 * but it is not going to be the file that teaches that guard an exception. So
 * it copies a snapshot, and `golden-worklist.test.ts` holds the snapshot equal
 * to the registry entry for entry and to the current scoring version: a copy
 * that cannot drift is not an opinion.
 *
 * What is NOT carried over from the evidence reader: a customer's own prompts
 * (ADR-0016). A cycle whose headline is a custom set is skipped and named; a
 * cycle's second, custom block is left out. The golden set measures the
 * scorer, and the curated bank's answers are the sample every domain shares.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBasis, type Citation } from '@bliprank/contracts'
import { AnswerIndex, r2KeyFor } from '../../collector/src/cache-index.js'
import { competitorsFor } from '../../grader/src/competitor-overrides.js'
import { listCycles, storedResults } from '../../grader/src/cycles.js'
import { FileBlobStore, FileKV } from '../../grader/src/local-store.js'
import { allBanks, readCategoryRecord } from '../../grader/src/resolve-category.js'
import { basisOf, cellsFor, subjectFor } from '../../grader/src/scan.js'
import { GOLDEN_SET_TARGET, validateGoldenCase, type GoldenCase, type LabelEvidence } from './golden.js'
import { WORKLIST_SEED, assignIds, caseKey, selectWorklist, toWorklistCase, type CorpusAnswer, type WorklistCase } from './golden-worklist.js'

const ENGINES = ['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews'] as const

const here = dirname(fileURLToPath(import.meta.url))
const GOLDEN_ANSWERS = join(here, '..', 'golden', 'answers')
export const REGISTRY_SNAPSHOT = join(here, '..', 'golden', 'publisher-registry.json')

/** The scan's publisher registry, from the snapshot the suite holds equal to it. */
export function scanPublishers(file: string = REGISTRY_SNAPSHOT): Readonly<Record<string, string>> {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { publishers?: Record<string, string> }
  if (!parsed.publishers || Object.keys(parsed.publishers).length === 0) throw new Error(`${file} holds no publishers: a case built without the registry would not be scored the way its cycle was`)
  return parsed.publishers
}

export interface CorpusRead {
  readonly answers: readonly CorpusAnswer[]
  /** Cycles and cells that produced no answer, each with its reason. Never silent. */
  readonly skipped: readonly string[]
  readonly cycles: number
}

/**
 * Every answer of every stored cycle, with the specs that cycle was scored
 * with. The derivation is `scoreStoredCycle`'s, step for step, minus the call
 * to the scorer.
 */
export async function readCorpus(dataDir: string): Promise<CorpusRead> {
  const answersDir = join(dataDir, 'answers')
  const indexFile = join(dataDir, 'index.json')
  if (!existsSync(join(dataDir, 'results')) || !existsSync(answersDir)) throw new Error(`${dataDir} is not a grader data directory: it has no results/ or no answers/`)

  const blob = new FileBlobStore(answersDir)
  // A directory with answers and no index reads through the provider-qualified key, as the evidence reader does.
  const index = existsSync(indexFile) ? new AnswerIndex(new FileKV(indexFile)) : null
  const banks = allBanks(dataDir)
  const publishers = scanPublishers()
  const answers: CorpusAnswer[] = []
  const skipped: string[] = []
  let cycles = 0

  for (const domain of storedResults(dataDir)) {
    for (const cycle of listCycles(dataDir, domain)) {
      // ONLY these four fields are read off a stored result. Its `promptRows` and `brands` are score rows and are not touched.
      const stored = cycle.result as { category?: unknown; comparisonBasis?: unknown }
      const day = cycle.day
      const comparisonBasis = typeof stored.comparisonBasis === 'string' ? stored.comparisonBasis : ''
      const record = readCategoryRecord(dataDir, domain)
      const slug = typeof stored.category === 'string' && stored.category ? stored.category : record?.slug
      const bank = slug ? banks.find((b) => b.category === slug) : undefined
      if (!slug || !bank) {
        skipped.push(`${domain} ${day}: no bank for category ${slug ?? '(none recorded)'}`)
        continue
      }
      const parsed = parseBasis(comparisonBasis)
      if (parsed && parsed.unprompted === 0) {
        skipped.push(`${domain} ${day}: the headline was measured over the customer's own prompt set, which the golden set does not sample`)
        continue
      }
      const basis = basisOf(comparisonBasis)
      const engines = basis.engines ?? [...ENGINES]
      const { spec: brand } = subjectFor(domain, bank, record?.brandName)
      const cs = competitorsFor(dataDir, domain, bank, brand.id, basis.set ?? null)
      if (!cs) {
        skipped.push(`${domain} ${day}: measured against competitor set ${basis.set}, which the store no longer holds`)
        continue
      }
      if (cs.missing.length) {
        skipped.push(`${domain} ${day}: the competitor set included ${cs.missing.join(', ')}, which this build no longer holds`)
        continue
      }
      const competitors = cs.competitors.filter((b) => b.id !== brand.id)
      cycles += 1

      const cells = cellsFor(bank, engines, day, basis.maxPrompts)
      const hits = index ? (await index.lookup(cells.map((c) => c.cell))).hits : new Map<string, { r2Key: string; adapter: string }>()
      for (const c of cells) {
        const hit = hits.get(c.cell.key)
        const adapter = hit?.adapter ?? `openwebninja:${c.engine}`
        const body = await blob.get(hit?.r2Key ?? r2KeyFor(c.cell, adapter))
        if (!body) {
          skipped.push(`${domain} ${day} ${c.engine} "${c.prompt}": no stored object for the cell`)
          continue
        }
        let runs: { text?: unknown; collectedAt?: unknown; citations?: unknown; adapter?: unknown }[]
        try {
          runs = (JSON.parse(body) as { runs?: typeof runs }).runs ?? []
        } catch {
          skipped.push(`${domain} ${day} ${c.engine} "${c.prompt}": the stored object does not parse`)
          continue
        }
        runs.forEach((run, i) => {
          if (typeof run.text !== 'string') return
          // Exactly as stored: title and provider metadata included. Only a citation with no URL string is dropped, as the reader drops it.
          const citations = (Array.isArray(run.citations) ? run.citations : []).flatMap((x, n) => {
            const u = (x ?? {}) as Record<string, unknown>
            return typeof u['url'] === 'string' && u['url'] ? [{ ...u, url: u['url'], position: typeof u['position'] === 'number' ? u['position'] : n } as Citation] : []
          })
          answers.push({
            domain,
            category: slug,
            day,
            engine: c.engine,
            prompt: c.prompt,
            comparisonBasis,
            cell: { key: c.cell.key, adapter: typeof run.adapter === 'string' ? run.adapter : adapter, run: i },
            collectedAt: typeof run.collectedAt === 'string' ? run.collectedAt : '',
            answer: { text: run.text, citations },
            brand,
            competitors,
            publishers,
          })
        })
      }
    }
  }
  return { answers, skipped, cycles }
}

// ── --apply ──────────────────────────────────────────────────────────────────

/** What a labeller hands back for one case. Nothing else of theirs reaches a case file. */
export interface ProposedLabel {
  readonly id: string
  readonly label: GoldenCase['label']
  readonly evidence: LabelEvidence
  /** An edge the labeller saw while reading, in a few words. Appended to `covers`. */
  readonly edge?: string
}

/** A worklist case with a proposed label attached, as it will be written. Key order follows the seed cases. */
export function withLabel(wl: WorklistCase, p: ProposedLabel): GoldenCase {
  const edge = (p.edge ?? '').replace(/\s+/g, ' ').trim()
  return {
    ...wl,
    covers: edge ? `${wl.covers ?? ''} · seen on reading: ${edge}` : (wl.covers ?? ''),
    label: {
      mentioned: p.label.mentioned,
      mentionCount: p.label.mentionCount,
      brandsDetected: p.label.brandsDetected,
      cited: p.label.cited,
      position: p.label.position,
      competitorsMentioned: [...p.label.competitorsMentioned],
      citationClasses: { ...p.label.citationClasses },
    },
    labelledBy: 'agent-proposed',
    verifiedBy: null,
    evidence: p.evidence,
  }
}

function args(argv: readonly string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    m.set(a.slice(2), argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true')
  }
  return m
}

/** The cases already in the set, by the answer they are about, so a re-run keeps their ids. */
function existingCases(dir: string): { id: string; key?: string }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8')) as GoldenCase
      const cell = c.source?.cell
      return { id: c.id, ...(cell && c.source.domain ? { key: caseKey({ domain: c.source.domain, cell }) } : {}) }
    })
}

async function build(a: Map<string, string>): Promise<void> {
  const dataDir = a.get('data')!
  const out = a.get('out')
  if (!out || out === 'true') {
    process.stderr.write('refusing: pass --out <dir>. The worklist is unlabelled and must not be written into the golden set.\n')
    process.exit(2)
  }
  if (resolve(out) === resolve(GOLDEN_ANSWERS)) {
    process.stderr.write('refusing: --out is the golden set itself. An unlabelled case there fails the suite; use --apply to add labelled ones.\n')
    process.exit(2)
  }
  const target = Number(a.get('target') ?? GOLDEN_SET_TARGET)
  const seed = a.get('seed') ?? WORKLIST_SEED

  const corpus = await readCorpus(dataDir)
  const selection = selectWorklist(corpus.answers, { target, seed })
  const ids = assignIds(selection.selected, existingCases(GOLDEN_ANSWERS))

  mkdirSync(out, { recursive: true })
  let bytes = 0
  const cases = selection.selected.map((ans) => toWorklistCase(ans, ids.get(caseKey(ans))!))
  for (const c of cases) {
    const body = JSON.stringify(c, null, 2) + '\n'
    bytes += Buffer.byteLength(body)
    writeFileSync(join(out, `${c.id}.json`), body)
  }
  const manifest = {
    seed: selection.seed,
    target: selection.target,
    cycles: corpus.cycles,
    corpusAnswers: corpus.answers.length,
    selected: cases.length,
    strata: selection.strata,
    excluded: selection.excluded,
    skipped: corpus.skipped,
    ids: cases.map((c) => c.id),
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  process.stdout.write(
    `golden worklist · seed ${selection.seed} · target ${selection.target}\n` +
      `  ${corpus.cycles} stored cycle(s) · ${corpus.answers.length} answers read · ${cases.length} selected · ${selection.excluded.length} left out · ${(bytes / 1024).toFixed(0)} KB\n` +
      (cases.length < target ? `  ⚠️ the corpus holds fewer eligible answers than the target: every one was taken, and the set stays below ${GOLDEN_SET_TARGET}\n` : '') +
      selection.strata.map((s) => `  ${s.stratum.padEnd(48)} ${String(s.selected).padStart(4)} of ${s.available}\n`).join('') +
      selection.excluded.map((e) => `  left out: ${e.domain} ${e.engine} "${e.prompt}": ${e.reason}\n`).join('') +
      corpus.skipped.map((s) => `  skipped: ${s}\n`).join('') +
      `  wrote ${out}\n  NEXT: label each case BY READING IT (golden/README.md), then --apply. Do not run the harness on a case before it is labelled.\n`,
  )
}

function apply(a: Map<string, string>): void {
  const file = a.get('apply')!
  const from = a.get('from')
  const to = a.get('to') ?? GOLDEN_ANSWERS
  if (!from || from === 'true' || !existsSync(from)) {
    process.stderr.write('refusing: pass --from <worklist dir>, the directory --out wrote.\n')
    process.exit(2)
  }
  const proposed = JSON.parse(readFileSync(file, 'utf8')) as ProposedLabel[]
  if (!Array.isArray(proposed)) {
    process.stderr.write(`refusing: ${file} is not an array of proposed labels.\n`)
    process.exit(2)
  }
  let written = 0
  const refused: string[] = []
  for (const p of proposed) {
    const wlFile = join(from, `${p?.id}.json`)
    if (!p?.id || !existsSync(wlFile)) {
      refused.push(`${p?.id ?? '(no id)'}: no worklist case of that id`)
      continue
    }
    const c = withLabel(JSON.parse(readFileSync(wlFile, 'utf8')) as WorklistCase, p)
    const errs = validateGoldenCase(c)
    if (errs.length) {
      refused.push(...errs)
      continue
    }
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, `${c.id}.json`), JSON.stringify(c, null, 2) + '\n')
    written += 1
  }
  process.stdout.write(`golden worklist · applied ${written} of ${proposed.length} proposed label(s) from ${file}\n`)
  for (const r of refused) process.stdout.write(`  refused: ${r}\n`)
  if (refused.length) process.exit(1)
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2))
  if (a.has('apply')) return apply(a)
  if (a.has('data')) return build(a)
  process.stderr.write('usage:\n  --data <grader data dir> --out <worklist dir> [--target 300] [--seed <s>]\n  --apply <labels.json> --from <worklist dir> [--to <answers dir>]\n')
  process.exit(2)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
