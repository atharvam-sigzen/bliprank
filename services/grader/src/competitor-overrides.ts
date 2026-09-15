/**
 * PER-DOMAIN COMPETITOR OVERRIDES — a customer's correction to the category's
 * competitor set, layered on it at scan time. ADR-0016, decision 3.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS, AND IS NOT.
 *
 * The category's set is promotion's business (`promote-competitors.ts`): per
 * category, evidence-gated, CLI-only, and every change bumps the bank version.
 * Nothing here touches it. An override is per DOMAIN: "our integration
 * partner, not a rival" for this one subject, without changing what every
 * other domain in the category measures.
 *
 *   - EXCLUDE is always allowed, for any leader in the category's set.
 *   - INCLUDE is allowed only from REVIEWED SOURCES: a leader of any bank this
 *     build holds, which is every hand-authored leader and every promoted one
 *     (ids `promoted:<key>`), each with an alias table a person or the evidence
 *     bar has looked at. A free-text name is refused: with no alias set it
 *     produces false mentions, and the competitor set decides `position`, which
 *     decides the score. A promotion-tally candidate that was never promoted is
 *     not includable either: it has no reviewed alias set and the tally is not a
 *     store an override could version against. Promote it first, and it becomes
 *     includable everywhere. (Decided by the owner, 2026-09-03; narrowed from
 *     the ADR's first wording after the step-3 review.)
 *   - The subject is never in its own override: not by id, and not by a
 *     sibling bank's leader whose domain is the subject's host or whose name is
 *     the subject's name (monday.com leads crm-software as `monday-crm` and
 *     project-management as `monday-com`; the second must not become its rival).
 *   - Clearing an override (no exclusions, no inclusions) is still a new
 *     version: the effective set moved back, so comparability with the cycles
 *     under the old set is gone, and every later cycle carries the new version
 *     while measuring the category's own set. True, and the record says so.
 *
 * ⚠️ AN OVERRIDE MOVES THE BASIS. From the first override on, every
 * measurement of the domain carries `set=<version>` in its comparison basis
 * (`packages/contracts/basis.ts`), so a cycle before and a cycle after are not
 * two points of one trend, and the record says "the competitor set" changed —
 * which is true. The version only ever goes up; every earlier override is kept
 * whole inside the current one, so a stored cycle can be read back under the
 * set it was measured with (`overrideAt`).
 *
 * The same shape as a category correction: a request store a visitor writes
 * to, an operator command that applies, a file lock shared with the record
 * store, and refusals returned rather than thrown.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { squash, type BrandSpec } from '@bliprank/scorer'
import { normaliseHost, type Leader, type PromptBank } from '@bliprank/taxonomy'
import { ids, overridesFile, readOverride, readOverrides, overrideAt, type CompetitorOverride } from './override-store.js'
import { allBanks, plainText, readCategoryRecord, withRecordLock, type CategoryRecord } from './resolve-category.js'
import { leadersOf, subjectFor } from './scan.js'
import { categoryRecordIn, overrideAtIn, overrideIn } from './store/documents.js'
import type { WorkspaceStore } from './store/pg-store.js'

export type { CompetitorOverride, SupersededOverride } from './override-store.js'
export { isLeaderId, overrideAt, readOverride, readOverrides } from './override-store.js'

const requestsFile = (dataDir: string): string => join(dataDir, 'competitor-requests.json')

/** Every leader of every bank this build holds, by id, with the bank it comes from. The only source an include may draw on. */
export function reviewedLeaders(dataDir: string): ReadonlyMap<string, Leader & { readonly bank: string }> {
  return reviewedOf(allBanks(dataDir))
}
/** The same map over a bank list already in hand. */
export function reviewedOf(banks: readonly PromptBank[]): ReadonlyMap<string, Leader & { readonly bank: string }> {
  const out = new Map<string, Leader & { readonly bank: string }>()
  for (const bank of banks) for (const l of bank.leaders) if (!out.has(l.id)) out.set(l.id, { ...l, bank: bank.category })
  return out
}

const spec = (l: Leader): BrandSpec => ({ id: l.id, name: l.name, aliases: [...l.aliases], domains: [...l.domains] })

