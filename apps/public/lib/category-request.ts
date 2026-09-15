/**
 * The category-correction contract: what `/api/category` says about a
 * domain's recorded category, and how a visitor files a request to change it.
 * ADR-0016, decisions 2 and 5.
 *
 * Separate from the route for the reason `preview-contract.ts` gives: a route
 * module may export only handlers. Both sides import from here.
 *
 * ⚠️ A REQUEST CHANGES NOTHING. It is stored on the machine that holds the
 * record and applied, or declined, by a person. The surface says so beside the
 * control, because a form under a "Send" button reads as configuration of a
 * running system.
 */

export const REASON_MIN = 10
export const REASON_MAX = 500

export interface CategoryChoice {
  readonly slug: string
  readonly name: string
  /** True when the bank was authored by a model rather than reviewed by a person. Said on the option. */
  readonly generated: boolean
}

export interface CategoryStatus {
  readonly domain: string
  readonly record: {
    readonly slug: string
    readonly name: string
    readonly source: string
    readonly decidedAt: string
    readonly version: number
    /** Every correction so far, oldest first. Empty on a record never corrected. */
    readonly corrections: readonly { readonly from: string; readonly to: string; readonly at: string; readonly by: string; readonly reason: string }[]
  }
  readonly categories: readonly CategoryChoice[]
  /** The pending request, without its reason: the reason is the filer's and the operator's, not the page's. */
  readonly pending: { readonly slug: string; readonly name: string; readonly requestedAt: string } | null
  /** Resolved requests, oldest first, so a declined one is visible with its note. */
  readonly history: readonly { readonly slug: string; readonly status: 'applied' | 'declined'; readonly requestedAt: string; readonly resolvedAt: string; readonly note: string }[]
  /** What applying a correction would do to the next cycle. Stated before anyone asks. */
  readonly nextCycle: { readonly prompts: number; readonly engines: number; readonly cells: number; readonly usd: number; readonly plan: string; readonly earlierCycles: number }
}

export type StatusResult = { readonly ok: true; readonly status: CategoryStatus } | { readonly ok: false; readonly kind: 'unavailable' | 'no-record' | 'failed'; readonly message: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Shape-check a status body. Storage and the wire are trust boundaries; a field that is not what it claims is dropped, never rendered. */
export function parseCategoryStatus(raw: unknown): CategoryStatus | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const rec = r['record']
  if (typeof rec !== 'object' || rec === null) return null
  const rr = rec as Record<string, unknown>
  if (!str(rr['slug']) || !str(r['domain'])) return null
  const corrections = Array.isArray(rr['corrections'])
    ? rr['corrections']
        .map((c) => (typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : null))
        .filter((c): c is Record<string, unknown> => c !== null && !!str(c['from']) && !!str(c['to']))
        .map((c) => ({ from: str(c['from']), to: str(c['to']), at: str(c['at']), by: str(c['by']), reason: str(c['reason']) }))
    : []
  const categories = Array.isArray(r['categories'])
    ? r['categories']
        .map((c) => (typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : null))
        .filter((c): c is Record<string, unknown> => c !== null && !!str(c['slug']))
        .map((c) => ({ slug: str(c['slug']), name: str(c['name']) || str(c['slug']), generated: c['generated'] === true }))
    : []
  const p = r['pending']
  const pending = typeof p === 'object' && p !== null && str((p as Record<string, unknown>)['slug']) ? { slug: str((p as Record<string, unknown>)['slug']), name: str((p as Record<string, unknown>)['name']) || str((p as Record<string, unknown>)['slug']), requestedAt: str((p as Record<string, unknown>)['requestedAt']) } : null
  const history = Array.isArray(r['history'])
    ? r['history']
        .map((h) => (typeof h === 'object' && h !== null ? (h as Record<string, unknown>) : null))
        .filter((h): h is Record<string, unknown> => h !== null && !!str(h['slug']) && (h['status'] === 'applied' || h['status'] === 'declined'))
        .map((h) => ({ slug: str(h['slug']), status: h['status'] as 'applied' | 'declined', requestedAt: str(h['requestedAt']), resolvedAt: str(h['resolvedAt']), note: str(h['note']) }))
    : []
  const n = typeof r['nextCycle'] === 'object' && r['nextCycle'] !== null ? (r['nextCycle'] as Record<string, unknown>) : {}
  return {
    domain: str(r['domain']),
    record: { slug: str(rr['slug']), name: str(rr['name']) || str(rr['slug']), source: str(rr['source']), decidedAt: str(rr['decidedAt']), version: Math.max(1, Math.floor(num(rr['version']) || 1)), corrections },
    categories,
    pending,
    history,
    nextCycle: { prompts: num(n['prompts']), engines: num(n['engines']), cells: num(n['cells']), usd: num(n['usd']), plan: str(n['plan']), earlierCycles: num(n['earlierCycles']) },
  }
}

export async function loadCategoryStatus(domain: string, fetchImpl: typeof fetch = fetch): Promise<StatusResult> {
  let res: Response
  try {
    res = await fetchImpl(`/api/category?domain=${encodeURIComponent(domain)}`)
  } catch (e) {
    return { ok: false, kind: 'unavailable', message: `Could not reach the category service: ${(e as Error).message}` }
  }
  if (res.status === 404) {
    // Two different absences share a status: no route on this deployment, or no record on this machine. The body tells them apart.
    let body: { kind?: unknown; message?: unknown } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      /* not JSON: the route does not exist here */
    }
    return body.kind === 'no-record'
      ? { ok: false, kind: 'no-record', message: String(body.message ?? '') }
      : { ok: false, kind: 'unavailable', message: 'Corrections are filed on the machine that holds the record, and this deployment does not hold one.' }
  }
  if (!res.ok) return { ok: false, kind: 'failed', message: `The category service answered ${res.status}.` }
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return { ok: false, kind: 'failed', message: 'The category service answered with something that is not a status.' }
  }
  const status = parseCategoryStatus(raw)
  return status ? { ok: true, status } : { ok: false, kind: 'failed', message: 'The category service answered with something that is not a status.' }
}

/** `applied` is present when the session applied the correction itself (an owner or admin, MVP_PLAN B4); absent when it was filed for a person to apply. */
export type FileResult = { readonly ok: true; readonly slug: string; readonly requestedAt: string; readonly applied?: true } | { readonly ok: false; readonly message: string }

export async function fileCorrection(domain: string, slug: string, reason: string, fetchImpl: typeof fetch = fetch): Promise<FileResult> {
  let res: Response
  try {
    res = await fetchImpl('/api/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, slug, reason }) })
  } catch (e) {
    return { ok: false, message: `Could not reach the category service: ${(e as Error).message}` }
  }
  let body: { message?: unknown; applied?: unknown; request?: { slug?: unknown; requestedAt?: unknown } } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    /* no body */
  }
  if (!res.ok) return { ok: false, message: String(body.message ?? `The category service answered ${res.status}.`) }
  const s = str(body.request?.slug)
  return s ? { ok: true, slug: s, requestedAt: str(body.request?.requestedAt), ...(body.applied === true ? { applied: true } : {}) } : { ok: false, message: 'The service did not confirm the request.' }
}
