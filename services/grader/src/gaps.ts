/**
 * THE GAP REPORT FOR A STORED CYCLE — what is on the page, against what that
 * cycle asked about it. ADR-0014.
 *
 * `aeo-audit.ts` is pure: HTML and prompts in, findings out. `aeo.ts` is the
 * CLI around it. This is the piece between them the result page needed: given
 * a domain this machine has SCANNED, fetch its homepage once through the SSRF
 * boundary and audit it against the prompts THAT CYCLE was measured over — the
 * bank it recorded, at the prompt count on its basis — so the report on the
 * page is about the questions the number on the page came from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS ITS OWN ARTEFACT, FETCHED ON REQUEST, AND NOT PART OF THE RESULT.
 *
 * A result is a measurement of the ENGINES on a day. A gap report is a fact
 * about the customer's PAGE at the moment it was read, and the page changes on
 * its own schedule. Writing the report into the result would date the page by
 * the scan; keeping it separate lets it carry its own `fetchedAt`, be re-read
 * without re-scanning, and follow the same pattern the answers already follow
 * (ADR-0011): a static file for the bundled scan, a route for a local one.
 *
 * ⚠️ IT SPENDS NOTHING. One GET to the domain's own homepage, the same one the
 * classifier makes, through `fetch-site.ts`'s address pinning and byte
 * ceiling. No provider, no model, no path that can collect. R3 does not govern
 * it and no flag gates it. It is bounded to domains with a stored cycle so
 * the route around it is not a fetch proxy for arbitrary hosts.
 *
 * ⚠️ IT DIAGNOSES AND NEVER GENERATES. Nothing here or downstream writes copy
 * (the `--draft` path was removed on 2026-09-02). Every finding is hedged in
 * `aeo-audit.ts` and the surface keeps the hedge.
 */

import { auditSite, type AeoReport } from './aeo-audit.js'
import type { CycleResult } from './cycles.js'
import { fetchSiteHtml, type FetchSiteOptions } from './fetch-site.js'
import { allBanks } from './resolve-category.js'
import { basisOf, promptsFor } from './scan.js'
import { categoryRecordIn } from './store/documents.js'
import { fileWorkspaceStore } from './store/file-store.js'
import type { WorkspaceStore } from './store/pg-store.js'

export interface GapReport extends AeoReport {
  /** The category the cycle was measured against — the bank the prompts came from. */
  readonly category: string
  /** The cycle's day and basis, so a surface can check the report belongs to the result it sits under. */
  readonly day: string
  readonly comparisonBasis: string
  /** When the page was read. The page's own clock, not the scan's. */
  readonly fetchedAt: string
  readonly bytes: number
  /** How many of the cycle's prompts were checked against the page. */
  readonly promptCount: number
}

export interface GapReportOptions {
  /** A specific cycle's day; the latest when absent. */
  readonly day?: string
  /** Passed through to `fetchSiteHtml`. Tests inject `fetchImpl` and `resolve`. */
  readonly fetch?: FetchSiteOptions
  readonly now?: () => Date
  /** The deployment's store; this machine's files when absent (MVP_PLAN B3b). */
  readonly store?: WorkspaceStore
}

type StoredShape = CycleResult & { readonly category?: string; readonly comparisonBasis?: string }

export async function gapReportFor(dataDir: string, domain: string, opts: GapReportOptions = {}): Promise<GapReport | { readonly refuse: string }> {
  const store = opts.store ?? fileWorkspaceStore(dataDir)
  const cycle = opts.day ? await store.cycles.read(domain, opts.day) : await store.cycles.latest(domain)
  if (!cycle) return { refuse: opts.day ? `no stored cycle of ${domain} for ${opts.day}` : `no stored result for ${domain}` }

  // The cycle's own category, exactly as `answers.ts` reads it: the prompts on
  // the report must be the prompts behind the number, not today's record's.
  const stored = cycle.result as unknown as StoredShape
  const slug = typeof stored.category === 'string' && stored.category ? stored.category : (await categoryRecordIn(store, domain))?.slug
  if (!slug) return { refuse: `${domain}: neither the stored result nor a category record names the category it was measured against` }
  const bank = allBanks(dataDir).find((b) => b.category === slug)
  if (!bank) return { refuse: `${domain}: no bank for category ${slug}` }

  const basis = basisOf(stored.comparisonBasis ?? '')
  const prompts = promptsFor(bank, basis.maxPrompts).map((p) => p.text)

  const fetched = await fetchSiteHtml(domain, opts.fetch ?? {})
  if (!fetched.ok) return { refuse: `${domain}: could not read the homepage (${fetched.reason}: ${fetched.message})` }

  const report = auditSite(fetched.html, { domain, finalUrl: fetched.finalUrl, prompts, truncated: fetched.truncated })
  return {
    ...report,
    category: slug,
    day: cycle.day,
    comparisonBasis: stored.comparisonBasis ?? '',
    fetchedAt: (opts.now ?? (() => new Date()))().toISOString(),
    bytes: fetched.bytes,
    promptCount: prompts.length,
  }
}
