import { normaliseHost } from '@bliprank/taxonomy'
import { consequencesOf, fileCategoryRequestIn, type CategoryRequest } from '../../../../../services/grader/src/category-requests.js'
import { allCategories, correctCategoryIn, readGeneratedBanks } from '../../../../../services/grader/src/resolve-category.js'
import { categoryRecordIn } from '../../../../../services/grader/src/store/documents.js'
import {
  DEFAULT_VISITOR_WINDOW_MS,
  checkVisitorThrottle,
  extractClientIp,
  recordVisitorScan,
  type VisitorThrottleConfig,
} from '../../../../../services/grader/src/visitor-throttle.js'
import { FALLBACK_SLUG } from '@bliprank/taxonomy'
import type { CategoryStatus } from '../../../lib/category-request'
import { applies, isForeignPending, isStaleVersion, PENDING_BY_ANOTHER, READ_AGAIN, workspaceAccess, type WorkspaceAccess } from '@/lib/workspace-access'

/**
 * A domain's recorded category, its history, and the request to change it.
 * ADR-0016, decisions 2 and 5.
 *
 * THE WORKSPACE IS THE SESSION'S (MVP_PLAN B3b): the record, the pending
 * request and the history are read from, and a request is filed into, the
 * store the session's token scopes. Nothing in the request names a
 * workspace; the domain names a subject inside it.
 *
 * WHO WRITES THE RECORD (MVP_PLAN B4). GET reads it. POST from a workspace
 * OWNER or ADMIN applies the correction: version N+1, every earlier record
 * kept, the pending request that asked for it marked applied, nothing
 * re-derived. POST from a member, or on a machine's file store, files a
 * REQUEST, which the record shows as pending and which changes no
 * measurement until an owner applies it here or an operator applies it with
 * `pnpm grader:correct`. Either way POST is bounded twice: by a per-visitor
 * allowance on its own ledger, and by the store's own rule of one pending
 * request per domain.
 *
 * GET is bounded to domains with a record (404 otherwise) and is not
 * throttled: it is one read, and a ledger keyed by a caller-written header
 * would cost more per request than the read it guarded, and grow with every
 * name the caller invented.
 *
 * ⚠️ WHAT GET DOES NOT SAY. A pending request's REASON is 500 characters of
 * anonymous text. Printing it on the domain's public record would let anyone
 * post a sentence on anyone's page; so the record says a correction to X was
 * requested on a date and not applied, and no more. The filer sees their own
 * words in the outcome; the operator sees them when applying.
 */

export const dynamic = 'force-dynamic'
// Two reads and one small write; the plan default (300s) is a runaway ceiling, not a need.
export const maxDuration = 30

const DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR = 5
/** Filings against ONE domain an hour, across every visitor. One pending request exists at a time; this bounds how often it can be rewritten. */
const DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR = 6

type Access = WorkspaceAccess & { ok: true }
const fileCfg = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_CATEGORY_REQUESTS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/category-request-throttle.json`,
  ledger: access.ledgers.doc('category-request-throttle.json'),
})
const domainCfg = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_CATEGORY_REQUESTS_PER_DOMAIN_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/category-request-domain-cap.json`,
  ledger: access.ledgers.doc('category-request-domain-cap.json'),
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

/** A stored request in the shape the modules define, host and all. */
type RequestBody = { readonly slug: string; readonly reason: string }
const requestOf = (r: { readonly host: string; readonly body: RequestBody; readonly requestedAt: string; readonly status: CategoryRequest['status']; readonly resolvedAt: string | null; readonly note: string | null }) => ({
  host: r.host,
  slug: r.body.slug,
  reason: r.body.reason,
  requestedAt: r.requestedAt,
  status: r.status,
  ...(r.resolvedAt ? { resolvedAt: r.resolvedAt } : {}),
  ...(r.note ? { note: r.note } : {}),
})

