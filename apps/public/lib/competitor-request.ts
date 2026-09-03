/**
 * The competitor-override contract: what `/api/competitors` says about the set
 * a domain is measured against, and how a visitor files a request to adjust
 * it. ADR-0016, decision 3. Separate from the route for the reason
 * `preview-contract.ts` gives.
 *
 * ⚠️ A REQUEST CHANGES NOTHING until a person applies it, and applying one
 * moves the basis: the next cycle is not comparable with the last, and the
 * record says "the competitor set" changed.
 */

export const REASON_MIN = 10
export const REASON_MAX = 500

export interface CompetitorEntry {
  readonly id: string
  readonly name: string
  /** `category`: the category's own set. `included`: added by this domain's override. */
  readonly source: 'category' | 'included'
}

export interface CompetitorStatus {
  readonly domain: string
  readonly category: { readonly slug: string; readonly name: string; readonly bankVersion: number }
  /** The override version in force, or null when the category's set applies alone. */
  readonly set: number | null
  /** What the next cycle would measure against, in order. */
  readonly competitors: readonly CompetitorEntry[]
  /** Category leaders this domain's override has excluded. */
  readonly excluded: readonly { readonly id: string; readonly name: string }[]
  /** Reviewed leaders not in the set, which an include may draw on. */
  readonly includable: readonly { readonly id: string; readonly name: string; readonly bank: string }[]
  readonly last: { readonly version: number; readonly at: string; readonly by: string; readonly reason: string } | null
  /** The pending request, without its reason. */
  readonly pending: { readonly exclude: readonly string[]; readonly include: readonly string[]; readonly requestedAt: string } | null
  readonly history: readonly { readonly status: 'applied' | 'declined'; readonly requestedAt: string; readonly resolvedAt: string; readonly note: string }[]
}

export type StatusResult = { readonly ok: true; readonly status: CompetitorStatus } | { readonly ok: false; readonly kind: 'unavailable' | 'no-record' | 'failed'; readonly message: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])
const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [])

export function parseCompetitorStatus(raw: unknown): CompetitorStatus | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const cat = typeof r['category'] === 'object' && r['category'] !== null ? (r['category'] as Record<string, unknown>) : null
  if (!str(r['domain']) || !cat || !str(cat['slug'])) return null
  const last = typeof r['last'] === 'object' && r['last'] !== null ? (r['last'] as Record<string, unknown>) : null
  const p = typeof r['pending'] === 'object' && r['pending'] !== null ? (r['pending'] as Record<string, unknown>) : null
  return {
    domain: str(r['domain']),
    category: { slug: str(cat['slug']), name: str(cat['name']) || str(cat['slug']), bankVersion: num(cat['bankVersion']) },
    set: typeof r['set'] === 'number' && Number.isInteger(r['set']) && r['set'] >= 1 ? r['set'] : null,
    competitors: objs(r['competitors'])
      .filter((c) => str(c['id']))
      .map((c) => ({ id: str(c['id']), name: str(c['name']) || str(c['id']), source: c['source'] === 'included' ? 'included' : 'category' })),
    excluded: objs(r['excluded'])
      .filter((c) => str(c['id']))
      .map((c) => ({ id: str(c['id']), name: str(c['name']) || str(c['id']) })),
    includable: objs(r['includable'])
      .filter((c) => str(c['id']))
      .map((c) => ({ id: str(c['id']), name: str(c['name']) || str(c['id']), bank: str(c['bank']) })),
    last: last && num(last['version']) >= 1 ? { version: num(last['version']), at: str(last['at']), by: str(last['by']), reason: str(last['reason']) } : null,
    pending: p ? { exclude: strs(p['exclude']), include: strs(p['include']), requestedAt: str(p['requestedAt']) } : null,
    history: objs(r['history'])
      .filter((h) => h['status'] === 'applied' || h['status'] === 'declined')
      .map((h) => ({ status: h['status'] as 'applied' | 'declined', requestedAt: str(h['requestedAt']), resolvedAt: str(h['resolvedAt']), note: str(h['note']) })),
  }
}

export async function loadCompetitorStatus(domain: string, fetchImpl: typeof fetch = fetch): Promise<StatusResult> {
  let res: Response
  try {
    res = await fetchImpl(`/api/competitors?domain=${encodeURIComponent(domain)}`)
  } catch (e) {
    return { ok: false, kind: 'unavailable', message: `Could not reach the competitor service: ${(e as Error).message}` }
  }
  if (res.status === 404) {
    let body: { kind?: unknown; message?: unknown } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      /* not JSON: the route does not exist here */
    }
    return body.kind === 'no-record'
      ? { ok: false, kind: 'no-record', message: String(body.message ?? '') }
      : { ok: false, kind: 'unavailable', message: 'Competitor adjustments are filed on the machine that holds the record, and this deployment does not hold one.' }
  }
  if (!res.ok) return { ok: false, kind: 'failed', message: `The competitor service answered ${res.status}.` }
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return { ok: false, kind: 'failed', message: 'The competitor service answered with something that is not a status.' }
  }
  const status = parseCompetitorStatus(raw)
  return status ? { ok: true, status } : { ok: false, kind: 'failed', message: 'The competitor service answered with something that is not a status.' }
}

export type FileResult = { readonly ok: true; readonly requestedAt: string } | { readonly ok: false; readonly message: string }

export async function fileCompetitorChange(domain: string, exclude: readonly string[], include: readonly string[], reason: string, fetchImpl: typeof fetch = fetch): Promise<FileResult> {
  let res: Response
  try {
    res = await fetchImpl('/api/competitors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, exclude, include, reason }) })
  } catch (e) {
    return { ok: false, message: `Could not reach the competitor service: ${(e as Error).message}` }
  }
  let body: { message?: unknown; request?: { requestedAt?: unknown } } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    /* no body */
  }
  if (!res.ok) return { ok: false, message: String(body.message ?? `The competitor service answered ${res.status}.`) }
  const at = str(body.request?.requestedAt)
  return at ? { ok: true, requestedAt: at } : { ok: false, message: 'The service did not confirm the request.' }
}
