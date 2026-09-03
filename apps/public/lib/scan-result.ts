/**
 * The Grader's data source — a real scan, produced by `pnpm grader:scan`.
 *
 * WHY A COMMITTED ARTEFACT AND NOT A FETCH FROM THE PAGE.
 *
 * Rule R3: nothing spends outside a runner with an explicit budget. A form on a
 * public page wired to collection is an unauthenticated, unmetered spend
 * trigger, and P3.6 — Turnstile and the per-IP cap — does not exist yet. The
 * daily ceiling is also global and shared with paid collection, so a burst of
 * free traffic would stop customers' cycles rather than merely cost money.
 *
 * So the scan runs where the cap, the plan and the day are explicit, and this
 * page renders what it produced. The pipeline behind it is the real one:
 * `services/grader` classifies the domain (3.1), selects the prompt bank (3.2),
 * collects through `CollectionOrchestrator`, scores with `services/scorer` and
 * takes every interval from `packages/stats`.
 *
 * `run.mode` says whether the answers came from a provider or from fixtures, and
 * the page states which — a page that cannot tell you where its numbers came
 * from is the thing this product exists to argue against.
 */

import type { Metric } from '@bliprank/stats'
import raw from './scan-result.json'

export interface ScanBrand {
  readonly id: string
  readonly name: string
  readonly isSubject: boolean
  readonly mentions: number
  readonly citations: number
  readonly metric: Metric
}

export interface ScanRun {
  readonly mode: 'live' | 'fixture' | 'stub'
  readonly plan: string
  readonly day: string
  readonly engines: readonly string[]
  /**
   * THIS run's marginal provider spend, in USD.
   *
   * Optional because it is not always knowable. The runner used to stamp the
   * ledger's LIFETIME total for its data dir here, so a 22-call scan recorded
   * $0.7640 - 4.3x its own cost, and rising with every later scan against the
   * same dir. Files written before that fix carry no honest figure and the real
   * one cannot be recovered, so the key is absent on them rather than guessed.
   * `runInfoOf` maps absent to null and no surface prints a cost without one.
   */
  readonly spentUsd?: number
  readonly capUsd: number
  readonly at: string
}

export interface ScanResultFile {
  readonly status: string
  readonly domain: string
  readonly category: string
  readonly categoryName: string
  /** Present only when the scan ran against the fallback bank — see `scan.ts`. */
  readonly fallback?: { readonly reason: 'unclassified' | 'ambiguous'; readonly detail: string; readonly candidates: readonly string[] }
  readonly subjectSource: 'leader' | 'domain-label'
  /**
   * Which rung of the classifier decided the category, and what it matched.
   *
   * `leader-domain` | `domain-token` | `site-content` | `generated` | `fallback` | `correction`.
   * Declared here because "no competitors" has two entirely different causes and
   * a surface may not conflate them: the FALLBACK bank has no leaders because we
   * could not place the business, while a GENERATED category has none because we
   * refuse to name rivals nobody measured (ADR-0009). Saying the first when the
   * second is true tells a categorised customer they were not categorised.
   */
  readonly categorySource?: { readonly signal: string; readonly evidence: string }
  readonly comparisonBasis: string
  readonly algoVersion: string
  readonly counts: {
    readonly cellsRequested: number
    readonly cacheHits: number
    readonly collected: number
    readonly failed: number
    readonly answersScored: number
    readonly providerCalls: number
  }
  readonly collectedAt: string
  readonly brands: readonly ScanBrand[]
  /**
   * One row per scored answer for the SUBJECT — which prompt, which engine,
   * mentioned or not, at what position. Written by `runScan` since 2026-09-02.
   *
   * ⚠️ OPTIONAL, AND THE ABSENCE MEANS ONE THING ONLY: this file predates the
   * field. It does NOT mean the subject went unmentioned. `promptBreakdown`
   * enforces the distinction — it returns null for a file without rows, and
   * every surface renders the absence in words rather than as an empty grid.
   *
   * Typed as `unknown[]` here on purpose. It arrives from a JSON import and from
   * `localStorage`, both of which are trust boundaries, so the shape is checked
   * at runtime in `lib/prompt-breakdown.ts` and nowhere else. A declared row
   * type here would let a caller skip that check while looking correct.
   */
  readonly promptRows?: readonly unknown[]
  /**
   * Present only on a file written by a runner that owned the budget — the CLI
   * envelope and, since this fix, `/api/scan`. Files cached before that carry no
   * run block at all, which is why this is optional and why nothing may read
   * `scan.run.x` directly. Use `runInfoOf`.
   */
  readonly run?: ScanRun
  /**
   * Set when this row was produced by RE-SCORING answers already on disk rather
   * than by collecting new ones.
   *
   * R5 forbids mutating a historical score, and re-scoring forward is what it
   * prescribes instead — bump the version, write a new row. These two fields are
   * what make that visible: `collectedAt` still says when the ANSWERS were
   * bought, and these say when the NUMBER over them was last derived, and from
   * which algorithm. Without them a det-2 row over August answers is
   * indistinguishable from a fresh August scan that never happened.
   *
   * The superseded row is kept beside it as `<domain>.det-N.audit.json`, which
   * nothing serves — the cache reads `<domain>.json` only.
   */
  readonly rescoredAt?: string
  readonly rescoredFrom?: string
}

