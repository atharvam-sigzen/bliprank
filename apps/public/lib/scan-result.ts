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
import sigzenRaw from './scan-sigzen.json'

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
   * Present only on a file written by a runner that owned the budget — the CLI
   * envelope and, since this fix, `/api/scan`. Files cached before that carry no
   * run block at all, which is why this is optional and why nothing may read
   * `scan.run.x` directly. Use `runInfoOf`.
   */
  readonly run?: ScanRun
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

/** A live-scanned domain, cached by /api/scan with no run block. Bundled
 * because a static export cannot read `services/grader/data-live` at runtime,
 * and because a file of THIS shape is the one the app used to crash on. */
export const SIGZEN = sigzenRaw as unknown as ScanResultFile

/** The scans compiled into this build: the committed demo domains. */
export const BUNDLED_SCANS: readonly ScanResultFile[] = [SCAN, SIGZEN]

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
 * ponytail: per-browser and per-session by design. A scan collected in one
 * browser is invisible in another until its json is bundled. Upgrade path when
 * the demo needs shared state: a route that lists the results dir.
 */
const SESSION_KEY = 'bliprank-session-scans'

function sessionScans(): readonly ScanResultFile[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as ScanResultFile[]) : []
  } catch {
    // No storage (SSR, node, a browser with site data blocked), or unparseable.
    // The bundled scans still resolve; nothing is invented to cover the gap.
    return []
  }
}

/** Stash a scan this session collected so every surface can find it. */
export function rememberScan(scan: ScanResultFile): void {
  if (scan.status !== 'scanned' || !scan.domain) return
  try {
    const kept = sessionScans().filter((s) => normaliseTyped(s.domain) !== normaliseTyped(scan.domain))
    globalThis.sessionStorage?.setItem(SESSION_KEY, JSON.stringify([...kept, scan]))
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

/** The scanned result for this domain, or null when this build has no scan for it. */
export function scanFor(domain: string): ScanResultFile | null {
  const typed = normaliseTyped(domain)
  return scans().find((s) => normaliseTyped(s.domain) === typed && s.status === 'scanned') ?? null
}

export const subjectOf = (s: ScanResultFile): ScanBrand => s.brands.find((b) => b.isSubject) ?? s.brands[0]!