/**
 * The category's set with an override laid over it: excluded ids out,
 * included ids in (from the reviewed sources), the subject never present.
 * Pure. An include the build no longer knows is NOT invented; it is named in
 * `missing`, so a reader of a stored cycle can refuse rather than classify
 * under a smaller set than the cycle was measured with.
 */
export function effectiveCompetitors(bank: PromptBank, override: Pick<CompetitorOverride, 'exclude' | 'include'> | null, reviewed: ReadonlyMap<string, Leader>, subjectId: string): { readonly competitors: BrandSpec[]; readonly missing: string[] } {
  const base = leadersOf(bank).filter((c) => c.id !== subjectId && !(override?.exclude ?? []).includes(c.id))
  const have = new Set(base.map((c) => c.id))
  const wanted = (override?.include ?? []).filter((id) => id !== subjectId && !have.has(id))
  const added = wanted.map((id) => reviewed.get(id)).filter((l): l is Leader & { bank: string } => l !== undefined)
  return { competitors: [...base, ...added.map(spec)], missing: wanted.filter((id) => !reviewed.has(id)) }
}

/**
 * The competitors a measurement of this domain uses, and the set version it
 * carries.
 *
 *   version undefined  the override in force NOW: a scan, a preview, the record page.
 *   version null       the category's own set, no override: a stored cycle whose basis carries no `set=`.
 *   version N          the override a stored cycle recorded; null when the store no longer has it,
 *                      which the caller reports rather than substitutes.
 *
 * The three are kept apart because "no version on the cycle" and "whatever is
 * in force today" are different sets the moment a first override exists, and
 * reading the old cycle under the new set would misclassify its citations.
 */
export function competitorsFor(dataDir: string, domain: string, bank: PromptBank, subjectId: string, version?: number | null): { readonly set?: number; readonly competitors: readonly BrandSpec[]; readonly missing: readonly string[] } | null {
  const reviewed = reviewedLeaders(dataDir)
  if (version === null) return { ...effectiveCompetitors(bank, null, reviewed, subjectId) }
  if (version === undefined) {
    const o = readOverride(dataDir, domain)
    return { ...(o ? { set: o.version } : {}), ...effectiveCompetitors(bank, o, reviewed, subjectId) }
  }
  const o = overrideAt(dataDir, domain, version)
  if (!o) return null
  return { set: version, ...effectiveCompetitors(bank, o, reviewed, subjectId) }
}

export interface OverrideRequest {
  readonly host: string
  readonly exclude: readonly string[]
  readonly include: readonly string[]
  readonly reason: string
  readonly by: string
  readonly at?: string
}

export type OverrideRefusal = { readonly refuse: string; readonly kind: 'input' | 'no-record' | 'no-change' | 'unknown-competitor' | 'subject' }

/**
 * Check a proposed override against the record, the category's set and the
 * reviewed sources. Shared by the request store (a visitor's filing) and the
 * writer (an operator's apply), so the two cannot disagree about what is
 * allowed. Returns the normalised lists, or a refusal with a kind.
 */
export type CheckedOverride = { readonly host: string; readonly exclude: readonly string[]; readonly include: readonly string[]; readonly reason: string; readonly bank: PromptBank; readonly subjectId: string }

export function checkOverride(dataDir: string, req: Omit<OverrideRequest, 'by' | 'at'>): CheckedOverride | OverrideRefusal {
  const host = normaliseHost(req.host)
  return checkOverrideWith(req, host ? readCategoryRecord(dataDir, host) : null, allBanks(dataDir))
}

