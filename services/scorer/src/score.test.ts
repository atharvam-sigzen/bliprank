import { describe, expect, it } from 'vitest'
import type { AnswerBody } from '@bliprank/contracts'
import { findMentions, normaliseForMatch, scoreAnswer, SCORING_ALGO_VERSION, type BrandSpec } from './score.js'

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
