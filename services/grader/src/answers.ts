/**
 * THE EVIDENCE BEHIND EVERY NUMBER — the answers themselves, read back out of
 * the store in the order they were scored.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * `promptRows` made the derivation inspectable: which question, which engine,
 * mentioned or not, at what position. That is still a DERIVED statistic, and a
 * reader is being asked to trust the instrument that produced it. This module
 * hands over the input instead — the answer text, verbatim, exactly as the
 * engine wrote it — so a brand owner can read the thing the number is about
 * rather than take our word for what it says.
 *
 * ⚠️ IT IS ALSO HOW THE INSTRUMENT GETS CAUGHT BEING WRONG, and that is a
 * feature rather than a risk. The worst defect this scorer can produce is a
 * false zero: `thecosmicbyte.com` was published as mentioned in 0 of 50 answers
 * while the engines wrote "Cosmic Byte" 139 times across 31 of them. Nothing on
 * the sheet could have revealed that. An answer a reader can open and search
 * would have revealed it immediately, to the person best placed to notice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ VERBATIM, WHOLE, AND UNRANKED.
 *
 * No excerpting, no summarising, no "relevant portion". An excerpt is us
 * choosing which part of the evidence the reader sees, which is the one thing
 * evidence may not be subjected to — and the answers that do NOT mention the
 * brand are exactly as load-bearing as the ones that do, because they are the
 * denominator.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ AN EMPTY ANSWER IS NOT A SILENT ONE.
 *
 * Five stored answers hold `status: OK` and no text at all, every one of them
 * from `google-ai-overviews` — Google showed no AI Overview for that query. Two
 * of them are inside pipedrive.com's published sample, where they are counted as
 * answers in which the brand was not mentioned: 38/85 = 44.71%, against 38/83 =
 * 45.78% if they were excluded.
 *
 * Whether an absent overview belongs in the denominator is a SCORING RULE and
 * therefore human-owned (CLAUDE.md §4); nothing here changes it. What this
 * module does is refuse to let it hide: an empty answer is carried with
 * `empty: true` so the surface can say "no answer was shown" instead of
 * rendering a blank box that reads as "the engine answered and said nothing
 * about you". Those are different facts and only one of them is true.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnswerIndex, r2KeyFor } from '@bliprank/collector'
import { ENGINES, customBasisMismatch, headlineSetOf, type EngineId } from '@bliprank/contracts'
import { PUBLISHER_REGISTRY } from '@bliprank/taxonomy'
import { answerStores } from './answer-stores.js'
import { allBanks } from './resolve-category.js'
import { SCORING_ALGO_VERSION, scoreAnswer, type ScoreRow } from '@bliprank/scorer'
import type { Citation } from '@bliprank/contracts'
import { competitorsIn } from './competitor-overrides.js'
import { categoryRecordIn, customPromptsAtIn } from './store/documents.js'
import { defaultWorkspaceStore } from './store/file-store.js'
import type { WorkspaceStore } from './store/pg-store.js'
import { basisOf, cellsFor, customCellsFor, subjectFor } from './scan.js'

/**
 * One source an answer cited, with the class the scorer assigned it.
 *
 * The class is `classifyCitation`'s (ADR-0005), computed here at READ time by
 * the same `scoreAnswer` the scan ran, over the same stored URL, with the same
 * subject and competitor domains — so it is the class the scan's own rows
 * carry, re-derived rather than copied. `algoVersion` on the file says which
 * rule set did it. ADR-0014.
 */
export interface StoredCitation {
  readonly url: string
  /** 0-based index in the engine's own citation list. */
  readonly position: number
  readonly sourceClass: string
  /** The registrable domain the class was decided on. */
  readonly domain: string
}

/** One collected answer, as a reader sees it. */
export interface StoredAnswer {
  readonly prompt: string
  readonly engine: string
  /** Verbatim, whole, exactly as the engine returned it. Never excerpted. */
  readonly text: string
  /** The engine returned no answer text. NOT the same as "did not mention you". */
  readonly empty: boolean
  readonly collectedAt: string
  /** Every source the engine cited for this answer, in its own order. Empty when it cited none. */
  readonly citations: readonly StoredCitation[]
  /** True for an answer to one of the customer's own prompts (ADR-0016): evidence for the second block, never for the headline. */
  readonly custom?: true
}

