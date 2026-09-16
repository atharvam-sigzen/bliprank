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
import { runInfoOf, scanFor } from './scan-result'
import { cyclesFor } from './cycles'
import { readBank, readDecision } from './resolved-category'

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
   * Collected cycles this build holds for the domain. NULL when never run,
   * for the same reason `answersCollected` is: a `0` in a figure slot on a
   * pre-flight screen reads as a result, and the test that sweeps every
   * workspace for figures would rightly refuse it.
   */
  readonly cycles: number | null
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

/**
 * The real prompts a cycle would ask, from the category bank.
 *
 * The session cache is consulted FIRST, and the bundled banks are the fallback.
 * The order matters: a category authored for this visitor's domain exists only
 * on the server and in that cache, so a bundle-first lookup would find nothing
 * for it and this page would show an empty prompt list under a category name it
 * had just displayed. `DEMO_BANKS` still answers for every hand-authored
 * category and for anyone arriving without a session.
 */
export function preflightPrompts(categorySlug: string, limit = PROMPTS_PER_CYCLE): readonly { text: string; intent: string }[] {
  const cached = readBank(categorySlug)
  const prompts = cached
    ? cached.prompts
    : (DEMO_BANKS.find((b) => b.category === categorySlug)?.prompts ?? [])
  return prompts.filter((p) => UNPROMPTED_INTENTS.includes(p.intent)).slice(0, Math.max(0, limit))
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

/**
 * The same two sentences as `reasonFor`, for a decision the server made.
 *
 * Separate because a server decision carries more than the pure classifier can:
 * it knows whether the homepage was read and failed to place the business, or
 * was never reachable at all, and those are different things to tell someone.
 */
function reasonForDecision(d: { slug: string; source: string; evidence: string }): string {
  if (d.slug !== FALLBACK_SLUG) return ''
  return `Unclassified: ${d.evidence || 'no category could be determined'}. It is measured against the general business software bank, which carries no competitor set, so no comparison is available.`
}

/** null when the input is not a usable domain (empty, junk, a filename). */
export function workspaceFor(domain: string): Workspace | null {
  const host = normaliseHost(domain)
  // A pasted filename is not a workspace. `normaliseHost` accepts `report.pdf`
  // by design, so this guard is the one that refuses it — the same reasoning as
  // the grader's spend guard, minus the spend.
  if (!host || looksLikeFilename(host)) return null

  /*
   * THE SERVER'S DECISION WINS, WHEN THERE IS ONE.
   *
   * `classifyDomain` reads the host string and nothing else, so it is the
   * WEAKEST of the signals now in play — it cannot see the homepage and it
   * cannot see a category authored ten seconds ago. Running it in preference to
   * a recorded decision is how this page came to contradict the Grader about
   * what a domain sells.
   *
   * The decision is still permanent and still the server's: this reads a mirror
   * of it (`resolved-category.ts`), never derives one. With no mirror — a fresh
   * tab, a domain never previewed — the pure classifier answers exactly as
   * before, so nothing regresses for the bundled demo domains.
   */
  const decided = readDecision(host)
  const classification = classifyDomain(host, DEMO_BANKS, DEMO_TAXONOMY)
  const confident = decided ? decided.slug !== FALLBACK_SLUG : classification.status === 'classified'
  const categorySlug = decided ? decided.slug : classification.status === 'classified' ? classification.slug : FALLBACK_SLUG
  const scan = scanFor(host)
  const cachedBank = readBank(categorySlug)

  return {
    domain: host,
    categorySlug,
    categoryName: cachedBank?.displayName ?? categoryBySlug(categorySlug)?.displayName ?? categorySlug,
    confident,
    fallbackReason: confident ? '' : decided ? reasonForDecision(decided) : reasonFor(classification),
    promptCount: preflightPrompts(categorySlug).length,
    // The surfaces a cycle WOULD cover, not a record of what any past cycle did.
    // A completed scan reports its own engine list on its own result.
    engines: ENGINES,
    hasData: scan !== null,
    // Through runInfoOf: a live-scanned file records no run block, and its day
    // comes from `collectedAt` instead. Empty means the file says nothing about
    // when it ran, which is null here rather than a blank in a date slot.
    lastRunDay: scan ? runInfoOf(scan).day || null : null,
    cycles: scan ? cyclesFor(host).length : null,
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
  if (!w.hasData) return 'queued — first cycle not collected'
  return w.cycles !== null && w.cycles > 1 ? `collected — ${w.cycles} cycles, latest ${w.lastRunDay}` : `collected — cycle of ${w.lastRunDay}`
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

function readRawSession(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeRawSession(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value)
  } catch {
    // Private window, exhausted quota, or SSR.
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
  //
  // ⚠️ PERSISTED, NOT SESSION-SCOPED — changed 2026-09-01, deliberately, and it
  // reverses an earlier decision. The old rule was "a domain is only locked once
  // genuinely entered during this visit", which kept a stale workspace from
  // leaking into a fresh session. The cost turned out to be larger than the
  // protection: a scan that COST REAL MONEY vanished from the dashboard the
  // moment the browser closed, and the only way back to it was through the
  // Grader again. Storage that forgets what was paid for teaches people to
  // re-run scans, which is the opposite of what every guard in this repo is for.
  //
  // Safe to persist because a scan result is immutable and day-stamped: every
  // surface prints the cycle day through `runInfoOf`, so an old workspace reads
  // as old rather than as current. That is exactly what makes this different
  // from the category mirror in `resolved-category.ts`, which stays
  // session-scoped — a stale DECISION would be presented as today's truth,
  // where a stale RESULT carries its own date.
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