/** THE DECISION, pure: the request against the record the store holds and the banks this build has (MVP_PLAN B3b). */
export function checkOverrideWith(req: Omit<OverrideRequest, 'by' | 'at'>, record: CategoryRecord | null, banks: readonly PromptBank[]): CheckedOverride | OverrideRefusal {
  const host = normaliseHost(req.host)
  if (!host) return { refuse: 'not a domain', kind: 'input' }
  const reason = plainText(req.reason)
  if (reason.length < 10) return { refuse: 'say why, in at least ten characters: it is read by the person who applies it', kind: 'input' }
  if (reason.length > 500) return { refuse: 'keep the reason under 500 characters', kind: 'input' }
  if (!record) return { refuse: `${host} has no category on record, so it has no competitor set to adjust. A first scan decides one.`, kind: 'no-record' }
  const bank = banks.find((b) => b.category === record.slug)
  if (!bank) return { refuse: `no bank for ${record.slug} in this build`, kind: 'no-record' }
  const subject = subjectFor(host, bank, record.brandName).spec
  const subjectId = subject.id
  const exclude = ids(req.exclude)
  const include = ids(req.include)
  if (exclude.length !== new Set(req.exclude).size || include.length !== new Set(req.include).size) return { refuse: 'a competitor is chosen from the list, not typed', kind: 'input' }
  if (exclude.includes(subjectId) || include.includes(subjectId)) return { refuse: `${host} is the subject of its own measurement and cannot be its own competitor, nor excluded from being one`, kind: 'subject' }
  const category = new Set(leadersOf(bank).map((l) => l.id))
  const reviewed = reviewedOf(banks)
  for (const id of exclude) if (!category.has(id)) return { refuse: `${id} is not in ${record.slug}'s competitor set, so there is nothing to exclude`, kind: 'unknown-competitor' }
  for (const id of include) {
    if (category.has(id)) return { refuse: `${id} is already in ${record.slug}'s competitor set`, kind: 'unknown-competitor' }
    const leader = reviewed.get(id)
    if (!leader) return { refuse: `${id} is not a competitor this build has a reviewed alias set for; a name nobody has reviewed would produce false mentions`, kind: 'unknown-competitor' }
    // The subject under another bank's id: same host, or the same name. It would be scored as its own rival and move its own position.
    const onHost = [...leader.domains, ...(leader.siteDomains ?? [])].some((d) => host === d || host.endsWith(`.${d}`))
    if (onHost || squash(leader.name) === squash(subject.name)) return { refuse: `${id} is ${host} itself under another category's name; a subject cannot be its own competitor`, kind: 'subject' }
  }
  const overlap = exclude.filter((id) => include.includes(id))
  if (overlap.length) return { refuse: `${overlap.join(', ')} cannot be both excluded and included`, kind: 'input' }
  return { host, exclude, include, reason, bank, subjectId }
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * THE WRITER. A new override one version up, the earlier ones kept whole. An
 * override identical to the one in force is refused as no change: the version
 * must not move for nothing, because moving it makes the next cycle
 * non-comparable with the last.
 */
export function applyOverride(dataDir: string, req: OverrideRequest): CompetitorOverride | OverrideRefusal {
  const checked = checkOverride(dataDir, req)
  if ('refuse' in checked) return checked
  const by = plainText(req.by)
  if (!by) return { refuse: 'an override names who applied it', kind: 'input' }
  return withRecordLock(dataDir, () => {
    const store = readOverrides(dataDir)
    const next = nextOverride(store[checked.host] ?? null, checked, by, req.at ?? new Date().toISOString())
    if ('refuse' in next) return next
    writeFileSync(overridesFile(dataDir), JSON.stringify({ ...store, [checked.host]: next }, null, 2) + '\n')
    return next
  })
}

/** THE NEXT OVERRIDE, pure: version N+1 over the one in force, or the refusal that nothing changed (MVP_PLAN B4). */
export function nextOverride(current: CompetitorOverride | null, checked: CheckedOverride, by: string, at: string): CompetitorOverride | OverrideRefusal {
  if (current && same(current.exclude, checked.exclude) && same(current.include, checked.include)) {
    // A different reason for the same lists is not a change: a version bump would make the next cycle non-comparable for nothing.
    return { refuse: `${checked.host}'s competitor set already stands exactly so (set ${current.version}); nothing to change. A pending request asking for this is declined, not applied.`, kind: 'no-change' }
  }
  if (!current && checked.exclude.length === 0 && checked.include.length === 0) return { refuse: 'nothing to override: no exclusions and no inclusions', kind: 'no-change' }
  const history = current ? [...(current.superseded ?? []), (({ superseded: _h, ...prior }) => prior)(current)] : []
  return { host: checked.host, version: (current?.version ?? 0) + 1, exclude: checked.exclude, include: checked.include, reason: checked.reason, by, at, ...(history.length ? { superseded: history } : {}) }
}

/** The same application through a `WorkspaceStore` (MVP_PLAN B4), written against the version that was read. */
export async function applyOverrideIn(store: WorkspaceStore, dataDir: string, req: OverrideRequest): Promise<CompetitorOverride | OverrideRefusal> {
  const host = normaliseHost(req.host)
  const checked = checkOverrideWith(req, host ? await categoryRecordIn(store, host) : null, allBanks(dataDir))
  if ('refuse' in checked) return checked
  const by = plainText(req.by)
  if (!by) return { refuse: 'an override names who applied it', kind: 'input' }
  const current = await overrideIn(store, checked.host)
  const next = nextOverride(current, checked, by, req.at ?? new Date().toISOString())
  if ('refuse' in next) return next
  const { superseded: _history, ...body } = next
  await store.documents.put('competitor-override', checked.host, body, current?.version ?? 0)
  return next
}

// ---------------------------------------------------------------- requests

export interface CompetitorRequest {
  readonly host: string
  readonly exclude: readonly string[]
  readonly include: readonly string[]
  readonly reason: string
  readonly requestedAt: string
  readonly status: 'pending' | 'applied' | 'declined'
  readonly resolvedAt?: string
  readonly resolvedBy?: string
  readonly note?: string
}

const HISTORY_PER_HOST = 20

function shapeRequest(host: string, value: unknown): CompetitorRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Partial<CompetitorRequest>
  if (typeof r.reason !== 'string' || r.reason !== plainText(r.reason) || typeof r.requestedAt !== 'string') return null
  if (r.status !== 'pending' && r.status !== 'applied' && r.status !== 'declined') return null
  return {
    host,
    exclude: ids(r.exclude),
    include: ids(r.include),
    reason: r.reason,
    requestedAt: r.requestedAt,
    status: r.status,
    ...(typeof r.resolvedAt === 'string' ? { resolvedAt: r.resolvedAt } : {}),
    ...(typeof r.resolvedBy === 'string' ? { resolvedBy: r.resolvedBy } : {}),
    ...(typeof r.note === 'string' ? { note: r.note } : {}),
  }
}

