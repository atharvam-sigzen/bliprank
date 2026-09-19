/**
 * THE DOMAIN'S PROMPT SET — the person's own questions, stored where the
 * record is, versioned, and since ADR-0016 Amendment 1 THE measurement a
 * cycle takes (owner decision 2026-09-16; MVP_PLAN C3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE SET IS, AND IS NOT.
 *
 * The curated bank is the category's sample: unprompted questions that name
 * no brand, the same for every domain in the category. On first entry it is
 * what a person sees. When the person edits it, adding, removing or rewording,
 * the result is saved here as version V, and from then on THAT set is what a
 * cycle asks, on every engine, and what the headline measures: its basis is
 * the bank's with `unprompted=0` and `custom=K@V`, the record says "your K
 * prompts, version V", the trend breaks at a version change exactly as it
 * breaks at any other change of basis, and a head-to-head compares equal bases
 * only. The bank's set is not collected separately for that domain unless the
 * person kept its prompts. Decision 4's "second measurement" (2026-09-03) is
 * superseded by this: a stored cycle that carried a second block still reads
 * back with it, and nothing new writes one.
 *
 * ⚠️ PROPERTY 2 HOLDS FOR THE CUSTOMER'S PROMPTS TOO. A prompt that names the
 * subject guarantees the subject a mention and reports our own phrasing back
 * as visibility; a prompt that names a tracked brand does the same for that
 * brand. Both are refused, with the same matcher the scorer uses to decide a
 * mention (`namesTrackedBrand`, `domainBrandForms`) — the machinery that
 * refuses a model-authored bank, reused on the customer's text so the two
 * cannot disagree about what "names a brand" means.
 *
 * Versioned like an override: every change is a new version with the earlier
 * set kept whole, the basis carries the version, and a stored cycle reads
 * back under the set it was measured with. Request-then-apply, as with the
 * category and the competitor set; a file lock shared with the record store.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalisePrompt } from '@bliprank/contracts'
import { domainBrandForms, findMentions, normaliseForMatch, squash, type BrandSpec } from '@bliprank/scorer'
import { normaliseHost, type PromptBank } from '@bliprank/taxonomy'
import { allBanks, namesTrackedBrand, plainText, readCategoryRecord, trackedBrands, withRecordLock, type CategoryRecord } from './resolve-category.js'
import { categoryRecordIn, customPromptsIn } from './store/documents.js'
import type { WorkspaceStore } from './store/pg-store.js'

/**
 * Custom prompts per domain in this build: a constant with no plan behind it.
 * The published plans (`apps/public/lib/pricing.ts`) share one pool between the
 * curated bank and the customer's own, and no plan is attached to anything in
 * this build, so this is not an entitlement and not the Starter pool (which,
 * shared with 17 curated prompts, would admit none). It bounds cells, cost and
 * the ceiling; the surface says so in those words.
 */
// One cycle's prompt count (`DEFAULT_PROMPTS_PER_SCAN`, live-gate.ts): the
// edited set IS the measurement, and a measurement costs at most one cycle's
// cells, so the set is bounded where the bank is (ADR-0016 Amendment 1).
export const MAX_CUSTOM_PROMPTS = 17
export const PROMPT_MIN = 10
export const PROMPT_MAX = 200

export interface CustomPromptSet {
  readonly host: string
  /** 1 on the first set, one more per change. The custom basis carries it as `custom=K@V`. */
  readonly version: number
  readonly prompts: readonly string[]
  readonly reason: string
  readonly by: string
  readonly at: string
  readonly superseded?: readonly SupersededSet[]
}
export type SupersededSet = Omit<CustomPromptSet, 'superseded'>

const setsFile = (dataDir: string): string => join(dataDir, 'custom-prompts.json')
const requestsFile = (dataDir: string): string => join(dataDir, 'custom-prompt-requests.json')

const cleanList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string').map(plainText).filter(Boolean) : [])

function shapeSet(host: string, value: unknown, withHistory: boolean): CustomPromptSet | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Partial<CustomPromptSet>
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return null
  if (typeof r.reason !== 'string' || typeof r.by !== 'string' || typeof r.at !== 'string') return null
  const superseded = withHistory && Array.isArray(r.superseded) ? r.superseded.map((v) => shapeSet(host, v, false)).filter((v): v is CustomPromptSet => v !== null) : []
  return { host, version: r.version, prompts: cleanList(r.prompts), reason: r.reason, by: r.by, at: r.at, ...(superseded.length ? { superseded } : {}) }
}

function readSets(dataDir: string): Record<string, CustomPromptSet> {
  const f = setsFile(dataDir)
  try {
    if (!existsSync(f)) return {}
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, CustomPromptSet> = {}
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      const s = shapeSet(host, value, true)
      if (s) out[host] = s
    }
    return out
  } catch {
    return {}
  }
}

