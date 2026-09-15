import { normaliseHost } from '@bliprank/taxonomy'
import { applyOverrideIn, competitorsIn, fileCompetitorRequestIn, reviewedLeaders } from '../../../../../services/grader/src/competitor-overrides.js'
import { allBanks, allCategories } from '../../../../../services/grader/src/resolve-category.js'
import { leadersOf, subjectFor } from '../../../../../services/grader/src/scan.js'
import { categoryRecordIn, overrideIn } from '../../../../../services/grader/src/store/documents.js'
import {
  DEFAULT_VISITOR_WINDOW_MS,
  checkVisitorThrottle,
  extractClientIp,
  recordVisitorScan,
  type VisitorThrottleConfig,
} from '../../../../../services/grader/src/visitor-throttle.js'
import type { CompetitorStatus } from '../../../lib/competitor-request'
import { applies, isForeignPending, isStaleVersion, PENDING_BY_ANOTHER, READ_AGAIN, workspaceAccess, type WorkspaceAccess } from '@/lib/workspace-access'

/**
 * The competitor set a domain is measured against, and the request to adjust
 * it. ADR-0016, decision 3. The same shape and the same bounds as
 * `/api/category`: GET reads, POST files a request and never writes the
 * override, one pending per domain, caps on their own ledgers, and the
 * request's reason is not published. The workspace is the session's
 * (MVP_PLAN B3b): the record, the override and the requests live in the
 * store the session's token scopes, and nothing in the request names one.
 */

export const dynamic = 'force-dynamic'
// JSON reads and one small write; the plan default (300s) is a runaway ceiling, not a need.
export const maxDuration = 30

const DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR = 5
const DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR = 6

type Access = WorkspaceAccess & { ok: true }
const fileCfg = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_COMPETITOR_REQUESTS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/competitor-request-throttle.json`,
  ledger: access.ledgers.doc('competitor-request-throttle.json'),
})
const domainCfg = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_COMPETITOR_REQUESTS_PER_DOMAIN_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/competitor-request-domain-cap.json`,
  ledger: access.ledgers.doc('competitor-request-domain-cap.json'),
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

type RequestBody = { readonly exclude: readonly string[]; readonly include: readonly string[]; readonly reason: string }