export function readCompetitorRequests(dataDir: string): Record<string, CompetitorRequest[]> {
  const f = requestsFile(dataDir)
  try {
    if (!existsSync(f)) return {}
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, CompetitorRequest[]> = {}
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const list = value.map((v) => shapeRequest(host, v)).filter((v): v is CompetitorRequest => v !== null)
      if (list.length) out[host] = list
    }
    return out
  } catch {
    return {}
  }
}

export function pendingCompetitorRequest(dataDir: string, domain: string): CompetitorRequest | null {
  const host = normaliseHost(domain)
  return host ? (readCompetitorRequests(dataDir)[host]?.find((r) => r.status === 'pending') ?? null) : null
}

export function competitorRequestsFor(dataDir: string, domain: string): readonly CompetitorRequest[] {
  const host = normaliseHost(domain)
  return host ? (readCompetitorRequests(dataDir)[host] ?? []) : []
}

export function allPendingCompetitorRequests(dataDir: string): readonly CompetitorRequest[] {
  return Object.values(readCompetitorRequests(dataDir))
    .flat()
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
}

/** File a request: the same checks as an apply, and no write to the override. One pending per host; filing again replaces it. */
export function fileCompetitorRequest(dataDir: string, req: Omit<OverrideRequest, 'by'>): CompetitorRequest | OverrideRefusal {
  const checked = checkOverride(dataDir, req)
  if ('refuse' in checked) return checked
  // Empty lists ask for the override to be cleared, which is a change when one is in force and nothing when none is.
  if (checked.exclude.length === 0 && checked.include.length === 0 && !readOverride(dataDir, checked.host)) return { refuse: 'nothing to ask for: no exclusions and no inclusions, and no override in force to clear', kind: 'no-change' }
  return withRecordLock(dataDir, () => {
    const store = readCompetitorRequests(dataDir)
    const request: CompetitorRequest = { host: checked.host, exclude: checked.exclude, include: checked.include, reason: checked.reason, requestedAt: req.at ?? new Date().toISOString(), status: 'pending' }
    const kept = (store[checked.host] ?? []).filter((r) => r.status !== 'pending').slice(-HISTORY_PER_HOST)
    store[checked.host] = [...kept, request]
    writeFileSync(requestsFile(dataDir), JSON.stringify(store, null, 2) + '\n')
    return request
  })
}

