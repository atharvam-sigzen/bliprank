import { describe, expect, it } from 'vitest'
import { AdapterError, cacheCell, ENGINES } from '@bliprank/contracts'
import { normaliseOwn, openWebNinjaAdapter, probeEngine } from './openwebninja.js'

// Payload shapes as documented on the provider's API pages (2026-08-18), wrapped
// in the { status, request_id, data } envelope its official MCP client unwraps.
const env = (data: unknown) => ({ status: 'OK', request_id: 'r1', data })

describe('normaliseOwn — documented payload shapes', () => {
  it('chatgpt / gemini: reply_text with markdown links as citations', () => {
    const p = env({ reply_text: 'Try [HubSpot](https://www.hubspot.com/crm) or [Zoho](https://zoho.com/crm).', content_references: {} })
    const a = normaliseOwn('chatgpt', p)
    expect(a.text).toContain('HubSpot')
    expect(a.citations.map((c) => c.url)).toEqual(['https://www.hubspot.com/crm', 'https://zoho.com/crm'])
    expect(a.citations[0]).toEqual({ url: 'https://www.hubspot.com/crm', title: 'HubSpot', position: 0 })
    expect(normaliseOwn('gemini', env({ reply_text: 'Hello', conversation_id: 'x' }))).toEqual({ text: 'Hello', citations: [] })
  })

  it('copilot: message + citations[]', () => {
    const a = normaliseOwn('copilot', env({ message: 'Salesforce is popular.', citations: [{ title: 'SF', url: 'https://www.salesforce.com/', publisher: 'x' }], conversation_id: 'c', has_ads: false }))
    expect(a.text).toBe('Salesforce is popular.')
    expect(a.citations).toEqual([{ url: 'https://www.salesforce.com/', title: 'SF', position: 0 }])
  })

  it('google-ai-mode: reply_parts + reference_links', () => {
    const a = normaliseOwn('google-ai-mode', env({
      reply_parts: [{ type: 'heading', text: 'Top CRMs' }, { type: 'list', list: [{ title: 'HubSpot', text: 'free tier' }, { title: 'Zoho CRM', text: 'cheap' }] }],
      reference_links: [{ title: 'HubSpot', link: 'https://www.hubspot.com/', snippet: '', source: 'hubspot.com' }],
      session_token: 't',
    }))
    expect(a.text).toBe('Top CRMs\nHubSpot: free tier\nZoho CRM: cheap')
    expect(a.citations).toEqual([{ url: 'https://www.hubspot.com/', title: 'HubSpot', position: 0 }])
  })

  it('google-ai-overviews: text_parts, and "no overview" is parseable-but-empty', () => {
    const shown = normaliseOwn('google-ai-overviews', env({ text_parts: [{ type: 'paragraph', text: 'Popular CRMs include Salesforce.' }], reference_links: [{ title: 'x', link: 'https://example.com/a' }], search_returned_ai_overviews: true }))
    expect(shown.text).toBe('Popular CRMs include Salesforce.')
    expect(shown.citations).toHaveLength(1)
    expect(normaliseOwn('google-ai-overviews', env({ search_returned_ai_overviews: false }))).toEqual({ text: '', citations: [] })
  })

  it('accepts a bare (un-enveloped) body', () => {
    expect(normaliseOwn('gemini', { reply_text: 'bare' }).text).toBe('bare')
  })

  it.each([
    ['chatgpt', env({ answer: 'x' })],
    ['copilot', env({ reply_text: 'x' })],
    ['google-ai-mode', env({ text_parts: [] })],
    ['google-ai-overviews', env({ reply_parts: [] })],
    ['gemini', 'not json'],
    ['gemini', null],
  ] as const)('%s: unknown shape → AdapterError(unparseable), not retryable', (engine, payload) => {
    try {
      normaliseOwn(engine, payload)
      throw new Error('did not throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError)
      expect((e as AdapterError).kind).toBe('unparseable')
      expect((e as AdapterError).retryable).toBe(false)
    }
  })
})

describe('openWebNinjaAdapter.collect', () => {
  const cell = cacheCell({ prompt: 'Best CRM for a small business?', engine: 'chatgpt', locale: 'en-US', geo: 'US', dateBucket: '2026-08-19' })
  const req = { cell, prompt: 'Best CRM for a small business?', run: 3 }
  const mkFetch = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const calls: { url: string; init: RequestInit }[] = []
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
    }) as typeof fetch
    return { f, calls }
  }

  it('POSTs the raw prompt with the key header and returns a self-describing RawAnswer', async () => {
    const { f, calls } = mkFetch(200, env({ reply_text: 'HubSpot is free.' }))
    const a = openWebNinjaAdapter('chatgpt', { apiKey: 'k', fetch: f, now: () => new Date('2026-08-19T10:00:00Z') })
    const ans = await a.collect(req)
    expect(calls[0]!.url).toBe('https://api.openwebninja.com/chatgpt/chat')
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('k')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ message: 'Best CRM for a small business?', markdown: true })
    expect(ans).toMatchObject({ text: 'HubSpot is free.', cell, prompt: req.prompt, run: 3, adapter: 'openwebninja:chatgpt', collectionPath: 'third-party-grounded', providerCalls: 1, collectedAt: '2026-08-19T10:00:00.000Z' })
    expect((ans.payload as { data: unknown }).data).toEqual({ reply_text: 'HubSpot is free.' })
  })

  it('Google surfaces GET with gl/hl from the cell', async () => {
    const { f, calls } = mkFetch(200, env({ search_returned_ai_overviews: false }))
    const cellIn = cacheCell({ prompt: 'best crm', engine: 'google-ai-overviews', locale: 'en-IN', geo: 'IN', dateBucket: '2026-08-19' })
    await openWebNinjaAdapter('google-ai-overviews', { apiKey: 'k', fetch: f }).collect({ cell: cellIn, prompt: 'best crm', run: 0 })
    const u = new URL(calls[0]!.url)
    expect(u.pathname).toBe('/ai-overviews/ai-overviews')
    expect(u.searchParams.get('q')).toBe('best crm')
    expect(u.searchParams.get('gl')).toBe('in')
    expect(u.searchParams.get('hl')).toBe('en')
    expect(calls[0]!.init.method).toBe('GET')
  })

  it.each([
    [429, 'rate-limited', true],
    [500, 'provider', true],
    [504, 'timeout', true],
    [401, 'rejected', false],
    [402, 'rejected', false],
    [403, 'rejected', false],
  ] as const)('HTTP %s → %s (retryable=%s)', async (status, kind, retryable) => {
    const { f } = mkFetch(status, { error: { message: 'nope' } }, status === 429 ? { 'retry-after': '2' } : {})
    const a = openWebNinjaAdapter('gemini', { apiKey: 'k', fetch: f })
    await expect(a.collect({ ...req, cell: { ...cell, engine: 'gemini' } })).rejects.toMatchObject({ name: 'AdapterError', kind, retryable, ...(status === 429 ? { retryAfterMs: 2000 } : {}) })
  })

  it('network failure → provider/retryable; abort → timeout/retryable', async () => {
    const boom = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(openWebNinjaAdapter('copilot', { apiKey: 'k', fetch: boom }).collect(req)).rejects.toMatchObject({ kind: 'provider', retryable: true })
    const abort = (async () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }) as unknown as typeof fetch
    await expect(openWebNinjaAdapter('copilot', { apiKey: 'k', fetch: abort }).collect(req)).rejects.toMatchObject({ kind: 'timeout', retryable: true })
  })

  it('declares the contract fields for every engine', () => {
    for (const engine of ENGINES) {
      const a = openWebNinjaAdapter(engine, { apiKey: 'k', plan: 'mega' })
      expect(a.id).toBe(`openwebninja:${engine}`)
      expect(a.provider).toBe('openwebninja')
      expect(a.collectionPath).toBe('third-party-grounded')
      expect(a.rateLimit().rps).toBeGreaterThan(0)
    }
  })
})

describe('probeEngine (--doctor)', () => {
  it('returns the verbatim status/body and never throws', async () => {
    const f403 = (async () => new Response(JSON.stringify({ message: 'You are not subscribed to this API' }), { status: 403, headers: { 'x-amzn-requestid': 'req-1' } })) as unknown as typeof fetch
    const bad = await probeEngine('chatgpt', { apiKey: 'k', fetch: f403 })
    expect(bad).toMatchObject({ engine: 'chatgpt', method: 'POST', path: '/chatgpt/chat', status: 403, ok: false, requestId: 'req-1' })
    expect(bad.body).toContain('not subscribed')
    const fOk = (async () => new Response(JSON.stringify({ status: 'OK', data: { reply_text: 'hi' } }), { status: 200 })) as unknown as typeof fetch
    expect((await probeEngine('google-ai-overviews', { apiKey: 'k', fetch: fOk })).ok).toBe(true)
    const boom = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const net = await probeEngine('gemini', { apiKey: 'k', fetch: boom })
    expect(net.status).toBe(0)
    expect(net.body).toContain('network error')
  })
})
