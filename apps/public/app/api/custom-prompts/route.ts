import { normaliseHost } from '@bliprank/taxonomy'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENGINES } from '@bliprank/contracts'
import { MAX_CUSTOM_PROMPTS, PROMPT_MAX, PROMPT_MIN, allPendingPromptRequests, filePromptRequest, pendingPromptRequest, promptRequestsFor, readCustomPromptSet } from '../../../../../services/grader/src/custom-prompts.js'
import { promptCost } from '../../../../../services/grader/src/prompts.js'
import { allCategories, readCategoryRecord } from '../../../../../services/grader/src/resolve-category.js'
import {
  DEFAULT_VISITOR_WINDOW_MS,
  checkVisitorThrottle,
  extractClientIp,
  recordVisitorScan,
  type VisitorThrottleConfig,
} from '../../../../../services/grader/src/visitor-throttle.js'
import type { CustomPromptStatus } from '../../../lib/custom-prompt-request'

/**
 * The custom prompts a domain's cycles ask beside the curated bank, and the
 * request to change them. ADR-0016, decision 4. The same shape and bounds as
 * `/api/category` and `/api/competitors`: GET reads, POST files a request and
 * never writes the set, one pending per domain, caps on their own ledgers, the
 * request's reason not published.
 *
 * ⚠️ THE VALIDATION IS THE STORE'S. A prompt naming the subject or a tracked
 * brand is refused here with the same matcher the scorer uses (PROPERTY 2),
 * so a visitor learns at filing time, not when an operator declines.
 *
 * Deployed as a function (ADR-0002 Amendment 1); its store is one machine's
 * disk until MVP_PLAN B3.
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
  maxScansPerHour: Number(env['GRADER_MAX_PROMPT_REQUESTS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: join(data, 'prompt-request-throttle.json'),
})
const domainCfg = (data: string, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_PROMPT_REQUESTS_PER_DOMAIN_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: join(data, 'prompt-request-domain-cap.json'),
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function GET(req: Request): Promise<Response> {
  const env = process.env
  const data = dataDir(env)
  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain) return json({ kind: 'input', message: 'Pass ?domain=example.com' }, 400)
  const record = readCategoryRecord(data, domain)
  if (!record) return json({ kind: 'no-record', message: `${domain} has no category on record on this machine, so there is no cycle for its prompts to join. A first scan decides one.` }, 404)
  const names = new Map(allCategories(data).map((c) => [c.slug, c.displayName]))
  const set = readCustomPromptSet(data, domain)
  const pending = pendingPromptRequest(data, domain)
  const one = promptCost(1, env)
  const body: CustomPromptStatus = {
    domain,
    category: { slug: record.slug, name: names.get(record.slug) ?? record.slug },
    set: set ? { version: set.version, prompts: set.prompts, at: set.at, by: set.by, reason: set.reason } : null,
    limits: { maxPrompts: MAX_CUSTOM_PROMPTS, promptMin: PROMPT_MIN, promptMax: PROMPT_MAX },
    perPrompt: { cells: ENGINES.length, usd: one.usd, plan: one.plan },
    pending: pending ? { prompts: pending.prompts, requestedAt: pending.requestedAt } : null,
    history: promptRequestsFor(data, domain)
      .filter((r): r is typeof r & { status: 'applied' | 'declined' } => r.status !== 'pending')
      .map((r) => ({ status: r.status, requestedAt: r.requestedAt, resolvedAt: r.resolvedAt ?? '', note: r.note ?? '' })),
  }
  return json(body)
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const data = dataDir(env)
  const raw = (await req.json().catch(() => ({}))) as { domain?: unknown; prompts?: unknown; reason?: unknown }
  const domain = normaliseHost(String(raw.domain ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Pass the domain the record is about.' }, 400)
  if (!Array.isArray(raw.prompts) || !raw.prompts.every((p) => typeof p === 'string')) return json({ kind: 'input', message: 'Prompts are a list of sentences.' }, 400)
  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  if (!readCategoryRecord(data, domain)) return json({ kind: 'no-record', message: `${domain} has no category on record on this machine, so there is no cycle for its prompts to join yet.` }, 404)

  const now = new Date()
  const perDomain = domainCfg(data, env)
  if (!checkVisitorThrottle(domain, perDomain, now).ok) return json({ kind: 'rate-limit', message: `Prompt requests about ${domain} have been filed ${perDomain.maxScansPerHour} times in the last hour. The pending one stands; try again later.` }, 429)
  const cfg = fileCfg(data, env)
  const ip = extractClientIp(req, env)
  const verdict = checkVisitorThrottle(ip, cfg, now)
  if (!verdict.ok) return json({ kind: 'rate-limit', message: verdict.message }, 429)

  const filed = filePromptRequest(data, { host: domain, prompts: raw.prompts as string[], reason })
  if ('refuse' in filed) {
    const status = filed.kind === 'input' || filed.kind === 'no-change' ? 400 : filed.kind === 'no-record' ? 404 : 422
    return json({ kind: filed.kind, message: filed.refuse }, status)
  }
  recordVisitorScan(domain, perDomain, now)
  recordVisitorScan(ip, cfg, now)
  return json({ request: filed, pendingAcrossStore: allPendingPromptRequests(data).length })
}
