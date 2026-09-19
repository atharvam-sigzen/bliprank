import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatFrequency, wilson } from '@bliprank/stats'
import type { ScanAnswers, StoredAnswer } from '../lib/answers'
import { citationMix } from '../lib/citations'
import { SCAN } from '../lib/scan-result'
import { simpleView } from '../lib/simple-view'
import { CitedSourcesBody } from './cited-sources'

/**
 * THE REACH VISUAL AND THE HOST BARS, RENDERED — D4 item 2, and the review
 * that followed it (2026-09-19): one BLOCKER (the reach sentence dropped its
 * own bounds) and MAJORs 4 and 5, fixed here alongside their tests.
 *
 * Synthetic evidence throughout, the same discipline `citations.test.ts`
 * already uses: invented answers with invented citations, so every number
 * asserted below is arithmetic a reviewer can check by hand rather than a
 * property of whatever the shipped scan happens to carry today.
 */

const cite = (domain: string, sourceClass: string, position = 0) => ({ url: `https://${domain}/x`, position, sourceClass, domain })
const answer = (over: Partial<StoredAnswer> & Pick<StoredAnswer, 'citations'>): StoredAnswer => ({
  prompt: 'q',
  engine: 'chatgpt',
  text: 'a',
  empty: false,
  collectedAt: '',
  ...over,
})
const evidence = (answers: readonly StoredAnswer[]): ScanAnswers => ({
  domain: 'acme.test',
  category: 'crm-software',
  day: '2026-09-01',
  comparisonBasis: 'b',
  algoVersion: 'det-2',
  answers,
})

describe('BLOCKER (R8): the reach sentence carries its own bounds, not only aria-hidden geometry', () => {
  const N = 40
  const answers: StoredAnswer[] = []
  for (let i = 0; i < N; i++) {
    const citations = []
    if (i < 10) citations.push(cite('acme.test', 'owned'))
    if (i < 16) citations.push(cite('g2.com', 'review', 1))
    answers.push(answer({ citations }))
  }
  const ev = evidence(answers)
  const mix = citationMix(ev)
  const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)

  /*
   * ⚠️ NOT `expectedClause` REIMPLEMENTING THE COMPONENT'S OWN BRANCHING.
   * The first version of this test built the exact JSX string the component
   * was expected to produce and compared it byte for byte — which asserts the
   * component agrees with itself, and would still pass with the bounds
   * dropped as long as the surrounding words matched. What actually matters
   * is only that BOTH of `formatFrequency`'s bounds appear in the rendered
   * text, whichever branch it takes; that is checked directly below, against
   * the reach paragraph only, so a bound quoted somewhere else on the page
   * (the exact table's own numbers) cannot make this pass by accident.
   */
  const reachParagraph = /<p class="prose" style="margin-top:var\(--space-3\)">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ''

  /** Both bounds `formatFrequency` names for this metric, whichever branch it takes — never assumed of it. */
  const bounds = (m: (typeof mix.classes)[number]['reach']) => {
    const spoken = formatFrequency(m)
    if (spoken.kind === 'ratio') return [spoken.low, spoken.high]
    if (spoken.kind === 'none') return [spoken.high]
    return [`${(m.ci_low * 100).toFixed(1)}`, `${(m.ci_high * 100).toFixed(1)}`]
  }

  it('review sites: both bounds are in the sentence, not only the band geometry', () => {
    const review = mix.classes.find((c) => c.sourceClass === 'review')!
    for (const b of bounds(review.reach)) expect(reachParagraph).toContain(b)
  })

  it("the subject's own site: both bounds are in the sentence too", () => {
    const owned = mix.classes.find((c) => c.sourceClass === 'owned')!
    for (const b of bounds(owned.reach)) expect(reachParagraph).toContain(b)
  })

  it('MINOR h: the denominator is named in the clause itself, not left implicit', () => {
    expect(reachParagraph).toContain(`<span class="num">${N}</span> answers`)
  })

  it('n is on the page at both depths, beside the same numbers it belongs to', () => {
    const simple = simpleView(html)
    expect(html).toContain(`${10} of ${N}`)
    expect(html).toContain(`${16} of ${N}`)
    expect(simple).toContain(`${10} of ${N}`)
  })

  it('the exact class table is real .detail — dropped at simple depth, present at full depth', () => {
    const simple = simpleView(html)
    expect(html).toContain('table-wrap')
    expect(simple).not.toContain('table-wrap')
    expect(simple).not.toContain('caption')
  })

  it('survives at simple depth: the estrip visual and its sentence are not marked .detail', () => {
    const simple = simpleView(html)
    expect(simple).toContain('estrip__band')
    expect(simple).toContain('What kind of site the engines pointed to')
  })
})

