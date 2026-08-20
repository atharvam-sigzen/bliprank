/**
 * Second provider stub — PHASES.md 1.3, ADR-0001 §2: "a second provider is
 * stubbed against the same contract before launch — the abstraction must be
 * proven, not theoretical."
 *
 * This is NOT a real vendor. It is a deliberately different payload dialect
 * (HTML content, differently-named citation fields, a different envelope, a
 * different error shape) served from deterministic local fixtures with zero
 * network and zero spend. What it proves: EngineAdapter absorbs a second
 * provider without any change to the runner, the cache key, the scorer input
 * (AnswerBody) or the R2 record (RawAnswer). Its collectionPath is
 * 'official-api' so the alternate disclosure value is exercised end to end
 * (the "Verified Sources" path in ADR-0001 §6).
 *
 * When a real second vendor is chosen, this file is the template: replace the
 * fixture transport with HTTP and keep normalise() pure.
 */

import { createHash } from 'node:crypto'
import {
  AdapterError,
  type AnswerBody,
  type Citation,
  type CollectRequest,
  type EngineAdapter,
  type EngineId,
  type RawAnswer,
} from '@bliprank/contracts'

export const STUB_PROVIDER = 'stubsearch'

/** The stub vendor's wire format — nothing like OpenWeb Ninja's on purpose. */
export interface StubEnvelope {
  api_version: 'v2'
  request: { surface: string; q: string }
  result: {
    /** Answer as HTML — the scorer needs text, so normalise must strip it. */
    content_html: string
    /** Citations under different names than the primary provider uses. */
    sources: { target_url: string; display_name?: string; rank: number }[]
  } | null
  /** Vendor-style error object, present instead of result. */
  fault?: { code: string; description: string }
}

const unit = (seed: string): number => createHash('sha256').update(seed).digest().readUInt32BE(0) / 2 ** 32

const STUB_BRANDS = [
  { name: 'HubSpot', url: 'https://www.hubspot.com/products/crm' },
  { name: 'Salesforce', url: 'https://www.salesforce.com/products/' },
  { name: 'Zoho CRM', url: 'https://www.zoho.com/crm/' },
]

/** Deterministic payload for a (prompt, engine, day, run) — the stub's "network". */
export function stubPayload(engine: EngineId, prompt: string, day: string, run: number): StubEnvelope {
  const mentioned = STUB_BRANDS.filter((b) => {
    const p = 0.15 + 0.7 * unit(`${STUB_PROVIDER}|${engine}|${prompt}|${b.name}|p`)
    return unit(`${STUB_PROVIDER}|${engine}|${prompt}|${b.name}|${day}|${run}`) < p
  })
  const paras = mentioned.length
    ? [`<p>For <em>${prompt}</em> the options most often named are ${mentioned.map((b) => `<a href="${b.url}">${b.name}</a>`).join(', ')}.</p>`, '<p>Weigh team size and budget before choosing.</p>']
    : [`<p>For <em>${prompt}</em> there is no single answer; compare a few tools on price and fit.</p>`]
  return {
    api_version: 'v2',
    request: { surface: engine, q: prompt },
    result: {
      content_html: paras.join('\n'),
      sources: mentioned.map((b, i) => ({ target_url: b.url, display_name: b.name, rank: i + 1 })),
    },
  }
}

const TAG = /<[^>]+>/g
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Pure: the stub dialect → the provider-agnostic AnswerBody the scorer reads. */
export function normaliseStub(payload: unknown): AnswerBody {
  if (!isObj(payload) || payload['api_version'] !== 'v2') {
    throw new AdapterError('unparseable', 'stub: not a v2 envelope', false)
  }
  if (payload['fault'] !== undefined) {
    const f = payload['fault']
    throw new AdapterError('unparseable', `stub: fault ${isObj(f) ? String(f['code']) : 'unknown'}`, false)
  }
  const result = payload['result']
  if (result === null) return { text: '', citations: [] } // surface returned no answer — valid, empty
  if (!isObj(result) || typeof result['content_html'] !== 'string') {
    throw new AdapterError('unparseable', 'stub: no result.content_html', false)
  }
  const text = result['content_html'].replace(TAG, '').replace(/\s+/g, ' ').trim()
  const citations: Citation[] = []
  const sources = result['sources']
  if (Array.isArray(sources)) {
    // rank is the vendor's order; Citation.position is ours (0-based, in rank order)
    const ranked = sources
      .filter(isObj)
      .filter((s) => typeof s['target_url'] === 'string' && s['target_url'])
      .sort((a, b) => Number(a['rank'] ?? 0) - Number(b['rank'] ?? 0))
    for (const s of ranked) {
      const title = typeof s['display_name'] === 'string' && s['display_name'] ? { title: s['display_name'] } : {}
      citations.push({ url: s['target_url'] as string, position: citations.length, ...title })
    }
  }
  return { text, citations }
}

export function stubAdapter(engine: EngineId): EngineAdapter {
  const id = `${STUB_PROVIDER}:${engine}`
  return {
    id,
    provider: STUB_PROVIDER,
    engine,
    collectionPath: 'official-api',
    normalise: normaliseStub,
    rateLimit: () => ({ rps: 5, burst: 5 }),
    async collect(req: CollectRequest): Promise<RawAnswer> {
      const payload = stubPayload(engine, req.prompt, req.cell.dateBucket, req.run)
      const body = normaliseStub(payload)
      return {
        ...body,
        cell: req.cell,
        prompt: req.prompt,
        run: req.run,
        adapter: id,
        collectionPath: 'official-api',
        collectedAt: new Date().toISOString(),
        latencyMs: 1,
        providerCalls: 0, // zero network, zero spend — it is a stub
        payload,
      }
    },
  }
}
