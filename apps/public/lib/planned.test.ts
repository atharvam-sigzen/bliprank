import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { PREVIEW_SCORE_CAPTION } from './preview-score'
import * as planned from './planned'
// The duplicate in the other app. Imported by relative path because there is no
// workspace dependency between the two apps - which is the whole reason the file
// is duplicated, and the whole reason this test exists.
import * as webCopy from '../../web/lib/planned'

describe('the planned marker', () => {
  it('says the capability is missing, not that the method is unsettled', () => {
    expect(planned.PLANNED_CAPTION.toLowerCase()).toContain('planned')
    expect(planned.PLANNED_CAPTION.toLowerCase()).toContain('not built')
    // The two provisional markers must not collapse into each other. A reader
    // who sees "preview" on a number and "planned" on a view has to be able to
    // tell that one of them means no code ran at all.
    expect(planned.PLANNED_CAPTION.toLowerCase()).not.toContain('preview')
    expect(PREVIEW_SCORE_CAPTION.toLowerCase()).not.toContain('planned')
  })

  it('states the scheduler gap in full', () => {
    const note = planned.NO_SCHEDULER_NOTE.toLowerCase()
    expect(note).toContain('not built yet')
    expect(note).toContain('no scheduler exists')
    // ...and still says what IS real, so the panel is not read as a mock-up.
    expect(note).toMatch(/significance rules/)
  })

  it('names the intended cadence and denies it is happening', () => {
    expect(planned.SCHEDULE_FACT).toContain('daily')
    expect(planned.SCHEDULE_FACT.toLowerCase()).toContain('nothing schedules')
  })

  it('keeps apps/web in step with the source of truth', () => {
    expect(webCopy.PLANNED_CAPTION).toBe(planned.PLANNED_CAPTION)
    expect(webCopy.NO_SCHEDULER_NOTE).toBe(planned.NO_SCHEDULER_NOTE)
    expect(webCopy.SCHEDULE_FACT).toBe(planned.SCHEDULE_FACT)
  })

  it('uses no em-dash in copy that reaches the screen', () => {
    for (const s of [planned.PLANNED_CAPTION, planned.NO_SCHEDULER_NOTE, planned.SCHEDULE_FACT]) {
      expect(s).not.toContain('—')
    }
  })
})

/**
 * THE CADENCE IS AN OFFER, NOT A FACT.
 *
 * `NO_SCHEDULER_NOTE` exists because nothing in this build runs on a timer. The
 * marker went on one chart while the two loudest surfaces in the product went on
 * asserting the schedule: the pricing page - the most public, indexable thing
 * here - stated recurring daily collection in the present tense five times and
 * caveated only that you cannot buy it; the worked example marked its trend
 * chart and left the masthead's two dated cycles, three delta badges and a "vs
 * previous cycle" column unmarked, which teaches a reader that the comparison
 * capability is real and only the chart is aspirational.
 */
describe('no surface asserts a cadence that nothing runs', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  it('the pricing page admits the scheduler gap, not only the missing checkout', () => {
    const src = read('../app/pricing/page.tsx').toLowerCase()
    expect(src).toContain('recurring collection is not built yet')
    expect(src).toMatch(/scheduler run(s)? a cycle/)
  })

  it('no cadence line on a commercial surface is in the present tense', () => {
    const banned = [/re-check(s|ed)? every prompt daily/i, /re-checked daily/i, /every day\b/i, /re-run daily/i, /engines, every day/i]
    const offenders: string[] = []
    for (const rel of ['../app/pricing/page.tsx', '../components/cap-split.tsx', '../lib/pricing.ts']) {
      for (const [i, line] of read(rel).split('\n').entries()) {
        // The file's own commentary about this fix necessarily quotes the claim.
        if (/^\s*(\*|\/\*|\/\/)/.test(line)) continue
        if (banned.some((b) => b.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the pricing metadata that reaches a search result is conditional', () => {
    // It is the one line here a reader can see without loading the page.
    const description = /description: '([^']+)'/.exec(read('../app/pricing/page.tsx'))?.[1] ?? ''
    expect(description).not.toMatch(/re-checked daily/i)
    expect(description.toLowerCase()).toContain('once collection is scheduled')
  })

  it('the worked example marks the timer claim above everything that makes it', () => {
    const src = read('../../web/app/page.tsx')
    const at = (needle: string) => {
      const i = src.indexOf(needle)
      expect([needle, i > -1]).toEqual([needle, true])
      return i
    }
    // Two dated cycles a fortnight apart is the timer claim in one sentence.
    const cycle = at('Cycle 2026-08-15')
    expect(src.slice(cycle, cycle + 240)).toContain('<Planned />')
    // The notice is above the delta badges and above the by-engine table, not
    // buried beside the chart. `{NO_SCHEDULER_NOTE}` is the use, not the import.
    const notice = at('{NO_SCHEDULER_NOTE}')
    expect(notice).toBeLessThan(at('previous={HEADLINE.mentionRate.previous}'))
    const column = at('vs previous cycle')
    expect(notice).toBeLessThan(column)
    // ...and the one column that exists only if a second cycle was collected.
    expect(src.slice(column, column + 80)).toContain('<Planned />')
  })

  it('the gap is worded once, from the shared constant, on every surface that states it', () => {
    // Two hand-written descriptions of one gap is how they drift apart.
    for (const rel of ['../../web/app/page.tsx']) {
      const src = read(rel)
      expect([rel, src.includes('{NO_SCHEDULER_NOTE}')]).toEqual([rel, true])
      expect([rel, src.includes('no scheduler exists;')]).toEqual([rel, false])
    }
  })
})
