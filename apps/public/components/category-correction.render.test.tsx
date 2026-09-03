import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CategoryStatus } from '../lib/category-request'
import { CategoryCorrectionBody, CategoryUnavailable } from './category-correction'

/**
 * The surface, rendered from a synthetic status. What is under test is what it
 * says: the version and provenance, the pending request as pending and not
 * as applied, the next cycle's size and cost, the earlier cycles as kept and
 * not drawn, and the absence of any form where the service is absent.
 */

const status: CategoryStatus = {
  domain: 'acme.test',
  record: { slug: 'crm-software', name: 'CRM software', source: 'site-content', decidedAt: '2026-08-01T00:00:00.000Z', version: 1, corrections: [] },
  categories: [
    { slug: 'accounting-software', name: 'Accounting software', generated: false },
    { slug: 'crm-software', name: 'CRM software', generated: false },
    { slug: 'widgets-india', name: 'Widgets (India)', generated: true },
  ],
  pending: null,
  history: [],
  nextCycle: { prompts: 17, engines: 5, cells: 85, usd: 0.578, plan: 'payg', earlierCycles: 2 },
}

describe('the category, as a record', () => {
  it('names the category, its version, that it is never re-derived, and what a correction would cost', () => {
    const html = renderToStaticMarkup(<CategoryCorrectionBody status={status} />)
    expect(html).toContain('CRM software')
    expect(html).toContain('record version')
    expect(html).toContain('Decided on 2026-08-01 and reused since; it is never re-derived.')
    expect(html).toContain('85')
    expect(html).toContain('$0.58')
    expect(html).toContain('pay-as-you-go')
    expect(html).not.toContain('payg')
    expect(html).toContain('2 cycles already collected keep the category they were measured under')
    expect(html).toContain('Wrong category?')
    // Closed by default: no form, no select, until the reader asks.
    expect(html).not.toContain('<select')
  })

  it('a corrected record says who, when, from what and why; a pending request is pending, not applied', () => {
    const corrected: CategoryStatus = {
      ...status,
      record: { ...status.record, slug: 'accounting-software', name: 'Accounting software', version: 2, corrections: [{ from: 'crm-software', to: 'accounting-software', at: '2026-09-02T10:00:00.000Z', by: 'operator', reason: 'the pricing page sells accounting modules' }] },
      pending: { slug: 'crm-software', name: 'CRM software', requestedAt: '2026-09-03T09:00:00.000Z' },
      history: [{ slug: 'widgets-india', status: 'declined', requestedAt: '2026-08-20T00:00:00.000Z', resolvedAt: '2026-08-21T00:00:00.000Z', note: 'the homepage sells software' }],
    }
    const html = renderToStaticMarkup(<CategoryCorrectionBody status={corrected} />)
    expect(html).toContain('Corrected on 2026-09-02 from CRM software by operator: the pricing page sells accounting modules.')
    expect(html).toContain('was requested on 2026-09-03 and has not been applied')
    expect(html).toContain('It changes nothing')
    expect(html).toContain('until a person applies it.')
    expect(html).toContain('was declined on 2026-08-21: the homepage sells software')
    expect(html).toContain('Change the request')
  })

  it('where the service is absent there is no form', () => {
    const html = renderToStaticMarkup(<CategoryUnavailable message="This deployment holds no record." />)
    expect(html).toContain('This deployment holds no record.')
    expect(html).toContain('applied by a person')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<select')
  })
})
