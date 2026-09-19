import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatFrequency, formatInterval, formatValue, wilson, type Metric } from '@bliprank/stats'
import type { ScanAnswers, StoredAnswer } from '../lib/answers'
import { citationMix } from '../lib/citations'
import { SCAN } from '../lib/scan-result'
import { simpleView } from '../lib/simple-view'
import { CitedSourcesBody } from './cited-sources'

/**
 * THE REACH VISUAL AND THE HOST BARS, RENDERED — D4 item 2.
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

/**
 * The exact same branching `ReachClause` does, kept here only to assert the
 * rendered markup matches whichever branch `formatFrequency` actually takes —
 * never to guess in advance which branch a given sample lands in. A Wilson
 * interval's shape at a given n and count is `packages/stats`'s to decide, not
 * this file's to predict.
 */
function expectedClause(m: Metric, n: number): string {
  const spoken = formatFrequency(m)
  if (spoken.kind === 'ratio') return `in about <span class="num">${spoken.point}</span> of answers`
  if (spoken.kind === 'none') return `in none of the <span class="num">${n}</span> answers`
  return `in <span class="num">${formatValue(m)}</span> of answers (range <span class="num">${formatInterval(m)}</span>)`
}

describe('a real-sized cycle: the reach strip and the plain reading', () => {
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
  const simple = simpleView(html)

  it('draws one .estrip band per class, positioned at its own Wilson interval', () => {
    const owned = wilson(10, N)
    const review = wilson(16, N)
    expect(html).toContain(`class="estrip__band" style="left:${owned.ci_low * 100}%;width:${(owned.ci_high - owned.ci_low) * 100}%"`)
    expect(html).toContain(`class="estrip__band" style="left:${review.ci_low * 100}%;width:${(review.ci_high - review.ci_low) * 100}%"`)
  })

  it('the plain sentence speaks the SAME numbers formatFrequency produces, not a rounded guess', () => {
    const review = mix.classes.find((c) => c.sourceClass === 'review')!
    const owned = mix.classes.find((c) => c.sourceClass === 'owned')!
    expect(html).toContain(`pointed at <strong>review sites</strong> ${expectedClause(review.reach, mix.answersInSample)}`)
    expect(html).toContain(`own site ${expectedClause(owned.reach, mix.answersInSample)}`)
  })

  it('n is on the page at both depths, beside the same numbers it belongs to', () => {
    expect(html).toContain(`${10} of ${N}`)
    expect(html).toContain(`${16} of ${N}`)
    expect(simple).toContain(`${10} of ${N}`)
  })

  it('this sample clears the floor, so no small-sample caveat is drawn', () => {
    expect(html).not.toContain('so these ranges are wide')
  })

  it('the exact class table is real .detail — dropped at simple depth, present at full depth', () => {
    expect(html).toContain('table-wrap')
    expect(html).toContain(`${Math.round((16 / mix.total) * 100)}%`)
    expect(simple).not.toContain('table-wrap')
    expect(simple).not.toContain('caption')
  })

  it('survives at simple depth: the estrip visual and its sentence are not marked .detail', () => {
    expect(simple).toContain('estrip__band')
    expect(simple).toContain('What kind of site the engines pointed to')
  })
})

describe('most cited sites: magnitude bars, scaled to their own maximum', () => {
  const answers: StoredAnswer[] = [
    answer({ citations: [cite('g2.com', 'review'), cite('g2.com', 'review', 1), cite('acme.test', 'owned', 2)] }),
    answer({ citations: [cite('g2.com', 'review'), cite('capterra.com', 'review', 1)] }),
  ]
  const ev = evidence(answers)
  const mix = citationMix(ev)
  const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)
  const simple = simpleView(html)

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

describe('every own-site clause in the reach sentence traces to formatValue when the frequency framing refuses', () => {
  it('a reach whose interval reaches past one half falls back to the percentage, never an inline toFixed', () => {
    // 30 of 40 answers reach the owned class: ci_high certainly exceeds the
    // 0.5 ceiling formatFrequency refuses above, so the sentence must fall
    // back to the plain percentage rather than inventing a "1 in k" for it.
    const answers: StoredAnswer[] = Array.from({ length: 40 }, (_, i) => answer({ citations: i < 30 ? [cite('acme.test', 'owned')] : [] }))
    const ev = evidence(answers)
    const mix = citationMix(ev)
    const own = mix.classes.find((c) => c.sourceClass === 'owned')!
    const spoken = formatFrequency(own.reach)
    expect(spoken.kind).toBe('unavailable')
    const html = renderToStaticMarkup(<CitedSourcesBody mix={mix} answers={ev} subjectName="acme.test" scan={SCAN} />)
    expect(html).toContain(`own site in <span class="num">${formatValue(own.reach)}</span> of answers`)
  })
})
