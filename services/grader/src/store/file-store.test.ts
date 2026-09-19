import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pendingRequest, requestsFor } from '../category-requests.js'
import { applyOverride, readOverride } from '../competitor-overrides.js'
import { correctCategory, readCategoryRecord, recordCategory } from '../resolve-category.js'
import { categoryRecordIn, overrideAtIn, overrideIn } from './documents.js'
import { fileWorkspaceStore } from './file-store.js'

/**
 * The file store against the layout the modules write and read. The pg-store
 * suite proves the interface's semantics on Postgres; this one proves the same
 * calls on files, and that what the store writes the modules' own validated
 * readers read back, and the reverse.
 */
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-file-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const result = (day: string, extra: Record<string, unknown> = {}) => ({ status: 'scanned', domain: 'acme.example', algoVersion: 'det-2', comparisonBasis: 'b', collectedAt: `${day}T10:00:00.000Z`, run: { day }, ...extra })

describe('cycles', () => {
  it('lists oldest first, reads one day, and the latest is the newest day', async () => {
    const s = fileWorkspaceStore(dir)
    await s.cycles.put({ host: 'acme.example', day: '2026-09-02', algoVersion: 'det-2', comparisonBasis: 'b', result: result('2026-09-02') })
    await s.cycles.put({ host: 'acme.example', day: '2026-09-01', algoVersion: 'det-2', comparisonBasis: 'b', result: result('2026-09-01') })
    expect((await s.cycles.list('acme.example')).map((c) => [c.day, c.algoVersion, c.comparisonBasis])).toEqual([
      ['2026-09-01', 'det-2', 'b'],
      ['2026-09-02', 'det-2', 'b'],
    ])
    expect((await s.cycles.latest('acme.example'))?.day).toBe('2026-09-02')
    // The file carries the same stamp the database column does (migration 0009): a caller that says nothing is a person.
    expect((await s.cycles.read('acme.example', '2026-09-01'))?.result).toEqual({ ...result('2026-09-01'), run: { day: '2026-09-01', source: 'hand' } })
    expect(await s.cycles.read('acme.example', '2026-09-03')).toBeNull()
    expect(await s.cycles.list('other.example')).toEqual([])
  })

  it('a same-day write under the same version on another basis, or from the other source, is refused as the database refuses it; the same measurement re-writes (C3 tenancy review, MINOR 7)', async () => {
    const s = fileWorkspaceStore(dir)
    const stamped = (over: Record<string, unknown>) => ({ ...result('2026-09-05'), algoVersion: 'det-3', comparisonBasis: 'b', ...over })
    await s.cycles.put({ host: 'acme.example', day: '2026-09-05', algoVersion: 'det-3', comparisonBasis: 'b', result: stamped({}), source: 'loop' })
    // The loop filed the day; a hand scan in flight at the same moment is a different measurement and is not written over it.
    await expect(s.cycles.put({ host: 'acme.example', day: '2026-09-05', algoVersion: 'det-3', comparisonBasis: 'b', result: stamped({}), source: 'hand' })).rejects.toThrow(/another basis or from another source/)
    await expect(s.cycles.put({ host: 'acme.example', day: '2026-09-05', algoVersion: 'det-3', comparisonBasis: 'set=2', result: stamped({ comparisonBasis: 'set=2' }), source: 'loop' })).rejects.toThrow(/another basis or from another source/)
    expect((await s.cycles.read('acme.example', '2026-09-05'))?.source).toBe('loop')
    // The same measurement again (a retry, a re-derivation) re-writes.
    await s.cycles.put({ host: 'acme.example', day: '2026-09-05', algoVersion: 'det-3', comparisonBasis: 'b', result: stamped({ rewritten: true }), source: 'loop' })
    // A NEW algorithm version on the same day is not refused by either twin, and NEITHER LOSES THE OLD SCORE (R5, MVP_PLAN C3r item 11).
    // Postgres keeps both rows. This store names a day's file by the day alone, so the det-3 body used to be gone from disk the
    // moment det-4 was written; now it is first copied, byte for byte, to its audit path, by the rule the re-score tool uses.
    const standingFile = join(dir, 'results', 'cycles', 'acme.example', '2026-09-05.json')
    const det3Bytes = readFileSync(standingFile, 'utf8')
    expect(JSON.parse(det3Bytes)).toMatchObject({ algoVersion: 'det-3', rewritten: true })
    await s.cycles.put({ host: 'acme.example', day: '2026-09-05', algoVersion: 'det-4', comparisonBasis: 'b', result: stamped({ algoVersion: 'det-4' }), source: 'hand' })
    expect((await s.cycles.list('acme.example')).filter((c) => c.day === '2026-09-05').map((c) => c.algoVersion)).toEqual(['det-4'])
    const audit = join(dir, 'results', 'cycles', 'acme.example', '2026-09-05.det-3.audit.json')
    expect(readFileSync(audit, 'utf8')).toBe(det3Bytes)
    // A same-version re-write supersedes nothing, so it leaves no copy; a SECOND supersession gets its own slot and the first stands.
    await s.cycles.put({ host: 'acme.example', day: '2026-09-05', algoVersion: 'det-4', comparisonBasis: 'b', result: stamped({ algoVersion: 'det-4', again: true }), source: 'hand' })
    expect(existsSync(join(dir, 'results', 'cycles', 'acme.example', '2026-09-05.det-4.audit.json'))).toBe(false)
    await s.cycles.put({ host: 'acme.example', day: '2026-09-05', algoVersion: 'det-3', comparisonBasis: 'b', result: stamped({ back: true }), source: 'hand' })
    await s.cycles.put({ host: 'acme.example', day: '2026-09-05', algoVersion: 'det-4', comparisonBasis: 'b', result: stamped({ algoVersion: 'det-4' }), source: 'hand' })
    expect(readFileSync(audit, 'utf8')).toBe(det3Bytes)
    expect(JSON.parse(readFileSync(join(dir, 'results', 'cycles', 'acme.example', '2026-09-05.det-3.2.audit.json'), 'utf8'))).toMatchObject({ algoVersion: 'det-3', back: true })
    // The copies are never cycles: the day still lists once.
    expect((await s.cycles.list('acme.example')).filter((c) => c.day === '2026-09-05')).toHaveLength(1)
  })

  it('keeps the database writer\'s guards: the host, the day and the status must agree with the result', async () => {
    const s = fileWorkspaceStore(dir)
    await expect(s.cycles.put({ host: 'other.example', day: '2026-09-01', algoVersion: 'det-2', comparisonBasis: 'b', result: result('2026-09-01') })).rejects.toThrow(/names domain acme.example/)
    await expect(s.cycles.put({ host: 'acme.example', day: '2026-09-02', algoVersion: 'det-2', comparisonBasis: 'b', result: result('2026-09-01') })).rejects.toThrow(/collected on 2026-09-01/)
    await expect(s.cycles.put({ host: 'acme.example', day: '2026-09-01', algoVersion: 'det-2', comparisonBasis: 'b', result: result('2026-09-01', { status: 'failed' }) })).rejects.toThrow(/only a scanned result/)
    expect(await s.cycles.list('acme.example')).toEqual([])
  })
})

