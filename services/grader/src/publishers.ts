/**
 * `pnpm grader:publishers` — what the corpus cites that no table names, and
 * what the proposed publisher registry WOULD change. ADR-0015.
 *
 *   pnpm grader:publishers                    candidates from every stored cycle, and the dry run
 *   pnpm grader:publishers -- --domain pipedrive.com    (scopes the dry run; candidates always span every cycle)
 *
 * ⚠️ IT PROPOSES AND NEVER WRITES. The registry lives in
 * `packages/taxonomy/src/publishers.ts` and grows by a person editing it, in a
 * commit that bumps the scoring version, because an added domain changes what
 * an existing answer scores. This tool does the two things a person needs
 * before that edit:
 *
 *   1. CANDIDATES. Every registrable domain classified `other` across every
 *      stored cycle, with how many citations, answers, prompts and engines
 *      cited it. The ones clearing the same evidentiary bar competitor
 *      promotion uses (≥ 3 answers, ≥ 2 prompts, ≥ 2 engines) are listed
 *      first; a domain already in the registry, or already refused by name
 *      in `NOT_PUBLISHERS`, is marked so nobody proposes it twice.
 *
 *   2. THE DRY RUN. The reference scan's citations re-counted AS IF the
 *      registry were wired: how many `other` citations would become
 *      `earned_media`, and what the `other` share would be. This is the number
 *      an owner needs to judge the registry honestly — a list built to shrink
 *      the number would show here as a list of sites that are not publishers.
 *
 * Reads disk only. No provider, no model, no network, no write.
 */

import { readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOT_PUBLISHERS, PUBLISHER_REGISTRY } from '@bliprank/taxonomy'
import { readScanAnswers, type ScanAnswers } from './answers.js'
import { listCycles } from './cycles.js'
import { DEFAULT_THRESHOLDS, type PromotionThresholds } from './promote-competitors.js'

export interface HostTally {
  readonly domain: string
  readonly citations: number
  readonly answers: number
  readonly prompts: number
  readonly engines: number
  /** Which scanned subjects' answers cited it. */
  readonly subjects: readonly string[]
  readonly sample: string
}

/** The competitor-promotion bar, the same constant: noise does not clear it, a real source does. */
export type Thresholds = PromotionThresholds

/** Every `other` citation with a host, tallied by registrable domain across the evidence given. */
export function tallyOther(evidence: readonly { readonly subject: string; readonly answers: ScanAnswers }[]): readonly HostTally[] {
  const agg = new Map<string, { citations: number; answers: Set<string>; prompts: Set<string>; engines: Set<string>; subjects: Set<string>; sample: string }>()
  for (const { subject, answers } of evidence) {
    answers.answers.forEach((a, i) => {
      if (a.custom) return // the customer's own prompts are not the corpus a publisher is proposed from
      for (const k of a.citations) {
        if (k.sourceClass !== 'other' || !k.domain) continue
        const h = agg.get(k.domain) ?? { citations: 0, answers: new Set(), prompts: new Set(), engines: new Set(), subjects: new Set(), sample: k.url }
        h.citations += 1
        h.answers.add(`${subject}|${answers.day}|${i}`)
        h.prompts.add(a.prompt)
        h.engines.add(a.engine)
        h.subjects.add(subject)
        agg.set(k.domain, h)
      }
    })
  }
  return [...agg.entries()]
    .map(([domain, h]) => ({ domain, citations: h.citations, answers: h.answers.size, prompts: h.prompts.size, engines: h.engines.size, subjects: [...h.subjects].sort(), sample: h.sample }))
    .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain))
}

export type CandidateStatus = 'candidate' | 'in-registry' | 'refused'

export interface Candidate extends HostTally {
  readonly status: CandidateStatus
  /** The refusal's reason, when `NOT_PUBLISHERS` names it. */
  readonly refusedWhy?: string
}

/** The hosts clearing the bar, each marked against the registry and the standing refusals. */
export function proposeCandidates(
  tally: readonly HostTally[],
  registry: Readonly<Record<string, string>> = PUBLISHER_REGISTRY,
  refused: readonly { readonly domain: string; readonly why: string }[] = NOT_PUBLISHERS,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): readonly Candidate[] {
  const refusedBy = new Map(refused.map((r) => [r.domain, r.why]))
  return tally
    .filter((h) => h.answers >= thresholds.minAnswers && h.prompts >= thresholds.minPrompts && h.engines >= thresholds.minEngines)
    .map((h) => {
      const why = refusedBy.get(h.domain)
      const status: CandidateStatus = registry[h.domain] ? 'in-registry' : why ? 'refused' : 'candidate'
      return { ...h, status, ...(why ? { refusedWhy: why } : {}) }
    })
}

export interface DryRun {
  readonly total: number
  readonly otherBefore: number
  readonly otherAfter: number
  readonly earnedMedia: number
  /** Which registry domains actually matched, with counts. */
  readonly matched: readonly { readonly domain: string; readonly name: string; readonly citations: number }[]
}