/** The same filing through a `WorkspaceStore` (MVP_PLAN B3b). */
export async function fileCompetitorRequestIn(store: WorkspaceStore, dataDir: string, req: Omit<OverrideRequest, 'by'>): Promise<CompetitorRequest | OverrideRefusal> {
  const host = normaliseHost(req.host)
  const checked = checkOverrideWith(req, host ? await categoryRecordIn(store, host) : null, allBanks(dataDir))
  if ('refuse' in checked) return checked
  if (checked.exclude.length === 0 && checked.include.length === 0 && !(await overrideIn(store, checked.host))) return { refuse: 'nothing to ask for: no exclusions and no inclusions, and no override in force to clear', kind: 'no-change' }
  const request: CompetitorRequest = { host: checked.host, exclude: checked.exclude, include: checked.include, reason: checked.reason, requestedAt: req.at ?? new Date().toISOString(), status: 'pending' }
  await store.requests.file('competitors', checked.host, { exclude: checked.exclude, include: checked.include, reason: checked.reason }, request.requestedAt)
  return request
}

/** `competitorsFor` over a `WorkspaceStore`: the override in force, none, or the version a stored cycle names (MVP_PLAN B3b). */
export async function competitorsIn(store: WorkspaceStore, dataDir: string, domain: string, bank: PromptBank, subjectId: string, version?: number | null): Promise<{ readonly set?: number; readonly competitors: readonly BrandSpec[]; readonly missing: readonly string[] } | null> {
  const reviewed = reviewedLeaders(dataDir)
  if (version === null) return { ...effectiveCompetitors(bank, null, reviewed, subjectId) }
  const host = normaliseHost(domain)
  if (version === undefined) {
    const o = host ? await overrideIn(store, host) : null
    return { ...(o ? { set: o.version } : {}), ...effectiveCompetitors(bank, o, reviewed, subjectId) }
  }
  const o = host ? await overrideAtIn(store, host, version) : null
  if (!o) return null
  return { set: version, ...effectiveCompetitors(bank, o, reviewed, subjectId) }
}

export function resolveCompetitorRequest(
  dataDir: string,
  domain: string,
  outcome: { readonly status: 'applied' | 'declined'; readonly by: string; readonly note?: string; readonly at?: string; readonly expectRequestedAt?: string },
): CompetitorRequest | { readonly refuse: string } {
  const host = normaliseHost(domain)
  if (!host) return { refuse: 'not a domain' }
  return withRecordLock(dataDir, () => {
    const store = readCompetitorRequests(dataDir)
    const list = store[host] ?? []
    const i = list.findIndex((r) => r.status === 'pending')
    if (i < 0) return { refuse: `${host} has no pending competitor request` }
    if (outcome.expectRequestedAt !== undefined && list[i]!.requestedAt !== outcome.expectRequestedAt) return { refuse: `${host}'s pending request changed since it was read; read it again before deciding` }
    const note = outcome.note ? plainText(outcome.note) : ''
    const resolved: CompetitorRequest = { ...list[i]!, status: outcome.status, resolvedAt: outcome.at ?? new Date().toISOString(), resolvedBy: outcome.by, ...(note ? { note } : {}) }
    store[host] = [...list.slice(0, i), ...list.slice(i + 1), resolved].slice(-HISTORY_PER_HOST)
    writeFileSync(requestsFile(dataDir), JSON.stringify(store, null, 2) + '\n')
    return resolved
  })
}