/** The set in force for a domain, or null when it has none. */
export function readCustomPromptSet(dataDir: string, domain: string): CustomPromptSet | null {
  const host = normaliseHost(domain)
  return host ? (readSets(dataDir)[host] ?? null) : null
}

/** The set at `version`, for reading a stored cycle back under the prompts it was measured with. */
export function customPromptsAt(dataDir: string, domain: string, version: number): SupersededSet | null {
  const current = readCustomPromptSet(dataDir, domain)
  if (!current) return null
  if (current.version === version) {
    const { superseded: _h, ...now } = current
    return now
  }
  return current.superseded?.find((s) => s.version === version) ?? null
}

export type PromptRefusal = { readonly refuse: string; readonly kind: 'input' | 'no-record' | 'no-change' | 'names-brand' | 'too-many' }

/**
 * Check a proposed list against the record, the length and count bounds, and
 * PROPERTY 2. Shared by the request store and the writer. Returns the
 * normalised list (trimmed, control characters out, case-insensitive
 * duplicates dropped) or a refusal that names the prompt and the brand.
 */
export type CheckedPrompts = { readonly host: string; readonly prompts: readonly string[]; readonly reason: string }

export function checkCustomPrompts(dataDir: string, domain: string, prompts: readonly unknown[], reason: string): CheckedPrompts | PromptRefusal {
  const host = normaliseHost(domain)
  return checkCustomPromptsWith(domain, prompts, reason, host ? readCategoryRecord(dataDir, host) : null, allBanks(dataDir))
}