describe('documents', () => {
  it('versions climb, history is reassembled newest first, and `at` reads a version back with its own history', async () => {
    const s = fileWorkspaceStore(dir)
    const rec = (slug: string) => ({ slug, source: 'site-content', evidence: 'e', decidedAt: '2026-09-01T00:00:00.000Z', generated: false })
    expect(await s.documents.put('category-record', 'acme.example', rec('crm'), 0)).toBe(1)
    expect(await s.documents.put('category-record', 'acme.example', rec('erp'), 1)).toBe(2)
    expect(await s.documents.put('category-record', 'acme.example', rec('hr'), 2)).toBe(3)
    await expect(s.documents.put('category-record', 'acme.example', rec('x'), 1)).rejects.toThrow(/at version 3, not 1/)
    const latest = await s.documents.latest<{ slug: string }>('category-record', 'acme.example')
    expect(latest?.version).toBe(3)
    expect(latest?.body).toMatchObject({ slug: 'hr' })
    expect(latest?.superseded.map((r) => [r.version, r.body.slug])).toEqual([[2, 'erp'], [1, 'crm']])
    const at2 = await s.documents.at<{ slug: string }>('category-record', 'acme.example', 2)
    expect(at2?.body).toMatchObject({ slug: 'erp' })
    expect(at2?.superseded.map((r) => r.version)).toEqual([1])
    expect(await s.documents.at('category-record', 'acme.example', 9)).toBeNull()
    // The module's own validated reader sees exactly the same record.
    expect(readCategoryRecord(dir, 'acme.example')).toMatchObject({ slug: 'hr', version: 3, superseded: [{ slug: 'crm', version: 1 }, { slug: 'erp', version: 2 }] })
    expect(await categoryRecordIn(s, 'acme.example')).toEqual(readCategoryRecord(dir, 'acme.example'))
  })

  it('an expected version that is not the current one is refused (write-once for a first decision)', async () => {
    const s = fileWorkspaceStore(dir)
    await s.documents.put('custom-prompts', 'acme.example', { prompts: ['a'], reason: 'r', by: 'me', at: '2026-09-01T00:00:00.000Z' }, 0)
    await expect(s.documents.put('custom-prompts', 'acme.example', { prompts: ['b'], reason: 'r', by: 'me', at: '2026-09-01T00:00:00.000Z' }, 0)).rejects.toThrow(/at version 1, not 0/)
    expect((await s.documents.latest('custom-prompts', 'acme.example'))?.version).toBe(1)
  })

  it('what the modules write, the store reads: a correction and an override, with their versions', async () => {
    recordCategory(dir, { host: 'acme.example', slug: 'crm-software', source: 'site-content', evidence: 'e', decidedAt: '2026-09-01T00:00:00.000Z', generated: false, brandName: 'Acme' })
    const corrected = correctCategory(dir, { host: 'acme.example', slug: 'hr-payroll-software', reason: 'the site sells payroll, not CRM', by: 'op' })
    expect(corrected).toMatchObject({ version: 2 })
    const s = fileWorkspaceStore(dir)
    expect(await categoryRecordIn(s, 'acme.example')).toEqual(readCategoryRecord(dir, 'acme.example'))
    expect((await s.documents.at<{ slug: string }>('category-record', 'acme.example', 1))?.body.slug).toBe('crm-software')

    const applied = applyOverride(dir, { host: 'acme.example', exclude: ['gusto'], include: [], reason: 'our integration partner, not a rival', by: 'op' })
    expect(applied).toMatchObject({ version: 1 })
    expect(await overrideIn(s, 'acme.example')).toEqual(readOverride(dir, 'acme.example'))
    expect((await overrideAtIn(s, 'acme.example', 1))?.exclude).toEqual(['gusto'])
    expect(await overrideAtIn(s, 'acme.example', 2)).toBeNull()
  })
})

