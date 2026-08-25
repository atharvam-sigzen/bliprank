/**
 * What a domain IS to this app, before anything has been measured.
 *
 * A workspace is the offline half of the product: classification, the prompt
 * bank, the engine list and the cycle arithmetic all resolve with no network
 * call and no spend (R3). The measured half — whether any answer has actually
 * been collected — is a single boolean, `hasData`, derived from the committed
 * scan and from nothing else.
 *
 * THAT SEPARATION IS THE POINT. A screen can legitimately show a visitor their
 * category, the seventeen prompts a cycle would ask and the five surfaces it
 * would ask them on, because all of that is true before collection. What it may
 * never do is let any of it imply a result. `hasData: false` means there is no
 * number, and there is no field on this object that could be mistaken for one.
 */

/*
 * The ENGINES SUBPATH, not the barrel.
 *
 * `@bliprank/contracts` re-exports cache-key.ts, which imports `node:crypto`.
 * This module is pulled into a CLIENT bundle by the dashboard, so the barrel
 * import made `next build` fail with an unresolvable node:crypto — and it failed
 * ONLY in the production browser build. `next dev` and vitest both run in node,
 * where node:crypto resolves, so every check in this repo passed while the
 * shipping bundle was broken.
 *
 * The subpath keeps one source of truth for the engine list rather than
 * duplicating five strings that must stay in step with the collector.
 */
import { ENGINES } from '@bliprank/contracts/engines'
import {
  classifyDomain,
  categoryBySlug,
  looksLikeFilename,
  normaliseHost,
  DEMO_BANKS,
  DEMO_TAXONOMY,
  FALLBACK_SLUG,
} from '@bliprank/taxonomy'
import { scanFor } from './scan-result'

export type Role = 'brand' | 'agency'

export interface Workspace {
  readonly domain: string
  readonly categorySlug: string
  readonly categoryName: string
  /** false when classifyDomain fell back or was ambiguous */
  readonly confident: boolean
  /** why it fell back, when confident is false; '' otherwise */
  readonly fallbackReason: string
  /** how many prompts a cycle would run for this workspace */
  readonly promptCount: number
  readonly engines: readonly string[]
  /** true ONLY when a committed scan exists for this domain */
  readonly hasData: boolean
  /** the day of the last collected cycle, or null when never run */
  readonly lastRunDay: string | null
  /**
   * Answers behind that cycle, or null when there is none.
   *
   * NULL, NEVER ZERO, and the type is the enforcement. Three screens printed a
   * hand-written `0` in a mono figure slot for a domain this build holds 85
   * collected answers for; a nullable field makes every render site branch
   * instead of defaulting, because `?? 0` is the bug written back in.
   */
  readonly answersCollected: number | null
}

/**
 * The grader's default `GRADER_PROMPTS_PER_SCAN` (services/grader/live-gate.ts),
 * and also the size of every bank's unprompted subset. Both being 17 is why a
 * cycle currently asks a whole bank rather than a sample of one.
 */
export const PROMPTS_PER_CYCLE = 17

/**
 * A cycle asks the intents that name NO brand. Duplicated from
 * `UNPROMPTED_INTENTS` in services/grader/src/scan.ts rather than imported:
 * that module is a Node CLI service pulling in the collector, the scorer and a
 * blob store, and none of that belongs in a browser bundle to learn two strings.
 * If the grader's list changes, this changes with it.
 */
const UNPROMPTED_INTENTS: readonly string[] = ['discovery', 'problem-led']

/** The real prompts a cycle would ask, from the category bank. */
export function preflightPrompts(categorySlug: string, limit = PROMPTS_PER_CYCLE): readonly { text: string; intent: string }[] {
  const bank = DEMO_BANKS.find((b) => b.category === categorySlug)
  if (!bank) return []
  return bank.prompts.filter((p) => UNPROMPTED_INTENTS.includes(p.intent)).slice(0, Math.max(0, limit))
}

/**
 * Why the general bank is being used, in words a visitor can act on.
 *
 * Ambiguous and unclassified are different problems and get different sentences:
 * one is "we know too much about you", the other "we know nothing about you".
 * Collapsing them into one apology would hide the fact that the ambiguous case
 * has a fix, which is naming the category.
 */
function reasonFor(c: ReturnType<typeof classifyDomain>): string {
  const name = (slug: string): string => categoryBySlug(slug)?.displayName ?? slug
  if (c.status === 'ambiguous') {
    return `Ambiguous: this domain leads more than one category (${c.candidates.map(name).join(', ')}), so no single one can be chosen for it. It would be measured against the general business software bank until a category is confirmed.`
  }
  if (c.status === 'unclassified') {
    return `Unclassified: ${c.reason}. It would be measured against the general business software bank, which carries no competitor set, so no comparison would be available.`
  }
  return ''
}

