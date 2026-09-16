import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyOverride } from './competitor-overrides.js'
import { correctCategory, readCategoryRecord, recordCategory } from './resolve-category.js'

/**
 * THE SECOND WRITER (ADR-0016). `recordCategory` still refuses to overwrite;
 * `correctCategory` writes a new record one version up, carrying every earlier
 * one whole. Nothing here fetches, classifies or spends.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-correct-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const first = () => recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'pipeline, deals', decidedAt: '2026-08-01T00:00:00.000Z', generated: false, brandName: 'Acme' })

describe('the version travels with the record', () => {
  it('a first decision is version 1, with no history and no correction', () => {
    expect(first()).toMatchObject({ version: 1, slug: 'crm-software' })
    expect(readCategoryRecord(dir, 'acme.test')).not.toHaveProperty('superseded')
    expect(readCategoryRecord(dir, 'acme.test')).not.toHaveProperty('correction')
  })

  it('a record written before versions existed reads as version 1', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'domain-categories.json'), JSON.stringify({ 'old.test': { host: 'old.test', slug: 'seo-tools', source: 'domain-token', evidence: 'seo', decidedAt: '2026-07-01', generated: false } }))
    expect(readCategoryRecord(dir, 'old.test')).toMatchObject({ slug: 'seo-tools', version: 1 })
  })
})

describe('correctCategory refuses what a person must not be able to do by accident', () => {
  it('a domain with no record: a first scan decides, a correction replaces', () => {
    const r = correctCategory(dir, { host: 'nobody.test', slug: 'crm-software', reason: 'this is a long enough reason', by: 'operator' })
    expect(r).toMatchObject({ refuse: expect.stringContaining('no category record') })
  })

  it('the same slug, a short reason, no author, a slug with no bank', () => {
    first()
    expect(correctCategory(dir, { host: 'acme.test', slug: 'crm-software', reason: 'this is a long enough reason', by: 'operator' })).toMatchObject({ refuse: expect.stringContaining('already recorded') })
    expect(correctCategory(dir, { host: 'acme.test', slug: 'seo-tools', reason: 'short', by: 'operator' })).toMatchObject({ refuse: expect.stringContaining('ten characters') })
    expect(correctCategory(dir, { host: 'acme.test', slug: 'seo-tools', reason: 'this is a long enough reason', by: '  ' })).toMatchObject({ refuse: expect.stringContaining('names who') })
    expect(correctCategory(dir, { host: 'acme.test', slug: 'made-up-category', reason: 'this is a long enough reason', by: 'operator' })).toMatchObject({ refuse: expect.stringContaining('no bank') })
    expect(correctCategory(dir, { host: 'acme.test', slug: 'general-business-software', reason: 'this is a long enough reason', by: 'operator' })).toMatchObject({ refuse: expect.stringContaining('absence of a category') })
    // And through all of that the record is untouched.
    expect(readCategoryRecord(dir, 'acme.test')).toMatchObject({ slug: 'crm-software', version: 1 })
  })

  it('it never derives: the slug is exactly the one given, whatever the host looks like', () => {
    recordCategory(dir, { host: 'pipedrive.com', slug: 'general-business-software', source: 'fallback', evidence: 'x', decidedAt: '2026-08-01', generated: false })
    const r = correctCategory(dir, { host: 'pipedrive.com', slug: 'seo-tools', reason: 'a person chose this, rightly or wrongly', by: 'operator' })
    expect(r).toMatchObject({ slug: 'seo-tools', source: 'correction' })
  })
})

describe('a correction is a new record, one version up, with its history inside it', () => {
  it('writes version 2, keeps the brand name, records who, why, when and from what, and carries the first record whole', () => {
    const before = first()
    const r = correctCategory(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'the pricing page sells ERP modules', by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    expect(r).toEqual({
      host: 'acme.test',
      slug: 'accounting-software',
      source: 'correction',
      evidence: 'corrected from crm-software by operator: the pricing page sells ERP modules',
      decidedAt: '2026-09-03T10:00:00.000Z',
      generated: false,
      brandName: 'Acme',
      version: 2,
      superseded: [before],
      correction: { from: 'crm-software', by: 'operator', reason: 'the pricing page sells ERP modules', at: '2026-09-03T10:00:00.000Z' },
    })
    expect(readCategoryRecord(dir, 'acme.test')).toEqual(r)
  })

  it('a second correction is version 3 and the history holds both earlier records, oldest first, none nested', () => {
    first()
    correctCategory(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'the pricing page sells ERP modules', by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    const r = correctCategory(dir, { host: 'acme.test', slug: 'seo-tools', reason: 'on reflection it is the SEO toolset', by: 'operator', at: '2026-09-04T10:00:00.000Z' })
    if ('refuse' in r) throw new Error(r.refuse)
    expect(r.version).toBe(3)
    expect(r.superseded?.map((s) => [s.version, s.slug])).toEqual([
      [1, 'crm-software'],
      [2, 'accounting-software'],
    ])
    for (const s of r.superseded ?? []) expect(s).not.toHaveProperty('superseded')
    expect(r.superseded?.[1]?.correction?.from).toBe('crm-software')
  })

  it('a reason is stored as words: control characters out, whitespace folded', () => {
    first()
    const r = correctCategory(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'the  pricing\x1b[31m page\n sells accounting', by: 'oper\x07ator' })
    expect(r).toMatchObject({ correction: { reason: 'the pricing[31m page sells accounting', by: 'operator' } })
  })

  it('a correction is refused while a competitor override is in force, and names the command that clears it', () => {
    first()
    applyOverride(dir, { host: 'acme.test', exclude: ['hubspot'], include: [], reason: 'HubSpot is our integration partner', by: 'operator' })
    expect(correctCategory(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'the pricing page sells accounting modules', by: 'operator' })).toMatchObject({ refuse: expect.stringContaining('grader:competitors') })
    expect(readCategoryRecord(dir, 'acme.test')?.slug).toBe('crm-software')
  })

  it('recordCategory still refuses to overwrite a corrected record', () => {
    first()
    correctCategory(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'the pricing page sells ERP modules', by: 'operator' })
    const again = recordCategory(dir, { host: 'acme.test', slug: 'seo-tools', source: 'site-content', evidence: 'x', decidedAt: '2026-09-05', generated: false })
    expect(again.slug).toBe('accounting-software')
    expect(again.version).toBe(2)
  })

  it('a corrupted history entry is dropped on read; the record itself survives', () => {
    first()
    correctCategory(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'the pricing page sells ERP modules', by: 'operator' })
    const f = join(dir, 'domain-categories.json')
    const store = JSON.parse(readFileSync(f, 'utf8')) as Record<string, { superseded: unknown[] }>
    store['acme.test']!.superseded = [{ nonsense: true }, ...store['acme.test']!.superseded]
    writeFileSync(f, JSON.stringify(store))
    const r = readCategoryRecord(dir, 'acme.test')
    expect(r).toMatchObject({ slug: 'accounting-software', version: 2 })
    expect(r?.superseded).toHaveLength(1)
  })
})
