/**
 * Both providers run the same contract suite from fixtures only — zero network.
 * PHASES.md 1.3: the abstraction is proven when a second dialect passes the
 * identical checks the primary passes.
 */

import { describeAdapterConformance } from './conformance.js'
import { openWebNinjaAdapter } from './openwebninja.js'
import { stubAdapter, stubPayload, type StubEnvelope } from './stub.js'

// ---------------------------------------------------------------------------
// Primary provider: OpenWeb Ninja — fixtures mirror its documented shapes.
// (Engine-specific shapes are covered in openwebninja.test.ts; the suite here
// runs on ENGINES[0] = chatgpt, so valid fixtures use the chatgpt dialect.)
// ---------------------------------------------------------------------------
const own = (data: unknown) => ({ status: 'OK', request_id: 'r1', data })

describeAdapterConformance({
  providerName: 'openwebninja (primary, third-party-grounded)',
  makeAdapter: (engine) => openWebNinjaAdapter(engine, { apiKey: 'fixture-key', plan: 'payg' }),
  fixtures: {
    valid: [
      {
        payload: own({ reply_text: 'Try [HubSpot](https://www.hubspot.com/crm) first.' }),
        expect: { text: 'Try [HubSpot](https://www.hubspot.com/crm) first.', citations: [{ url: 'https://www.hubspot.com/crm', title: 'HubSpot', position: 0 }] },
      },
      { payload: own({ reply_text: 'No links here.' }), expect: { text: 'No links here.', citations: [] } },
      { payload: { reply_text: 'bare body' }, expect: { text: 'bare body', citations: [] } },
    ],
    malformed: [own({ answer: 'wrong field' }), own({}), 'not json', null, 42],
  },
})

// ---------------------------------------------------------------------------
// Second provider: the stub dialect (HTML + differently-named fields),
// official-api path, offline collect.
// ---------------------------------------------------------------------------
const stubValid: StubEnvelope = {
  api_version: 'v2',
  request: { surface: 'chatgpt', q: 'best crm' },
  result: {
    content_html: '<p>Consider <a href="https://www.zoho.com/crm/">Zoho CRM</a> or <strong>HubSpot</strong>.</p>',
    sources: [
      { target_url: 'https://www.hubspot.com/products/crm', display_name: 'HubSpot', rank: 2 },
      { target_url: 'https://www.zoho.com/crm/', display_name: 'Zoho CRM', rank: 1 },
    ],
  },
}

describeAdapterConformance({
  providerName: 'stubsearch (second provider stub, official-api)',
  makeAdapter: stubAdapter,
  offlineCollect: true,
  fixtures: {
    valid: [
      {
        payload: stubValid,
        expect: {
          text: 'Consider Zoho CRM or HubSpot.',
          citations: [
            // rank order, not array order — the dialect really is different
            { url: 'https://www.zoho.com/crm/', title: 'Zoho CRM', position: 0 },
            { url: 'https://www.hubspot.com/products/crm', title: 'HubSpot', position: 1 },
          ],
        },
      },
      { payload: { api_version: 'v2', request: { surface: 'gemini', q: 'x' }, result: null }, expect: { text: '', citations: [] } },
      {
        // compact block markup with no literal newlines + an entity: must NOT glue words
        payload: { api_version: 'v2', request: { surface: 'chatgpt', q: 'x' }, result: { content_html: '<ul><li>HubSpot &amp; Zoho</li><li>Salesforce</li></ul>', sources: [] } },
        expect: { text: 'HubSpot & Zoho Salesforce', citations: [] },
      },
      { payload: stubPayload('gemini', 'best crm for startups', '2026-08-20', 0), expect: (() => {
          // self-consistency: the generator's own output must round-trip through
          // the same htmlToText the adapter uses (block tags → spaces), so use
          // stubAdapter.normalise as the oracle rather than a re-implemented strip.
          const p = stubPayload('gemini', 'best crm for startups', '2026-08-20', 0)
          return stubAdapter('gemini').normalise(p)
        })() },
    ],
    malformed: [
      { api_version: 'v1', result: {} }, // wrong envelope version
      { api_version: 'v2', request: { surface: 'chatgpt', q: 'x' }, fault: { code: 'QUOTA', description: 'over' } },
      { api_version: 'v2', request: { surface: 'chatgpt', q: 'x' }, result: { sources: [] } }, // no content_html
      { reply_text: 'a primary-provider payload fed to the stub' }, // cross-dialect confusion must fail loudly
      null,
    ],
  },
})
