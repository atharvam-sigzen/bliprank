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
import { r2KeyFor } from '@bliprank/collector'
import { ENGINES, type EngineId } from '@bliprank/contracts'
import { FileBlobStore } from './local-store.js'
import { allBanks, readCategoryRecord } from './resolve-category.js'
import { latestCycle, readCycle } from './cycles.js'
import { basisOf, cellsFor } from './scan.js'

/** One collected answer, as a reader sees it. */
export interface StoredAnswer {
  readonly prompt: string
  readonly engine: string
  /** Verbatim, whole, exactly as the engine returned it. Never excerpted. */
  readonly text: string
  /** The engine returned no answer text. NOT the same as "did not mention you". */
  readonly empty: boolean
  readonly collectedAt: string
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
  readonly answers: readonly StoredAnswer[]
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
export async function readScanAnswers(dataDir: string, domain: string, cycleDay?: string): Promise<ScanAnswers | { readonly refuse: string }> {
  // One cycle's evidence, by day (ADR-0013). The latest when no day is asked
  // for, which is what every reader before cycles existed was reading.
  const cycle = cycleDay ? readCycle(dataDir, domain, cycleDay) : latestCycle(dataDir, domain)
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
  const slug = typeof stored.category === 'string' && stored.category ? stored.category : readCategoryRecord(dataDir, domain)?.slug
  if (!slug) return { refuse: `${domain}: neither the stored result nor a category record names the category it was measured against` }
  const bank = allBanks(dataDir).find((b) => b.category === slug)
  if (!bank) return { refuse: `${domain}: no bank for category ${slug}` }

  const basis = basisOf(stored.comparisonBasis ?? '')
  const cells = cellsFor(bank, basis.engines ?? ([...ENGINES] as EngineId[]), day, basis.maxPrompts)

  const blob = new FileBlobStore(join(dataDir, 'answers'))
  const answers: StoredAnswer[] = []
  for (const c of cells) {
    // Path-qualified exactly as the collector wrote it. An unqualified key would
    // miss every object and report a scan with no evidence at all.
    const body = await blob.get(r2KeyFor(c.cell, `openwebninja:${c.engine}`))
    if (!body) continue
    try {
      const parsed = JSON.parse(body) as { runs?: { text?: unknown; collectedAt?: unknown }[] }
      for (const run of parsed.runs ?? []) {
        if (typeof run.text !== 'string') continue
        answers.push({
          prompt: c.prompt,
          engine: c.engine,
          text: run.text,
          empty: run.text.trim() === '',
          collectedAt: typeof run.collectedAt === 'string' ? run.collectedAt : '',
        })
      }
    } catch {
      // A corrupt object costs one answer's evidence, not the report. The
      // surface counts what it received against what the rows expect and says
      // so, rather than silently showing a shorter list.
    }
  }

  return { domain, category: slug, day, comparisonBasis: stored.comparisonBasis ?? '', answers }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The runner: emit one scan's evidence as a file the public app can ship.
 *
 *   pnpm grader:answers -- --domain pipedrive.com --out apps/public/lib/scan-answers.json
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
