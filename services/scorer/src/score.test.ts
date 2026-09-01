import { describe, expect, it } from 'vitest'
import type { AnswerBody } from '@bliprank/contracts'
import { domainBrandForms, findMentions, normaliseForMatch, scoreAnswer, SCORING_ALGO_VERSION, type BrandSpec } from './score.js'

const HUBSPOT: BrandSpec = { id: 'hubspot', name: 'HubSpot', aliases: ['HubSpot', 'Hub Spot', 'HubSpot CRM'], domains: ['hubspot.com'] }
const SALESFORCE: BrandSpec = { id: 'salesforce', name: 'Salesforce', aliases: ['Salesforce', 'Sales Force'], domains: ['salesforce.com'] }
const ZOHO: BrandSpec = { id: 'zoho', name: 'Zoho CRM', aliases: ['Zoho', 'Zoho CRM'], domains: ['zoho.com'] }

const answer = (text: string, urls: string[] = []): AnswerBody => ({ text, citations: urls.map((url, position) => ({ url, position })) })
const score = (text: string, urls: string[] = []) => scoreAnswer({ answer: answer(text, urls), brand: HUBSPOT, competitors: [SALESFORCE, ZOHO] })

describe('mention detection is deterministic and whole-token', () => {
  it('matches case-insensitively across surface forms', () => {
    for (const t of ['HubSpot is good', 'hubspot is good', 'HUBSPOT is good', 'Hub Spot is good']) {
      expect(score(t).mentioned, t).toBe(true)
    }
  })

  it('does not match inside a longer word', () => {
    expect(score('HubSpotters love it').mentioned).toBe(false)
    expect(score('Zohoish tools').competitorsMentioned).toEqual([])
  })

  it('does not match across a digit boundary', () => {
    expect(score('HubSpot2 is different').mentioned).toBe(false)
  })

  it('matches when flanked by punctuation, which is where \\b alone fails', () => {
    expect(score('(HubSpot), Salesforce; and others').mentioned).toBe(true)
    expect(score('"HubSpot" — the obvious pick').mentioned).toBe(true)
  })

  it('tolerates the whitespace variants an engine emits for a multi-word alias', () => {
    expect(score('Hub  Spot works').mentioned).toBe(true)
    expect(score('Hub\nSpot works').mentioned).toBe(true)
  })

  it('counts every occurrence but reports the earliest as the position anchor', () => {
    const r = score('HubSpot is fine. Later, HubSpot again.')
    expect(r.mentionCount).toBe(2)
    const m = findMentions(normaliseForMatch('HubSpot is fine. Later, HubSpot again.'), HUBSPOT)
    expect(m?.firstOffset).toBe(0)
    expect(m?.matchedAlias).toBe('HubSpot')
  })

  it('is unaffected by unicode width — NFKC folds full-width forms', () => {
    expect(score('ＨｕｂＳｐｏｔ is good').mentioned).toBe(true)
  })
})

describe('URL masking — a link is not a text mention', () => {
  it('a brand appearing only inside a URL is cited but not mentioned', () => {
    const r = score('See https://hubspot.com/crm for details.', ['https://hubspot.com/crm'])
    expect(r.mentioned).toBe(false)
    expect(r.cited).toBe(true)
    expect(r.citedAtPositions).toEqual([0])
  })

  it('a bare www link is masked too', () => {
    expect(score('See www.hubspot.com/crm').mentioned).toBe(false)
  })

  it('masking preserves offsets, so position stays comparable', () => {
    const text = 'https://zoho.com/x is one option. HubSpot is another.'
    const masked = normaliseForMatch(text)
    expect(masked).toHaveLength(text.length)
    expect(score(text).position).toBe(1) // Zoho was masked away, HubSpot is first
  })

  it('prose mention alongside its own link still counts once per occurrence', () => {
    const r = score('HubSpot (https://hubspot.com) is the easiest.', ['https://hubspot.com'])
    expect(r.mentioned).toBe(true)
    expect(r.mentionCount).toBe(1)
    expect(r.cited).toBe(true)
  })
})

