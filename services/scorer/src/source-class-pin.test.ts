/**
 * THE VERSION PIN, EXTENDED TO THE CITATION CLASSIFIER (ADR-0012, ADR-0014).
 *
 * `algo-version-pin.test.ts` freezes alias derivation under
 * `SCORING_ALGO_VERSION`. This freezes the other half of the deterministic
 * scorer: which class a citation gets, what detail is extracted with it, and
 * the platform tables themselves — because an entry in a table is a rule, and
 * one added domain changes what an existing answer scores.
 *
 * HOW IT WORKS, as before. A table of inputs is pinned to the exact output the
 * CURRENT version produces, keyed by that version. A rule change fails a row;
 * a version bump fails the lookup until a table for the new version is
 * written, which is the moment the changelog gets its row. Either way nothing
 * changes silently — including a domain moved between tables, or a publisher
 * registry wired in, each of which is a det-3 by construction.
 *
 * One case per rule and one per boundary, all invented URLs on a fixed
 * registry. Nothing here fetches anything.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLATFORM_TABLES, classifyCitation, type ClassifierRegistry, type SourceClass, type SourceDetail } from './classify-source.js'
import { SCORING_ALGO_VERSION, scoreAnswer } from './score.js'

/** The registry every case is classified against: the subject owns two domains, two rivals own one each, one publisher is named. */
const REGISTRY: ClassifierRegistry = {
  ownedDomains: ['pipedrive.com', 'pipedrive.io'],
  competitorDomains: { HubSpot: ['hubspot.com'], 'Zoho CRM': ['crm.zoho.com'] },
  publishers: { 'techradar.com': 'TechRadar' },
}

interface Pin {
  readonly url: string
  readonly why: string
  readonly sourceClass: SourceClass
  readonly domain: string
  readonly detail?: SourceDetail
  /** A different registry, for the precedence cases. Default: REGISTRY. */
  readonly registry?: ClassifierRegistry
  /** Provider-supplied metadata, for the cases about what it may and may not decide. */
  readonly meta?: Record<string, unknown>
}

/**
 * ⚠️ det-3 CLASSIFIES A CITATION EXACTLY AS det-2 DID, and that is the point.
 *
 * Every case below passes its OWN `REGISTRY`, which already names a publisher.
 * So `classifyCitation` is unchanged by det-3: the rule that moved is not in
 * the classifier, it is in WHO SUPPLIES THE REGISTRY. det-2 scored every stored
 * answer with the map empty; det-3 passes the approved 52-entry registry from
 * `scan.ts` and `answers.ts`.
 *
 * Keyed to the same table rather than copied, deliberately. A copy would let
 * the two drift and then this file would assert a classifier change that never
 * happened. What det-3 actually changed is asserted by the two wiring guards
 * below, which is where the bump's whole content lives.
 */
