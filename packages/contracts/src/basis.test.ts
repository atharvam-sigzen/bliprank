import { describe, expect, it } from 'vitest'
import { BASIS_KEYS, BASIS_LABELS, basisDifference, formatBasis, parseBasis, type Basis } from './basis.js'

/** Every basis string a stored scan or the bundled reference carries today. Byte for byte; ADR-0016 promises they never change. */
const STORED = [
  'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=17|runs=1',
  'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|erp-software@1|unprompted=10|runs=1',
  'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|erp-software@2|unprompted=10|runs=1',
  'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|gaming-peripherals-india@1|unprompted=10|runs=1',
]

const base: Basis = {
  format: 'grader',
  engines: ['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews'],
  locale: 'en-US',
  geo: 'US',
  bank: { slug: 'crm-software', version: 1 },
  unprompted: 17,
  runs: 1,
}

describe('the stored strings are reproduced byte for byte', () => {
  for (const s of STORED) {
    it(s.slice(0, 60), () => {
      const b = parseBasis(s)
      expect(b).not.toBeNull()
      expect(formatBasis(b!)).toBe(s)
    })
  }

  it('a basis with no override and no custom prompts is the seven-segment form', () => {
    expect(formatBasis(base)).toBe(STORED[0]!)
    expect(parseBasis(STORED[0]!)).toEqual(base)
  })

  it('engine order never changes the string', () => {
    expect(formatBasis({ ...base, engines: ['gemini', 'chatgpt', 'google-ai-overviews', 'copilot', 'google-ai-mode'] })).toBe(STORED[0])
  })
})

describe('the tail segments are appended only when they apply', () => {
  it('a competitor override adds set=N after the seven', () => {
    const s = formatBasis({ ...base, set: 2 })
    expect(s).toBe(`${STORED[0]}|set=2`)
    expect(parseBasis(s)).toEqual({ ...base, set: 2 })
  })

  it('a custom-prompt measurement carries its own count and version, and unprompted=0', () => {
    const s = formatBasis({ ...base, unprompted: 0, custom: { count: 15, version: 3 } })
    expect(s).toBe('grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=0|runs=1|custom=15@3')
    expect(parseBasis(s)).toEqual({ ...base, unprompted: 0, custom: { count: 15, version: 3 } })
  })

  it('both tails, in a fixed order', () => {
    const s = formatBasis({ ...base, set: 1, custom: { count: 2, version: 1 } })
    expect(s.endsWith('|set=1|custom=2@1')).toBe(true)
    expect(formatBasis(parseBasis(s)!)).toBe(s)
  })
})

describe('what the parser refuses', () => {
  it.each([
    ['', 'empty'],
    ['grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=17', 'six segments'],
    ['grader|chatgpt|en-US|US|crm-software@1|unprompted=17|runs=1', 'engines without its key'],
    ['grader|engines=chatgpt|en-US|US|crm-software|unprompted=17|runs=1', 'bank without a version'],
    ['grader|engines=chatgpt|en-US|US|crm-software@one|unprompted=17|runs=1', 'a non-numeric version'],
    ['grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=17|runs=1|mystery=4', 'an unknown tail key'],
    ['grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=17|runs=1|custom=15', 'custom without a version'],
  ])('%s (%s) is null, never a guess', (s) => {
    expect(parseBasis(s)).toBeNull()
  })
})

describe('the difference line names every segment that moved, in the words the record uses', () => {
  const s = (over: Partial<Basis>) => formatBasis({ ...base, ...over })

  it('the prompt count, previous against current', () => {
    expect(basisDifference(s({ unprompted: 10 }), s({}))).toBe('measured on a different basis: the prompt count (17 against 10)')
  })

  it('the bank version after a promotion', () => {
    expect(basisDifference(s({ bank: { slug: 'crm-software', version: 2 } }), s({}))).toBe('measured on a different basis: the bank version (crm-software@1 against crm-software@2)')
  })

  it('a competitor override that did not exist before reads as absent against its version', () => {
    expect(basisDifference(s({ set: 1 }), s({}))).toBe('measured on a different basis: the competitor set (absent against 1)')
  })

  it('a curated measurement against a custom one names both moved segments', () => {
    expect(basisDifference(s({ unprompted: 0, custom: { count: 3, version: 1 } }), s({}))).toBe(
      'measured on a different basis: the prompt count (17 against 0), the custom prompt set (absent against 3@1)',
    )
  })

  it('several differences, in segment order', () => {
    expect(basisDifference(s({ engines: ['chatgpt'], runs: 2 }), s({}))).toBe(
      'measured on a different basis: the engine set (chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews against chatgpt), the runs per cell (1 against 2)',
    )
  })

  it('null when nothing differs', () => {
    expect(basisDifference(s({}), s({}))).toBeNull()
  })

  it('a string it cannot parse is named whole, never labelled by position', () => {
    // The older four-segment form the store once wrote: positional labels would put "the engine set" on a locale.
    expect(basisDifference(s({}), 'grader|en-US|US|crm-software@1')).toBe(`measured on a different basis: the basis (grader|en-US|US|crm-software@1 against ${s({})})`)
    expect(basisDifference('', s({}))).toBe(`measured on a different basis: the basis (${s({})} against absent)`)
    expect(basisDifference('legacy|x|y', 'legacy|x|y')).toBeNull()
  })

  it('two strings that differ at all are two bases: a non-canonical form never reads as equal to its canonical one', () => {
    const canon = s({ set: 2 })
    for (const variant of [`${s({})}|set=1|set=2`, `${s({})}|custom=1@1|set=2`, s({}).replace('unprompted=17', 'unprompted=017'), s({}).replace('crm-software@1', 'crm-software@01')]) {
      expect(parseBasis(variant), variant).toBeNull()
      expect(basisDifference(variant, canon), variant).not.toBeNull()
    }
    expect(parseBasis(s({}).replace('engines=chatgpt,copilot', 'engines=copilot,chatgpt'))).toBeNull()
  })

  it('the writer refuses a field carrying the separator', () => {
    expect(() => formatBasis({ ...base, locale: 'en|US' })).toThrow(/separator/)
  })
})

describe('the definition cannot drift from itself', () => {
  it('every key the shape has is written, compared and labelled', () => {
    const keys = Object.keys({ ...base, set: 0, custom: { count: 0, version: 0 } } satisfies Basis).sort()
    expect([...BASIS_KEYS].sort()).toEqual(keys)
    expect(Object.keys(BASIS_LABELS).sort()).toEqual(keys)
  })
})