describe('position is a rank among detected brands', () => {
  it('is 1 when the subject appears first', () => {
    const r = score('HubSpot leads, then Salesforce.')
    expect(r.position).toBe(1)
    expect(r.brandsDetected).toBe(2)
  })

  it('is 2 when a competitor appears first', () => {
    const r = score('Salesforce dominates. HubSpot owns small business.')
    expect(r.position).toBe(2)
  })

  it('is null when absent, and competitors are still ranked', () => {
    const r = score('Zoho and Salesforce are the usual picks.')
    expect(r.position).toBeNull()
    expect(r.mentioned).toBe(false)
    expect(r.competitorsMentioned).toEqual(['Zoho CRM', 'Salesforce'])
  })

  it('ties break deterministically rather than on input order', () => {
    const a = scoreAnswer({ answer: answer('HubSpot'), brand: HUBSPOT, competitors: [SALESFORCE, ZOHO] })
    const b = scoreAnswer({ answer: answer('HubSpot'), brand: HUBSPOT, competitors: [ZOHO, SALESFORCE] })
    expect(a.position).toBe(b.position)
    expect(a).toEqual(b)
  })

  it('the subject appearing in its own competitor set is not double-counted', () => {
    const r = scoreAnswer({ answer: answer('HubSpot and Salesforce'), brand: HUBSPOT, competitors: [HUBSPOT, SALESFORCE] })
    expect(r.brandsDetected).toBe(2)
    expect(r.competitorsMentioned).toEqual(['Salesforce'])
  })
})

describe('citation detection', () => {
  it('matches subdomains of an owned domain', () => {
    expect(score('HubSpot', ['https://blog.hubspot.com/x']).cited).toBe(true)
  })
  it('does not match a lookalike domain', () => {
    expect(score('HubSpot', ['https://hubspot.com.evil.example/x']).cited).toBe(false)
    expect(score('HubSpot', ['https://nothubspot.com/x']).cited).toBe(false)
  })
  it('records every position the brand is cited at', () => {
    const r = score('HubSpot', ['https://other.example', 'https://hubspot.com/a', 'https://hubspot.com/b'])
    expect(r.citedAtPositions).toEqual([1, 2])
  })
  it('classifies every citation alongside (ADR-0005)', () => {
    const r = score('HubSpot', ['https://hubspot.com/a', 'https://reddit.com/r/x/comments/1/t', 'https://unknown.example/z'])
    expect(r.citations.map((c) => c.sourceClass)).toEqual(['owned', 'community', 'other'])
  })
})

