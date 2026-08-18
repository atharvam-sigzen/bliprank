/**
 * OpenWeb Ninja AI Answers adapters — implementation #1 of the EngineAdapter
 * contract (ADR-0001). One adapter per engine, all sharing the `openwebninja`
 * rate-budget bucket. Every surface is `third-party-grounded`
 * (docs/METHODOLOGY.md).
 *
 * Request shapes and payload fields come from the provider's published docs and
 * its official MCP server (@openwebninja/mcp-server 0.2.1); the envelope is
 * `{ status, request_id, data }`. Only the Google surfaces accept gl/hl — for
 * ChatGPT, Gemini and Copilot the locale/geo in the cell are what we *asked
 * for*, but egress is the provider's default. Disclosed in the pilot report.
 */

import {
  AdapterError,
  type AnswerBody,
  type Citation,
  type CollectRequest,
  type EngineAdapter,
  type EngineId,
  type RateLimit,
  type RawAnswer,
} from '@bliprank/contracts'

export const PROVIDER = 'openwebninja'
export const DEFAULT_BASE_URL = 'https://api.openwebninja.com'

/** Provider plan — decides marginal $/call and the per-API rate ceiling. */
export type OwnPlan = 'payg' | 'pro' | 'ultra' | 'mega'

/**
 * Marginal USD per request by plan, from the provider's public pricing pages
 * (2026-08-18). Subscription tiers include a monthly quota; the marginal rate is
 * the overage rate. Pay-as-you-go is the safe default when the plan is unknown.
 */
export const PRICE_USD_PER_CALL: Record<OwnPlan, Record<EngineId, number>> = {
  payg: { chatgpt: 0.007, gemini: 0.007, copilot: 0.007, 'google-ai-mode': 0.008, 'google-ai-overviews': 0.005 },
  pro: { chatgpt: 0.005, gemini: 0.005, copilot: 0.005, 'google-ai-mode': 0.005, 'google-ai-overviews': 0.003 },
  ultra: { chatgpt: 0.003, gemini: 0.003, copilot: 0.003, 'google-ai-mode': 0.003, 'google-ai-overviews': 0.002 },
  mega: { chatgpt: 0.002, gemini: 0.002, copilot: 0.002, 'google-ai-mode': 0.002, 'google-ai-overviews': 0.001 },
}

/** Published requests/second ceiling per API by plan (2026-08-18). */
export const RPS_CEILING: Record<OwnPlan, Record<EngineId, number>> = {
  payg: { chatgpt: 5, gemini: 5, copilot: 5, 'google-ai-mode': 5, 'google-ai-overviews': 2 },
  pro: { chatgpt: 5, gemini: 5, copilot: 5, 'google-ai-mode': 5, 'google-ai-overviews': 2 },
  ultra: { chatgpt: 10, gemini: 10, copilot: 10, 'google-ai-mode': 8, 'google-ai-overviews': 5 },
  mega: { chatgpt: 15, gemini: 15, copilot: 15, 'google-ai-mode': 10, 'google-ai-overviews': 10 },
}