const DET_2_CASES: readonly Pin[] = [
    // Identity beats platform, and a subdomain is on the domain.
    { url: 'https://app.pipedrive.com/settings', why: 'owned, on a subdomain', sourceClass: 'owned', domain: 'pipedrive.com', detail: {} },
    { url: 'https://pipedrive.io/x', why: 'owned, second owned domain', sourceClass: 'owned', domain: 'pipedrive.io', detail: {} },
    { url: 'https://monday.com/blog/crm-and-sales/b2b-crm/', why: 'not owned, not a competitor in THIS registry, no platform: other', sourceClass: 'other', domain: 'monday.com', detail: {} },
    { url: 'https://blog.hubspot.com/sales/crm', why: 'competitor, on a subdomain of a competitor domain', sourceClass: 'competitor', domain: 'hubspot.com', detail: { competitor: 'HubSpot' } },
    { url: 'https://crm.zoho.com/signup', why: 'competitor pinned to a narrow attribution domain matches on it', sourceClass: 'competitor', domain: 'zoho.com', detail: { competitor: 'Zoho CRM' } },
    { url: 'https://www.zoho.com/crm/', why: "the apex the narrow attribution domain does NOT cover is other (ADR-0005's narrowing)", sourceClass: 'other', domain: 'zoho.com', detail: {} },
    // A YouTube link beats a competitor? No: identity first, so a competitor's video page would be competitor. This is a plain video.
    { url: 'https://www.youtube.com/watch?v=umcjcZxzvY8&t=510', why: 'video with id and timestamp in seconds', sourceClass: 'video', domain: 'youtube.com', detail: { platform: 'youtube', videoId: 'umcjcZxzvY8', timestamp: 510 } },
    { url: 'https://youtu.be/abc123xyz?t=1m30s', why: 'short link: id from the path, timestamp parsed from 1m30s', sourceClass: 'video', domain: 'youtu.be', detail: { platform: 'youtube', videoId: 'abc123xyz', timestamp: 90 } },
    { url: 'https://www.reddit.com/r/CRMSoftware/comments/1j278wy/best_crm/', why: 'community thread with subreddit and thread id', sourceClass: 'community', domain: 'reddit.com', detail: { platform: 'reddit', subCommunity: 'r/CRMSoftware', threadId: '1j278wy' } },
    { url: 'https://stackoverflow.com/questions/12345/how-to', why: 'community, question id as thread, host as sub-community', sourceClass: 'community', domain: 'stackoverflow.com', detail: { platform: 'stackoverflow', subCommunity: 'stackoverflow.com', threadId: '12345' } },
    { url: 'https://www.g2.com/products/pipedrive/reviews', why: 'review listing, slug as listing id', sourceClass: 'review', domain: 'g2.com', detail: { platform: 'g2', listingId: 'pipedrive' } },
    { url: 'https://en.wikipedia.org/wiki/Customer_relationship_management', why: 'reference by table', sourceClass: 'reference', domain: 'wikipedia.org', detail: { platform: 'wikipedia', referenceType: 'wikipedia' } },
    { url: 'https://www.ico.org.uk/for-organisations/', why: 'NOT reference: org.uk is not a government suffix', sourceClass: 'other', domain: 'ico.org.uk', detail: {} },
    { url: 'https://www.gov.uk/data-protection', why: 'reference by government suffix, no table entry needed', sourceClass: 'reference', domain: 'gov.uk', detail: { referenceType: 'government' } },
    { url: 'https://www.techradar.com/reviews/pipedrive-crm-review', why: 'earned media: named in the publisher registry', sourceClass: 'earned_media', domain: 'techradar.com', detail: { publisher: 'TechRadar' } },
    { url: 'https://www.forbes.com/advisor/business/software/best-simple-crm/', why: 'other: not in any table and not in the registry', sourceClass: 'other', domain: 'forbes.com', detail: {} },
    { url: '/goto?url=CAESbwHrOzAVj9d2', why: "a provider's own redirect path: no host, other, empty domain", sourceClass: 'other', domain: '', detail: {} },

    // --- precedence: identity beats platform, in both directions ---
    { url: 'https://www.youtube.com/watch?v=abc', why: 'an owned domain that is also a platform is owned', sourceClass: 'owned', domain: 'youtube.com', detail: {}, registry: { ownedDomains: ['youtube.com'] } },
    { url: 'https://www.g2.com/products/pipedrive/reviews', why: 'a competitor domain that is also a review platform is competitor', sourceClass: 'competitor', domain: 'g2.com', detail: { competitor: 'G2' }, registry: { ownedDomains: [], competitorDomains: { G2: ['g2.com'] } } },
    // --- every extractor path ---
    { url: 'https://www.youtube.com/watch?v=abc123&t=1:02:03', why: 'colon timestamp form', sourceClass: 'video', domain: 'youtube.com', detail: { platform: 'youtube', videoId: 'abc123', timestamp: 3723 } },
    { url: 'https://www.youtube.com/shorts/sh0rt1d', why: 'shorts id from the path', sourceClass: 'video', domain: 'youtube.com', detail: { platform: 'youtube', videoId: 'sh0rt1d' } },
    { url: 'https://www.youtube.com/embed/emb3d?start=45', why: 'embed id and the start= parameter', sourceClass: 'video', domain: 'youtube.com', detail: { platform: 'youtube', videoId: 'emb3d', timestamp: 45 } },
    { url: 'https://vimeo.com/123456789', why: 'non-YouTube video id is the last path segment', sourceClass: 'video', domain: 'vimeo.com', detail: { platform: 'vimeo', videoId: '123456789' } },
    { url: 'https://news.ycombinator.com/item?id=39001234', why: 'Hacker News thread id from the query', sourceClass: 'community', domain: 'ycombinator.com', detail: { platform: 'hackernews', threadId: '39001234' } },
    { url: 'https://superuser.com/questions/1700001/some-title', why: 'a Stack Exchange site: question id and the site as sub-community', sourceClass: 'community', domain: 'superuser.com', detail: { platform: 'stackexchange', subCommunity: 'superuser.com', threadId: '1700001' } },
    { url: 'https://www.capterra.com/p/12345/pipedrive/', why: 'Capterra listing id after /p/', sourceClass: 'review', domain: 'capterra.com', detail: { platform: 'capterra', listingId: '12345' } },
    { url: 'https://www.trustpilot.com/review/pipedrive.com', why: 'Trustpilot listing is the reviewed domain', sourceClass: 'review', domain: 'trustpilot.com', detail: { platform: 'trustpilot', listingId: 'pipedrive.com' } },
    { url: 'https://ec.europa.eu/info/law', why: 'EU institutions by suffix, no platform name', sourceClass: 'reference', domain: 'europa.eu', detail: { referenceType: 'government' } },
    { url: 'https://www.nist.gov/publications', why: 'a named government table entry carries the platform; the suffix alone would not', sourceClass: 'reference', domain: 'nist.gov', detail: { platform: 'government', referenceType: 'government' } },
    // --- what the provider may say, and may not decide ---
    { url: 'https://www.example-news.com/story', why: 'a provider-supplied publisher name is recorded and does NOT promote the class', sourceClass: 'other', domain: 'example-news.com', detail: { publisher: 'Example News' }, meta: { publisher: 'Example News' } },
]

