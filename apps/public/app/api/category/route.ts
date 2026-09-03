import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { allPending, consequencesOf, fileCategoryRequest, pendingRequest, requestsFor } from '../../../../../services/grader/src/category-requests.js'
import { allCategories, readCategoryRecord, readGeneratedBanks } from '../../../../../services/grader/src/resolve-category.js'
import {
  DEFAULT_VISITOR_WINDOW_MS,
  checkVisitorThrottle,
  extractClientIp,
  recordVisitorScan,
  type VisitorThrottleConfig,
} from '../../../../../services/grader/src/visitor-throttle.js'
import type { CategoryStatus } from '../../../lib/category-request'

/**
 * A domain's recorded category, its history, and the request to change it.
 * ADR-0016, decisions 2 and 5.
 *
 * ⚠️ LOCAL DEMO ONLY, like /api/scan. On the static deployment this route does
 * not exist and the surface says corrections are filed where the record is.
 *
 * ⚠️ NOTHING HERE WRITES THE RECORD. GET reads it. POST files a REQUEST, which
 * the record shows as pending and which changes no measurement until
 * `pnpm grader:correct` applies it. There is no identity in the product, so a
 * route that applied a correction would let anyone relabel anyone's domain
 * (the audit that shaped ADR-0016). What POST can do is bounded twice: by a
 * per-visitor allowance on its own ledger, and by the store's own rule of one
 * pending request per domain, so a loop of "visitors" can at most keep
 * replacing one sentence.
 *
 * GET is bounded to domains with a record (404 otherwise) and is not
 * throttled: it is one JSON read, and a ledger keyed by a caller-written
 * header would cost more per request than the read it guarded, and grow with
 * every name the caller invented.
 *
 * ⚠️ WHAT GET DOES NOT SAY. A pending request's REASON is 500 characters of
 * anonymous text. Printing it on the domain's public record would let anyone
 * post a sentence on anyone's page; so the record says a correction to X was
 * requested on a date and not applied, and no more. The filer sees their own
 * words in the outcome; the operator sees them in `pnpm grader:correct`.
 */

export const dynamic = 'force-dynamic'

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
/** Filings against ONE domain an hour, across every visitor. One pending request exists at a time; this bounds how often it can be rewritten. */
const DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR = 6

const fileCfg = (data: string, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_CATEGORY_REQUESTS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: join(data, 'category-request-throttle.json'),
})
const domainCfg = (data: string, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_CATEGORY_REQUESTS_PER_DOMAIN_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: join(data, 'category-request-domain-cap.json'),
})

const normalise = (d: string): string =>
  d.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '')
const isHost = (d: string): boolean => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function GET(req: Request): Promise<Response> {
  const env = process.env
  const data = dataDir(env)
  const domain = normalise(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain || !isHost(domain)) return json({ kind: 'input', message: 'Pass ?domain=example.com' }, 400)

  // Bounded to recorded domains BEFORE the ledger: an unknown name costs nobody a slot.
  const record = readCategoryRecord(data, domain)
  if (!record) return json({ kind: 'no-record', message: `${domain} has no category on record on this machine. A first scan decides one; there is nothing to correct until then.` }, 404)

  const names = new Map(allCategories(data).map((c) => [c.slug, c]))
  const name = (slug: string) => names.get(slug)?.displayName ?? slug
  // Authored by a model or written by a person: the generated store says which. (`verified` on a bank means collected, not reviewed.)
  const generatedSlugs = new Set(readGeneratedBanks(data).map((g) => g.bank.category))
  // Each correction's target is the slug of the record that carries it.
  const chain = [...(record.superseded ?? []), record]
  const pending = pendingRequest(data, domain)
  const c = consequencesOf(data, domain, env)
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
    categories: [...names.values()].map((k) => ({ slug: k.slug, name: k.displayName, generated: generatedSlugs.has(k.slug) })).sort((a, b) => a.name.localeCompare(b.name)),
    pending: pending ? { slug: pending.slug, name: name(pending.slug), requestedAt: pending.requestedAt } : null,
    history: requestsFor(data, domain)
      .filter((r): r is typeof r & { status: 'applied' | 'declined' } => r.status !== 'pending')
      .map((r) => ({ slug: r.slug, status: r.status, requestedAt: r.requestedAt, resolvedAt: r.resolvedAt ?? '', note: r.note ?? '' })),
    nextCycle: { prompts: c.prompts, engines: c.engines, cells: c.cells, usd: c.usd, plan: c.plan, earlierCycles: c.earlierCycles },
  }
  return json(body)
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const data = dataDir(env)
  const raw = (await req.json().catch(() => ({}))) as { domain?: unknown; slug?: unknown; reason?: unknown }
  const domain = normalise(String(raw.domain ?? ''))
  if (!domain || !isHost(domain)) return json({ kind: 'input', message: 'Pass the domain the record is about.' }, 400)
  const slug = String(raw.slug ?? '').trim()
  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  if (!slug) return json({ kind: 'input', message: 'Choose the category you think is right.' }, 400)

  // No record: nothing to correct, and no slot spent finding that out.
  if (!readCategoryRecord(data, domain)) return json({ kind: 'no-record', message: `${domain} has no category on record on this machine, so there is nothing to correct yet.` }, 404)

  const now = new Date()
  const perDomain = domainCfg(data, env)
  const domainVerdict = checkVisitorThrottle(domain, perDomain, now)
  if (!domainVerdict.ok) return json({ kind: 'rate-limit', message: `Requests about ${domain} have been filed ${perDomain.maxScansPerHour} times in the last hour. The pending one stands; try again later.` }, 429)
  const cfg = fileCfg(data, env)
  const ip = extractClientIp(req)
  const verdict = checkVisitorThrottle(ip, cfg, now)
  if (!verdict.ok) return json({ kind: 'rate-limit', message: verdict.message }, 429)

  const filed = fileCategoryRequest(data, { host: domain, slug, reason })
  if ('refuse' in filed) {
    const status = filed.kind === 'input' ? 400 : filed.kind === 'same-category' ? 409 : 422
    return json({ kind: filed.kind, message: filed.refuse }, status)
  }
  // Booked after a successful filing: a refusal wrote nothing and costs nothing.
  recordVisitorScan(domain, perDomain, now)
  recordVisitorScan(ip, cfg, now)
  return json({ request: filed, pendingAcrossStore: allPending(data).length })
}