describe('requests', () => {
  const T1 = '2026-09-10T10:00:00.000Z'
  const T2 = '2026-09-10T11:00:00.000Z'

  it('filing replaces the pending one; resolving is optimistic; history stays; the module reader agrees', async () => {
    const s = fileWorkspaceStore(dir)
    await s.requests.file('category', 'acme.example', { slug: 'erp', reason: 'first reason here' }, T1)
    await s.requests.file('category', 'acme.example', { slug: 'hr', reason: 'second reason here' }, T2)
    const pending = await s.requests.pending<{ reason: string }>('category', 'acme.example')
    expect(pending?.body.reason).toBe('second reason here')
    expect(pending?.requestedAt).toBe(T2)
    expect(pendingRequest(dir, 'acme.example')).toMatchObject({ slug: 'hr', requestedAt: T2, status: 'pending' })
    expect(await s.requests.resolve('category', 'acme.example', T1, { status: 'applied', by: 'op' })).toBe(false)
    expect(await s.requests.resolve('category', 'acme.example', T2, { status: 'applied', by: 'op', note: 'done' })).toBe(true)
    expect(await s.requests.pending('category', 'acme.example')).toBeNull()
    expect((await s.requests.forHost('category', 'acme.example')).map((r) => [r.status, r.resolvedBy, r.note])).toEqual([['applied', 'op', 'done']])
    expect(requestsFor(dir, 'acme.example').map((r) => r.status)).toEqual(['applied'])
    // The file the CLIs read is the same file.
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'category-requests.json'), 'utf8')) as object)).toEqual(['acme.example'])
  })

  it('allPending lists the kind across hosts', async () => {
    const s = fileWorkspaceStore(dir)
    await s.requests.file('competitors', 'one.example', { exclude: ['x'], include: [], reason: 'a reason long enough' }, T1)
    await s.requests.file('competitors', 'two.example', { exclude: ['y'], include: [], reason: 'a reason long enough' }, T2)
    expect((await s.requests.allPending('competitors')).map((r) => r.host)).toEqual(['one.example', 'two.example'])
    expect(await s.requests.allPending('custom-prompts')).toEqual([])
  })
})

