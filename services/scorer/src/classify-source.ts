/**
 * Citation source classification — ADR-0005, PHASES.md 2.1b.
 *
 * Every cited URL gets a source class during the DETERMINISTIC pass (rule R1):
 * URL pattern matching plus a maintained publisher registry. No model call, no
 * cost, and the same URL classifies the same way every time — which is what
 * lets the class be stored on the score row (R5) instead of re-derived at query
 * time, where a registry update would silently rewrite history.
 *
 * The constraint that matters most, from ADR-0005: **`other` is never silently
 * reclassified.** An unrecognised URL is `other`. A classifier that quietly
 * buckets unknowns as `owned` inflates the customer's own number — the exact
 * failure mode this product exists to criticise. There is deliberately no
 * fallback path that can reach `owned`.
 *
 * Precedence is identity before platform: if a URL is on the customer's domain
 * it is `owned` even when that domain is a YouTube channel, because who owns
 * the surface is a stronger fact than what kind of surface it is.
 */

import type { Citation } from '@bliprank/contracts'
import { hostOf, isOnDomain, registrableDomain } from './domain.js'

export type SourceClass = 'owned' | 'video' | 'community' | 'review' | 'earned_media' | 'competitor' | 'reference' | 'other'

/** Extracted alongside the class, per ADR-0005's table. All optional. */
export interface SourceDetail {
  readonly platform?: string
  /** `video`: the video id. */
  readonly videoId?: string
  /** `video`: seconds into the video, or the provider's raw chapter marker. */
  readonly timestamp?: string | number
  /** `community`: the sub-community (subreddit, Stack Exchange site, tag). */
  readonly subCommunity?: string
  /** `community`: thread / post id. */
  readonly threadId?: string
  /** `review`: the listing being reviewed. */
  readonly listingId?: string
  /** `earned_media`: publisher name, from the registry or the provider. */
  readonly publisher?: string
  /** `competitor`: which competitor alias or domain matched. */
  readonly competitor?: string
  /** `reference`: wikipedia | wikidata | standards | government. */
  readonly referenceType?: string
}

export interface ClassifiedCitation {
  readonly url: string
  readonly position: number
  readonly sourceClass: SourceClass
  readonly detail: SourceDetail
  /** The registrable domain the decision was made on, for audit. */
  readonly domain: string
}

export interface ClassifierRegistry {
  /** Domains the customer owns. Subdomains count. */
  readonly ownedDomains: readonly string[]
  /** Competitor name → domains they own. */
  readonly competitorDomains?: Readonly<Record<string, readonly string[]>>
  /**
   * Publisher authority registry: domain → publisher name. ADR-0005 flags this
   * as a maintained asset that will drift without ownership; it is data, not
   * code, so it can be updated without a scoring version bump ONLY because the
   * class is stored per row at scoring time (R5).
   */
  readonly publishers?: Readonly<Record<string, string>>
}

// --- platform tables -------------------------------------------------------
// Kept as explicit data. A URL that is not in one of these is `other`, and that
// is the correct answer, not a gap to paper over.

const VIDEO: Record<string, string> = {
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'vimeo.com': 'vimeo',
  'dailymotion.com': 'dailymotion',
  'tiktok.com': 'tiktok',
  'twitch.tv': 'twitch',
}

const COMMUNITY: Record<string, string> = {
  'reddit.com': 'reddit',
  'stackoverflow.com': 'stackoverflow',
  'stackexchange.com': 'stackexchange',
  'superuser.com': 'stackexchange',
  'serverfault.com': 'stackexchange',
  'quora.com': 'quora',
  'ycombinator.com': 'hackernews',
  'discourse.org': 'discourse',
  'spiceworks.com': 'spiceworks',
}

const REVIEW: Record<string, string> = {
  'g2.com': 'g2',
  'capterra.com': 'capterra',
  'getapp.com': 'getapp',
  'softwareadvice.com': 'softwareadvice',
  'trustradius.com': 'trustradius',
  'trustpilot.com': 'trustpilot',
  'gartner.com': 'gartner',
  'yelp.com': 'yelp',
}