describe('MAJOR 4: naming a class is a claim of separation, gated exactly as IntentSplit gates it', () => {
  it('when the reach candidate is NOT separated from another class, no class is bolded — all are listed in SOURCE_ORDER', () => {
    // review 16/40 and community 14/40: their Wilson intervals overlap
    // comfortably (checked below), so nothing here may be named as leading.
    const N = 40
    const answers: StoredAnswer[] = []
    for (let i = 0; i < N; i++) {
      const citations = []
      if (i < 16) citations.push(cite('g2.com', 'review'))
      if (i < 14) citations.push(cite('reddit.com', 'community', 1))
      answers.push(answer({ citations }))
    }
    const ev = evidence(answers)
    const mix = citationMix(ev)
    const review = mix.classes.find((c) => c.sourceClass === 'review')!
    const community = mix.classes.find((c) => c.sourceClass === 'community')!
    expect(review.reach.ci_low).toBeLessThan(community.reach.ci_high)
    expect(community.reach.ci_low).toBeLessThan(review.reach.ci_high)

    const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)
    expect(html).not.toMatch(/pointed at <strong>/)
    expect(html).toContain('No one kind of site clearly leads by reach')
    // SOURCE_ORDER: review before community.
    expect(html.indexOf('review sites')).toBeLessThan(html.indexOf('community threads'))
  })

  it('when the top candidate IS separated from every other class, it is named and bolded', () => {
    // review reaches 38/40; community reaches only 2/40 — the two intervals
    // cannot plausibly touch.
    const N = 40
    const answers: StoredAnswer[] = []
    for (let i = 0; i < N; i++) {
      const citations = []
      if (i < 38) citations.push(cite('g2.com', 'review'))
      if (i < 2) citations.push(cite('reddit.com', 'community', 1))
      answers.push(answer({ citations }))
    }
    const ev = evidence(answers)
    const mix = citationMix(ev)
    const review = mix.classes.find((c) => c.sourceClass === 'review')!
    const community = mix.classes.find((c) => c.sourceClass === 'community')!
    expect(review.reach.ci_low).toBeGreaterThan(community.reach.ci_high)

    const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)
    expect(html).toContain('pointed at <strong>review sites</strong>')
    expect(html).not.toContain('No one kind of site clearly leads')
  })

  it('with only one non-owned class there is nothing to overlap with, so it is always named', () => {
    const ev = evidence([answer({ citations: [cite('g2.com', 'review'), cite('acme.test', 'owned', 1)] }), answer({ citations: [cite('g2.com', 'review')] })])
    const mix = citationMix(ev)
    const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)
    expect(html).toContain('pointed at <strong>review sites</strong>')
  })
})

describe('MAJOR 5: the distinct-site count is headline-only, not inflated by custom-prompt answers', () => {
  it('a site cited only in a custom-prompt answer is not counted among the distinct sites', () => {
    const ev = evidence([
      answer({ citations: [cite('g2.com', 'review')] }),
      answer({ citations: [cite('onlyincustom.test', 'other')], custom: true }),
    ])
    const mix = citationMix(ev)
    const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)
    // The headline has exactly one distinct site (g2.com); the custom answer's
    // site must not inflate the count the opening sentence states.
    expect(html).toContain('<span class="num">1</span> distinct sites')
  })
})

describe('MINOR (a): a class with real citations never rounds to 0%', () => {
  it('prints "<1%" rather than "0%" for a thin but real share', () => {
    // 1 citation to `other` against 250 to `review`: 1/251 rounds to 0% under
    // plain Math.round, which reads as "none" — a different claim.
    const answers: StoredAnswer[] = [
      answer({ citations: [cite('x.test', 'other'), ...Array.from({ length: 250 }, () => cite('g2.com', 'review'))] }),
    ]
    const ev = evidence(answers)
    const mix = citationMix(ev)
    const other = mix.classes.find((c) => c.sourceClass === 'other')!
    expect(Math.round(other.share * 100)).toBe(0)
    const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)
    // `<` is HTML-escaped in rendered text content.
    expect(html).toContain('&lt;1%')
    expect(html).not.toMatch(/other[\s\S]{0,200}>0%</)
  })
})