export interface OwnAdapterOptions {
  readonly apiKey: string
  readonly plan?: OwnPlan
  readonly baseUrl?: string
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

interface HttpRequest {
  readonly method: 'GET' | 'POST'
  readonly url: string
  readonly body?: Record<string, unknown>
}

/** How each engine is called. hl = language subtag of the cell locale, gl = cell geo. */
function buildRequest(base: string, engine: EngineId, req: CollectRequest): HttpRequest {
  const hl = req.cell.locale.split('-')[0] ?? 'en'
  const gl = req.cell.geo.toLowerCase()
  switch (engine) {
    case 'chatgpt':
      return { method: 'POST', url: `${base}/chatgpt/chat`, body: { message: req.prompt, markdown: true } }
    case 'gemini':
      return { method: 'POST', url: `${base}/gemini/chat`, body: { message: req.prompt, markdown: true } }
    case 'copilot':
      return { method: 'POST', url: `${base}/copilot/copilot`, body: { message: req.prompt, mode: 'CHAT', markdown: true } }
    case 'google-ai-mode': {
      const u = new URL(`${base}/google-ai-mode/ai-mode`)
      u.searchParams.set('prompt', req.prompt)
      u.searchParams.set('gl', gl)
      u.searchParams.set('hl', hl)
      return { method: 'GET', url: u.toString() }
    }
    case 'google-ai-overviews': {
      const u = new URL(`${base}/ai-overviews/ai-overviews`)
      u.searchParams.set('q', req.prompt)
      u.searchParams.set('gl', gl)
      u.searchParams.set('hl', hl)
      return { method: 'GET', url: u.toString() }
    }
  }
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Envelope `{status, request_id, data}` → data; a bare object is accepted too. */
function unwrap(payload: unknown): Json {
  if (!isObj(payload)) throw new AdapterError('unparseable', 'payload is not an object', false)
  const data = payload['data']
  return isObj(data) ? data : payload
}

const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g

/** Markdown links in answer text, in order of appearance, deduplicated by URL. */
function citationsFromMarkdown(text: string): Citation[] {
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const m of text.matchAll(MD_LINK)) {
    const url = m[2] ?? ''
    if (!url || seen.has(url)) continue
    seen.add(url)
    const title = m[1] ?? ''
    out.push(title ? { url, title, position: out.length } : { url, position: out.length })
  }
  return out
}

/** `reference_links` / `citations` arrays → Citation[] (skips entries without a URL). */
function citationsFromArray(v: unknown): Citation[] {
  if (!Array.isArray(v)) return []
  const out: Citation[] = []
  for (const item of v) {
    if (!isObj(item)) continue
    const url = str(item['link']) || str(item['url'])
    if (!url) continue
    const title = str(item['title'])
    out.push(title ? { url, title, position: out.length } : { url, position: out.length })
  }
  return out
}

/** Google "parts" arrays (`text_parts` / `reply_parts`) → plain text. */
function textFromParts(v: unknown): string {
  if (!Array.isArray(v)) return ''
  const chunks: string[] = []
  for (const part of v) {
    if (!isObj(part)) continue
    const t = str(part['text'])
    if (t) chunks.push(t)
    const list = part['list']
    if (Array.isArray(list)) {
      for (const li of list) {
        if (!isObj(li)) continue
        const title = str(li['title'])
        const text = str(li['text'])
        if (title || text) chunks.push([title, text].filter(Boolean).join(': '))
      }
    }
  }
  return chunks.join('\n')
}

/** Pure, per-engine payload → AnswerBody. Exported so fixtures exercise it directly. */
export function normaliseOwn(engine: EngineId, payload: unknown): AnswerBody {
  const d = unwrap(payload)
  switch (engine) {
    case 'chatgpt':
    case 'gemini': {
      const text = str(d['reply_text'])
      if (!('reply_text' in d)) throw new AdapterError('unparseable', `${engine}: no reply_text`, false)
      // content_references (ChatGPT) is undocumented in shape; markdown links are the reliable signal.
      return { text, citations: citationsFromMarkdown(text) }
    }
    case 'copilot': {
      if (!('message' in d)) throw new AdapterError('unparseable', 'copilot: no message', false)
      const text = str(d['message'])
      const cites = citationsFromArray(d['citations'])
      return { text, citations: cites.length ? cites : citationsFromMarkdown(text) }
    }
    case 'google-ai-mode': {
      if (!('reply_parts' in d)) throw new AdapterError('unparseable', 'ai-mode: no reply_parts', false)
      return { text: textFromParts(d['reply_parts']), citations: citationsFromArray(d['reference_links']) }
    }
    case 'google-ai-overviews': {
      if (!('search_returned_ai_overviews' in d) && !('text_parts' in d)) {
        throw new AdapterError('unparseable', 'ai-overviews: no text_parts / search_returned_ai_overviews', false)
      }
      // No overview shown is a valid, parseable answer: empty text, no citations.
      if (d['search_returned_ai_overviews'] === false) return { text: '', citations: [] }
      return { text: textFromParts(d['text_parts']), citations: citationsFromArray(d['reference_links']) }
    }
  }
}

function classifyHttp(status: number, detail: string, retryAfterMs?: number): AdapterError {
  if (status === 429) return new AdapterError('rate-limited', `HTTP 429: ${detail}`, true, retryAfterMs)
  if (status === 408 || status === 504) return new AdapterError('timeout', `HTTP ${status}: ${detail}`, true)
  if (status >= 500) return new AdapterError('provider', `HTTP ${status}: ${detail}`, true)
  // 401/402/403 (auth, quota, plan) and other 4xx: retrying only spends more.
  return new AdapterError('rejected', `HTTP ${status}: ${detail}`, false)
}

export function openWebNinjaAdapter(engine: EngineId, opts: OwnAdapterOptions): EngineAdapter {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const plan: OwnPlan = opts.plan ?? 'payg'
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? (() => new Date())
  const id = `${PROVIDER}:${engine}`

  return {
    id,
    provider: PROVIDER,
    engine,
    collectionPath: 'third-party-grounded',

    normalise: (payload) => normaliseOwn(engine, payload),

    rateLimit(): RateLimit {
      const rps = RPS_CEILING[plan][engine]
      return { rps, burst: rps }
    },

    async collect(req: CollectRequest): Promise<RawAnswer> {
      const http = buildRequest(base, engine, req)
      const started = now()
      const t0 = performance.now()
      let res: Response
      try {
        const init: RequestInit = {
          method: http.method,
          headers: {
            'x-api-key': opts.apiKey,
            Accept: 'application/json',
            'User-Agent': 'bliprank-collector',
            ...(http.body ? { 'Content-Type': 'application/json' } : {}),
          },
          signal: req.signal ?? null,
        }
        if (http.body) init.body = JSON.stringify(http.body)
        res = await doFetch(http.url, init)
      } catch (e) {
        const aborted = (e as { name?: string })?.name === 'AbortError'
        throw new AdapterError(aborted ? 'timeout' : 'provider', `${id}: ${aborted ? 'aborted' : 'network error'}`, true, undefined, {
          cause: e,
        })
      }
      const latencyMs = Math.round(performance.now() - t0)
      const raw = await res.text()
      let payload: unknown = raw
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch {
        /* keep the raw string; unparseable is decided below */
      }
      if (!res.ok) {
        const detail = isObj(payload)
          ? str((isObj(payload['error']) ? payload['error']['message'] : payload['error']) ?? payload['message']) || res.statusText
          : raw.slice(0, 200) || res.statusText
        const ra = Number(res.headers.get('retry-after'))
        throw classifyHttp(res.status, detail, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined)
      }
      const body = normaliseOwn(engine, payload) // throws AdapterError('unparseable') on unknown shape
      return {
        ...body,
        cell: req.cell,
        prompt: req.prompt,
        run: req.run,
        adapter: id,
        collectionPath: 'third-party-grounded',
        collectedAt: started.toISOString(),
        latencyMs,
        providerCalls: 1,
        payload,
      }
    },
  }
}
