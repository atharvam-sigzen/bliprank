import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { wilson, type Metric } from '@bliprank/stats'
import { sentence } from '../lib/simple-view'
import { Headline } from './headline'

/**
 * THE LEDE, IN EVERY SHAPE IT CAN TAKE.
 *
 * One sentence carries the whole plain reading on both surfaces, so each branch
 * has to be read as English rather than merely produced. The collision branch
 * exists because one of them was NOT read, and shipped: at n=750 the dashboard
 * said "in about 1 in 3 answers. Could be as few as 1 in 4, or as many as 1 in
 * 3" — a closing clause that says nothing. It was found by rendering the page,
 * which is coverage apps/web only just acquired.
 */

const metric = (k: number, n: number): Metric => {
  const w = wilson(k, n)
  return {
    value: w.value,
    ci_low: w.ci_low,
    ci_high: w.ci_high,
    n: w.n,
    algo_version: 'det-1',
    collection_path: 'third-party-grounded',
    comparison_basis: 'five-engine/en-GB/GB/30d',
  }
}

const say = (k: number, n: number, engines = 5) =>
  sentence(renderToStaticMarkup(<Headline subject="Acme" metric={metric(k, n)} engines={engines} />))

describe('the frequency form', () => {
  it('reads as the sentence the design was built on', () => {
    // n=150 at p̂≈25%, the Starter unit.
    expect(say(37, 150)).toBe('AI assistants mention Acme in about 1 in 4 answers. Could be as few as 1 in 6, or as many as 1 in 3. From 150 answers across 5 engines.')
  })

  it('names both bounds and the sample, so R8 holds in words', () => {
    const s = say(15, 150)
    expect(s).toMatch(/as few as 1 in \d+/)
    expect(s).toMatch(/as many as 1 in \d+/)
    expect(s).toContain('From 150 answers across 5 engines')
  })
})

describe('the collision form', () => {
  it('states a range when the estimate rounds onto one of its own bounds', () => {
    // n=750 at p̂=29.3% — the dashboard's own figures, and the case that shipped
    // reading "about 1 in 3 … as many as 1 in 3".
    expect(say(220, 750)).toBe('AI assistants mention Acme in 1 in 4 to 1 in 3 answers. From 750 answers across 5 engines.')
  })

  it('never says "as many as X" where X is the estimate it just gave', () => {
    /*
     * THE PROPERTY, NOT THE EXAMPLE. Swept over every real Wilson interval, no
     * rendered sentence may name the same frequency twice — that is the whole
     * defect, and an example test would only pin the one case it was written
     * from.
     */
    for (const n of [30, 50, 100, 150, 300, 600, 750, 1000]) {
      for (let k = 0; k <= n; k += Math.max(1, Math.floor(n / 40))) {
        const s = say(k, n)
        const spoken = [...s.matchAll(/1 in (\d+)/g)].map((m) => m[1])
        expect([n, k, new Set(spoken).size]).toEqual([n, k, spoken.length])
      }
    }
  })

  it('keeps the sample size in the collision form too', () => {
    expect(say(220, 750)).toContain('From 750 answers')
  })
})

describe('the percentage fallback', () => {
  it('prints an exact interval where a frequency would mislead', () => {
    // n=600 at p̂=25%: "1 in 5 to 1 in 3" would inflate 1.93x, so it is refused.
    const s = say(150, 600)
    expect(s).not.toContain('1 in')
    expect(s).toContain('The range is')
    expect(s).toContain('From 600 answers across 5 engines')
  })
})

describe('the shapes that are not sentences', () => {
  it('renders nothing at all when the brand was never mentioned', () => {
    // The surfaces have their own zero treatment, which says more than a lede
    // should. Printing both would state one finding twice.
    expect(renderToStaticMarkup(<Headline subject="Acme" metric={metric(0, 150)} engines={5} />)).toBe('')
  })

  it('omits the engine clause rather than claiming zero engines', () => {
    const s = say(37, 150, 0)
    expect(s).toContain('From 150 answers.')
    expect(s).not.toContain('engines')
  })

  it('says "engine" for one, "engines" for more', () => {
    expect(say(37, 150, 1)).toContain('across 1 engine.')
    expect(say(37, 150, 2)).toContain('across 2 engines.')
  })
})