const PINNED: Readonly<Record<string, readonly Pin[]>> = { 'det-2': DET_2_CASES, 'det-3': DET_2_CASES }

/** The tables as they stand under this version. A domain moved or added is a rule change and fails here. */
const PINNED_TABLES_DET_2: typeof PLATFORM_TABLES = {
    video: { 'youtube.com': 'youtube', 'youtu.be': 'youtube', 'vimeo.com': 'vimeo', 'dailymotion.com': 'dailymotion', 'tiktok.com': 'tiktok', 'twitch.tv': 'twitch' },
    community: {
      'reddit.com': 'reddit',
      'stackoverflow.com': 'stackoverflow',
      'stackexchange.com': 'stackexchange',
      'superuser.com': 'stackexchange',
      'serverfault.com': 'stackexchange',
      'quora.com': 'quora',
      'ycombinator.com': 'hackernews',
      'discourse.org': 'discourse',
      'spiceworks.com': 'spiceworks',
    },
    review: {
      'g2.com': 'g2',
      'capterra.com': 'capterra',
      'getapp.com': 'getapp',
      'softwareadvice.com': 'softwareadvice',
      'trustradius.com': 'trustradius',
      'trustpilot.com': 'trustpilot',
      'gartner.com': 'gartner',
      'yelp.com': 'yelp',
    },
    reference: {
      'wikipedia.org': 'wikipedia',
      'wikidata.org': 'wikidata',
      'wikimedia.org': 'wikipedia',
      'britannica.com': 'reference',
      'w3.org': 'standards',
      'ietf.org': 'standards',
      'iso.org': 'standards',
      'nist.gov': 'government',
    },
    govSuffixes: ['.gov', '.gov.uk', '.gov.in', '.gov.au', '.europa.eu'],
}

