import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEMO_BANKS } from '@bliprank/taxonomy'
import {
  allPendingCompetitorRequests,
  applyOverride,
  checkOverride,
  competitorsFor,
  effectiveCompetitors,
  fileCompetitorRequest,
  overrideAt,
  pendingCompetitorRequest,
  readOverride,
  resolveCompetitorRequest,
  reviewedLeaders,
} from './competitor-overrides.js'
import { isLeaderId } from './override-store.js'
import { recordCategory } from './resolve-category.js'
import { leadersOf, subjectFor } from './scan.js'

/**
 * A per-domain override over the category's set (ADR-0016, decision 3).
 * Synthetic store, the built-in banks; nothing fetches, nothing spends.
 */

let dir: string
const crm = DEMO_BANKS.find((b) => b.category === 'crm-software')!
const seo = DEMO_BANKS.find((b) => b.category === 'seo-tools')!
const crmIds = leadersOf(crm).map((l) => l.id)
const seoIds = leadersOf(seo).map((l) => l.id)
const REASON = 'Zoho is our integration partner, not a rival'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-overrides-'))
  // A domain in CRM whose host is not a leader, so the subject is the domain itself.
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false, brandName: 'Acme' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the effective set, pure', () => {
  it('excludes by id, includes from the reviewed sources, never the subject, never a duplicate, never an unknown', () => {
    const reviewed = reviewedLeaders(dir)
    const [a, b] = crmIds
    const foreign = seoIds[0]!
    const { competitors: set, missing } = effectiveCompetitors(crm, { exclude: [a!], include: [foreign, b!, 'made-up'] }, reviewed, 'domain:acme.test')
    const got = set.map((c) => c.id)
    expect(missing).toEqual(['made-up'])
    expect(got).not.toContain(a)
    expect(got).toContain(b)
    expect(got).toContain(foreign)
    expect(got).not.toContain('made-up')
    expect(new Set(got).size).toBe(got.length)
    // The included leader carries its reviewed alias table, not a bare name.
    expect(set.find((c) => c.id === foreign)!.aliases.length).toBeGreaterThan(0)
  })

  it('with no override the set is the category’s own, minus the subject when it is a leader', () => {
    const pipedrive = subjectFor('pipedrive.com', crm).spec.id
    const set = effectiveCompetitors(crm, null, reviewedLeaders(dir), pipedrive).competitors.map((c) => c.id)
    expect(set).not.toContain(pipedrive)
    expect(set).toHaveLength(crmIds.length - 1)
  })
})

