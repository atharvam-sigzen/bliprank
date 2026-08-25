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
  readonly spentUsd: number
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
  readonly brands: readonly ScanBrand[]
  readonly run: ScanRun
}

export const SCAN = raw as unknown as ScanResultFile

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
  return normaliseTyped(domain) === normaliseTyped(SCAN.domain) && SCAN.status === 'scanned' ? SCAN : null
}

export const subjectOf = (s: ScanResultFile): ScanBrand => s.brands.find((b) => b.isSubject) ?? s.brands[0]!