/**
 * Is a cached result still an answer to the question we would ask today?
 *
 * ⚠️ THE CATEGORY IS PART OF THE QUESTION, SO IT IS PART OF THE CACHE KEY.
 *
 * `/api/scan` keyed its result cache on the domain alone, which is not a cache —
 * it is a promise that a domain has one answer forever. It does not.
 * `resolveCategory` grew a site-content rung and an authoring rung (ADR-0009),
 * so a domain scanned before those existed carries a result measured against a
 * bank nobody would choose for it today. sigzen.com is the specimen: collected
 * under `general-business-software`, recorded since as `erp-software`. The
 * preview showed the ERP prompts, the visitor pressed the button, and the cache
 * handed back a general-business-software measurement — two consecutive screens
 * disagreeing about what the number is OF, which is the one thing this product
 * exists not to do.
 *
 * A mismatch is therefore a MISS, not a stale-but-usable hit. R5 forbids
 * rebasing a historical score, and serving one under a new category's name is
 * that with extra steps. The miss re-scans and overwrites the file, so it
 * self-heals once.
 *
 * Two deliberate falses-to-true:
 *
 *   - NO RECORD (`recordedSlug` null). Nothing to disagree with, so the result
 *     stands. A domain scanned before records existed must not be invalidated
 *     merely for predating the mechanism.
 *   - NO CATEGORY on the file. It cannot be checked, and invalidating what
 *     cannot be checked would re-spend on shape drift alone. Same rule
 *     `runInfoOf` follows for cost: refuse to guess, in the safe direction.
 */
export function measuresCurrentCategory(hit: unknown, recordedSlug: string | null): boolean {
  // Arrays excluded explicitly. `typeof [] === 'object'` and an array has no
  // `.category`, so without this an empty array read as "a result with no
  // category recorded" and was SERVED — the permissive branch above firing on
  // something that is not a result at all. Same discipline as readRecords.
  if (typeof hit !== 'object' || hit === null || Array.isArray(hit)) return false
  const collectedUnder = (hit as { category?: unknown }).category
  if (typeof collectedUnder !== 'string' || !collectedUnder) return true
  return recordedSlug === null || recordedSlug === collectedUnder
}

/**
 * What a surface may say about the run behind a scan, whether or not the file
 * records one.
 *
 * The defect this exists to end: `run` was declared required, 17 call sites
 * read `scan.run.day` through it, and every file `/api/scan` cached had no run
 * block — so a domain scanned through the UI cached a file that crashed the UI
 * that read it. The fix is not a default object. A default object would have
 * printed `cost $0.0000` for a scan that spent real money, and a numeric slot
 * reads as a small measurement rather than as an absence.
 */
export interface RunInfo {
  readonly day: string
  readonly engines: readonly string[]
  /** null when the file does not record it. NEVER 0 as a stand-in. */
  readonly spentUsd: number | null
  readonly mode: ScanRun['mode'] | 'unknown'
}