/** THE DECISION, pure: the prompts against the record the store holds and the banks this build has (MVP_PLAN B3b). */
export function checkCustomPromptsWith(domain: string, prompts: readonly unknown[], reason: string, record: CategoryRecord | null, banks: readonly PromptBank[]): CheckedPrompts | PromptRefusal {
  const host = normaliseHost(domain)
  if (!host) return { refuse: 'not a domain', kind: 'input' }
  const why = plainText(reason)
  if (why.length < 10) return { refuse: 'say why, in at least ten characters: it is read by the person who applies it', kind: 'input' }
  if (why.length > 500) return { refuse: 'keep the reason under 500 characters', kind: 'input' }
  if (!Array.isArray(prompts) || prompts.some((p) => typeof p !== 'string')) return { refuse: 'prompts are a list of sentences', kind: 'input' }
  // Bounded before any work: an unauthenticated filing must not make the store fold and match a thousand strings.
  if (prompts.length > MAX_CUSTOM_PROMPTS * 4) return { refuse: `${prompts.length} prompts is far over the ${MAX_CUSTOM_PROMPTS} this build allows per domain`, kind: 'too-many' }
  if (!record) return { refuse: `${host} has no category on record, so there is no cycle for its prompts to join. A first scan decides one.`, kind: 'no-record' }

  const seen = new Set<string>()
  const list: string[] = []
  for (const raw of prompts as string[]) {
    const p = plainText(raw)
    if (p.length < PROMPT_MIN) return { refuse: `"${p}" is too short to be a question the engines can answer; at least ${PROMPT_MIN} characters`, kind: 'input' }
    if (p.length > PROMPT_MAX) return { refuse: `"${p.slice(0, 40)}…" is over ${PROMPT_MAX} characters`, kind: 'input' }
    // A prompt is a question, not a link. A URL is a brand the matcher cannot see (it masks URLs before matching), and the engine reads it as one.
    if (/(^|\s)(https?:\/\/|www\.)/i.test(p) || /\S+\.[a-z]{2,}\/\S*/i.test(p)) return { refuse: `"${p}" carries a link. A prompt is a question in words; a URL names a site, and a named site is a named brand.`, kind: 'names-brand' }
    // The cache key's own normalisation decides what is the same question: "best crm?" and "best crm" are one cell, so they are one prompt here.
    // A prompt the bank also asks is KEPT, not refused: the set replaces the bank (Amendment 1), so a kept bank prompt is one cell, asked once.
    const key = normalisePrompt(p)
    if (seen.has(key)) continue
    seen.add(key)
    list.push(p)
  }
  if (list.length > MAX_CUSTOM_PROMPTS) return { refuse: `${list.length} prompts is over the ${MAX_CUSTOM_PROMPTS} this build allows per domain`, kind: 'too-many' }

  // PROPERTY 2, on the customer's text, with the scorer's own matcher — and,
  // for the subject only, on the squashed text too: "acmelabs" is the subject
  // written without its space, which the whole-token matcher cannot see and a
  // person plainly can.
  const forms = domainBrandForms(host, record.brandName)
  const subject: BrandSpec = { id: 'subject', name: forms.name, aliases: forms.aliases, squashedAliases: forms.squashedAliases, domains: [host] }
  const squashedForms = [...new Set([...forms.squashedAliases, ...forms.aliases.map(squash)])].filter((f) => f.length >= 4)
  const tracked = trackedBrands(banks)
  for (const p of list) {
    const namesSubject = findMentions(normaliseForMatch(p), subject) !== null || squashedForms.some((f) => squash(p).includes(f))
    if (namesSubject) return { refuse: `"${p}" names ${forms.name}, your own brand. A prompt that names you guarantees a mention and measures our phrasing, not the engines' habit; ask the question without the name.`, kind: 'names-brand' }
    const hit = namesTrackedBrand(p, tracked)
    if (hit) return { refuse: `"${p}" names ${hit.name} (matched "${hit.alias}"), a brand this build tracks. A prompt that names a tracked brand guarantees it a mention in its own score; ask without the name.`, kind: 'names-brand' }
  }
  return { host, prompts: list, reason: why }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** THE WRITER. A new set one version up, the earlier ones kept whole; an identical list is refused as no change. An empty list clears the set, and is a version too. */
export type PromptSetRequest = { readonly host: string; readonly prompts: readonly string[]; readonly reason: string; readonly by: string; readonly at?: string }

export function applyCustomPrompts(dataDir: string, req: PromptSetRequest): CustomPromptSet | PromptRefusal {
  const checked = checkCustomPrompts(dataDir, req.host, req.prompts, req.reason)
  if ('refuse' in checked) return checked
  const by = plainText(req.by)
  if (!by) return { refuse: 'a prompt set names who applied it', kind: 'input' }
  return withRecordLock(dataDir, () => {
    const store = readSets(dataDir)
    const next = nextPromptSet(store[checked.host] ?? null, checked, by, req.at ?? new Date().toISOString())
    if ('refuse' in next) return next
    writeFileSync(setsFile(dataDir), JSON.stringify({ ...store, [checked.host]: next }, null, 2) + '\n')
    return next
  })
}

/** THE NEXT SET, pure: version N+1 over the one in force, or the refusal that nothing changed (MVP_PLAN B4). */
export function nextPromptSet(current: CustomPromptSet | null, checked: CheckedPrompts, by: string, at: string): CustomPromptSet | PromptRefusal {
  if (current && sameList(current.prompts, checked.prompts)) return { refuse: `${checked.host}'s prompts already stand exactly so (set ${current.version}); nothing to change`, kind: 'no-change' }
  if (!current && checked.prompts.length === 0) return { refuse: 'nothing to set: no prompts, and no set in force to clear', kind: 'no-change' }
  const history = current ? [...(current.superseded ?? []), (({ superseded: _h, ...prior }) => prior)(current)] : []
  return { host: checked.host, version: (current?.version ?? 0) + 1, prompts: checked.prompts, reason: checked.reason, by, at, ...(history.length ? { superseded: history } : {}) }
}

/** The same application through a `WorkspaceStore` (MVP_PLAN B4), written against the version that was read. */
export async function applyCustomPromptsIn(store: WorkspaceStore, dataDir: string, req: PromptSetRequest): Promise<CustomPromptSet | PromptRefusal> {
  const host = normaliseHost(req.host)
  const checked = checkCustomPromptsWith(req.host, req.prompts, req.reason, host ? await categoryRecordIn(store, host) : null, allBanks(dataDir))
  if ('refuse' in checked) return checked
  const by = plainText(req.by)
  if (!by) return { refuse: 'a prompt set names who applied it', kind: 'input' }
  const current = await customPromptsIn(store, checked.host)
  const next = nextPromptSet(current, checked, by, req.at ?? new Date().toISOString())
  if ('refuse' in next) return next
  const { superseded: _history, ...body } = next
  await store.documents.put('custom-prompts', checked.host, body, current?.version ?? 0)
  return next
}

// ---------------------------------------------------------------- requests

export interface PromptRequest {
  readonly host: string
  readonly prompts: readonly string[]
  readonly reason: string
  readonly requestedAt: string
  readonly status: 'pending' | 'applied' | 'declined'
  readonly resolvedAt?: string
  readonly resolvedBy?: string
  readonly note?: string
}

const HISTORY_PER_HOST = 20

function shapeRequest(host: string, value: unknown): PromptRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Partial<PromptRequest>
  if (typeof r.reason !== 'string' || r.reason !== plainText(r.reason) || typeof r.requestedAt !== 'string') return null
  if (r.status !== 'pending' && r.status !== 'applied' && r.status !== 'declined') return null
  return {
    host,
    prompts: cleanList(r.prompts),
    reason: r.reason,
    requestedAt: r.requestedAt,
    status: r.status,
    ...(typeof r.resolvedAt === 'string' ? { resolvedAt: r.resolvedAt } : {}),
    ...(typeof r.resolvedBy === 'string' ? { resolvedBy: r.resolvedBy } : {}),
    ...(typeof r.note === 'string' ? { note: r.note } : {}),
  }
}