/**
 * The reference count AS IF the registry were wired: an `other` citation whose
 * domain the registry names would be `earned_media`. Nothing else moves —
 * identity and platform classes win before the registry is consulted, exactly
 * as in `classifyCitation`.
 */
export function applyRegistry(answers: ScanAnswers, registry: Readonly<Record<string, string>> = PUBLISHER_REGISTRY): DryRun {
  const all = answers.answers.filter((a) => !a.custom).flatMap((a) => a.citations)
  const matchedCounts = new Map<string, number>()
  let otherBefore = 0
  for (const k of all) {
    if (k.sourceClass !== 'other') continue
    otherBefore += 1
    if (k.domain && registry[k.domain]) matchedCounts.set(k.domain, (matchedCounts.get(k.domain) ?? 0) + 1)
  }
  const earnedMedia = [...matchedCounts.values()].reduce((n, c) => n + c, 0)
  return {
    total: all.length,
    otherBefore,
    otherAfter: otherBefore - earnedMedia,
    earnedMedia,
    matched: [...matchedCounts.entries()].map(([domain, citations]) => ({ domain, name: registry[domain]!, citations })).sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain)),
  }
}

const pct = (k: number, n: number) => (n === 0 ? '0%' : `${((k / n) * 100).toFixed(1)}%`)

async function main(): Promise<void> {
  const args = new Map<string, string>()
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(a.slice(2), v)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const dataDir = args.get('data') ?? join(here, '..', 'data-live')
  const only = args.get('domain')

  const results = join(dataDir, 'results')
  const domains = existsSync(results) ? readdirSync(results).filter((f) => f.endsWith('.json') && !f.includes('.audit.')).map((f) => f.slice(0, -5)) : []
  const evidence: { subject: string; answers: ScanAnswers }[] = []
  for (const d of domains) {
    for (const c of listCycles(dataDir, d)) {
      const got = await readScanAnswers(dataDir, d, c.day)
      if ('refuse' in got) {
        process.stdout.write(`  skip ${d} ${c.day}: ${got.refuse}\n`)
        continue
      }
      evidence.push({ subject: d, answers: got })
    }
  }
  const total = evidence.reduce((n, e) => n + e.answers.answers.reduce((m, a) => m + a.citations.length, 0), 0)
  // Provider redirects with no host are `other` too; they cannot be tallied by domain, so they are counted here instead of vanishing.
  const hostless = evidence.reduce((n, e) => n + e.answers.answers.reduce((m, a) => m + a.citations.filter((k) => k.sourceClass === 'other' && !k.domain).length, 0), 0)
  const tally = tallyOther(evidence)
  const other = tally.reduce((n, h) => n + h.citations, 0)
  process.stdout.write(
    `publishers · ${evidence.length} stored cycle(s) · ${total} citations · ${other} classed other with a host · ${tally.length} distinct hosts · ${hostless} other with no host (provider redirects, not tallied)\n` +
      `  registry holds ${Object.keys(PUBLISHER_REGISTRY).length} publishers, ${NOT_PUBLISHERS.length} named refusals. Nothing here writes.\n`,
  )

  const cands = proposeCandidates(tally)
  process.stdout.write(`\nCLEARING THE BAR (≥ ${DEFAULT_THRESHOLDS.minAnswers} answers, ≥ ${DEFAULT_THRESHOLDS.minPrompts} prompts, ≥ ${DEFAULT_THRESHOLDS.minEngines} engines): ${cands.length}\n`)
  for (const c of cands) {
    process.stdout.write(
      `  ${c.status.padEnd(12)} ${c.domain.padEnd(26)} ${String(c.citations).padStart(3)} cit  ${String(c.answers).padStart(3)} ans  ${String(c.prompts).padStart(2)} pr  ${c.engines} eng  ${c.subjects.join('+')}` +
        (c.refusedWhy ? `\n               refused: ${c.refusedWhy}` : '') +
        `\n               ${c.sample.slice(0, 90)}\n`,
    )
  }
  process.stdout.write(`\n  A "candidate" is for a PERSON to judge against the four criteria in packages/taxonomy/src/publishers.ts. Nothing is added by this tool.\n`)

  process.stdout.write(`\nDRY RUN — as if the registry were wired (it is not):\n`)
  for (const e of evidence) {
    if (only && e.subject !== only) continue
    const r = applyRegistry(e.answers)
    process.stdout.write(
      `  ${e.subject.padEnd(20)} ${e.answers.day}  ${r.total} citations · other ${r.otherBefore} (${pct(r.otherBefore, r.total)}) → ${r.otherAfter} (${pct(r.otherAfter, r.total)}) · earned media +${r.earnedMedia}` +
        (r.matched.length ? `\n${r.matched.map((m) => `      ${m.domain.padEnd(24)} ${m.name.padEnd(28)} ${m.citations}`).join('\n')}` : '') +
        '\n',
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
