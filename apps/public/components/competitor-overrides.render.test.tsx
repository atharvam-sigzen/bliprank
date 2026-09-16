import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CompetitorStatus } from '../lib/competitor-request'
import { CompetitorOverridesBody, CompetitorsUnavailable } from './competitor-overrides'

const status: CompetitorStatus = {
  domain: 'acme.test',
  category: { slug: 'crm-software', name: 'CRM software', bankVersion: 1 },
  set: null,
  competitors: [
    { id: 'hubspot', name: 'HubSpot', source: 'category' },
    { id: 'zoho-crm', name: 'Zoho CRM', source: 'category' },
  ],
  excluded: [],
  includable: [{ id: 'semrush', name: 'Semrush', bank: 'SEO tools' }],
  last: null,
  pending: null,
  history: [],
}

describe('the competitor set, as a record', () => {
  it('names the set, says it is the category’s own, and what an adjustment would and would not change', () => {
    const html = renderToStaticMarkup(<CompetitorOverridesBody status={status} />)
    expect(html).toContain('HubSpot')
    expect(html).toContain('no adjustment has been applied for this domain')
    expect(html).toContain('Adjust the competitors?')
    expect(html).toContain('The prompts, the engines and the cost do not change.')
    expect(html).toContain('not compared with the cycles before it')
    expect(html).not.toContain('<input')
  })

  it('an adjusted set says its version, who and why, the exclusion, the inclusion, and a pending request as pending', () => {
    const adjusted: CompetitorStatus = {
      ...status,
      set: 2,
      competitors: [
        { id: 'hubspot', name: 'HubSpot', source: 'category' },
        { id: 'semrush', name: 'Semrush', source: 'included' },
      ],
      excluded: [{ id: 'zoho-crm', name: 'Zoho CRM' }],
      includable: [],
      last: { version: 2, at: '2026-09-03T10:00:00.000Z', by: 'operator', reason: 'Zoho is our integration partner' },
      pending: { exclude: ['hubspot'], include: [], requestedAt: '2026-09-04T09:00:00.000Z' },
      history: [{ status: 'declined', requestedAt: '2026-08-20T00:00:00.000Z', resolvedAt: '2026-08-21T00:00:00.000Z', note: 'Zoho competes on the same deals' }],
    }
    const html = renderToStaticMarkup(<CompetitorOverridesBody status={adjusted} />)
    expect(html).toContain('Semrush (added for this domain)')
    expect(html).toContain('set version 2')
    expect(html).toContain('by operator on 2026-09-03: Zoho is our integration partner')
    expect(html).toContain('Excluded for this domain: Zoho CRM.')
    expect(html).toContain('was requested on 2026-09-04 and has not been applied')
    expect(html).toContain('exclude HubSpot')
    expect(html).toContain('was declined on 2026-08-21: Zoho competes on the same deals')
    expect(html).toContain('Change the request')
  })

  it('a category with no set says so, and where the service is absent there is no form', () => {
    const none = renderToStaticMarkup(<CompetitorOverridesBody status={{ ...status, competitors: [], includable: [] }} />)
    expect(none).toContain('this category has no competitor set')
    const away = renderToStaticMarkup(<CompetitorsUnavailable message="This deployment holds no record." />)
    expect(away).toContain('applied by a person')
    expect(away).not.toContain('<button')
  })
})