// The platform tables are det-2's, unchanged: det-3 adds no domain to any of them.
const PINNED_TABLES: Readonly<Record<string, typeof PLATFORM_TABLES>> = { 'det-2': PINNED_TABLES_DET_2, 'det-3': PINNED_TABLES_DET_2 }

describe(`citation classification is pinned to SCORING_ALGO_VERSION (${SCORING_ALGO_VERSION})`, () => {
  it('the current version has a pinned table of cases — a bump must bring a new one', () => {
    expect(Object.keys(PINNED)).toContain(SCORING_ALGO_VERSION)
    expect(Object.keys(PINNED_TABLES)).toContain(SCORING_ALGO_VERSION)
  })

  for (const pin of PINNED[SCORING_ALGO_VERSION] ?? []) {
    it(`${pin.url} · ${pin.why}`, () => {
      const got = classifyCitation({ url: pin.url, position: 0, ...(pin.meta ? { meta: pin.meta } : {}) } as Parameters<typeof classifyCitation>[0], pin.registry ?? REGISTRY)
      expect({ sourceClass: got.sourceClass, domain: got.domain, ...(pin.detail ? { detail: got.detail } : {}) }).toEqual({
        sourceClass: pin.sourceClass,
        domain: pin.domain,
        ...(pin.detail ? { detail: pin.detail } : {}),
      })
    })
  }


  it('⚠️ the scorer itself still defaults to no registry — the caller supplies it', () => {
    /*
     * INVERTED AT det-3, AND ONLY HALFWAY. Under det-2 this asserted that a
     * registry publisher came back `other` when scored the way the grader
     * scores, because no caller passed a map. det-3 makes the CALLERS pass one;
     * it does not give `scoreAnswer` a default.
     *
     * That distinction is worth a test of its own. A default inside the scorer
     * would mean a caller could get `earned_media` without asking for it, and
     * the golden harness — which passes each case's own declared map — would
     * silently start classifying against the product registry instead of the
     * case's. The scorer stays a pure function of its inputs; the wiring is the
     * grader's, and the guard below is what proves the grader does it.
     */
    const row = scoreAnswer({
      answer: { text: 'Pipedrive is a CRM.', citations: [{ url: 'https://www.techradar.com/reviews/pipedrive-crm-review', position: 0 }] },
      brand: { id: 'pipedrive', name: 'Pipedrive', aliases: ['Pipedrive'], domains: ['pipedrive.com'] },
      competitors: [],
    })
    expect(row.citations.map((c) => c.sourceClass)).toEqual(['other'])
  })

  /*
   * ⚠️ THE WIRING GUARD LIVES WITH THE GRADER, NOT HERE — moved at det-3.
   *
   * It asserts that `scan.ts` and `answers.ts` pass the approved registry, and
   * to check that it must read `@bliprank/taxonomy`, which `services/scorer`
   * does not depend on and should not: the scorer is a pure function over the
   * inputs it is handed, and the registry is data about the world that the
   * grader owns. Adding the dependency to make a test compile would have
   * inverted a layer for the convenience of an assertion.
   *
   * `services/grader/src/publisher-wiring.test.ts` holds it, where both are
   * already dependencies and where the thing being asserted actually lives.
   */

  it('the platform tables are exactly what this version says they are', () => {
    expect(PLATFORM_TABLES).toEqual(PINNED_TABLES[SCORING_ALGO_VERSION])
  })

  it('with no publisher registry at all, the registry case is other — which is what every stored scan has been classified with', () => {
    const got = classifyCitation({ url: 'https://www.techradar.com/reviews/pipedrive-crm-review', position: 0 }, { ownedDomains: ['pipedrive.com'] })
    expect(got.sourceClass).toBe('other')
  })
})