describe('the invariants rules R1, R5 and R8 depend on', () => {
  it('scoring the same answer twice is byte-identical (G2 determinism)', () => {
    const a = score('HubSpot beats Salesforce for small teams.', ['https://hubspot.com/x'])
    const b = score('HubSpot beats Salesforce for small teams.', ['https://hubspot.com/x'])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('every row carries the algorithm version, so history can be re-derived (R5)', () => {
    expect(score('HubSpot').algoVersion).toBe(SCORING_ALGO_VERSION)
  })

  it('emits NO interval for a single answer — one Bernoulli trial has no CI (R8)', () => {
    // {value, ci_low, ci_high, n} belongs to aggregation over n runs, in
    // packages/stats. A per-answer "confidence" would be a category error.
    const r = score('HubSpot') as unknown as Record<string, unknown>
    for (const k of ['ci_low', 'ci_high', 'value', 'confidence']) expect(r[k]).toBeUndefined()
  })

  it('an empty answer scores cleanly rather than throwing', () => {
    const r = score('')
    expect(r).toMatchObject({ mentioned: false, mentionCount: 0, position: null, cited: false, brandsDetected: 0 })
  })

  it('a brand with no aliases never matches instead of matching everything', () => {
    const r = scoreAnswer({ answer: answer('anything at all'), brand: { ...HUBSPOT, aliases: [] } })
    expect(r.mentioned).toBe(false)
  })

  it('an alias that is only whitespace is ignored, not treated as a universal match', () => {
    const r = scoreAnswer({ answer: answer('anything at all'), brand: { ...HUBSPOT, aliases: ['   '] } })
    expect(r.mentioned).toBe(false)
  })

  it('a regex-special alias is matched literally, not compiled as a pattern', () => {
    const weird: BrandSpec = { id: 'w', name: 'C++ CRM', aliases: ['C++ CRM'], domains: [] }
    expect(scoreAnswer({ answer: answer('we use C++ CRM here'), brand: weird }).mentioned).toBe(true)
    expect(scoreAnswer({ answer: answer('we use CCCC CRM here'), brand: weird }).mentioned).toBe(false)
  })
})

describe('review findings — regressions that were shipped and are now pinned', () => {
  const ZOHO_NESTED: BrandSpec = { id: 'zoho', name: 'Zoho CRM', aliases: ['Zoho', 'Zoho CRM'], domains: ['zoho.com'] }

  it('BLOCKER: nested aliases count one mention, not one per alias', () => {
    // 'Zoho CRM' matched both 'Zoho' and 'Zoho CRM' and reported 2. Every brand
    // whose alias table holds a name plus a "name + product line" form — most
    // of them — had its frequency silently inflated.
    const r = scoreAnswer({ answer: answer('Zoho CRM is affordable.'), brand: ZOHO_NESTED })
    expect(r.mentionCount).toBe(1)
    expect(scoreAnswer({ answer: answer('HubSpot CRM is best.'), brand: HUBSPOT }).mentionCount).toBe(1)
    // and genuinely separate occurrences still count separately
    expect(scoreAnswer({ answer: answer('Zoho CRM is cheap. Zoho is popular.'), brand: ZOHO_NESTED }).mentionCount).toBe(2)
  })

  it('BLOCKER: the more specific alias is the one reported', () => {
    const m = findMentions(normaliseForMatch('Zoho CRM is affordable.'), ZOHO_NESTED)
    expect(m?.matchedAlias).toBe('Zoho CRM')
  })

  it('BLOCKER: an empty entry in domains never makes an unrelated URL "cited"', () => {
    // A trailing comma in an imported domain list was enough: isOnDomain('', ...)
    // matched every unparseable URL, so `cited` — the primary visibility signal —
    // went true for arbitrary third-party links.
    const r = scoreAnswer({
      answer: answer('HubSpot is fine.', ['not a url at all', 'https://evil.example/x']),
      brand: { ...HUBSPOT, domains: ['hubspot.com', ''] },
    })
    expect(r.cited).toBe(false)
    expect(r.citedAtPositions).toEqual([])
    // and `cited` now agrees with what the classifier says about the same URLs
    expect(r.citations.every((c) => c.sourceClass !== 'owned')).toBe(true)
  })

  it('BLOCKER: two competitors sharing a domain classify the same way in any order', () => {
    const A: BrandSpec = { id: 'a', name: 'BrandA', aliases: ['BrandA'], domains: ['shared.example'] }
    const B: BrandSpec = { id: 'b', name: 'BrandB', aliases: ['BrandB'], domains: ['shared.example'] }
    const forward = scoreAnswer({ answer: answer('x', ['https://shared.example/x']), brand: HUBSPOT, competitors: [A, B] })
    const reversed = scoreAnswer({ answer: answer('x', ['https://shared.example/x']), brand: HUBSPOT, competitors: [B, A] })
    expect(forward.citations[0]?.detail.competitor).toBe(reversed.citations[0]?.detail.competitor)
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed))
  })

  it('a trailing-dot FQDN is the same site, for citation and classification alike', () => {
    const r = scoreAnswer({ answer: answer('HubSpot', ['https://hubspot.com./crm']), brand: HUBSPOT })
    expect(r.cited).toBe(true)
    expect(r.citations[0]?.sourceClass).toBe('owned')
  })

  it('nested brands rank by specificity at the same offset, not alphabetically', () => {
    const MS: BrandSpec = { id: 'microsoft', name: 'Microsoft', aliases: ['Microsoft'], domains: [] }
    const COPILOT: BrandSpec = { id: 'ms-copilot', name: 'Microsoft Copilot', aliases: ['Microsoft Copilot'], domains: [] }
    const text = 'Microsoft Copilot is built into Windows.'
    // Whichever is the subject, the longer match ranks first.
    expect(scoreAnswer({ answer: answer(text), brand: COPILOT, competitors: [MS] }).position).toBe(1)
    expect(scoreAnswer({ answer: answer(text), brand: MS, competitors: [COPILOT] }).position).toBe(2)
  })

  it('an underscore is a token boundary — handles are not mentions', () => {
    expect(scoreAnswer({ answer: answer('follow HubSpot_alt for updates'), brand: HUBSPOT }).mentioned).toBe(false)
  })
})