export async function GET(req: Request): Promise<Response> {
  const env = process.env
  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain) return json({ kind: 'input', message: 'Pass ?domain=example.com' }, 400)

  const access = await workspaceAccess(env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  const { store, dataDir: data } = access

  const record = await categoryRecordIn(store, domain)
  if (!record) return json({ kind: 'no-record', message: `${domain} has no category on record in this workspace, so it has no competitor set yet. A first scan decides one.` }, 404)
  const bank = allBanks(data).find((b) => b.category === record.slug)
  if (!bank) return json({ kind: 'no-record', message: `no bank for ${record.slug} in this build` }, 404)

  const subjectId = subjectFor(domain, bank, record.brandName).spec.id
  const now = (await competitorsIn(store, data, domain, bank, subjectId))!
  const override = await overrideIn(store, domain)
  const categoryIds = new Set(leadersOf(bank).map((l) => l.id))
  const reviewed = reviewedLeaders(data)
  const inSet = new Set(now.competitors.map((c) => c.id))
  const names = new Map(allCategories(data).map((c) => [c.slug, c.displayName]))
  const pending = await store.requests.pending<RequestBody>('competitors', domain)
  const body: CompetitorStatus = {
    domain,
    category: { slug: record.slug, name: names.get(record.slug) ?? record.slug, bankVersion: bank.version },
    set: override?.version ?? null,
    competitors: now.competitors.map((c) => ({ id: c.id, name: c.name, source: categoryIds.has(c.id) ? 'category' : 'included' })),
    excluded: (override?.exclude ?? []).filter((id) => categoryIds.has(id)).map((id) => ({ id, name: reviewed.get(id)?.name ?? id })),
    includable: [...reviewed.values()]
      .filter((l) => l.id !== subjectId && !inSet.has(l.id) && !categoryIds.has(l.id))
      .map((l) => ({ id: l.id, name: l.name, bank: names.get(l.bank) ?? l.bank }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    last: override ? { version: override.version, at: override.at, by: override.by, reason: override.reason } : null,
    pending: pending ? { exclude: pending.body.exclude, include: pending.body.include, requestedAt: pending.requestedAt } : null,
    history: (await store.requests.forHost<RequestBody>('competitors', domain))
      .filter((r): r is typeof r & { status: 'applied' | 'declined' } => r.status !== 'pending')
      .map((r) => ({ status: r.status, requestedAt: r.requestedAt, resolvedAt: r.resolvedAt ?? '', note: r.note ?? '' })),
  }
  return json(body)
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const raw = (await req.json().catch(() => ({}))) as { domain?: unknown; exclude?: unknown; include?: unknown; reason?: unknown }
  const domain = normaliseHost(String(raw.domain ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Pass the domain the record is about.' }, 400)
  const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)
  const exclude = strs(raw.exclude ?? [])
  const include = strs(raw.include ?? [])
  if (!exclude || !include) return json({ kind: 'input', message: 'Competitors are chosen from the list.' }, 400)
  const reason = typeof raw.reason === 'string' ? raw.reason : ''

  const access = await workspaceAccess(env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  const { store, dataDir: data } = access

  if (!(await categoryRecordIn(store, domain))) return json({ kind: 'no-record', message: `${domain} has no category on record in this workspace, so there is no competitor set to adjust yet.` }, 404)

  const now = new Date()
  const perDomain = domainCfg(access, env)
  if (!(await checkVisitorThrottle(`${access.workspaceId}:${domain}`, perDomain, now)).ok) return json({ kind: 'rate-limit', message: `Requests about ${domain}'s competitors have been filed ${perDomain.maxScansPerHour} times in the last hour. The pending one stands; try again later.` }, 429)
  const cfg = fileCfg(access, env)
  const ip = extractClientIp(req, env)
  const verdict = await checkVisitorThrottle(ip, cfg, now)
  if (!verdict.ok) return json({ kind: 'rate-limit', message: verdict.message }, 429)

  if (applies(access)) {
    let written: Awaited<ReturnType<typeof applyOverrideIn>>
    try {
      written = await applyOverrideIn(store, data, { host: domain, exclude, include, reason, by: access.who })
    } catch (e) {
      if (isStaleVersion(e)) return json({ kind: 'read-again', message: READ_AGAIN }, 409)
      throw e
    }
    if ('refuse' in written) {
      const status = written.kind === 'input' || written.kind === 'no-change' ? 400 : written.kind === 'no-record' ? 404 : 422
      return json({ kind: written.kind, message: written.refuse }, status)
    }
    const pending = await store.requests.pending<RequestBody>('competitors', domain)
    const sameLists = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])
    if (pending && sameLists(pending.body.exclude, written.exclude) && sameLists(pending.body.include, written.include)) {
      await store.requests.resolve('competitors', domain, pending.requestedAt, { status: 'applied', by: access.who })
    }
    await recordVisitorScan(`${access.workspaceId}:${domain}`, perDomain, now)
    await recordVisitorScan(ip, cfg, now)
    return json({ applied: true, version: written.version, request: { host: domain, exclude: written.exclude, include: written.include, reason: written.reason, requestedAt: written.at, status: 'applied' } })
  }

  let filed: Awaited<ReturnType<typeof fileCompetitorRequestIn>>
  try {
    filed = await fileCompetitorRequestIn(store, data, { host: domain, exclude, include, reason })
  } catch (e) {
    // Another account's filing stands and this session is a member: the store refused, nothing changed (0007).
    if (isForeignPending(e)) return json({ kind: 'pending-elsewhere', message: PENDING_BY_ANOTHER }, 409)
    throw e
  }
  if ('refuse' in filed) {
    const status = filed.kind === 'input' || filed.kind === 'no-change' ? 400 : filed.kind === 'no-record' ? 404 : 422
    return json({ kind: filed.kind, message: filed.refuse }, status)
  }
  await recordVisitorScan(`${access.workspaceId}:${domain}`, perDomain, now)
  await recordVisitorScan(ip, cfg, now)
  return json({ request: filed, pendingAcrossStore: (await store.requests.allPending('competitors')).length })
}

