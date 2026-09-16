/**
 * THE PUBLISHER REGISTRY — which sites are editorial outlets. ADR-0015.
 *
 * ⚠️ WIRED SINCE det-3 (2026-09-07). This IS a scoring rule now: `scan.ts` and
 * `answers.ts` pass this map to `scoreAnswer`, and a domain in it is classed
 * `earned_media` instead of `other`. Wiring it flipped 8 rows across the stored
 * corpus and moved 9 of 629 citations; see ADR-0015 Amendment 1.
 *
 * ⚠️ SO ADDING OR REMOVING AN ENTRY IS A VERSION BUMP. One added domain changes
 * what an existing answer scores, and two cycles either side of that edit would
 * both stamp the same version with `compare()` unable to tell them apart.
 * `services/grader/src/publisher-registry-pin.test.ts` freezes the exact domain
 * set under `SCORING_ALGO_VERSION` and fails on any edit; the fix when it fails
 * is `/score-version`, not a new hash.
 *
 * `pnpm grader:publishers` proposes candidates from the corpus and never writes
 * to this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT COUNTS AS A PUBLISHER HERE. A domain is in this file only if all four hold:
 *
 *   1. AN EDITORIAL ORGANISATION. A named editorial staff, a masthead, an
 *      editorial-standards or corrections page. A site that is one person's
 *      blog, a marketing team, or a "content" operation with no masthead fails
 *      this, however good the writing.
 *   2. INDEPENDENT OF THE VENDORS IT COVERS. Not owned by, and not a blog of, a
 *      company that sells in a category the taxonomy tracks. Vendor blogs are
 *      what `competitor` and `other` already hold; a vendor-owned magazine
 *      (opensource.com under Red Hat, say) is left out for the same reason.
 *      OWNERSHIP COUNTS AT ANY DISTANCE, whatever the title's beat: a masthead
 *      whose group also owns a tracked vendor (Ziff Davis and Moz) or a refused
 *      directory operator (TechnologyAdvice and TechRepublic) is out. Decided
 *      2026-09-03, applied to every entry rather than case by case; the
 *      refusals below name each one.
 *   3. NOT PRIMARILY AN AFFILIATE DIRECTORY OR LISTICLE OPERATION. Sites whose
 *      product is a ranked list with referral links and a "get quotes" form —
 *      software directories, lead-generation comparison sites, statistics
 *      farms — are not editorial coverage even when they carry bylines. A
 *      masthead outlet that ALSO runs affiliate-supported buying guides
 *      (TechRadar, Forbes Advisor) is in, with `affiliate: true` on the entry so
 *      the fact is recorded rather than hidden.
 *   4. RELEVANT TO A CATEGORY THE TAXONOMY TRACKS AND A MARKET IT SELLS INTO.
 *      Business software, and gaming hardware for the India category, across
 *      the UK/EU, India and GCC beachheads. This is why the list is short: it
 *      is seeded for the categories that exist, not for the whole press.
 *
 * Review aggregators (G2, Capterra, Trustpilot) are NOT publishers; they are
 * the `review` class and stay there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE LIST COMES FROM, AND HOW IT GROWS. The seed is the outlets that
 * cover the taxonomy's categories in its markets, checked against what the
 * three stored scans actually cited. It grows in one way only: a person adds
 * an entry to this file, with a reason, in a commit that also bumps the
 * scoring version — because an added domain changes what an existing answer
 * scores. `pnpm grader:publishers` proposes candidates from the corpus that
 * clear an evidentiary bar (cited in ≥ 3 answers, ≥ 2 prompts, ≥ 2 engines,
 * the same bar competitor promotion uses) and marks which already fail a
 * criterion above; it never writes to this file.
 */

export type PublisherKind = 'tech-press' | 'business-press' | 'general-news' | 'trade-press' | 'reviews-lab' | 'consumer-tech'
export type Region = 'global' | 'uk' | 'eu' | 'india' | 'gcc' | 'us'

