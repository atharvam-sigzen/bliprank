import { describe, expect, it } from 'vitest'
import { cacheCell, cacheKey, normalisePrompt, NORMALISATION_VERSION } from './cache-key.js'
import { canonicalGeo, ISO_3166_1_ALPHA2 } from './geo.js'

describe('canonicalGeo', () => {
  it('is the full ISO 3166-1 alpha-2 set', () => {
    expect(ISO_3166_1_ALPHA2.size).toBe(249)
    for (const c of ['IN', 'GB', 'US', 'AE', 'SA', 'DE', 'FR', 'AU', 'SG']) expect(ISO_3166_1_ALPHA2.has(c)).toBe(true)
  })
  it.each([
    ['in', 'IN'],
    [' gb ', 'GB'],
    ['uk', 'GB'], // common mistake → resolved, not a new bucket
    ['UK', 'GB'],
    ['BU', 'MM'], // retired code → current
    ['SU', 'RU'],
  ])('%j → %j', (input, expected) => {
    expect(canonicalGeo(input)).toBe(expected)
  })
  it.each(['XX', 'ZZ', 'EU', 'UN', 'XK', 'QO', 'IND', 'IN-MH', 'I', ''])('rejects %j', (bad) => {
    expect(() => canonicalGeo(bad)).toThrow(RangeError)
  })
})

describe('normalisePrompt v1', () => {
  it.each([
    ['  Best CRM for startups?  ', 'best crm for startups'],
    ['Best\tCRM\n\nfor   startups', 'best crm for startups'],
    ['best crm for startups...', 'best crm for startups'],
    ['best crm for startups ?!', 'best crm for startups'],
    ['Ｗhat’s the best CRM…', 'what’s the best crm'], // NFKC folds full-width; apostrophe kept
    ['what? really', 'what? really'], // only terminal punctuation is stripped
  ])('%j → %j', (input, expected) => {
    expect(normalisePrompt(input)).toBe(expected)
  })
})

describe('cacheCell', () => {
  const base = { prompt: 'Best CRM for startups?', engine: 'chatgpt', locale: 'en-in', geo: 'in', dateBucket: '2026-08-18' } as const

  it('canonicalises every part', () => {
    expect(cacheCell(base)).toEqual({
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
      normalisedPrompt: 'best crm for startups',
      engine: 'chatgpt',
      locale: 'en-IN',
      geo: 'IN',
      dateBucket: '2026-08-18',
      normalisationVersion: NORMALISATION_VERSION,
    })
  })

  it('is insensitive to prompt whitespace/case/terminal punctuation and to locale/geo casing', () => {
    const k = cacheKey(base)
    expect(cacheKey({ ...base, prompt: 'best   crm for STARTUPS' })).toBe(k)
    expect(cacheKey({ ...base, locale: 'EN-IN', geo: 'In' })).toBe(k)
    expect(cacheKey({ ...base, geo: 'uk' })).toBe(cacheKey({ ...base, geo: 'GB' }))
  })

  it('accepts a Date and buckets it by UTC day', () => {
    expect(cacheKey({ ...base, dateBucket: new Date('2026-08-18T23:59:59.999Z') })).toBe(cacheKey(base))
    expect(cacheKey({ ...base, dateBucket: new Date('2026-08-19T00:00:00.000Z') })).not.toBe(cacheKey(base))
  })

  it('changes when any part changes', () => {
    const k = cacheKey(base)
    expect(cacheKey({ ...base, engine: 'gemini' })).not.toBe(k)
    expect(cacheKey({ ...base, locale: 'en-GB' })).not.toBe(k)
    expect(cacheKey({ ...base, geo: 'GB' })).not.toBe(k)
    expect(cacheKey({ ...base, dateBucket: '2026-08-19' })).not.toBe(k)
    expect(cacheKey({ ...base, prompt: 'best crm for enterprises' })).not.toBe(k)
  })

  it.each([
    [{ engine: 'perplexity' as never }, /unknown engine/],
    [{ locale: 'not a locale' }, RangeError],
    [{ geo: 'IND' }, /alpha-2/],
    [{ geo: 'IN-MH' }, /alpha-2/],
    [{ geo: 'XX' }, /unknown/],
    [{ dateBucket: '2026-13-40' }, /YYYY-MM-DD/],
    [{ dateBucket: '18/08/2026' }, /YYYY-MM-DD/],
    [{ prompt: ' ?! ' }, /empty/],
  ])('rejects %j', (override, err) => {
    expect(() => cacheCell({ ...base, ...override })).toThrow(err)
  })

  // Golden keys. If one of these changes, the shape of the key changed — that
  // needs an ADR (rule R6), not a test update.
  it.each([
    [base, '4c7f78272bfa13f32b83663e5ce0e13292caed117259a0ee053e2718e053dc47'],
    [{ ...base, engine: 'google-ai-overviews' as const, locale: 'en-GB', geo: 'GB', dateBucket: '2026-01-01' }, 'eeedc78f71c74802030d85a1ceb6873a6937ebc277699c11263929d0eb5be27c'],
  ])('golden %j', (input, key) => {
    expect(cacheKey(input)).toBe(key)
  })
})
