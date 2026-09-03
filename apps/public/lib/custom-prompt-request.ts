/**
 * The custom-prompt contract: what `/api/custom-prompts` says about the set a
 * domain's cycles ask beside the curated bank, and how a visitor files a
 * request to change it. ADR-0016, decision 4. Separate from the route for the
 * reason `preview-contract.ts` gives.
 *
 * ⚠️ A REQUEST CHANGES NOTHING until a person applies it. When one does, the
 * next cycle asks the set as a SECOND measurement, with its own basis; the
 * headline and its trend are untouched.
 */

export const REASON_MIN = 10
export const REASON_MAX = 500

export interface CustomPromptStatus {
  readonly domain: string
  readonly category: { readonly slug: string; readonly name: string }
  /** The set in force, or null when the domain has none. */
  readonly set: { readonly version: number; readonly prompts: readonly string[]; readonly at: string; readonly by: string; readonly reason: string } | null
  readonly limits: { readonly maxPrompts: number; readonly promptMin: number; readonly promptMax: number }
  /** What each prompt adds to every cycle. */
  readonly perPrompt: { readonly cells: number; readonly usd: number; readonly plan: string }
  /** The pending request, without its reason. */
  readonly pending: { readonly prompts: readonly string[]; readonly requestedAt: string } | null
  readonly history: readonly { readonly status: 'applied' | 'declined'; readonly requestedAt: string; readonly resolvedAt: string; readonly note: string }[]
}

export type StatusResult = { readonly ok: true; readonly status: CustomPromptStatus } | { readonly ok: false; readonly kind: 'unavailable' | 'no-record' | 'failed'; readonly message: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null)

export function parseCustomPromptStatus(raw: unknown): CustomPromptStatus | null {
  const r = obj(raw)
  const cat = r ? obj(r['category']) : null
  if (!r || !cat || !str(r['domain']) || !str(cat['slug'])) return null
  const set = obj(r['set'])
  const lim = obj(r['limits']) ?? {}
  const per = obj(r['perPrompt']) ?? {}
  const p = obj(r['pending'])
  return {
    domain: str(r['domain']),
    category: { slug: str(cat['slug']), name: str(cat['name']) || str(cat['slug']) },
    set: set && num(set['version']) >= 1 ? { version: num(set['version']), prompts: strs(set['prompts']), at: str(set['at']), by: str(set['by']), reason: str(set['reason']) } : null,
    limits: { maxPrompts: num(lim['maxPrompts']), promptMin: num(lim['promptMin']), promptMax: num(lim['promptMax']) },
    perPrompt: { cells: num(per['cells']), usd: num(per['usd']), plan: str(per['plan']) },
    pending: p ? { prompts: strs(p['prompts']), requestedAt: str(p['requestedAt']) } : null,
    history: (Array.isArray(r['history']) ? r['history'] : [])
      .map(obj)
      .filter((h): h is Record<string, unknown> => h !== null && (h['status'] === 'applied' || h['status'] === 'declined'))
      .map((h) => ({ status: h['status'] as 'applied' | 'declined', requestedAt: str(h['requestedAt']), resolvedAt: str(h['resolvedAt']), note: str(h['note']) })),
  }
}

export async function loadCustomPromptStatus(domain: string, fetchImpl: typeof fetch = fetch): Promise<StatusResult> {
  let res: Response
  try {
    res = await fetchImpl(`/api/custom-prompts?domain=${encodeURIComponent(domain)}`)
  } catch (e) {
    return { ok: false, kind: 'unavailable', message: `Could not reach the prompt service: ${(e as Error).message}` }
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
      : { ok: false, kind: 'unavailable', message: 'Prompts are filed on the machine that holds the record, and this deployment does not hold one.' }
  }
  if (!res.ok) return { ok: false, kind: 'failed', message: `The prompt service answered ${res.status}.` }
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return { ok: false, kind: 'failed', message: 'The prompt service answered with something that is not a status.' }
  }
  const status = parseCustomPromptStatus(raw)
  return status ? { ok: true, status } : { ok: false, kind: 'failed', message: 'The prompt service answered with something that is not a status.' }
}

export type FileResult = { readonly ok: true; readonly requestedAt: string; readonly prompts: readonly string[] } | { readonly ok: false; readonly message: string }

export async function filePromptSet(domain: string, prompts: readonly string[], reason: string, fetchImpl: typeof fetch = fetch): Promise<FileResult> {
  let res: Response
  try {
    res = await fetchImpl('/api/custom-prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, prompts, reason }) })
  } catch (e) {
    return { ok: false, message: `Could not reach the prompt service: ${(e as Error).message}` }
  }
  let body: { message?: unknown; request?: { requestedAt?: unknown; prompts?: unknown } } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    /* no body */
  }
  if (!res.ok) return { ok: false, message: String(body.message ?? `The prompt service answered ${res.status}.`) }
  const at = str(body.request?.requestedAt)
  return at ? { ok: true, requestedAt: at, prompts: strs(body.request?.prompts) } : { ok: false, message: 'The service did not confirm the request.' }
}