export interface Publisher {
  /** The registrable domain, as `registrableDomain` would derive it from a citation URL. */
  readonly domain: string
  readonly name: string
  readonly kind: PublisherKind
  readonly regions: readonly Region[]
  /** True when the outlet also runs affiliate-supported buying guides. Recorded, not hidden. */
  readonly affiliate?: boolean
  /** Why it meets the four criteria, in a line a reviewer can check. */
  readonly why: string
  readonly addedOn: string
}

const SEED = '2026-09-03'

/** The proposed initial registry. Every entry is a claim about an organisation, and each carries its reason. */
export const PUBLISHERS: readonly Publisher[] = [
  // Technology press, global — the outlets that review business software.
  { domain: 'techradar.com', name: 'TechRadar', kind: 'tech-press', regions: ['global', 'uk'], affiliate: true, why: 'Future plc masthead; reviews CRM, hosting, password managers; cited in the reference scan', addedOn: SEED },
  { domain: 'techcrunch.com', name: 'TechCrunch', kind: 'tech-press', regions: ['global'], why: 'Newsroom with editorial standards; startup and SaaS reporting', addedOn: SEED },
  { domain: 'theverge.com', name: 'The Verge', kind: 'tech-press', regions: ['global'], affiliate: true, why: 'Vox Media masthead; hardware and platform coverage', addedOn: SEED },
  { domain: 'wired.com', name: 'Wired', kind: 'tech-press', regions: ['global', 'uk'], affiliate: true, why: 'Condé Nast masthead; technology reporting and reviews', addedOn: SEED },
  { domain: 'arstechnica.com', name: 'Ars Technica', kind: 'tech-press', regions: ['global'], why: 'Condé Nast masthead; technology reporting', addedOn: SEED },
  { domain: 'engadget.com', name: 'Engadget', kind: 'consumer-tech', regions: ['global'], affiliate: true, why: 'Yahoo masthead; consumer hardware reviews', addedOn: SEED },
  { domain: 'tomshardware.com', name: "Tom's Hardware", kind: 'consumer-tech', regions: ['global'], affiliate: true, why: 'Future plc masthead; keyboards, mice and headsets reviewed in a lab — the gaming-peripherals category', addedOn: SEED },
  { domain: 'tomsguide.com', name: "Tom's Guide", kind: 'consumer-tech', regions: ['global'], affiliate: true, why: 'Future plc masthead; consumer hardware and software buying guides', addedOn: SEED },
  { domain: 'digitaltrends.com', name: 'Digital Trends', kind: 'consumer-tech', regions: ['global', 'us'], affiliate: true, why: 'Editorial masthead; hardware reviews', addedOn: SEED },
  { domain: 'rtings.com', name: 'RTINGS', kind: 'reviews-lab', regions: ['global'], affiliate: true, why: 'Independent test lab with published methodology; keyboards, mice, headsets; cited by two engines in the reference corpus', addedOn: SEED },
  { domain: 'computerworld.com', name: 'Computerworld', kind: 'trade-press', regions: ['global'], why: 'Foundry (IDG) masthead; enterprise software trade press', addedOn: SEED },
  { domain: 'infoworld.com', name: 'InfoWorld', kind: 'trade-press', regions: ['global'], why: 'Foundry (IDG) masthead; enterprise software trade press', addedOn: SEED },
  { domain: 'theregister.com', name: 'The Register', kind: 'trade-press', regions: ['global', 'uk'], why: 'Situation Publishing masthead; enterprise technology reporting', addedOn: SEED },
  { domain: 'venturebeat.com', name: 'VentureBeat', kind: 'tech-press', regions: ['global', 'us'], why: 'Editorial masthead; enterprise AI and SaaS reporting', addedOn: SEED },
  { domain: 'searchenginejournal.com', name: 'Search Engine Journal', kind: 'trade-press', regions: ['global'], why: 'Alpha Brand Media masthead; the SEO-tools category', addedOn: SEED },

  // Business and general press, global — where a category gets covered as business news.
  { domain: 'forbes.com', name: 'Forbes', kind: 'business-press', regions: ['global', 'us'], affiliate: true, why: 'Masthead; Forbes Advisor buying guides are affiliate-supported and are what the engines cite; cited in the reference scan', addedOn: SEED },
  { domain: 'fortune.com', name: 'Fortune', kind: 'business-press', regions: ['global', 'us'], affiliate: true, why: 'Masthead; Fortune Recommends buying guides', addedOn: SEED },
  { domain: 'businessinsider.com', name: 'Business Insider', kind: 'business-press', regions: ['global', 'us'], affiliate: true, why: 'Axel Springer masthead; business and tech reporting', addedOn: SEED },
  { domain: 'inc.com', name: 'Inc.', kind: 'business-press', regions: ['us', 'global'], why: 'Mansueto Ventures masthead; small-business coverage', addedOn: SEED },
  { domain: 'fastcompany.com', name: 'Fast Company', kind: 'business-press', regions: ['us', 'global'], why: 'Mansueto Ventures masthead; business technology coverage', addedOn: SEED },
  { domain: 'entrepreneur.com', name: 'Entrepreneur', kind: 'business-press', regions: ['us', 'india', 'global'], why: 'Masthead with regional editions including India; small-business tooling coverage', addedOn: SEED },
  { domain: 'hbr.org', name: 'Harvard Business Review', kind: 'business-press', regions: ['global'], why: 'Harvard Business Publishing masthead; management and technology', addedOn: SEED },
  { domain: 'technologyreview.com', name: 'MIT Technology Review', kind: 'tech-press', regions: ['global'], why: 'MIT-owned masthead with a standing editorial team; enterprise technology reporting', addedOn: SEED },
  { domain: 'nytimes.com', name: 'The New York Times', kind: 'general-news', regions: ['global', 'us'], affiliate: true, why: 'Masthead; Wirecutter buying guides are affiliate-supported; cited in the ERP corpus', addedOn: SEED },
  { domain: 'wsj.com', name: 'The Wall Street Journal', kind: 'general-news', regions: ['global', 'us'], why: 'Dow Jones masthead; technology and enterprise software reporting', addedOn: SEED },
  { domain: 'ft.com', name: 'Financial Times', kind: 'general-news', regions: ['global', 'uk'], why: 'Nikkei-owned masthead; technology and business reporting for the UK and EU beachheads', addedOn: SEED },
  { domain: 'bloomberg.com', name: 'Bloomberg', kind: 'general-news', regions: ['global'], why: 'Bloomberg L.P. masthead; technology and enterprise software reporting', addedOn: SEED },
  { domain: 'reuters.com', name: 'Reuters', kind: 'general-news', regions: ['global'], why: 'Masthead and published trust principles', addedOn: SEED },
  { domain: 'theguardian.com', name: 'The Guardian', kind: 'general-news', regions: ['uk', 'global'], why: 'Guardian Media Group masthead; technology desk and small-business coverage', addedOn: SEED },
  { domain: 'bbc.co.uk', name: 'BBC', kind: 'general-news', regions: ['uk', 'global'], why: 'Public-service broadcaster with editorial guidelines', addedOn: SEED },
  { domain: 'bbc.com', name: 'BBC', kind: 'general-news', regions: ['global'], why: 'Public-service broadcaster with editorial guidelines', addedOn: SEED },
  { domain: 'economist.com', name: 'The Economist', kind: 'general-news', regions: ['global', 'uk'], why: 'Masthead with a technology desk; business coverage across the UK and EU beachheads', addedOn: SEED },

  // UK small-business press — the UK beachhead.
  { domain: 'smallbusiness.co.uk', name: 'SmallBusiness.co.uk', kind: 'trade-press', regions: ['uk'], affiliate: true, why: 'Stubben Edge Group title with a named editorial team; cited twice in the CRM corpus for UK prompts', addedOn: SEED },

  // India — business and technology press, and the outlets that review gaming hardware there.
  { domain: 'livemint.com', name: 'Mint', kind: 'business-press', regions: ['india'], why: 'HT Media masthead; business technology', addedOn: SEED },
  { domain: 'business-standard.com', name: 'Business Standard', kind: 'business-press', regions: ['india'], why: 'Business Standard Ltd masthead; technology and enterprise coverage in India', addedOn: SEED },
  { domain: 'moneycontrol.com', name: 'Moneycontrol', kind: 'business-press', regions: ['india'], why: 'Network18 masthead; business and technology news', addedOn: SEED },
  { domain: 'news18.com', name: 'News18', kind: 'general-news', regions: ['india'], why: 'Network18 masthead; tech desk covers peripherals; cited in the gaming-peripherals corpus', addedOn: SEED },
  { domain: 'hindustantimes.com', name: 'Hindustan Times', kind: 'general-news', regions: ['india'], affiliate: true, why: 'HT Media masthead; tech buying guides', addedOn: SEED },
  { domain: 'indianexpress.com', name: 'The Indian Express', kind: 'general-news', regions: ['india'], why: 'Indian Express Group masthead; technology desk in India', addedOn: SEED },
  { domain: 'thehindu.com', name: 'The Hindu', kind: 'general-news', regions: ['india'], why: 'The Hindu Group masthead; technology desk in India', addedOn: SEED },
  { domain: 'ndtv.com', name: 'NDTV', kind: 'general-news', regions: ['india'], why: 'Masthead; ndtv.com and gadgets360.com are the news and the gadgets desk', addedOn: SEED },
  { domain: 'gadgets360.com', name: 'Gadgets 360', kind: 'consumer-tech', regions: ['india'], affiliate: true, why: 'NDTV masthead; reviews keyboards, mice and headsets sold in India', addedOn: SEED },
  { domain: 'digit.in', name: 'Digit', kind: 'consumer-tech', regions: ['india'], affiliate: true, why: '9.9 Group masthead with a test lab; cited in the gaming-peripherals corpus', addedOn: SEED },
  { domain: 'yourstory.com', name: 'YourStory', kind: 'business-press', regions: ['india'], why: 'Masthead; startup and SaaS coverage', addedOn: SEED },
  { domain: 'inc42.com', name: 'Inc42', kind: 'business-press', regions: ['india'], why: 'Masthead; Indian SaaS reporting', addedOn: SEED },

  // GCC — the outlets business software gets covered in.
  { domain: 'gulfnews.com', name: 'Gulf News', kind: 'general-news', regions: ['gcc'], why: 'Al Nisr Publishing masthead; business and technology desk in the UAE', addedOn: SEED },
  { domain: 'khaleejtimes.com', name: 'Khaleej Times', kind: 'general-news', regions: ['gcc'], why: 'Galadari Printing masthead; business and technology desk in the UAE', addedOn: SEED },
  { domain: 'thenationalnews.com', name: 'The National', kind: 'general-news', regions: ['gcc'], why: 'International Media Investments masthead; business and technology desk in the UAE', addedOn: SEED },
  { domain: 'arabianbusiness.com', name: 'Arabian Business', kind: 'business-press', regions: ['gcc'], why: 'ITP Media Group masthead; GCC business and technology coverage', addedOn: SEED },
  { domain: 'zawya.com', name: 'Zawya', kind: 'business-press', regions: ['gcc'], why: 'LSEG-owned masthead; regional business news', addedOn: SEED },

  // EU — English-language technology press covering the EU beachhead.
  { domain: 'sifted.eu', name: 'Sifted', kind: 'tech-press', regions: ['eu'], why: 'FT-backed masthead; European startups and SaaS', addedOn: SEED },
  { domain: 'thenextweb.com', name: 'The Next Web', kind: 'tech-press', regions: ['eu', 'global'], why: 'FT-owned masthead; European technology and SaaS reporting', addedOn: SEED },
]

