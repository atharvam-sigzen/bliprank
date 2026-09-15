/**
 * CATEGORY CORRECTION REQUESTS — what a visitor may file, and what a person
 * later applies. ADR-0016, decision 5.
 *
 * ⚠️ A REQUEST IS NOT A CORRECTION. Nothing in the product has an identity, so
 * a route that applied a category change would let anyone relabel anyone's
 * domain. A request is a stored sentence: "this domain should be measured as
 * X, because …". It is shown on the record as requested and not yet applied,
 * it changes no measurement, and it is applied only by `pnpm grader:correct`,
 * which calls `correctCategory` and writes the new record with the request's
 * own words as its reason.
 *
 * One pending request per host. Filing again replaces it: a visitor who
 * changes their mind should not need an operator to clear the first one. The
 * resolved ones are kept, most recent last, so "this was asked for before and
 * declined" is visible to the next operator.
 *
 * Disk only. The same trust-boundary read as the record store: validate, drop
 * what fails, never throw.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRICE_USD_PER_CALL, type OwnPlan } from '@bliprank/collector'
import { ENGINES } from '@bliprank/contracts'
import { FALLBACK_SLUG, normaliseHost, type PromptBank } from '@bliprank/taxonomy'
import { listCycles } from './cycles.js'
import { defaultGateConfig } from './live-gate.js'
import { allBanks, plainText, readCategoryRecord, withRecordLock, type CategoryRecord } from './resolve-category.js'
import { categoryRecordIn } from './store/documents.js'
import type { WorkspaceStore } from './store/pg-store.js'

export type RequestStatus = 'pending' | 'applied' | 'declined'

export interface CategoryRequest {
  readonly host: string
  readonly slug: string
  readonly reason: string
  readonly requestedAt: string
  readonly status: RequestStatus
  readonly resolvedAt?: string
  readonly resolvedBy?: string
  /** The operator's note on declining or applying. */
  readonly note?: string
}

export type RequestRefusal = { readonly refuse: string; readonly kind: 'input' | 'no-record' | 'same-category' | 'unknown-category' }

export const REASON_MIN = 10
export const REASON_MAX = 500
/** Resolved requests kept per host, most recent last. */
const HISTORY_PER_HOST = 20

const requestsFile = (dataDir: string): string => join(dataDir, 'category-requests.json')

type RequestStore = Record<string, CategoryRequest[]>

function shape(host: string, value: unknown): CategoryRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Partial<CategoryRequest>
  if (typeof r.slug !== 'string' || !r.slug || typeof r.reason !== 'string' || typeof r.requestedAt !== 'string') return null
  if (r.reason !== plainText(r.reason)) return null // a hand-edited store cannot smuggle a control sequence into a terminal
  if (r.status !== 'pending' && r.status !== 'applied' && r.status !== 'declined') return null
  return {
    host,
    slug: r.slug,
    reason: r.reason,
    requestedAt: r.requestedAt,
    status: r.status,
    ...(typeof r.resolvedAt === 'string' ? { resolvedAt: r.resolvedAt } : {}),
    ...(typeof r.resolvedBy === 'string' ? { resolvedBy: r.resolvedBy } : {}),
    ...(typeof r.note === 'string' ? { note: r.note } : {}),
  }
}

export function readRequests(dataDir: string): RequestStore {
  const f = requestsFile(dataDir)
  try {
    if (!existsSync(f)) return {}
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: RequestStore = {}
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const list = value.map((v) => shape(host, v)).filter((v): v is CategoryRequest => v !== null)
      if (list.length) out[host] = list
    }
    return out
  } catch {
    return {}
  }
}

function writeRequests(dataDir: string, store: RequestStore): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(requestsFile(dataDir), JSON.stringify(store, null, 2) + '\n')
}

/** The one pending request for a host, or null. */
export function pendingRequest(dataDir: string, domain: string): CategoryRequest | null {
  const host = normaliseHost(domain)
  if (!host) return null
  return readRequests(dataDir)[host]?.find((r) => r.status === 'pending') ?? null
}

/** Every request ever filed for a host, oldest first. */
export function requestsFor(dataDir: string, domain: string): readonly CategoryRequest[] {
  const host = normaliseHost(domain)
  return host ? (readRequests(dataDir)[host] ?? []) : []
}

/** Every pending request across the store, for the operator's list. */
export function allPending(dataDir: string): readonly CategoryRequest[] {
  return Object.values(readRequests(dataDir))
    .flat()
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
}

/**
 * File a request. Refused, with a kind the route can map to a status, when
 * there is nothing to correct (no record: a first scan decides), when the slug
 * is the recorded one, or when it is not a category this build can measure.
 * The reason is bounded both ways: too short says nothing, too long is a
 * store-filling vector.
 */
export interface CategoryRequestInput {
  readonly host: string
  readonly slug: string
  readonly reason: string
  readonly at?: string
}

/**
 * THE DECISION, pure: the input against the record the store holds and the
 * banks this build has. Both filers below call it and then write to their
 * own store, so the rule is one rule whichever store a deployment runs on
 * (MVP_PLAN B3b).
 */