export function readPromptRequests(dataDir: string): Record<string, PromptRequest[]> {
  const f = requestsFile(dataDir)
  try {
    if (!existsSync(f)) return {}
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, PromptRequest[]> = {}
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const list = value.map((v) => shapeRequest(host, v)).filter((v): v is PromptRequest => v !== null)
      if (list.length) out[host] = list
    }
    return out
  } catch {
    return {}
  }
}

export function pendingPromptRequest(dataDir: string, domain: string): PromptRequest | null {
  const host = normaliseHost(domain)
  return host ? (readPromptRequests(dataDir)[host]?.find((r) => r.status === 'pending') ?? null) : null
}

export function promptRequestsFor(dataDir: string, domain: string): readonly PromptRequest[] {
  const host = normaliseHost(domain)
  return host ? (readPromptRequests(dataDir)[host] ?? []) : []
}

export function allPendingPromptRequests(dataDir: string): readonly PromptRequest[] {
  return Object.values(readPromptRequests(dataDir))
    .flat()
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
}

/** File a request: the same checks as an apply, no write to the set. One pending per host; filing again replaces it. */
export function filePromptRequest(dataDir: string, req: { readonly host: string; readonly prompts: readonly unknown[]; readonly reason: string; readonly at?: string }): PromptRequest | PromptRefusal {
  const checked = checkCustomPrompts(dataDir, req.host, req.prompts, req.reason)
  if ('refuse' in checked) return checked
  if (checked.prompts.length === 0 && !readCustomPromptSet(dataDir, checked.host)) return { refuse: 'nothing to ask for: no prompts, and no set in force to clear', kind: 'no-change' }
  return withRecordLock(dataDir, () => {
    const store = readPromptRequests(dataDir)
    const request: PromptRequest = { host: checked.host, prompts: checked.prompts, reason: checked.reason, requestedAt: req.at ?? new Date().toISOString(), status: 'pending' }
    const kept = (store[checked.host] ?? []).filter((r) => r.status !== 'pending').slice(-HISTORY_PER_HOST)
    store[checked.host] = [...kept, request]
    writeFileSync(requestsFile(dataDir), JSON.stringify(store, null, 2) + '\n')
    return request
  })
}

/** The same filing through a `WorkspaceStore` (MVP_PLAN B3b). */
export async function filePromptRequestIn(store: WorkspaceStore, dataDir: string, req: { readonly host: string; readonly prompts: readonly unknown[]; readonly reason: string; readonly at?: string }): Promise<PromptRequest | PromptRefusal> {
  const host = normaliseHost(req.host)
  const checked = checkCustomPromptsWith(req.host, req.prompts, req.reason, host ? await categoryRecordIn(store, host) : null, allBanks(dataDir))
  if ('refuse' in checked) return checked
  if (checked.prompts.length === 0 && !(await customPromptsIn(store, checked.host))) return { refuse: 'nothing to ask for: no prompts, and no set in force to clear', kind: 'no-change' }
  const request: PromptRequest = { host: checked.host, prompts: checked.prompts, reason: checked.reason, requestedAt: req.at ?? new Date().toISOString(), status: 'pending' }
  await store.requests.file('custom-prompts', checked.host, { prompts: checked.prompts, reason: checked.reason }, request.requestedAt)
  return request
}

export function resolvePromptRequest(
  dataDir: string,
  domain: string,
  outcome: { readonly status: 'applied' | 'declined'; readonly by: string; readonly note?: string; readonly at?: string; readonly expectRequestedAt?: string },
): PromptRequest | { readonly refuse: string } {
  const host = normaliseHost(domain)
  if (!host) return { refuse: 'not a domain' }
  return withRecordLock(dataDir, () => {
    const store = readPromptRequests(dataDir)
    const list = store[host] ?? []
    const i = list.findIndex((r) => r.status === 'pending')
    if (i < 0) return { refuse: `${host} has no pending prompt request` }
    if (outcome.expectRequestedAt !== undefined && list[i]!.requestedAt !== outcome.expectRequestedAt) return { refuse: `${host}'s pending request changed since it was read; read it again before deciding` }
    const note = outcome.note ? plainText(outcome.note) : ''
    const resolved: PromptRequest = { ...list[i]!, status: outcome.status, resolvedAt: outcome.at ?? new Date().toISOString(), resolvedBy: outcome.by, ...(note ? { note } : {}) }
    store[host] = [...list.slice(0, i), ...list.slice(i + 1), resolved].slice(-HISTORY_PER_HOST)
    writeFileSync(requestsFile(dataDir), JSON.stringify(store, null, 2) + '\n')
    return resolved
  })
}