const REFERENCE: Record<string, string> = {
  'wikipedia.org': 'wikipedia',
  'wikidata.org': 'wikidata',
  'wikimedia.org': 'wikipedia',
  'britannica.com': 'reference',
  'w3.org': 'standards',
  'ietf.org': 'standards',
  'iso.org': 'standards',
  'nist.gov': 'government',
}

/** Government suffixes get `reference` without needing an entry each. */
const GOV_SUFFIXES = ['.gov', '.gov.uk', '.gov.in', '.gov.au', '.europa.eu']

/**
 * The tables, read-only, for the version pin in `source-class-pin.test.ts`.
 * An entry in one of these is a scoring rule: adding a domain changes what an
 * existing answer scores, so the pin freezes their exact contents under
 * `SCORING_ALGO_VERSION` (ADR-0012). Exported for that test and nothing else;
 * the classifier reads the private constants above.
 */
export const PLATFORM_TABLES: {
  readonly video: Readonly<Record<string, string>>
  readonly community: Readonly<Record<string, string>>
  readonly review: Readonly<Record<string, string>>
  readonly reference: Readonly<Record<string, string>>
  readonly govSuffixes: readonly string[]
} = Object.freeze({
  // Frozen COPIES: a consumer cannot reach the tables the classifier reads.
  video: Object.freeze({ ...VIDEO }),
  community: Object.freeze({ ...COMMUNITY }),
  review: Object.freeze({ ...REVIEW }),
  reference: Object.freeze({ ...REFERENCE }),
  govSuffixes: Object.freeze([...GOV_SUFFIXES]),
})

// --- extractors ------------------------------------------------------------

/** Seconds from a YouTube-style `t`/`start` parameter (`90`, `1m30s`, `01:30`). */
export function parseTimestamp(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined
  const s = String(raw).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s)
  if (hms && (hms[1] || hms[2] || hms[3])) return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0)
  const colon = /^(?:(\d+):)?(\d+):(\d{1,2})$/.exec(s)
  if (colon) return Number(colon[1] ?? 0) * 3600 + Number(colon[2]) * 60 + Number(colon[3])
  return undefined
}

function videoDetail(url: string, platform: string, meta: Citation['meta']): SourceDetail {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { platform }
  }
  const path = u.pathname
  let videoId: string | undefined
  if (platform === 'youtube') {
    videoId = u.searchParams.get('v') ?? (hostOf(url) === 'youtu.be' ? path.slice(1) : undefined)
    if (!videoId && /^\/(shorts|embed|live)\//.test(path)) videoId = path.split('/')[2]
  } else {
    const last = path.split('/').filter(Boolean).pop()
    if (last && /^\d+$/.test(last)) videoId = last
    else if (last) videoId = last
  }
  // The provider's own marker wins: it may name a chapter we cannot see in the URL.
  const timestamp = meta?.timestamp ?? parseTimestamp(u.searchParams.get('t') ?? u.searchParams.get('start') ?? u.hash.replace(/^#t=/, ''))
  return { platform, ...(videoId ? { videoId } : {}), ...(timestamp !== undefined ? { timestamp } : {}) }
}

function communityDetail(url: string, platform: string, meta: Citation['meta']): SourceDetail {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { platform }
  }
  const segs = u.pathname.split('/').filter(Boolean)
  const d: { subCommunity?: string; threadId?: string } = {}
  if (platform === 'reddit') {
    const i = segs.indexOf('r')
    if (i >= 0 && segs[i + 1]) d.subCommunity = `r/${segs[i + 1]}`
    const c = segs.indexOf('comments')
    const thread = c >= 0 ? segs[c + 1] : undefined
    if (thread) d.threadId = thread
  } else if (platform === 'stackoverflow' || platform === 'stackexchange') {
    const q = segs.indexOf('questions')
    const question = q >= 0 ? segs[q + 1] : undefined
    if (question) d.threadId = question
    d.subCommunity = hostOf(url)
  } else if (platform === 'hackernews') {
    const id = u.searchParams.get('id')
    if (id) d.threadId = id
  }
  const threadId = meta?.threadId ?? d.threadId
  return { platform, ...(d.subCommunity ? { subCommunity: d.subCommunity } : {}), ...(threadId ? { threadId: String(threadId) } : {}) }
}

function reviewDetail(url: string, platform: string, meta: Citation['meta']): SourceDetail {
  let listingId: string | undefined
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean)
    // g2.com/products/<slug>/reviews, capterra.com/p/<id>/<slug>, trustpilot.com/review/<domain>
    const anchor = segs.findIndex((s) => s === 'products' || s === 'p' || s === 'review' || s === 'reviews')
    if (anchor >= 0 && segs[anchor + 1]) listingId = segs[anchor + 1]
    else if (segs.length) listingId = segs[segs.length - 1]
  } catch {
    /* leave undefined */
  }
  const fromMeta = meta?.['listingId']
  return { platform, ...(fromMeta || listingId ? { listingId: String(fromMeta ?? listingId) } : {}) }
}