/**
 * The engine list, recovered from the comparison basis.
 *
 * `comparisonBasis` is pipe-joined and carries an `engines=a,b,c` segment
 * (`comparisonBasisFor`, services/grader/src/scan.ts). It is on every scanned
 * file because `compare()` refuses to put two numbers side by side without it,
 * so it is the one place the engine set survives when the run block does not.
 * Absent or malformed yields [] — the count is then omitted, never printed as 0.
 */
function enginesOf(comparisonBasis: string): readonly string[] {
  const segment = (comparisonBasis ?? '').split('|').find((s) => s.startsWith('engines='))
  return segment ? segment.slice('engines='.length).split(',').filter(Boolean) : []
}

/**
 * DERIVED, NEVER INVENTED. When the file records a run, it is used verbatim.
 * When it does not, each field comes from something the file actually carries —
 * and where nothing carries it, the answer is null or 'unknown', not a value.
 *
 *   day      collectedAt, the timestamp the scan wrote for itself
 *   engines  parsed out of comparisonBasis
 *   spentUsd null. The file does not record spend and no one may guess it.
 *   mode     'unknown'. A cached file is not evidence the answers were live.
 */
export function runInfoOf(scan: ScanResultFile): RunInfo {
  if (scan.run) {
    return { day: scan.run.day, engines: scan.run.engines, spentUsd: scan.run.spentUsd ?? null, mode: scan.run.mode }
  }
  return { day: (scan.collectedAt ?? '').slice(0, 10), engines: enginesOf(scan.comparisonBasis), spentUsd: null, mode: 'unknown' }
}

/**
 * The reference scan: the one this build ships on the Grader landing page as
 * "here is a collected result". Typed with `run` present because this file HAS
 * one — the CLI envelope wrote it — so the landing page and its tests keep
 * reading real recorded values rather than derived ones.
 */
export const SCAN = raw as unknown as ScanResultFile & { readonly run: ScanRun }

/** The scans compiled into this build: the committed demo domains. */
export const BUNDLED_SCANS: readonly ScanResultFile[] = [SCAN]

/**
 * Scans this browser collected through /api/scan during this session.
 *
 * `/api/scan` caches to `services/grader/data-live/results/`, which no client
 * can read - a static export has no filesystem and no route. So the third
 * domain anyone scanned rendered a full record on the Grader and then, one
 * click later, a dashboard saying "no cycle collected" for it. The result the
 * SSE already handed the client is stashed here instead, which costs nothing
 * and needs no second store.
 *
 * ⚠️ PERSISTED PER BROWSER, NOT PER SESSION — changed 2026-09-01. This was
 * sessionStorage, so a scan that cost real provider quota disappeared from the
 * dashboard, the portfolio and the workspace switcher the moment the browser
 * closed. The server still had it — `/api/scan` caches to
 * `data-live/results/` and replays it free forever — but nothing in the UI
 * could find it, so the visible behaviour was "your scan is gone" and the
 * obvious response was to run another one. Storage that forgets what was paid
 * for teaches people to re-spend.
 *
 * Honest to persist because a result is immutable and carries its own day:
 * every surface prints it through `runInfoOf`, so a week-old record reads as a
 * week-old record. The category mirror in `resolved-category.ts` stays session-
 * scoped for the opposite reason — a stale decision has no date on its face.
 *
 * ponytail: still per-browser. A scan collected in one browser is invisible in
 * another until its json is bundled. Upgrade path when the demo needs shared
 * state: a route that lists the results dir.
 */
const SESSION_KEY = 'bliprank-session-scans'

/**
 * Shape guard for a stored entry. Storage is a trust boundary: a stale build or
 * a hand-edited key can hold any legal JSON, and one malformed entry would
 * crash every surface that calls scans() — chrome, dashboard, portfolio,
 * client pages. Same discipline as readAgencyDomains/readCustomPrompts:
 * validate, drop what fails, never throw.
 */
