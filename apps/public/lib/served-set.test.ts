/**
 * What the entry page says when the record it was served is not a measurement
 * of the questions now in force (MVP_PLAN C3r item 5). The route half, that
 * the facts on the wire are the stored cycle's own, is `api/entry-flow.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { servedFactsOf, servedSetNotice } from './served-set'

const facts = { servedDay: '2026-09-19', servedVersion: 1, inForceVersion: 2, today: '2026-09-19', nextCheckFrom: '2026-09-20' } as const

describe('the sentence', () => {
  it('an edit on a day whose check already ran: which version was asked, that the newer one was not, and the date it will be', () => {
    expect(servedSetNotice(facts)).toBe(
      'Today\u2019s check (2026-09-19) already ran, on version 1 of your questions; that is the result shown here. The questions you saved since (version 2) were not asked today, because one check runs per day. They will be asked at the next check, which can run from 2026-09-20.',
    )
  })

  it('a first set of the person\u2019s own, saved after the day\u2019s check asked the category\u2019s questions', () => {
    expect(servedSetNotice({ ...facts, servedVersion: null, inForceVersion: 1 })).toBe(
      'Today\u2019s check (2026-09-19) already ran, on the category\u2019s questions; that is the result shown here. Your own questions (version 1) were not asked today, because one check runs per day. They will be asked at the next check, which can run from 2026-09-20.',
    )
  })

  it('an older cycle is served: the new questions have not been asked, and a check can run from today', () => {
    expect(servedSetNotice({ ...facts, servedDay: '2026-09-17', nextCheckFrom: '2026-09-19' })).toBe(
      'The latest check ran on 2026-09-17, on version 1 of your questions; that is the result shown here. The questions you saved since (version 2) have not been asked yet. They will be asked at the next check, which can run from 2026-09-19.',
    )
  })

  it('a set that was cleared: the category\u2019s questions are in force again and were not what this check asked', () => {
    expect(servedSetNotice({ ...facts, servedVersion: 2, inForceVersion: null })).toContain('The category\u2019s questions, in force again since you cleared your own, were not asked today')
  })

  it('says NOTHING when the served check asked exactly what is in force: the ordinary case carries no notice', () => {
    expect(servedSetNotice({ ...facts, servedVersion: 2, inForceVersion: 2 })).toBeNull()
    expect(servedSetNotice({ ...facts, servedVersion: null, inForceVersion: null })).toBeNull()
  })
})

describe('the facts off the wire', () => {
  it('are taken only in the shape this file words; anything else is no notice, never a sentence built on a guess', () => {
    expect(servedFactsOf(facts)).toEqual(facts)
    expect(servedFactsOf({ ...facts, servedVersion: null })).toMatchObject({ servedVersion: null })
    for (const bad of [undefined, null, 'x', {}, { ...facts, servedVersion: '1' }, { ...facts, inForceVersion: 0 }, { ...facts, servedDay: 'yesterday' }, { ...facts, nextCheckFrom: undefined }]) expect(servedFactsOf(bad)).toBeNull()
  })
})

describe('no promise the system does not keep (stats review of C3r, MAJOR 2)', () => {
  it('NEVER says a check WILL run on a date: a domain that is not re-checked daily, or whose days end today, has no check tomorrow', () => {
    for (const f of [facts, { ...facts, servedVersion: null, inForceVersion: 1 }, { ...facts, servedDay: '2026-09-17', nextCheckFrom: '2026-09-19' }, { ...facts, servedVersion: 2, inForceVersion: null }]) {
      const s = servedSetNotice(f)!
      expect(s).toContain('which can run from')
      expect(s).not.toMatch(/next check, on \d{4}/)
      expect(s).not.toMatch(/will run|will be checked on/)
    }
  })
})