/**
 * The evidence file for one scan.
 *
 * `day` and `comparisonBasis` are carried so a surface can verify these answers
 * belong to the result it is displaying. Showing a reader the right text under
 * the wrong number would be worse than showing no text.
 */
export interface ScanAnswers {
  readonly domain: string
  readonly category: string
  readonly day: string
  readonly comparisonBasis: string
  /** The scoring rule set that classified the citations. */
  readonly algoVersion: string
  readonly answers: readonly StoredAnswer[]
}

/** One stored run with the full row the scorer gives it. What `version-diff` snapshots. */
export interface ScoredRun {
  readonly prompt: string
  readonly engine: EngineId
  readonly text: string
  readonly collectedAt: string
  readonly row: ScoreRow
  /** An answer to one of the customer's own prompts. */
  readonly custom?: true
}

export interface ScoredCycle {
  readonly domain: string
  readonly category: string
  readonly day: string
  readonly comparisonBasis: string
  readonly runs: readonly ScoredRun[]
}

/**
 * Score one stored cycle's answers again, from the blobs, with the subject and
 * competitor specs the scan used. The evidence reader below and the version
 * diff both start here, so they cannot disagree about what a stored answer is.
 * In `cellsFor` order. Reads only: no provider call, no model call, no path
 * here can collect.
 */

/** `fn` over `items`, at most `limit` in flight, results in the items' order. */
async function inBatches<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  return out
}