export function isScanResultFile(s: unknown): s is ScanResultFile {
  if (typeof s !== 'object' || s === null) return false
  const f = s as Partial<ScanResultFile>
  return (
    typeof f.domain === 'string' &&
    typeof f.status === 'string' &&
    typeof f.categoryName === 'string' &&
    Array.isArray(f.brands) &&
    f.brands.length > 0 &&
    f.brands.every(isScanBrand) &&
    typeof f.counts === 'object' &&
    f.counts !== null &&
    typeof f.counts.answersScored === 'number'
  )
}

/**
 * A brand a record surface can render without throwing: a string name and a
 * metric whose numeric fields are finite, because intervalWidth and
 * confidenceGrade subtract and compare them unconditionally. A shallow check
 * here let brands:[{}] through and every surface white-screened on
 * `undefined - undefined`.
 */
function isScanBrand(b: unknown): b is ScanBrand {
  if (typeof b !== 'object' || b === null) return false
  const x = b as Partial<ScanBrand>
  const m = x.metric as Partial<Metric> | undefined
  return (
    typeof x.name === 'string' &&
    typeof m === 'object' &&
    m !== null &&
    Number.isFinite(m.value) &&
    Number.isFinite(m.ci_low) &&
    Number.isFinite(m.ci_high) &&
    Number.isFinite(m.n)
  )
}

function sessionScans(): readonly ScanResultFile[] {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isScanResultFile)
  } catch {
    // No storage (SSR, node, a browser with site data blocked), or unparseable.
    // The bundled scans still resolve; nothing is invented to cover the gap.
    return []
  }
}

/**
 * Stash a scan this session collected so every surface can find it.
 *
 * ONE ENTRY PER DOMAIN PER DAY, since 2026-09-02 (ADR-0013). A cycle is one
 * scan on one UTC day, and a domain may hold several: the store keeps them
 * side by side so `cyclesFor` can draw a trend over them, and replaces only a
 * same-day entry, which is the same measurement written again.
 */
export function rememberScan(scan: ScanResultFile): void {
  if (scan.status !== 'scanned' || !scan.domain) return
  try {
    const day = runInfoOf(scan).day
    const kept = sessionScans().filter((s) => !(normaliseTyped(s.domain) === normaliseTyped(scan.domain) && runInfoOf(s).day === day))
    globalThis.localStorage?.setItem(SESSION_KEY, JSON.stringify([...kept, scan]))
  } catch {
    /* failing to remember a scan must not break the page showing it */
  }
}

/**
 * Every scan this build can render. A registry rather than one constant: a
 * domain scanned through the UI was invisible to the dashboard and the agency
 * portfolio, because both decide `hasData` through `scanFor`.
 *
 * Bundled first, so a committed demo scan is never shadowed by a session one.
 */
export const scans = (): readonly ScanResultFile[] => [...BUNDLED_SCANS, ...sessionScans()]


/** True when the answers behind this result came from a paid provider. */
export const IS_LIVE = SCAN.run.mode === 'live'

/**
 * Same normalisation the classifier applies, so "https://www.Pipedrive.com/" in
 * the box matches the domain the scan was run for.
 */
export function normaliseTyped(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
}

/**
 * The LATEST scanned cycle for this domain, or null when this build has none.
 *
 * Latest by the day its answers were bought, not by position in the registry:
 * a cycle this browser collected after the bundled reference scan is the newer
 * measurement and the record leads with it. On the same day the earlier entry
 * wins, which is the bundled file — a session copy of the reference cycle is
 * never allowed to shadow the committed one. Every cycle, in order, is
 * `cyclesFor` in lib/cycles.ts.
 */
export function scanFor(domain: string): ScanResultFile | null {
  const typed = normaliseTyped(domain)
  let best: ScanResultFile | null = null
  for (const s of scans()) {
    if (s.status !== 'scanned' || normaliseTyped(s.domain) !== typed) continue
    if (!best || runInfoOf(s).day > runInfoOf(best).day) best = s
  }
  return best
}

export const subjectOf = (s: ScanResultFile): ScanBrand => s.brands.find((b) => b.isSubject) ?? s.brands[0]!
