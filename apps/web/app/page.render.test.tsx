import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { simpleView, words } from '../../public/lib/simple-view'
import { BY_ENGINE, CYCLE_DATES, ENGINES, HEADLINE, TREND } from '@/lib/fixtures'
import Dashboard from './page'

/**
 * THE DASHBOARD, ACTUALLY RENDERED — the coverage this app has never had.
 *
 * Until the importer-aware `@/` alias landed in vitest.config.ts, a test here
 * could not exist: `@/components/metric-card` resolved into apps/public and
 * failed, while `@/components/chrome` resolved into apps/public and SUCCEEDED,
 * rendering the wrong component. Two defects shipped behind that gap — the
 * rail's mislabelled-axis fix never crossing the deploy boundary, and a fixture
 * whose masthead and headline disagreed about the sample size. Neither was
 * findable by a source scan; both are obvious here.
 *
 * The first block is therefore about the harness, not the page. If the alias
 * regresses, everything below it becomes a test of apps/public wearing this
 * file's name, and it would pass.
 */

const html = renderToStaticMarkup(<Dashboard />)
const simple = simpleView(html)

describe('THE HARNESS: this file renders apps/web, not apps/public', () => {
  it('paints apps/web own chrome, which apps/public has no way to produce', () => {
    // `navbar__wsstatic` is the static "worked example" slot.
    expect(html).toContain('navbar__wsstatic')
    expect(html).toContain('worked example')
  })

  it('and the marker it proves resolution with is genuinely exclusive', () => {
    /*
     * The assertion above is only proof while apps/public cannot produce that
     * class. Its stylesheet carries the rule and none of its components use it
     * — true today, and exactly the kind of premise that rots silently, taking
     * this whole file's meaning with it.
     */
    const publicChrome = readFileSync(new URL('../../public/components/chrome.tsx', import.meta.url), 'utf8')
    expect(publicChrome).not.toContain('navbar__wsstatic')
  })

  it('and carries none of apps/public own navigation', () => {
    // The role doors and the workspace switcher button exist only over there.
    expect(html).not.toContain('navbar__link--door')
    expect(html).not.toContain('navbar__wsbtn')
    expect(html).not.toContain('href="/agency"')
  })
})

describe('the rail draws the FIXED bounds row', () => {
  /*
   * ⚠️ THE REGRESSION GUARD FOR A BUG THAT SHIPPED. apps/public prints each
   * bound under the band edge it describes and states the fixed scale with a
   * quiet 0 and 100; apps/web kept the pre-fix row, two figures pinned to the
   * track's corners, where on a 0-100 track they read as the SCALE'S endpoints
   * — a mislabelled axis rather than a measurement. The fix never crossed the
   * deploy boundary because nothing rendered this page.
   */
  it('positions each bound and states the scale', () => {
    expect(html).toContain('rail__bounds--scale')
    expect(html).toContain('rail__bound')
    expect(html).toContain('rail__end')
  })

  it('and does not use the old corner-pinned row', () => {
    expect(html).not.toMatch(/class="rail__bounds"[^>]*>\s*<span>/)
  })

  it('every card keeps its own n at BOTH depths', () => {
    // Invariant 2 of ADR-0010. Three cards, three rails, three sample sizes.
    const railN = [...html.matchAll(/class="rail__n">n = (\d+)</g)].map((m) => m[1])
    expect(railN.length).toBe(3)
    for (const n of railN) expect(simple).toContain(`n = ${n}`)
  })
})