export async function GET(req: Request): Promise<Response> {
  const env = process.env
  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain) return json({ kind: 'input', message: 'Pass ?domain=example.com' }, 400)

  const access = await workspaceAccess(env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  const { store, dataDir: data } = access

  // Bounded to recorded domains BEFORE the ledger: an unknown name costs nobody a slot.
  const record = await categoryRecordIn(store, domain)
  if (!record) return json({ kind: 'no-record', message: `${domain} has no category on record in this workspace. A first scan decides one; there is nothing to correct until then.` }, 404)

  const names = new Map(allCategories(data).map((c) => [c.slug, c]))
  const name = (slug: string) => names.get(slug)?.displayName ?? slug
  // Authored by a model or written by a person: the generated store says which. (`verified` on a bank means collected, not reviewed.)
  const generatedSlugs = new Set(readGeneratedBanks(data).map((g) => g.bank.category))
  // Each correction's target is the slug of the record that carries it.
  const chain = [...(record.superseded ?? []), record]
  const pending = await store.requests.pending<RequestBody>('category', domain)
  const c = consequencesOf(data, domain, env, (await store.cycles.list(domain)).length)
  const body: CategoryStatus = {
    domain,
    record: {
      slug: record.slug,
      name: name(record.slug),
      source: record.source,
      decidedAt: record.decidedAt,
      version: record.version,
      corrections: chain.filter((r) => r.correction).map((r) => ({ from: r.correction!.from, to: r.slug, at: r.correction!.at, by: r.correction!.by, reason: r.correction!.reason })),
    },
    // The general bank is what a domain gets when no category fits; it is not a category to choose, and the store refuses it.
    categories: [...names.values()].filter((k) => k.slug !== FALLBACK_SLUG).map((k) => ({ slug: k.slug, name: k.displayName, generated: generatedSlugs.has(k.slug) })).sort((a, b) => a.name.localeCompare(b.name)),
    pending: pending ? { slug: pending.body.slug, name: name(pending.body.slug), requestedAt: pending.requestedAt } : null,
    history: (await store.requests.forHost<RequestBody>('category', domain))
      .map(requestOf)
      .filter((r): r is typeof r & { status: 'applied' | 'declined' } => r.status !== 'pending')
      .map((r) => ({ slug: r.slug, status: r.status, requestedAt: r.requestedAt, resolvedAt: r.resolvedAt ?? '', note: r.note ?? '' })),
    nextCycle: { prompts: c.prompts, engines: c.engines, cells: c.cells, usd: c.usd, plan: c.plan, earlierCycles: c.earlierCycles },
  }
  return json(body)
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const raw = (await req.json().catch(() => ({}))) as { domain?: unknown; slug?: unknown; reason?: unknown }
  const domain = normaliseHost(String(raw.domain ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Pass the domain the record is about.' }, 400)
  const slug = String(raw.slug ?? '').trim()
  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  if (!slug) return json({ kind: 'input', message: 'Choose the category you think is right.' }, 400)

  const access = await workspaceAccess(env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  const { store, dataDir: data } = access

  // No record: nothing to correct, and no slot spent finding that out.
  if (!(await categoryRecordIn(store, domain))) return json({ kind: 'no-record', message: `${domain} has no category on record in this workspace, so there is nothing to correct yet.` }, 404)

  const now = new Date()
  const perDomain = domainCfg(access, env)
  const domainVerdict = await checkVisitorThrottle(`${access.workspaceId}:${domain}`, perDomain, now)
  if (!domainVerdict.ok) return json({ kind: 'rate-limit', message: `Requests about ${domain} have been filed ${perDomain.maxScansPerHour} times in the last hour. The pending one stands; try again later.` }, 429)
  const cfg = fileCfg(access, env)
  const ip = extractClientIp(req, env)
  const verdict = await checkVisitorThrottle(ip, cfg, now)
  if (!verdict.ok) return json({ kind: 'rate-limit', message: verdict.message }, 429)

  if (applies(access)) {
    let written: Awaited<ReturnType<typeof correctCategoryIn>>
    try {
      written = await correctCategoryIn(store, data, { host: domain, slug, reason, by: access.who })
    } catch (e) {
      if (isStaleVersion(e)) return json({ kind: 'read-again', message: READ_AGAIN }, 409)
      throw e
    }
    if ('refuse' in written) return json({ kind: 'refused', message: written.refuse }, 422)
    // The pending request that asked for exactly this is applied by it; one that asked for something else stays for a separate decision.
    const pending = await store.requests.pending<RequestBody>('category', domain)
    if (pending && pending.body.slug === written.slug) await store.requests.resolve('category', domain, pending.requestedAt, { status: 'applied', by: access.who })
    await recordVisitorScan(`${access.workspaceId}:${domain}`, perDomain, now)
    await recordVisitorScan(ip, cfg, now)
    return json({ applied: true, version: written.version, request: { host: domain, slug: written.slug, reason: written.correction?.reason ?? reason, requestedAt: written.decidedAt, status: 'applied' } })
  }

  let filed: Awaited<ReturnType<typeof fileCategoryRequestIn>>
  try {
    filed = await fileCategoryRequestIn(store, data, { host: domain, slug, reason })
  } catch (e) {
    // Another account's filing stands and this session is a member: the store refused, nothing changed (0007).
    if (isForeignPending(e)) return json({ kind: 'pending-elsewhere', message: PENDING_BY_ANOTHER }, 409)
    throw e
  }
  if ('refuse' in filed) {
    const status = filed.kind === 'input' ? 400 : filed.kind === 'same-category' ? 409 : 422
    return json({ kind: filed.kind, message: filed.refuse }, status)
  }
  // Booked after a successful filing: a refusal wrote nothing and costs nothing.
  await recordVisitorScan(`${access.workspaceId}:${domain}`, perDomain, now)
  await recordVisitorScan(ip, cfg, now)
  return json({ request: filed, pendingAcrossStore: (await store.requests.allPending('category')).length })
}