/**
 * THE FALSE ZERO — 2026-09-01, and the worst defect this scorer can produce.
 *
 * thecosmicbyte.com is not a tracked leader, so `subjectFor` gave it the domain
 * label `thecosmicbyte` as its only alias. The engines write "Cosmic Byte".
 * Whole-token matching found nothing, and a brand named 139 times across 31 of
 * 50 collected answers was published as 0.0% — mentioned in none of them.
 *
 * A low number is a finding. A zero that should be ~62% is a broken instrument,
 * and it is indistinguishable from the real thing on the page.
 */
describe('squashed aliases — a brand whose domain runs its words together', () => {
  const cosmic: BrandSpec = {
    id: 'domain:thecosmicbyte.com',
    name: 'thecosmicbyte',
    aliases: ['thecosmicbyte'],
    squashedAliases: ['cosmicbyte'],
    domains: ['thecosmicbyte.com'],
  }

  it('matches the trading name the engines actually write', () => {
    for (const text of [
      'For budget gaming, Cosmic Byte headsets are worth a look.',
      'The CosmicByte CB-GK-19 is a solid pick.',
      'Try the Cosmic-Byte mousepad.',
      'brands like cosmic  byte compete on price',
    ]) {
      const m = findMentions(normaliseForMatch(text), cosmic)
      expect(m, text).not.toBeNull()
      expect(m!.count).toBe(1)
    }
  })

  it('still matches the plain domain label when an answer uses it', () => {
    const m = findMentions(normaliseForMatch('see thecosmicbyte for details'), cosmic)
    expect(m).not.toBeNull()
  })

  it('⚠️ DOES NOT INVENT A MENTION across a word boundary', () => {
    // Squashing destroys boundaries: "smart station" -> "smartstation", which
    // CONTAINS "artstation". Inventing a mention is worse than missing one.
    const artstation: BrandSpec = { id: 'a', name: 'ArtStation', aliases: ['ArtStation'], squashedAliases: ['artstation'], domains: ['artstation.com'] }
    expect(findMentions(normaliseForMatch('a smart station for your desk'), artstation)).toBeNull()
    // The real brand, properly bounded, still matches.
    expect(findMentions(normaliseForMatch('posted on Art Station yesterday'), artstation)).not.toBeNull()
  })

  it('refuses a needle too short to be evidence', () => {
    const tiny: BrandSpec = { id: 't', name: 'Go', aliases: [], squashedAliases: ['go'], domains: [] }
    expect(findMentions(normaliseForMatch('go to the good goggles'), tiny)).toBeNull()
  })

  it('a squashed hit overlapping a plain alias is counted ONCE, not twice', () => {
    // 'Cosmic Byte' matches the squashed form; if the brand also lists it as a
    // plain alias, the existing overlap resolution must still collapse them.
    const both: BrandSpec = { ...cosmic, aliases: ['thecosmicbyte', 'cosmic byte'] }
    const m = findMentions(normaliseForMatch('Cosmic Byte makes keyboards'), both)
    expect(m!.count).toBe(1)
  })

  it('a brand with no squashedAliases behaves exactly as before', () => {
    const plain: BrandSpec = { id: 'p', name: 'Pipedrive', aliases: ['Pipedrive'], domains: ['pipedrive.com'] }
    expect(findMentions(normaliseForMatch('Pipe drive is not the same word'), plain)).toBeNull()
    expect(findMentions(normaliseForMatch('Pipedrive is a CRM'), plain)).not.toBeNull()
  })
})

