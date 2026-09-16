import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as planned from './planned'

describe('the planned marker', () => {
  it('says the capability is missing, not that the method is unsettled', () => {
    expect(planned.PLANNED_CAPTION.toLowerCase()).toContain('planned')
    expect(planned.PLANNED_CAPTION.toLowerCase()).toContain('not built')
    // A reader who sees "planned" on a view has to be able to tell that it
    // means no code ran at all, not that a number's method is unsettled.
    expect(planned.PLANNED_CAPTION.toLowerCase()).not.toContain('preview')
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
 * caveated only that you cannot buy it. (The fixture-only worked example in
 * apps/web, which once did the same on its masthead, was retired 2026-09-07.)
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
})