describe('what an override may and may not do', () => {
  it('refuses, by kind, a domain with no record, a subject, a typed name, an unreviewed include, an exclude not in the set, an overlap, a short reason', () => {
    const [a] = crmIds
    expect(fileCompetitorRequest(dir, { host: 'nobody.test', exclude: [a!], include: [], reason: REASON })).toMatchObject({ kind: 'no-record' })
    // A subject that IS a leader (pipedrive.com leads crm-software): it cannot be excluded from being its own rival, nor included as one.
    recordCategory(dir, { host: 'pipedrive.com', slug: 'crm-software', source: 'leader-domain', evidence: 'x', decidedAt: '2026-08-01', generated: false })
    expect(checkOverride(dir, { host: 'pipedrive.com', exclude: ['pipedrive'], include: [], reason: REASON })).toMatchObject({ kind: 'subject' })
    expect(checkOverride(dir, { host: 'pipedrive.com', exclude: [], include: ['pipedrive'], reason: REASON })).toMatchObject({ kind: 'subject' })
    expect(checkOverride(dir, { host: 'acme.test', exclude: ['Not An Id!'], include: [], reason: REASON })).toMatchObject({ kind: 'input' })
    // The subject under a sibling bank's id: monday.com leads crm-software as monday-crm and project-management as monday-com.
    recordCategory(dir, { host: 'monday.com', slug: 'crm-software', source: 'leader-domain', evidence: 'x', decidedAt: '2026-08-01', generated: false })
    expect(checkOverride(dir, { host: 'monday.com', exclude: [], include: ['monday-com'], reason: REASON })).toMatchObject({ kind: 'subject' })
    // Promotion's ids carry a namespace and are ids, not free text.
    expect(isLeaderId('promoted:ornexa')).toBe(true)
    expect(isLeaderId('Ornexa Inc')).toBe(false)
    expect(checkOverride(dir, { host: 'acme.test', exclude: [], include: ['brand-nobody-reviewed'], reason: REASON })).toMatchObject({ kind: 'unknown-competitor' })
    expect(checkOverride(dir, { host: 'acme.test', exclude: [seoIds[0]!], include: [], reason: REASON })).toMatchObject({ kind: 'unknown-competitor' })
    expect(checkOverride(dir, { host: 'acme.test', exclude: [], include: [a!], reason: REASON })).toMatchObject({ kind: 'unknown-competitor', refuse: expect.stringContaining('already in') })
    // An overlap cannot arise: an exclude must be a category leader and an include must not be, so the two lists are disjoint by construction.
    expect(checkOverride(dir, { host: 'acme.test', exclude: [a!], include: [], reason: 'meh' })).toMatchObject({ kind: 'input' })
    expect(readOverride(dir, 'acme.test')).toBeNull()
  })

  it('a first override is set 1, a second is set 2 with the first kept whole, and a no-op is refused', () => {
    const [a, b] = crmIds
    const foreign = seoIds[0]!
    const first = applyOverride(dir, { host: 'acme.test', exclude: [a!], include: [], reason: REASON, by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    expect(first).toEqual({ host: 'acme.test', version: 1, exclude: [a], include: [], reason: REASON, by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    expect(applyOverride(dir, { host: 'acme.test', exclude: [a!], include: [], reason: 'same thing again, worded differently', by: 'operator' })).toMatchObject({ kind: 'no-change' })
    const second = applyOverride(dir, { host: 'acme.test', exclude: [b!, a!], include: [foreign], reason: 'and Freshsales is who we actually lose deals to', by: 'operator', at: '2026-09-04T10:00:00.000Z' })
    if ('refuse' in second) throw new Error(second.refuse)
    expect(second.version).toBe(2)
    expect(second.exclude).toEqual([a, b].sort())
    expect(second.include).toEqual([foreign])
    expect(second.superseded).toEqual([first])
    expect(readOverride(dir, 'acme.test')).toEqual(second)
  })

  it('clearing every exclusion and inclusion is still a new version: the basis must move, because the set did', () => {
    const [a] = crmIds
    applyOverride(dir, { host: 'acme.test', exclude: [a!], include: [], reason: REASON, by: 'operator' })
    const cleared = applyOverride(dir, { host: 'acme.test', exclude: [], include: [], reason: 'we were wrong, Zoho does compete', by: 'operator' })
    expect(cleared).toMatchObject({ version: 2, exclude: [], include: [] })
    expect(applyOverride(dir, { host: 'nobody.test', exclude: [], include: [], reason: 'nothing at all to do here', by: 'operator' })).toMatchObject({ kind: 'no-record' })
  })
})

describe('reading a stored cycle back under the set it was measured with', () => {
  it('competitorsFor at a version returns that version’s set; an unknown version is null, never today’s set', () => {
    const [a, b] = crmIds
    const subject = 'domain:acme.test'
    expect(competitorsFor(dir, 'acme.test', crm, subject)).toEqual(effectiveCompetitors(crm, null, reviewedLeaders(dir), subject))
    applyOverride(dir, { host: 'acme.test', exclude: [a!], include: [], reason: REASON, by: 'operator' })
    applyOverride(dir, { host: 'acme.test', exclude: [b!], include: [], reason: 'changed our mind about which one', by: 'operator' })
    expect(overrideAt(dir, 'acme.test', 1)?.exclude).toEqual([a])
    expect(overrideAt(dir, 'acme.test', 2)?.exclude).toEqual([b])
    expect(overrideAt(dir, 'acme.test', 3)).toBeNull()
    const at1 = competitorsFor(dir, 'acme.test', crm, subject, 1)!
    expect(at1.set).toBe(1)
    expect(at1.competitors.map((c) => c.id)).not.toContain(a)
    expect(at1.competitors.map((c) => c.id)).toContain(b)
    const now = competitorsFor(dir, 'acme.test', crm, subject)!
    expect(now.set).toBe(2)
    expect(now.competitors.map((c) => c.id)).toContain(a)
    expect(competitorsFor(dir, 'acme.test', crm, subject, 9)).toBeNull()
    // A cycle whose basis carries no set= was measured under the category's own set, whatever is in force today.
    const own = competitorsFor(dir, 'acme.test', crm, subject, null)!
    expect(own.set).toBeUndefined()
    expect(own.competitors.map((c) => c.id)).toContain(a)
    expect(own.competitors.map((c) => c.id)).toContain(b)
  })
})

describe('requests: filed by a visitor, resolved by a person', () => {
  it('a request passes the same checks as an apply, writes no override, and one pending replaces another', () => {
    const [a, b] = crmIds
    const r = fileCompetitorRequest(dir, { host: 'https://www.acme.test/', exclude: [a!], include: [], reason: REASON, at: '2026-09-03T09:00:00.000Z' })
    expect(r).toEqual({ host: 'acme.test', exclude: [a], include: [], reason: REASON, requestedAt: '2026-09-03T09:00:00.000Z', status: 'pending' })
    expect(readOverride(dir, 'acme.test')).toBeNull()
    fileCompetitorRequest(dir, { host: 'acme.test', exclude: [b!], include: [], reason: 'no, the other one', at: '2026-09-03T09:05:00.000Z' })
    expect(pendingCompetitorRequest(dir, 'acme.test')?.exclude).toEqual([b])
    expect(allPendingCompetitorRequests(dir)).toHaveLength(1)
    expect(fileCompetitorRequest(dir, { host: 'acme.test', exclude: [], include: [], reason: 'nothing to ask for here' })).toMatchObject({ kind: 'no-change' })
    // Once an override is in force, empty lists ask for it to be cleared, which is a real change.
    applyOverride(dir, { host: 'acme.test', exclude: [a!], include: [], reason: REASON, by: 'operator' })
    expect(fileCompetitorRequest(dir, { host: 'acme.test', exclude: [], include: [], reason: 'please put Zoho back in' })).toMatchObject({ status: 'pending', exclude: [], include: [] })
  })

  it('resolving names the request it read', () => {
    const [a] = crmIds
    fileCompetitorRequest(dir, { host: 'acme.test', exclude: [a!], include: [], reason: REASON, at: '2026-09-03T09:00:00.000Z' })
    expect(resolveCompetitorRequest(dir, 'acme.test', { status: 'applied', by: 'operator', expectRequestedAt: 'not-that-one' })).toMatchObject({ refuse: expect.stringContaining('changed since') })
    expect(resolveCompetitorRequest(dir, 'acme.test', { status: 'declined', by: 'operator', note: 'Zoho competes on the same deals', expectRequestedAt: '2026-09-03T09:00:00.000Z' })).toMatchObject({ status: 'declined', note: 'Zoho competes on the same deals' })
    expect(resolveCompetitorRequest(dir, 'acme.test', { status: 'applied', by: 'operator' })).toMatchObject({ refuse: expect.stringContaining('no pending') })
  })
})