/**
 * THE FLOOR, AND THE EVIDENCE THAT OVERRIDES IT.
 *
 * Reviewing MIN_STRIPPED_LENGTH = 5 exposed a real cost. `getlago.com` minus
 * `get` is `lago` — four characters — so it was refused and every "Lago handles
 * usage-based billing" went uncounted: the same false zero one letter further
 * down. Lowering the floor to 4 fixes that and breaks `google.com`, whose
 * remainder after `go` is `ogle`, an ordinary English word that would score a
 * mention of Google every time somebody ogles something.
 *
 * Length cannot separate them — both are four letters. Evidence can: Lago's
 * homepage says "Lago"; Google's does not say "Ogle".
 *
 * Every sentence and every title below is INVENTED for this test. Nothing here
 * touches a provider, a stored scan, or a real homepage.
 */
describe('a four-letter remainder is admitted only when the site title names it', () => {
  const specFor = (host: string, title?: string): BrandSpec => {
    const f = domainBrandForms(host, title)
    return { id: host, name: f.name, aliases: f.aliases, squashedAliases: f.squashedAliases, domains: [host] }
  }
  const matches = (host: string, sentence: string, title?: string) =>
    findMentions(normaliseForMatch(sentence), specFor(host, title)) !== null

  // Synthetic. No such scan exists and none is needed.
  const LAGO_SENTENCE = 'For usage-based billing, Lago is the one people self-host.'
  const OGLE_SENTENCE = 'People ogle at their phones all day on the train.'

  it('WITH corroboration: "Lago" matches for getlago.com', () => {
    expect(matches('getlago.com', LAGO_SENTENCE, 'Lago - Open Source Usage Based Billing')).toBe(true)
    expect(specFor('getlago.com', 'Lago - Open Source Usage Based Billing').squashedAliases).toContain('lago')
  })

  it('WITHOUT corroboration: the same four letters stay refused', () => {
    // No title at all, and a title that does not name it, are both "no evidence".
    expect(matches('getlago.com', LAGO_SENTENCE)).toBe(false)
    expect(matches('getlago.com', LAGO_SENTENCE, 'Open Source Billing for Developers')).toBe(false)
  })

  it('"ogle" is STILL refused for google.com, title or no title', () => {
    // The case the floor exists for. Google's homepage does not say "Ogle", so
    // nothing promotes it — this is what a blanket floor of 4 would have broken.
    expect(matches('google.com', OGLE_SENTENCE)).toBe(false)
    expect(matches('google.com', OGLE_SENTENCE, 'Google')).toBe(false)
    expect(matches('google.com', OGLE_SENTENCE, 'Google - Search the world&apos;s information')).toBe(false)
    expect(specFor('google.com', 'Google').squashedAliases).not.toContain('ogle')
  })

  it('a title naming a RIVAL cannot promote anything', () => {
    // The corroboration is specific: the title must name THIS candidate, not
    // merely be present. A competitor's name in the title promotes nothing.
    const s = specFor('getlago.com', 'Alternatives to Stripe Billing and Chargebee')
    expect(s.squashedAliases).not.toContain('lago')
    expect(matches('getlago.com', LAGO_SENTENCE, 'Alternatives to Stripe Billing and Chargebee')).toBe(false)
  })

  it('the five-letter rule is unchanged — no title needed above the floor', () => {
    // thecosmicbyte -> cosmicbyte is ten characters: trusted on length alone,
    // which is why the original fix worked with no homepage read at all.
    expect(matches('thecosmicbyte.com', 'Cosmic Byte makes budget headsets.')).toBe(true)
    expect(matches('usebubbles.com', 'Bubbles is a decent async video tool.')).toBe(true)
  })
})