describe('the apply twins agree with the CLI functions (B4)', () => {
  it('a correction, an override and a prompt set through the store read back exactly as the modules write them', async () => {
    const { applyOverrideIn } = await import('../competitor-overrides.js')
    const { applyCustomPromptsIn, readCustomPromptSet } = await import('../custom-prompts.js')
    const { correctCategoryIn } = await import('../resolve-category.js')
    recordCategory(dir, { host: 'acme.example', slug: 'crm-software', source: 'site-content', evidence: 'e', decidedAt: '2026-09-01T00:00:00.000Z', generated: false, brandName: 'Acme' })
    const s = fileWorkspaceStore(dir)
    const corrected = await correctCategoryIn(s, dir, { host: 'acme.example', slug: 'hr-payroll-software', reason: 'the site sells payroll, not CRM', by: 'owner', at: '2026-09-02T00:00:00.000Z' })
    expect(corrected).toMatchObject({ version: 2, slug: 'hr-payroll-software', correction: { from: 'crm-software', by: 'owner' } })
    expect(readCategoryRecord(dir, 'acme.example')).toEqual(corrected)
    // The same slug again: nothing to correct, version 2 stands.
    expect(await correctCategoryIn(s, dir, { host: 'acme.example', slug: 'hr-payroll-software', reason: 'the site sells payroll, not CRM', by: 'owner' })).toMatchObject({ refuse: expect.stringContaining('already recorded') })
    const override = await applyOverrideIn(s, dir, { host: 'acme.example', exclude: ['gusto'], include: [], reason: 'our integration partner, not a rival', by: 'owner', at: '2026-09-03T00:00:00.000Z' })
    expect(override).toMatchObject({ version: 1, exclude: ['gusto'] })
    expect(readOverride(dir, 'acme.example')).toEqual(override)
    // A correction while an override is in force is refused, as the CLI refuses it.
    expect(await correctCategoryIn(s, dir, { host: 'acme.example', slug: 'crm-software', reason: 'back to CRM after all', by: 'owner' })).toMatchObject({ refuse: expect.stringContaining('competitor override in force') })
    const set = await applyCustomPromptsIn(s, dir, { host: 'acme.example', prompts: ['which payroll tool suits a two-person bakery'], reason: 'our buyers ask this exact question', by: 'owner', at: '2026-09-04T00:00:00.000Z' })
    expect(set).toMatchObject({ version: 1, prompts: ['which payroll tool suits a two-person bakery'] })
    expect(readCustomPromptSet(dir, 'acme.example')).toEqual(set)
  })
})