describe('the simple reading of the dashboard', () => {
  it('leads with the sentence, not with three competing numbers', () => {
    expect(simple).toContain('AI assistants mention')
    expect(simple).toContain('Acme CRM')
  })

  it('keeps every disclosure — the stamp and the timer notice both', () => {
    // Neither may ever be hidden: one says the numbers are fixture data, the
    // other says nothing ran on a timer.
    expect(simple).toContain('Illustrative data')
    expect(simple).toContain('No answers have been collected')
    expect(simple).toContain('Recurring collection is not built yet')
  })

  it('ORDER: the fixture disclosure precedes the first number, the timer notice follows it', () => {
    /*
     * The rule is "no claim precedes its own qualifier", and it does not fix
     * both. The stamp discloses that every figure here is fixture data, so it
     * must come before any figure. The timer notice qualifies CADENCE, and the
     * lede makes no cadence claim — so it may follow, and doing so moved the
     * headline 75 words earlier without leaving anything unqualified.
     */
    const stamp = simple.indexOf('Illustrative data')
    const lede = simple.indexOf('AI assistants mention')
    const notice = simple.indexOf('Recurring collection is not built yet')
    expect(stamp).toBeGreaterThan(-1)
    expect(stamp).toBeLessThan(lede)
    expect(lede).toBeLessThan(notice)
  })

  it('the cycle line carries the planned marker, RENDERED', () => {
    // planned.test.ts asserts this against the source, because for as long as
    // apps/web had no render coverage that was the only way to ask. This is the
    // same property observed on the output, where a marker that failed to
    // render would actually show.
    const line = /<p class="cycle">([\s\S]*?)<\/p>/.exec(html)?.[1]
    expect(line).toBeDefined()
    expect(line).toContain('planned')
    expect(simpleView(line!)).toContain('compared with')
  })

  it('the timer notice still sits above everything that makes the timer claim', () => {
    // Its own reason for existing: above every delta badge and above the trend.
    const notice = simple.indexOf('Recurring collection is not built yet')
    expect(notice).toBeLessThan(simple.indexOf('no significant change'))
    expect(notice).toBeLessThan(simple.indexOf('Mention rate over cycles'))
  })

  it('keeps all three cards — they are different questions, not extra depth', () => {
    for (const label of ['Mention rate', 'Citation rate', 'Share of voice']) expect(simple).toContain(label)
  })

  it('drops the per-engine table, the citation sources and the sample shape', () => {
    expect(simple).not.toContain('By engine')
    expect(simple).not.toContain('Where the citations come from')
    expect(simple).not.toContain('30 prompts')
    // ...while keeping the dates, which explain the delta badges that remain.
    expect(simple).toContain('Cycle 2026-08-15')
    expect(simple).toContain('compared with 2026-08-01')
  })

  it('drops every provenance footer and keeps no algorithm version', () => {
    expect(simple).not.toContain('algo det-1')
    expect(html).toContain('algo det-1')
  })

  it('is materially shorter than the full record', () => {
    expect(words(simple).length).toBeLessThan(words(html).length * 0.7)
  })
})

describe('the fixture reconciles with the claims the page makes about it', () => {
  /*
   * ⚠️ THE SECOND DEFECT THIS FILE EXISTS TO CATCH. The masthead states the
   * shape of the cycle and the cards state their own n; if those disagree the
   * page is two measurements wearing one heading, which is the exact
   * substitution this product argues against — and it disagreed.
   */
  it('the headline n is the sum of the per-engine n over the stated engine set', () => {
    const perEngine = BY_ENGINE.filter((r) => (ENGINES as readonly string[]).includes(r.engine))
    expect(perEngine.length).toBe(ENGINES.length)
    const total = perEngine.reduce((sum, r) => sum + r.current.n, 0)
    expect(HEADLINE.mentionRate.current.n).toBe(total)
  })

  it('and the masthead states that same total', () => {
    const shape = /(\d+) prompts × (\d+) runs × (\d+) engines/.exec(html)
    expect(shape).not.toBeNull()
    const [, prompts, runs, engines] = shape!.map(Number)
    expect(engines).toBe(ENGINES.length)
    expect(prompts! * runs! * engines!).toBe(HEADLINE.mentionRate.current.n)
  })

  it('THE THIRD MISMATCH: the trend tail IS the headline pair', () => {
    /*
     * The masthead names two dated cycles and says they are the ones compared.
     * The trend plots those same dates. They disagreed — 2026-08-01 was 41/150
     * on the chart and 37/150 in the delta badge — so a reader could read one
     * cycle's rate two ways on one screen. Both now come off the same array.
     */
    expect(HEADLINE.mentionRate.current).toBe(TREND[TREND.length - 1]!.metric)
    expect(HEADLINE.mentionRate.previous).toBe(TREND[TREND.length - 2]!.metric)
    expect(CYCLE_DATES.current).toBe(TREND[TREND.length - 1]!.cycle)
    expect(CYCLE_DATES.previous).toBe(TREND[TREND.length - 2]!.cycle)
    // ...and the masthead prints those dates rather than its own.
    expect(html).toContain(`Cycle ${CYCLE_DATES.current}`)
    expect(html).toContain(`compared with ${CYCLE_DATES.previous}`)
  })

  it('every point on the trend is measured over one cycle of answers', () => {
    for (const p of TREND) expect([p.cycle, p.metric.n]).toEqual([p.cycle, HEADLINE.mentionRate.current.n])
  })

  it('every headline metric is measured over the same cycle', () => {
    // Three cards over one cycle must share a denominator, or "share of voice"
    // and "mention rate" are answers about different amounts of evidence.
    expect(HEADLINE.citationRate.current.n).toBe(HEADLINE.mentionRate.current.n)
  })
})
