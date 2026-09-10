import { normaliseHost } from '@bliprank/taxonomy'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  allPendingCompetitorRequests,
  competitorRequestsFor,
  competitorsFor,
  fileCompetitorRequest,
  pendingCompetitorRequest,
  readOverride,
  reviewedLeaders,
} from '../../../../../services/grader/src/competitor-overrides.js'
import { allBanks, allCategories, readCategoryRecord } from '../../../../../services/grader/src/resolve-category.js'
import { leadersOf, subjectFor } from '../../../../../services/grader/src/scan.js'
import {
  DEFAULT_VISITOR_WINDOW_MS,
  checkVisitorThrottle,
  extractClientIp,
  recordVisitorScan,
  type VisitorThrottleConfig,
} from '../../../../../services/grader/src/visitor-throttle.js'
import type { CompetitorStatus } from '../../../lib/competitor-request'

/**
 * The competitor set a domain is measured against, and the request to adjust
 * it. ADR-0016, decision 3. The same shape and the same bounds as
 * `/api/category`: GET reads, POST files a request and never writes the
 * override, one pending per domain, caps on their own ledgers, and the
 * request's reason is not published. Deployed as a function (ADR-0002
 * Amendment 1); its store is one machine's disk until MVP_PLAN B3.
 */

export const dynamic = 'force-dynamic'
// JSON reads and one small write; the plan default (300s) is a runaway ceiling, not a need.
export const maxDuration = 30

const resolveRoot = (): string => {
  let curr = process.cwd()
  while (curr && curr !== dirname(curr)) {
    if (existsSync(join(curr, 'services', 'grader'))) return curr
    curr = dirname(curr)
  }
  return join(process.cwd(), '..', '..')
}
const dataDir = (env: NodeJS.ProcessEnv): string => env['GRADER_DATA_DIR'] || join(resolveRoot(), 'services', 'grader', 'data-live')

const DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR = 5
const DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR = 6

const fileCfg = (data: string, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_COMPETITOR_REQUESTS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: join(data, 'competitor-request-throttle.json'),
})
const domainCfg = (data: string, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_COMPETITOR_REQUESTS_PER_DOMAIN_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: join(data, 'competitor-request-domain-cap.json'),
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function GET(req: Request): Promise<Response> {
  const env = process.env
  const data = dataDir(env)
  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain) return json({ kind: 'input', message: 'Pass ?domain=example.com' }, 400)
  const record = readCategoryRecord(data, domain)
  if (!record) return json({ kind: 'no-record', message: `${domain} has no category on record on this machine, so it has no competitor set yet. A first scan decides one.` }, 404)
  const bank = allBanks(data).find((b) => b.category === record.slug)
  if (!bank) return json({ kind: 'no-record', message: `no bank for ${record.slug} in this build` }, 404)

  const subjectId = subjectFor(domain, bank, record.brandName).spec.id
  const now = competitorsFor(data, domain, bank, subjectId)!
  const override = readOverride(data, domain)
  const categoryIds = new Set(leadersOf(bank).map((l) => l.id))
  const reviewed = reviewedLeaders(data)
  const inSet = new Set(now.competitors.map((c) => c.id))
  const names = new Map(allCategories(data).map((c) => [c.slug, c.displayName]))
  const pending = pendingCompetitorRequest(data, domain)
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
    pending: pending ? { exclude: pending.exclude, include: pending.include, requestedAt: pending.requestedAt } : null,
    history: competitorRequestsFor(data, domain)
      .filter((r): r is typeof r & { status: 'applied' | 'declined' } => r.status !== 'pending')
      .map((r) => ({ status: r.status, requestedAt: r.requestedAt, resolvedAt: r.resolvedAt ?? '', note: r.note ?? '' })),
  }
  return json(body)
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const data = dataDir(env)
  const raw = (await req.json().catch(() => ({}))) as { domain?: unknown; exclude?: unknown; include?: unknown; reason?: unknown }
  const domain = normaliseHost(String(raw.domain ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Pass the domain the record is about.' }, 400)
  const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)
  const exclude = strs(raw.exclude ?? [])
  const include = strs(raw.include ?? [])
  if (!exclude || !include) return json({ kind: 'input', message: 'Competitors are chosen from the list.' }, 400)
  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  if (!readCategoryRecord(data, domain)) return json({ kind: 'no-record', message: `${domain} has no category on record on this machine, so there is no competitor set to adjust yet.` }, 404)

  const now = new Date()
  const perDomain = domainCfg(data, env)
  if (!checkVisitorThrottle(domain, perDomain, now).ok) return json({ kind: 'rate-limit', message: `Requests about ${domain}'s competitors have been filed ${perDomain.maxScansPerHour} times in the last hour. The pending one stands; try again later.` }, 429)
  const cfg = fileCfg(data, env)
  const ip = extractClientIp(req, env)
  const verdict = checkVisitorThrottle(ip, cfg, now)
  if (!verdict.ok) return json({ kind: 'rate-limit', message: verdict.message }, 429)

  const filed = fileCompetitorRequest(data, { host: domain, exclude, include, reason })
  if ('refuse' in filed) {
    const status = filed.kind === 'input' || filed.kind === 'no-change' ? 400 : filed.kind === 'no-record' ? 404 : 422
    return json({ kind: filed.kind, message: filed.refuse }, status)
  }
  recordVisitorScan(domain, perDomain, now)
  recordVisitorScan(ip, cfg, now)
  return json({ request: filed, pendingAcrossStore: allPendingCompetitorRequests(data).length })
}
