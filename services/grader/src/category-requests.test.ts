import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allPending, fileCategoryRequest, pendingRequest, readRequests, requestsFor, resolveRequest } from './category-requests.js'
import { readCategoryRecord, recordCategory } from './resolve-category.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-requests-'))
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const REASON = 'we sell ERP modules, see the pricing page'

describe('what a visitor may file', () => {
  it('refuses, by kind, what cannot be a request', () => {
    expect(fileCategoryRequest(dir, { host: 'nobody.test', slug: 'accounting-software', reason: REASON })).toMatchObject({ kind: 'no-record' })
    expect(fileCategoryRequest(dir, { host: 'acme.test', slug: 'crm-software', reason: REASON })).toMatchObject({ kind: 'same-category' })
    expect(fileCategoryRequest(dir, { host: 'acme.test', slug: 'made-up', reason: REASON })).toMatchObject({ kind: 'unknown-category' })
    expect(fileCategoryRequest(dir, { host: 'acme.test', slug: 'general-business-software', reason: REASON })).toMatchObject({ kind: 'unknown-category' })
    expect(fileCategoryRequest(dir, { host: 'acme.test', slug: 'Erp Software!', reason: REASON })).toMatchObject({ kind: 'input' })
    expect(fileCategoryRequest(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'meh' })).toMatchObject({ kind: 'input' })
    expect(fileCategoryRequest(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'x'.repeat(600) })).toMatchObject({ kind: 'input' })
    expect(fileCategoryRequest(dir, { host: '', slug: 'accounting-software', reason: REASON })).toMatchObject({ kind: 'input' })
    expect(readRequests(dir)).toEqual({})
  })

  it('files a pending request, whitespace folded, and never touches the record', () => {
    const r = fileCategoryRequest(dir, { host: 'https://www.acme.test/', slug: 'accounting-software', reason: '  we sell   ERP modules,\nsee the pricing page ', at: '2026-09-03T09:00:00.000Z' })
    expect(r).toEqual({ host: 'acme.test', slug: 'accounting-software', reason: REASON, requestedAt: '2026-09-03T09:00:00.000Z', status: 'pending' })
    expect(pendingRequest(dir, 'acme.test')).toEqual(r)
    expect(readCategoryRecord(dir, 'acme.test')?.slug).toBe('crm-software')
  })

  it('filing again replaces the pending request rather than queueing a second', () => {
    fileCategoryRequest(dir, { host: 'acme.test', slug: 'accounting-software', reason: REASON, at: '2026-09-03T09:00:00.000Z' })
    fileCategoryRequest(dir, { host: 'acme.test', slug: 'seo-tools', reason: 'on reflection, seo tools', at: '2026-09-03T09:05:00.000Z' })
    expect(requestsFor(dir, 'acme.test')).toHaveLength(1)
    expect(pendingRequest(dir, 'acme.test')?.slug).toBe('seo-tools')
  })
})

describe('what an operator resolves', () => {
  it('applied and declined are kept as history, and a new pending one can follow', () => {
    fileCategoryRequest(dir, { host: 'acme.test', slug: 'accounting-software', reason: REASON, at: '2026-09-03T09:00:00.000Z' })
    const declined = resolveRequest(dir, 'acme.test', { status: 'declined', by: 'operator', note: 'the homepage says CRM', at: '2026-09-03T10:00:00.000Z' })
    expect(declined).toMatchObject({ status: 'declined', resolvedBy: 'operator', note: 'the homepage says CRM', resolvedAt: '2026-09-03T10:00:00.000Z' })
    expect(pendingRequest(dir, 'acme.test')).toBeNull()
    fileCategoryRequest(dir, { host: 'acme.test', slug: 'accounting-software', reason: 'the pricing page, second time', at: '2026-09-04T09:00:00.000Z' })
    expect(requestsFor(dir, 'acme.test').map((r) => r.status)).toEqual(['declined', 'pending'])
    expect(allPending(dir).map((r) => r.host)).toEqual(['acme.test'])
  })

  it('resolving a request that was replaced since it was read is refused, so the replacement is never marked under the first decision', () => {
    fileCategoryRequest(dir, { host: 'acme.test', slug: 'accounting-software', reason: REASON, at: '2026-09-03T09:00:00.000Z' })
    fileCategoryRequest(dir, { host: 'acme.test', slug: 'seo-tools', reason: 'changed my mind, seo tools', at: '2026-09-03T09:05:00.000Z' })
    expect(resolveRequest(dir, 'acme.test', { status: 'applied', by: 'operator', expectRequestedAt: '2026-09-03T09:00:00.000Z' })).toMatchObject({ refuse: expect.stringContaining('changed since it was read') })
    expect(pendingRequest(dir, 'acme.test')?.slug).toBe('seo-tools')
    expect(resolveRequest(dir, 'acme.test', { status: 'applied', by: 'operator', expectRequestedAt: '2026-09-03T09:05:00.000Z' })).toMatchObject({ status: 'applied' })
  })

  it('resolving with nothing pending is refused', () => {
    expect(resolveRequest(dir, 'acme.test', { status: 'applied', by: 'operator' })).toMatchObject({ refuse: expect.stringContaining('no pending') })
  })

  it('a corrupt store reads as empty rather than throwing', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'category-requests.json'), '{ nope')
    expect(readRequests(dir)).toEqual({})
    expect(allPending(dir)).toEqual([])
  })
})