// --- the classifier --------------------------------------------------------

/**
 * Classify one citation. Pure: same URL plus same registry always yields the
 * same class, which is what makes storing the class on the row (R5) honest.
 */
export function classifyCitation(citation: Citation, registry: ClassifierRegistry): ClassifiedCitation {
  const { url, position } = citation
  const domain = registrableDomain(url)
  const host = hostOf(url)
  const base = { url, position, domain }

  // 1. Identity beats platform. Owned first, then competitor.
  for (const owned of registry.ownedDomains) {
    if (owned && isOnDomain(url, owned)) return { ...base, sourceClass: 'owned', detail: {} }
  }
  for (const [name, domains] of Object.entries(registry.competitorDomains ?? {})) {
    for (const d of domains) {
      if (d && isOnDomain(url, d)) return { ...base, sourceClass: 'competitor', detail: { competitor: name } }
    }
  }

  // 2. Platform classes, matched on the registrable domain so subdomains count.
  const video = VIDEO[domain]
  if (video) return { ...base, sourceClass: 'video', detail: videoDetail(url, video, citation.meta) }

  const community = COMMUNITY[domain]
  if (community) return { ...base, sourceClass: 'community', detail: communityDetail(url, community, citation.meta) }

  const review = REVIEW[domain]
  if (review) return { ...base, sourceClass: 'review', detail: reviewDetail(url, review, citation.meta) }

  const reference = REFERENCE[domain]
  if (reference) return { ...base, sourceClass: 'reference', detail: { platform: reference, referenceType: reference } }
  if (host && GOV_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
    return { ...base, sourceClass: 'reference', detail: { referenceType: 'government' } }
  }

  // 3. Publisher authority registry.
  const publisher = registry.publishers?.[domain]
  if (publisher) return { ...base, sourceClass: 'earned_media', detail: { publisher } }

  // 4. Unrecognised. `other` — never `owned`, never guessed. ADR-0005 §2.
  //    A provider-supplied publisher name is recorded but does NOT promote the
  //    class: the provider does not know our authority registry, and letting it
  //    decide would make the class depend on which provider collected the run.
  const providerPublisher = citation.meta?.publisher
  return { ...base, sourceClass: 'other', detail: providerPublisher ? { publisher: String(providerPublisher) } : {} }
}

export function classifyCitations(citations: readonly Citation[], registry: ClassifierRegistry): ClassifiedCitation[] {
  return citations.map((c) => classifyCitation(c, registry))
}

/** Counts per class — the source-mix primitive the CBI and P5.5b read. */
export function sourceMix(classified: readonly ClassifiedCitation[]): Record<SourceClass, number> {
  const mix: Record<SourceClass, number> = { owned: 0, video: 0, community: 0, review: 0, earned_media: 0, competitor: 0, reference: 0, other: 0 }
  for (const c of classified) mix[c.sourceClass]++
  return mix
}
