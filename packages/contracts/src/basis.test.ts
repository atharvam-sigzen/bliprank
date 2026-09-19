import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BASIS_KEYS, BASIS_LABELS, basisDifference, customBasisOf, formatBasis, headlineSetOf, parseBasis, promptSetFingerprint, sameBasis, sha256Hex, type Basis } from './basis.js'
import { NORMALISATION_VERSION, normalisePrompt } from './normalise.js'

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
    ['grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=0|runs=1|custom=3@1#', 'an empty fingerprint'],
    ['grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=0|runs=1|custom=3@1#9f2c', 'a short fingerprint'],
    ['grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=0|runs=1|custom=3@1#9F2C41AA07BE', 'an upper-case fingerprint'],
    ['grader|engines=chatgpt|en-US|US|crm-software@1|unprompted=0|runs=1|custom=3@1#9f2c41aa07be00', 'a long fingerprint'],
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

describe('the custom tail identifies the sample, not only its label (MVP_PLAN C3r item 1)', () => {
  const A = ['What is the best CRM for a small team?', 'Which CRM has the best mobile app?', 'Which CRM is cheapest to start with?']
  const B = ['What is the best CRM for a small team?', 'Which CRM has the best mobile app?', 'Which CRM do accountants recommend?']
  const on = (prompts: readonly string[], version: number): string => formatBasis({ ...base, unprompted: 0, custom: customBasisOf(prompts, version) })

  it('the writer stamps count, version and a twelve-hex fingerprint, and the parser reads all three back', () => {
    const s = on(A, 1)
    expect(s).toMatch(/\|unprompted=0\|runs=1\|custom=3@1#[0-9a-f]{12}$/)
    expect(parseBasis(s)?.custom).toEqual({ count: 3, version: 1, fingerprint: promptSetFingerprint(A) })
    expect(formatBasis(parseBasis(s)!)).toBe(s)
  })

  it('TWO DIFFERENT SETS AT THE SAME K AND V NO LONGER SHARE A BASIS: they did, byte for byte, before the fingerprint', () => {
    const before = (version: number) => formatBasis({ ...base, unprompted: 0, custom: { count: 3, version } })
    expect(before(1)).toBe(before(1)) // the defect: nothing in the string said which three prompts
    expect(on(A, 1)).not.toBe(on(B, 1))
    expect(sameBasis(on(A, 1), on(B, 1))).toBe(false)
    expect(basisDifference(on(A, 1), on(B, 1))).toBe('measured on a different basis: the custom prompt set (3@1 on both, and the questions recorded for the two do not match)')
  })

  it('A REVERT TO AN IDENTICAL SET SHARES ITS BASIS: version 3 holding the list version 1 held is the same sample, and the version between them is not', () => {
    const v1 = on(A, 1)
    const v2 = on(B, 2)
    const v3 = on(A, 3)
    expect(v3).not.toBe(v1) // the pointer moved: the stored version is 3, and the string says so
    expect(sameBasis(v3, v1)).toBe(true)
    expect(basisDifference(v3, v1)).toBeNull()
    expect(sameBasis(v2, v1)).toBe(false)
    expect(sameBasis(v3, v2)).toBe(false)
    expect(basisDifference(v2, v1)).toBe('measured on a different basis: the custom prompt set (3@1 against 3@2)')
  })

  it('the same list under another spelling or order is one sample; one prompt reworded is another', () => {
    const respelt = ['  which CRM is cheapest to start with  ', 'WHICH CRM HAS THE BEST MOBILE APP?', 'What is the best CRM for a small team?!']
    expect(promptSetFingerprint(respelt)).toBe(promptSetFingerprint(A))
    expect(promptSetFingerprint([...A].reverse())).toBe(promptSetFingerprint(A))
    // A REPEATED PROMPT IS A DIFFERENT SAMPLE (stats review of C3r item 1, MAJOR 1). A cycle asks one cell per list ENTRY
    // (scan.ts `customCellsFor`), so a repeat is a question weighted twice, and the fingerprint is of what is asked, repeats included.
    expect(promptSetFingerprint([...A, A[0]!])).not.toBe(promptSetFingerprint(A))
    expect(promptSetFingerprint(B)).not.toBe(promptSetFingerprint(A))
    expect(promptSetFingerprint([A[0]!, A[1]!])).not.toBe(promptSetFingerprint(A))
  })

  it('TWO LISTS THAT WEIGHT THE SAME QUESTIONS DIFFERENTLY DO NOT SHARE A BASIS: the reviewer’s pair, same K, same V, same distinct prompts', () => {
    const [p, q] = ['Which CRM is best for a small team?', 'Which CRM has the best mobile app?']
    const heavyP = on([p!, p!, q!], 1)
    const heavyQ = on([p!, q!, q!], 1)
    expect(heavyP).not.toBe(heavyQ)
    expect(sameBasis(heavyP, heavyQ)).toBe(false)
    // Order still does not matter: the same multiset is the same sample.
    expect(on([q!, p!, p!], 1)).toBe(heavyP)
  })

  it('anyone holding the list can reproduce the fingerprint with a standard SHA-256: the published recipe, for every list, with no step left out', () => {
    const recipe = (prompts: readonly string[]): string =>
      createHash('sha256')
        .update(JSON.stringify([NORMALISATION_VERSION, prompts.map(normalisePrompt).sort()]))
        .digest('hex')
        .slice(0, 12)
    // Including the lists an earlier draft treated specially: a repeat, and a prompt that normalises to nothing.
    for (const list of [A, B, [...A, A[0]!], ['Which CRM is best for a small team?', '??????????'], []]) expect(promptSetFingerprint(list), JSON.stringify(list)).toBe(recipe(list))
  })

  it('the normaliser’s version is inside the fingerprint, so a change of normaliser moves it honestly rather than by accident', () => {
    const withVersion = (v: number): string => createHash('sha256').update(JSON.stringify([v, A.map(normalisePrompt).sort()])).digest('hex').slice(0, 12)
    expect(promptSetFingerprint(A)).toBe(withVersion(NORMALISATION_VERSION))
    expect(promptSetFingerprint(A)).not.toBe(withVersion(NORMALISATION_VERSION + 1))
  })

  it('only the version may differ: the same list under another engine set, bank version or count is another basis', () => {
    const v1 = on(A, 1)
    expect(sameBasis(formatBasis({ ...base, unprompted: 0, engines: ['chatgpt'], custom: customBasisOf(A, 3) }), v1)).toBe(false)
    expect(sameBasis(formatBasis({ ...base, unprompted: 0, bank: { slug: 'crm-software', version: 2 }, custom: customBasisOf(A, 3) }), v1)).toBe(false)
    expect(sameBasis(formatBasis({ ...base, unprompted: 0, set: 1, custom: customBasisOf(A, 3) }), v1)).toBe(false)
    // A hand-made tail whose count disagrees with its list: the fingerprint drops duplicates and the count did not.
    expect(sameBasis(formatBasis({ ...base, unprompted: 0, custom: { ...customBasisOf(A, 3), count: 4 } }), v1)).toBe(false)
  })

  it('A STORED CYCLE WITHOUT THE FINGERPRINT STILL PARSES, byte for byte, and is the same basis only as itself', () => {
    const stored = 'grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=0|runs=1|custom=3@1'
    expect(parseBasis(stored)).toEqual({ ...base, unprompted: 0, custom: { count: 3, version: 1 } })
    expect(formatBasis(parseBasis(stored)!)).toBe(stored)
    expect(sameBasis(stored, stored)).toBe(true)
    // It never recorded its list, so nothing can vouch that it is the list a later cycle asked: refused, in words that say why.
    expect(sameBasis(on(A, 1), stored)).toBe(false)
    // Said as the property, not as a history: nothing here knows which of the two is older (stats review, MINOR 2).
    expect(basisDifference(on(A, 1), stored)).toBe('measured on a different basis: the custom prompt set (3@1 on both, and one of them does not record which questions it held)')
    expect(basisDifference(stored, on(A, 1))).toBe('measured on a different basis: the custom prompt set (3@1 on both, and one of them does not record which questions it held)')
    // And two of them at different versions stay two bases, as they always were.
    expect(sameBasis(stored, stored.replace('custom=3@1', 'custom=3@2'))).toBe(false)
  })

  it('the difference is null exactly when the basis is the same, over every pairing of the forms above', () => {
    const forms = [on(A, 1), on(A, 3), on(B, 1), on(B, 2), formatBasis({ ...base, unprompted: 0, custom: { count: 3, version: 1 } }), formatBasis(base), formatBasis({ ...base, set: 1 }), 'legacy|x|y', '']
    for (const x of forms) {
      for (const y of forms) {
        expect(basisDifference(x, y) === null, `${x} / ${y}`).toBe(sameBasis(x, y))
        expect(sameBasis(x, y), `${x} / ${y}`).toBe(sameBasis(y, x))
      }
    }
  })

  it('the writer refuses a fingerprint that is not twelve lower-case hex characters', () => {
    expect(() => formatBasis({ ...base, custom: { count: 1, version: 1, fingerprint: 'XYZ' } })).toThrow(/fingerprint/)
  })
})

describe('one predicate for "is this measurement over a person\u2019s own set" (MVP_PLAN C3r item 6)', () => {
  it('needs BOTH halves: the custom tail, and unprompted=0 on the same basis', () => {
    const own = formatBasis({ ...base, unprompted: 0, custom: customBasisOf(['which crm suits a small team'], 2) })
    expect(headlineSetOf(own)).toMatchObject({ count: 1, version: 2 })
    // The bank's headline: no tail.
    expect(headlineSetOf(formatBasis(base))).toBeNull()
    // A tail beside bank prompts is not a headline set. The re-score used to read this as one: it asked for the tail and not for unprompted=0.
    expect(headlineSetOf(formatBasis({ ...base, unprompted: 17, custom: { count: 2, version: 1 } }))).toBeNull()
    // A stored cycle from before the fingerprint is still a headline set.
    expect(headlineSetOf(formatBasis({ ...base, unprompted: 0, custom: { count: 3, version: 1 } }))).toEqual({ count: 3, version: 1 })
    for (const s of [undefined, '', 'legacy|x|y']) expect(headlineSetOf(s)).toBeNull()
  })
})

describe('the hash written out for the browser is SHA-256', () => {
  it('agrees with Node over every length that crosses a padding boundary, and over text that is not ASCII', () => {
    for (let len = 0; len <= 260; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff)
      expect(sha256Hex(bytes), `length ${len}`).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
    for (const text of ['', 'abc', 'quel est le meilleur CRM pour une équipe réduite', '最好的客户关系管理软件是什么', '🧪 emoji and ﬁ ligatures']) {
      expect(sha256Hex(new TextEncoder().encode(text))).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    }
  })

  it('the published test vector', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('the definition cannot drift from itself', () => {
  it('every key the shape has is written, compared and labelled', () => {
    const keys = Object.keys({ ...base, set: 0, custom: { count: 0, version: 0 } } satisfies Basis).sort()
    expect([...BASIS_KEYS].sort()).toEqual(keys)
    expect(Object.keys(BASIS_LABELS).sort()).toEqual(keys)
  })
})
