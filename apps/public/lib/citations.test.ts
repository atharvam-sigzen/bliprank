import { describe, expect, it } from 'vitest'
import type { ScanAnswers, StoredAnswer } from './answers'
import { SOURCE_ORDER, citationMix, labelFor, shortFor } from './citations'

/** Synthetic evidence: invented answers with invented citations, so the arithmetic can be checked by hand. */
const cite = (domain: string, sourceClass: string, position = 0) => ({ url: `https://${domain}/x`, position, sourceClass, domain })
const answer = (engine: string, citations: StoredAnswer['citations']): StoredAnswer => ({ prompt: 'q', engine, text: 'a', empty: false, collectedAt: '', citations })
const evidence = (answers: readonly StoredAnswer[]): ScanAnswers => ({ domain: 'acme.test', category: 'crm-software', day: '2026-09-01', comparisonBasis: 'b', algoVersion: 'det-2', answers })

describe('the citation mix', () => {
  it('counts citations, not answers, and gives every share a Wilson interval with n = citations', () => {
    const mix = citationMix(
      evidence([
        answer('chatgpt', [cite('acme.test', 'owned'), cite('g2.com', 'review', 1), cite('reddit.com', 'community', 2)]),
        answer('copilot', [cite('g2.com', 'review'), cite('hubspot.com', 'competitor', 1)]),
        answer('gemini', []),
        answer('gemini', []),
      ]),
    )
    expect(mix.total).toBe(5)
    expect(mix.answersWithAny).toBe(2)
    expect(mix.answersWithout).toBe(2)
    expect(mix.enginesWithNone).toEqual(['gemini'])
    expect(mix.classes.map((c) => [c.sourceClass, c.count])).toEqual([
      ['owned', 1],
      ['competitor', 1],
      ['review', 2],
      ['community', 1],
    ])
    for (const c of mix.classes) {
      // Share is a plain number now: no interval, no n, no basis. It used to be
      // a Metric carrying n = the CITATION total while `reach` beside it carries
      // n = the answers, both stamped with the same comparison_basis — two
      // denominators wearing one basis, which is the thing compare() trusts.
      expect(c.share).toBeCloseTo(c.count / 5)
      expect((c as unknown as { metric?: unknown }).metric).toBeUndefined()
      // ...and the provenance that used to be duplicated per class sits once.
      expect(mix.provenance).toContain('det-2')
    }
  })

  it('ranks hosts by citations, then name, and counts the distinct answers each was cited in', () => {
    const mix = citationMix(
      evidence([
        answer('chatgpt', [cite('g2.com', 'review'), cite('g2.com', 'review', 1), cite('acme.test', 'owned', 2)]),
        answer('copilot', [cite('g2.com', 'review'), cite('capterra.com', 'review', 1)]),
      ]),
    )
    expect(mix.hosts.map((h) => [h.domain, h.count, h.answers])).toEqual([
      ['g2.com', 3, 2],
      ['acme.test', 1, 1],
      ['capterra.com', 1, 1],
    ])
    expect(mix.hosts[1]!.sourceClass).toBe('owned')
  })

  it('a citation naming no host is counted in its class and never listed as a site', () => {
    const mix = citationMix(evidence([answer('google-ai-mode', [cite('', 'other'), cite('', 'other', 1), cite('acme.test', 'owned', 2)])]))
    expect(mix.total).toBe(3)
    expect(mix.unresolvable).toBe(2)
    expect(mix.hosts.map((h) => h.domain)).toEqual(['acme.test'])
    expect(mix.classes.find((c) => c.sourceClass === 'other')?.count).toBe(2)
  })

  it('with no citations at all there are no shares — wilson(0, 0) is refused, not shrugged', () => {
    const mix = citationMix(evidence([answer('gemini', []), answer('chatgpt', [])]))
    expect(mix.total).toBe(0)
    expect(mix.classes).toEqual([])
    expect(mix.hosts).toEqual([])
    expect(mix.enginesWithNone).toEqual(['chatgpt', 'gemini'])
  })

  it('an unknown class still counts, after the known ones, under its own name', () => {
    const mix = citationMix(evidence([answer('chatgpt', [cite('x.test', 'novel-class'), cite('acme.test', 'owned', 1)])]))
    expect(mix.classes.map((c) => c.sourceClass)).toEqual(['owned', 'novel-class'])
    expect(labelFor('novel-class')).toBe('novel-class')
    expect(shortFor('owned')).toBe('yours')
    expect(SOURCE_ORDER[0]).toBe('owned')
  })
})
