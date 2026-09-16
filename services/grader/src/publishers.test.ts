import { describe, expect, it } from 'vitest'
import type { ScanAnswers } from './answers.js'
import { applyRegistry, proposeCandidates, tallyOther } from './publishers.js'

/** Synthetic evidence: invented answers and citations, hand-countable. */
const cite = (domain: string, sourceClass = 'other') => ({ url: `https://www.${domain}/x`, position: 0, sourceClass, domain })
const answer = (prompt: string, engine: string, citations: ReturnType<typeof cite>[]) => ({ prompt, engine, text: 'a', empty: false, collectedAt: '', citations })
const evidence = (answers: ReturnType<typeof answer>[]): ScanAnswers => ({ domain: 'acme.test', category: 'crm-software', day: '2026-09-01', comparisonBasis: 'b', algoVersion: 'det-2', answers })

describe('the tally counts what no table names', () => {
  it('by registrable domain, with distinct answers, prompts and engines, ignoring hostless and non-other citations', () => {
    const t = tallyOther([
      {
        subject: 'acme.test',
        answers: evidence([
          answer('p1', 'chatgpt', [cite('techradar.com'), cite('techradar.com'), cite('g2.com', 'review')]),
          answer('p2', 'copilot', [cite('techradar.com'), cite('', 'other')]),
          answer('p1', 'gemini', [cite('zipdo.co')]),
        ]),
      },
    ])
    expect(t.map((h) => [h.domain, h.citations, h.answers, h.prompts, h.engines])).toEqual([
      ['techradar.com', 3, 2, 2, 2],
      ['zipdo.co', 1, 1, 1, 1],
    ])
  })
})

describe('candidates clear the promotion bar and are marked against the registry and the refusals', () => {
  const tally = [
    // In the order tallyOther emits: most cited first. proposeCandidates keeps it.
    { domain: 'zipdo.co', citations: 6, answers: 5, prompts: 3, engines: 2, subjects: ['a'], sample: 'https://zipdo.co/x' },
    { domain: 'techradar.com', citations: 4, answers: 3, prompts: 2, engines: 2, subjects: ['a'], sample: 'https://techradar.com/x' },
    { domain: 'newsite.example', citations: 3, answers: 3, prompts: 2, engines: 2, subjects: ['a', 'b'], sample: 'https://newsite.example/x' },
    { domain: 'once.example', citations: 1, answers: 1, prompts: 1, engines: 1, subjects: ['a'], sample: 'https://once.example/x' },
  ]
  it('marks in-registry, refused and candidate, and drops what does not clear the bar', () => {
    const c = proposeCandidates(tally, { 'techradar.com': 'TechRadar' }, [{ domain: 'zipdo.co', why: 'statistics farm' }])
    expect(c.map((x) => [x.domain, x.status])).toEqual([
      ['zipdo.co', 'refused'],
      ['techradar.com', 'in-registry'],
      ['newsite.example', 'candidate'],
    ])
    expect(c[0]!.refusedWhy).toBe('statistics farm')
  })
})

describe('the dry run moves only other → earned media, and only for registry domains', () => {
  it('reports before, after and what matched', () => {
    const r = applyRegistry(
      evidence([
        answer('p1', 'chatgpt', [cite('techradar.com'), cite('forbes.com'), cite('g2.com', 'review'), cite('hubspot.com', 'competitor')]),
        answer('p2', 'copilot', [cite('zipdo.co'), cite('techradar.com'), cite('', 'other')]),
      ]),
      { 'techradar.com': 'TechRadar', 'forbes.com': 'Forbes' },
    )
    expect(r).toEqual({
      total: 7,
      otherBefore: 5,
      otherAfter: 2,
      earnedMedia: 3,
      matched: [
        { domain: 'techradar.com', name: 'TechRadar', citations: 2 },
        { domain: 'forbes.com', name: 'Forbes', citations: 1 },
      ],
    })
  })
})