/**
 * Sites the corpus cites that LOOK like publishers and are deliberately not in
 * the list, with the criterion each fails. Kept beside the list so the next
 * person to propose one of them finds the reason first.
 */
export const NOT_PUBLISHERS: readonly { readonly domain: string; readonly fails: 1 | 2 | 3 | 4; readonly why: string }[] = [
  { domain: 'pcmag.com', fails: 2, why: 'Ziff Davis title; Ziff Davis owns Moz, a tracked seo-tools vendor. Ownership counts, whatever the beat (decided 2026-09-03)' },
  { domain: 'zdnet.com', fails: 2, why: 'Ziff Davis title; Ziff Davis owns Moz, a tracked seo-tools vendor. Ownership counts, whatever the beat (decided 2026-09-03)' },
  { domain: 'cnet.com', fails: 2, why: 'Ziff Davis title; Ziff Davis owns Moz, a tracked seo-tools vendor. Ownership counts, whatever the beat (decided 2026-09-03)' },
  { domain: 'techrepublic.com', fails: 3, why: 'owned by TechnologyAdvice, a software directory operator refused under criterion 3; the title inherits the business model of its owner' },
  { domain: 'startups.co.uk', fails: 3, why: 'owned by MVF, a lead-generation group; the title runs affiliate buying guides for the categories it covers' },
  { domain: 'indiatimes.com', fails: 1, why: 'the registrable domain covers non-editorial Times Internet properties beside the mastheads; a match cannot tell them apart' },
  { domain: 'sportskeeda.com', fails: 4, why: 'a sports site; an esports desk is not coverage of a tracked category' },
  { domain: 'searchengineland.com', fails: 2, why: 'Third Door Media, owned by Semrush since 2024; Semrush is a tracked seo-tools vendor and SEO is the beat' },
  { domain: 'martech.org', fails: 2, why: 'Third Door Media, owned by Semrush since 2024; covers the CRM and email-marketing categories Semrush sells beside' },
  { domain: 'medium.com', fails: 1, why: 'a publishing platform, not an editorial organisation; any author, any standard' },
  { domain: 'linkedin.com', fails: 1, why: 'social platform; posts and pulse articles are self-published' },
  { domain: 'facebook.com', fails: 1, why: 'social platform' },
  { domain: 'github.com', fails: 1, why: 'code host' },
  { domain: 'opensource.com', fails: 2, why: 'vendor-owned magazine (Red Hat); editorial, but not independent of a vendor in the ERP category' },
  { domain: 'fitsmallbusiness.com', fails: 3, why: 'affiliate-supported buying-guide operation without a newsroom masthead' },
  { domain: 'technologyadvice.com', fails: 3, why: 'a lead-generation directory with content; its editorial title TechRepublic is listed separately' },
  { domain: 'selecthub.com', fails: 3, why: 'software directory with lead-generation forms' },
  { domain: 'softwaresuggest.com', fails: 3, why: 'software directory with lead-generation forms' },
  { domain: 'techjockey.com', fails: 3, why: 'software marketplace' },
  { domain: 'worldmetrics.org', fails: 3, why: 'statistics farm; no masthead' },
  { domain: 'zipdo.co', fails: 3, why: 'statistics farm; no masthead' },
  { domain: 'analyticsinsight.net', fails: 3, why: 'paid-placement publication; no independent editorial standard' },
  { domain: 'thedigitalprojectmanager.com', fails: 3, why: 'affiliate-supported niche guide; a candidate for a future review, not a seed' },
  { domain: 'research.com', fails: 3, why: 'ranking and directory site' },
]

/** The map the classifier takes: registrable domain → publisher name. */
export const PUBLISHER_REGISTRY: Readonly<Record<string, string>> = Object.fromEntries(PUBLISHERS.map((p) => [p.domain, p.name]))