describe('MINOR (g): the host list names itself as a top, and the small-gap caveat', () => {
  const answers: StoredAnswer[] = [
    answer({ citations: [cite('g2.com', 'review'), cite('g2.com', 'review', 1), cite('acme.test', 'owned', 2)] }),
    answer({ citations: [cite('g2.com', 'review'), cite('capterra.com', 'review', 1)] }),
  ]
  const ev = evidence(answers)
  const mix = citationMix(ev)
  const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)

  it('states the list is a top-N of a real total', () => {
    expect(html).toContain(`The <span class="num">${mix.hosts.length}</span> sites cited most often, of <span class="num">3</span> in total`)
  })

  it('warns that a small gap between neighbours is not a finding', () => {
    expect(html).toContain('A gap of one or two citations between neighbouring sites is not a finding')
  })

  it('the top host draws a full-width bar, others scaled against it', () => {
    expect(mix.hosts[0]!.domain).toBe('g2.com')
    expect(html).toContain('class="hostbar__fill" style="width:100%"')
    const acme = mix.hosts.find((h) => h.domain === 'acme.test')!
    expect(html).toContain(`class="hostbar__fill" style="width:${(acme.count / mix.hosts[0]!.count) * 100}%"`)
  })

  it('names the most-cited site in one sentence, with its real counts', () => {
    expect(html).toContain('Cited most often: <strong>g2.com</strong>')
    expect(html).toContain(`<span class="num">${mix.hosts[0]!.count}</span>`)
  })

  it('survives at simple depth, the exact table does not', () => {
    const simple = simpleView(html)
    expect(simple).toContain('hostbar__fill')
    expect(simple).not.toContain('table-wrap')
  })
})

describe('the zero-hosts case: every citation is an unresolvable redirect', () => {
  const answers: StoredAnswer[] = [answer({ citations: [cite('', 'other'), cite('', 'other', 1)] })]
  const ev = evidence(answers)
  const mix = citationMix(ev)
  const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)

  it('says plainly that no site can be ranked, and draws no bars', () => {
    expect(mix.hosts).toEqual([])
    expect(html).toContain('no individual site can be ranked')
    expect(html).not.toContain('hostbar__fill')
  })

  it('the reach strip still draws — "other" is a class even with no nameable site', () => {
    expect(html).toContain('estrip__band')
  })
})

describe('the small-n case: a handful of answers makes the ranges wide', () => {
  const answers: StoredAnswer[] = Array.from({ length: 5 }, (_, i) => answer({ citations: i < 2 ? [cite('g2.com', 'review')] : [] }))
  const ev = evidence(answers)
  const mix = citationMix(ev)
  const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)

  it('the caveat names the real sample size', () => {
    expect(html).toContain('This reads from only <span class="num">5</span> answers')
  })
})

describe('the zero-citations case is unchanged: no visual is invented over nothing', () => {
  const ev = evidence([answer({ citations: [] }), answer({ citations: [] })])
  const mix = citationMix(ev)
  const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)

  it('draws neither the reach strip nor the host bars', () => {
    expect(html).not.toContain('estrip')
    expect(html).not.toContain('hostbar')
    expect(html).toContain('No answer in this cycle cited a source')
  })
})

describe('a reach whose interval reaches past one half falls back to the percentage, with its own bounds', () => {
  it('never an inline toFixed, and the range is still named', () => {
    // 30 of 40 answers reach the owned class: ci_high certainly exceeds the
    // 0.5 ceiling formatFrequency refuses above, so the sentence must fall
    // back to the plain percentage rather than inventing a "1 in k" for it —
    // and it must still carry the range, not just the point.
    const answers: StoredAnswer[] = Array.from({ length: 40 }, (_, i) => answer({ citations: i < 30 ? [cite('acme.test', 'owned')] : [] }))
    const ev = evidence(answers)
    const mix = citationMix(ev)
    const own = mix.classes.find((c) => c.sourceClass === 'owned')!
    const spoken = formatFrequency(own.reach)
    expect(spoken.kind).toBe('unavailable')
    const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)
    const w = wilson(30, 40)
    expect(html).toContain('own site in <span class="num">75.0%</span>')
    expect(html).toContain(`${(w.ci_low * 100).toFixed(1)}`)
    expect(html).toContain(`${(w.ci_high * 100).toFixed(1)}`)
  })
})