/** null when the input is not a usable domain (empty, junk, a filename). */
export function workspaceFor(domain: string): Workspace | null {
  const host = normaliseHost(domain)
  // A pasted filename is not a workspace. `normaliseHost` accepts `report.pdf`
  // by design, so this guard is the one that refuses it — the same reasoning as
  // the grader's spend guard, minus the spend.
  if (!host || looksLikeFilename(host)) return null

  const classification = classifyDomain(host, DEMO_BANKS, DEMO_TAXONOMY)
  const confident = classification.status === 'classified'
  const categorySlug = confident ? classification.slug : FALLBACK_SLUG
  const scan = scanFor(host)

  return {
    domain: host,
    categorySlug,
    categoryName: categoryBySlug(categorySlug)?.displayName ?? categorySlug,
    confident,
    fallbackReason: confident ? '' : reasonFor(classification),
    promptCount: preflightPrompts(categorySlug).length,
    // The surfaces a cycle WOULD cover, not a record of what any past cycle did.
    // A completed scan reports its own engine list on its own result.
    engines: ENGINES,
    hasData: scan !== null,
    lastRunDay: scan?.run.day ?? null,
    answersCollected: scan?.counts.answersScored ?? null,
  }
}

/*
 * THE TWO THINGS A SCREEN MAY SAY ABOUT COLLECTION.
 *
 * Shared rather than retyped per screen: /agency, /agency/add and /dashboard all
 * state whether a cycle has run, and when each wrote its own version they
 * disagreed — the portfolio drew a rail at n=85 while the add sheet one click
 * earlier printed "0 answers collected" for the same domain. One sentence, one
 * place, and both branches derived from the same field.
 */

/** The value for a "Status" slot. Words, never a figure. */
export function collectionStatus(w: Workspace): string {
  return w.hasData ? `collected — cycle of ${w.lastRunDay}` : 'queued — first cycle not collected'
}

/** One mono line for a provenance margin. */
export function collectionLine(w: Workspace): string {
  return w.answersCollected === null ? 'no cycle in this record' : `${w.answersCollected} answers · day ${w.lastRunDay}`
}

/*
 * Browser storage. Three keys rather than one settings blob: they are written by
 * different screens at different times, and a shared key means the last writer
 * wins and silently drops what another screen saved.
 */

export const ROLE_STORAGE_KEY = 'bliprank-role'
export const ACTIVE_STORAGE_KEY = 'bliprank-active-domain'
export const AGENCY_STORAGE_KEY = 'bliprank-agency-domains'

/**
 * Every access goes through these two. SSR has no `localStorage` at all and a
 * private window throws on the property itself, so the lookup is inside the try
 * as well as the call. A preference that cannot be saved is never a reason to
 * fail a render.
 */
function readRaw(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Private window, exhausted quota, or SSR. Nothing to recover and nothing
    // to report: the caller's screen works either way.
  }
}

export function readRole(): Role {
  return readRaw(ROLE_STORAGE_KEY) === 'agency' ? 'agency' : 'brand'
}

export function writeRole(role: Role): void {
  writeRaw(ROLE_STORAGE_KEY, role)
}

export function readActiveDomain(): string | null {
  // Normalised on the way out as well as in: a value written by an older build,
  // or edited by hand in devtools, must not become a lookup key that no scan can
  // match.
  return normaliseHost(readRaw(ACTIVE_STORAGE_KEY) ?? '') || null
}

export function writeActiveDomain(domain: string): void {
  const host = normaliseHost(domain)
  if (host) writeRaw(ACTIVE_STORAGE_KEY, host)
}

export function readAgencyDomains(): readonly string[] {
  const raw = readRaw(AGENCY_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Put through the same normaliser as everything else, so a stale or
    // hand-edited entry drops out rather than rendering as a workspace that
    // cannot resolve.
    return [...new Set((parsed as readonly unknown[]).map((d) => (typeof d === 'string' ? normaliseHost(d) : '')).filter(Boolean))]
  } catch {
    return []
  }
}

/**
 * Returns the list INCLUDING the new domain even when the write failed. A
 * private window would otherwise appear to reject the addition, which reads as a
 * broken button rather than as absent persistence: the list still works for the
 * session, it just does not survive a reload.
 */
export function addAgencyDomain(domain: string): readonly string[] {
  const host = normaliseHost(domain)
  const current = readAgencyDomains()
  if (!host || looksLikeFilename(host) || current.includes(host)) return current
  const next = [...current, host]
  writeRaw(AGENCY_STORAGE_KEY, JSON.stringify(next))
  return next
}

export function removeAgencyDomain(domain: string): readonly string[] {
  const host = normaliseHost(domain)
  const next = readAgencyDomains().filter((d) => d !== host)
  writeRaw(AGENCY_STORAGE_KEY, JSON.stringify(next))
  return next
}