export async function scoreStoredCycle(dataDir: string, domain: string, cycleDay?: string, store: WorkspaceStore = defaultWorkspaceStore(dataDir)): Promise<ScoredCycle | { readonly refuse: string }> {
  // One cycle's evidence, by day (ADR-0013). The latest when no day is asked
  // for, which is what every reader before cycles existed was reading. The
  // store is the deployment's (Postgres, this workspace) or this machine's
  // files; the raw answers come from the answer store either way (R4).
  const cycle = cycleDay ? await store.cycles.read(domain, cycleDay) : await store.cycles.latest(domain)
  if (!cycle) return { refuse: cycleDay ? `no stored cycle of ${domain} for ${cycleDay}` : `no stored result for ${domain}` }
  const stored = cycle.result as { run?: { day?: string }; collectedAt?: string; comparisonBasis?: string; category?: string }

  const day = stored.run?.day ?? (stored.collectedAt ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { refuse: `${domain}: no collection day on the stored result` }

  // THE CYCLE'S OWN CATEGORY, and the file's own scope. A record deliberately
  // moved since this cycle ran (sigzen.com: general-business-software, then
  // erp-software) names a different bank, and cells built from it would fetch
  // the answers to a different measurement than the one on screen — or none,
  // with the client's basis check still passing because the basis string is
  // copied from the file. Found by the ADR-0013 review. The record is consulted
  // only for a file too old to name its category.
  const record = await categoryRecordIn(store, domain)
  const slug = typeof stored.category === 'string' && stored.category ? stored.category : record?.slug
  if (!slug) return { refuse: `${domain}: neither the stored result nor a category record names the category it was measured against` }
  const bank = allBanks(dataDir).find((b) => b.category === slug)
  if (!bank) return { refuse: `${domain}: no bank for category ${slug}` }

  const basis = basisOf(stored.comparisonBasis ?? '')
  const engines = basis.engines ?? ([...ENGINES] as EngineId[])
  // The custom prompts this cycle asked are in its own block, verbatim; their
  // answers are evidence for that block and are marked so the reader keeps
  // them apart from the headline's sample.
  const customPrompts = (stored as { customPrompts?: { prompts?: unknown } }).customPrompts?.prompts
  // A HEADLINE measured over the person's own set (ADR-0016 Amendment 1: the
  // headline basis reads `unprompted=0|…|custom=K@V`). Its evidence is the
  // answers to THAT set at THAT version, and they are the headline's own
  // sample, so they are not marked `custom` (the mark keeps decision 4's
  // second block apart from a headline; here there is no second block).
  // `basisOf` yields no prompt count for `unprompted=0`, and `cellsFor` with
  // none would build the WHOLE bank: the wrong evidence under the right
  // number. A version the store no longer holds is a refusal, never today's.
  // The ONE predicate for a headline set, shared with the re-score and the record's label (`headlineSetOf`, C3r item 6).
  const headlineSet = headlineSetOf(stored.comparisonBasis)
  let cells: { readonly cell: ReturnType<typeof cellsFor>[number]['cell']; readonly prompt: string; readonly engine: EngineId; readonly custom: boolean }[]
  if (headlineSet) {
    const set = await customPromptsAtIn(store, domain, headlineSet.version)
    if (!set) return { refuse: `${domain}: this cycle was measured over prompt set ${headlineSet.version}, which the store no longer holds` }
    // THE SAME CHECK THE RE-SCORE MAKES (stats review of C3r, MINOR 9). The version is a pointer into a store a person can edit, and a
    // set is now read with repeats dropped: a store whose version N is no longer the list this cycle asked would yield evidence over
    // a NARROWER or different sample than the headline beside it, with no word said. Refused, as the re-score refuses it.
    const mismatch = customBasisMismatch(headlineSet, set.prompts)
    if (mismatch) return { refuse: `${domain}: the store's prompt set ${headlineSet.version} is no longer the list this cycle asked (${mismatch === 'count' ? `it asked ${headlineSet.count} prompts and the set now holds ${set.prompts.length}` : 'its fingerprint differs'}), so its evidence cannot be shown as that cycle's` }
    cells = customCellsFor(bank, engines, day, set.prompts).map((c) => ({ ...c, custom: false }))
  } else {
    cells = [
      ...cellsFor(bank, engines, day, basis.maxPrompts).map((c) => ({ ...c, custom: false })),
      ...(Array.isArray(customPrompts) ? customCellsFor(bank, engines, day, customPrompts.filter((p): p is string => typeof p === 'string')).map((c) => ({ ...c, custom: true })) : []),
    ]
  }

  // The same subject and competitor specs the scan scored with, derived the
  // same way, so a citation's class here is the class the scan's rows carry.
  const { spec: subject } = subjectFor(domain, bank, record?.brandName)
  // The competitor set THIS cycle was measured against: the category's, or
  // the per-domain override at the version its basis records (ADR-0016). An
  // override the store no longer holds is a refusal, never today's set.
  const cs = await competitorsIn(store, dataDir, domain, bank, subject.id, basis.set ?? null)
  if (!cs) return { refuse: `${domain}: this cycle was measured against competitor set ${basis.set}, which the store no longer holds` }
  if (cs.missing.length) return { refuse: `${domain}: this cycle's competitor set included ${cs.missing.join(', ')}, which this build no longer holds` }
  const competitors = cs.competitors.filter((b) => b.id !== subject.id)

  // R2 + Upstash when the deployment is configured for them, this machine's
  // disk otherwise; one decision for both halves (answer-stores.ts).
  const stores = answerStores(dataDir)
  const blob = stores.blob
  // The index says where each cell's object is, qualified by whichever adapter
  // fetched it (ADR-0003 Amendment 1): the provider on a live run, the fixture
  // adapter on an offline one. Guessing the provider's key would read a
  // fixture cycle as a scan with no evidence at all. A cell the index does not
  // hold falls back to the provider-qualified key, which is how every cycle
  // collected before the index was consulted here was written.
  const index = new AnswerIndex(stores.kv)
  const { hits } = await index.lookup(cells.map((c) => c.cell))
  // One object per cell, read a few at a time: up to 160 cells (17 curated +
  // 15 custom prompts across five engines) would be 160 sequential round trips
  // against a network store on a request path (2026-09-10 cost review). The
  // bound keeps it a burst of eight, not a fan-out, and the order is kept.
  const bodies = await inBatches(cells, 8, (c) => blob.get(hits.get(c.cell.key)?.r2Key ?? r2KeyFor(c.cell, `openwebninja:${c.engine}`)))
  const runs: ScoredRun[] = []
  for (const [i, c] of cells.entries()) {
    const body = bodies[i]
    if (!body) continue
    try {
      const parsed = JSON.parse(body) as { runs?: { text?: unknown; collectedAt?: unknown; citations?: unknown }[] }
      for (const run of parsed.runs ?? []) {
        if (typeof run.text !== 'string') continue
        // The stored citation list, shape-checked: a URL string, and its index
        // in the engine's list when the provider gave one.
        const cited: Citation[] = Array.isArray(run.citations)
          ? run.citations.flatMap((x, i) => {
              const u = (x as { url?: unknown; position?: unknown }) ?? {}
              return typeof u.url === 'string' && u.url ? [{ url: u.url, position: typeof u.position === 'number' ? u.position : i }] : []
            })
          : []
        const row = scoreAnswer({
          answer: { text: run.text, citations: cited },
          brand: subject,
          competitors,
          // ADR-0015 / det-3: the approved 52-entry publisher registry. It sits
          // at step 3 of `classifyCitation`, AFTER owned, competitor, community,
          // review and reference, so it can only move a citation from `other` to
          // `earned_media` and can never override a more specific class.
          publishers: PUBLISHER_REGISTRY,
        })
        runs.push({ prompt: c.prompt, engine: c.engine, text: run.text, collectedAt: typeof run.collectedAt === 'string' ? run.collectedAt : '', row, ...(c.custom ? { custom: true as const } : {}) })
      }
    } catch {
      // A corrupt object costs one answer's evidence, not the report. The
      // surface counts what it received against what the rows expect and says
      // so, rather than silently showing a shorter list.
    }
  }

  return { domain, category: slug, day, comparisonBasis: stored.comparisonBasis ?? '', runs }
}

/**
 * Read a stored result's answers back out of the blob store.
 *
 * ⚠️ IN `cellsFor` ORDER, WHICH IS `promptRows` ORDER. `runScan` iterates cells
 * and appends each cell's runs, so an answer's index here is the index of the
 * row that describes it. The surface still matches on prompt AND engine rather
 * than on position — an index that quietly drifts is the failure that would put
 * one prompt's answer under another prompt's heading — but the order is what
 * makes that match cheap and total.
 *
 * Reads only. No provider call, no model call, and no path here can collect.
 */
export async function readScanAnswers(dataDir: string, domain: string, cycleDay?: string, store?: WorkspaceStore): Promise<ScanAnswers | { readonly refuse: string }> {
  const got = await scoreStoredCycle(dataDir, domain, cycleDay, store)
  if ('refuse' in got) return got
  return {
    domain: got.domain,
    category: got.category,
    day: got.day,
    comparisonBasis: got.comparisonBasis,
    algoVersion: SCORING_ALGO_VERSION,
    answers: got.runs.map((r) => ({
      prompt: r.prompt,
      engine: r.engine,
      text: r.text,
      empty: r.text.trim() === '',
      collectedAt: r.collectedAt,
      citations: r.row.citations.map((k) => ({ url: k.url, position: k.position, sourceClass: k.sourceClass, domain: k.domain })),
      ...(r.custom ? { custom: true as const } : {}),
    })),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The runner: emit one scan's evidence as a file the public app can ship.
 *
 *   pnpm grader:answers -- --domain pipedrive.com --out apps/public/public/scan-answers.json
 *
 * Reads disk only. Nothing here spends.
 */

async function main(): Promise<void> {
  const args = new Map<string, string>()
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(a.slice(2), v)
  }
  const domain = args.get('domain')
  if (!domain) {
    process.stderr.write('refusing: no --domain given\n')
    process.exit(2)
  }
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const dataDir = args.get('data') ?? join(here, '..', 'data-live')
  const got = await readScanAnswers(dataDir, domain)
  if ('refuse' in got) {
    process.stderr.write(`refusing: ${got.refuse}\n`)
    process.exit(2)
  }
  const empty = got.answers.filter((a) => a.empty).length
  const chars = got.answers.reduce((n, a) => n + a.text.length, 0)
  process.stdout.write(
    `answers · ${got.domain} · ${got.category} · day ${got.day}\n` +
      `  ${got.answers.length} answers · ${chars.toLocaleString()} characters` +
      `${empty > 0 ? ` · ${empty} with NO answer text (an absent overview, not a silent one)` : ''}\n`,
  )
  const out = args.get('out')
  if (!out) {
    process.stdout.write('  no --out given, so nothing was written.\n')
    return
  }
  writeFileSync(out, JSON.stringify(got, null, 2) + '\n')
  process.stdout.write(`  wrote ${out}\n`)
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('answers.ts')) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