export function checkCategoryRequest(req: CategoryRequestInput, record: CategoryRecord | null, banks: readonly PromptBank[]): { readonly host: string; readonly slug: string; readonly reason: string } | RequestRefusal {
  const host = normaliseHost(req.host)
  if (!host) return { refuse: 'not a domain', kind: 'input' }
  const slug = req.slug.trim()
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return { refuse: 'a category is chosen from the list, not typed', kind: 'input' }
  const reason = plainText(req.reason)
  if (reason.length < REASON_MIN) return { refuse: `say why, in at least ${REASON_MIN} characters: it is read by the person who applies it`, kind: 'input' }
  if (reason.length > REASON_MAX) return { refuse: `keep the reason under ${REASON_MAX} characters`, kind: 'input' }
  if (!record) return { refuse: `${host} has no category on record yet. A first scan decides one; there is nothing to correct until then.`, kind: 'no-record' }
  if (record.slug === slug) return { refuse: `${host} is already recorded as ${slug}`, kind: 'same-category' }
  if (slug === FALLBACK_SLUG) return { refuse: 'the general bank is what a domain gets when no category fits; a correction names a category', kind: 'unknown-category' }
  if (!banks.some((b) => b.category === slug)) return { refuse: `${slug} is not a category this build can measure`, kind: 'unknown-category' }
  return { host, slug, reason }
}

export function fileCategoryRequest(dataDir: string, req: CategoryRequestInput): CategoryRequest | RequestRefusal {
  const checked = checkCategoryRequest(req, normaliseHost(req.host) ? readCategoryRecord(dataDir, req.host) : null, allBanks(dataDir))
  if ('refuse' in checked) return checked
  const { host, slug, reason } = checked
  return withRecordLock(dataDir, () => {
    const store = readRequests(dataDir)
    const request: CategoryRequest = { host, slug, reason, requestedAt: req.at ?? new Date().toISOString(), status: 'pending' }
    const kept = (store[host] ?? []).filter((r) => r.status !== 'pending').slice(-HISTORY_PER_HOST)
    store[host] = [...kept, request]
    writeRequests(dataDir, store)
    return request
  })
}

/** The same filing through a `WorkspaceStore`: the record from the store, the banks from this build, the request into the store. */
export async function fileCategoryRequestIn(store: WorkspaceStore, dataDir: string, req: CategoryRequestInput): Promise<CategoryRequest | RequestRefusal> {
  const host = normaliseHost(req.host)
  const checked = checkCategoryRequest(req, host ? await categoryRecordIn(store, host) : null, allBanks(dataDir))
  if ('refuse' in checked) return checked
  const request: CategoryRequest = { host: checked.host, slug: checked.slug, reason: checked.reason, requestedAt: req.at ?? new Date().toISOString(), status: 'pending' }
  await store.requests.file('category', checked.host, { slug: checked.slug, reason: checked.reason }, request.requestedAt)
  return request
}

/**
 * Mark the pending request applied or declined. Refused when there is none,
 * and refused when `expectRequestedAt` names a different one: the operator
 * read a request, applied it, and a visitor replaced it in between. The
 * replacement must not be marked applied under the first one's decision.
 */
export function resolveRequest(
  dataDir: string,
  domain: string,
  outcome: { readonly status: 'applied' | 'declined'; readonly by: string; readonly note?: string; readonly at?: string; readonly expectRequestedAt?: string },
): CategoryRequest | { readonly refuse: string } {
  const host = normaliseHost(domain)
  if (!host) return { refuse: 'not a domain' }
  return withRecordLock(dataDir, () => {
    const store = readRequests(dataDir)
    const list = store[host] ?? []
    const i = list.findIndex((r) => r.status === 'pending')
    if (i < 0) return { refuse: `${host} has no pending request` }
    if (outcome.expectRequestedAt !== undefined && list[i]!.requestedAt !== outcome.expectRequestedAt) {
      return { refuse: `${host}'s pending request changed since it was read (now ${list[i]!.requestedAt}); read it again before deciding` }
    }
    const note = outcome.note ? plainText(outcome.note) : ''
    const resolved: CategoryRequest = { ...list[i]!, status: outcome.status, resolvedAt: outcome.at ?? new Date().toISOString(), resolvedBy: outcome.by, ...(note ? { note } : {}) }
    store[host] = [...list.slice(0, i), ...list.slice(i + 1), resolved].slice(-HISTORY_PER_HOST)
    writeRequests(dataDir, store)
    return resolved
  })
}

export interface Consequences {
  /** Stored cycles of this domain, every one of which stays under its own category and off a corrected trend. */
  readonly earlierCycles: number
  readonly prompts: number
  readonly engines: number
  readonly cells: number
  readonly plan: OwnPlan
  /** What one fresh cycle would cost at the plan's marginal price, before retries. */
  readonly usd: number
}

/**
 * What applying a correction would do: the stored cycles it leaves off the
 * new trend, and the size and cost of the fresh collection the next cycle
 * becomes. Pure reads; the route and the operator command both print this
 * before anything is applied. Pay-as-you-go when the plan is unset, the
 * dearest, so the stated cost is never an underestimate.
 */
export function consequencesOf(dataDir: string, domain: string, env: NodeJS.ProcessEnv, earlierCycles: number = listCycles(dataDir, domain).length): Consequences {
  const gate = defaultGateConfig(dataDir, env)
  const engines = gate.engines.length > 0 ? gate.engines : ENGINES
  const planRaw = env['OPENWEBNINJA_PLAN']
  const plan: OwnPlan = planRaw === 'pro' || planRaw === 'ultra' || planRaw === 'mega' ? planRaw : 'payg'
  const perPrompt = engines.reduce((n, e) => n + PRICE_USD_PER_CALL[plan][e], 0)
  return { earlierCycles, prompts: gate.callsPerEngine, engines: engines.length, cells: gate.callsPerEngine * engines.length, plan, usd: perPrompt * gate.callsPerEngine }
}
