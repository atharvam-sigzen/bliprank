import { normaliseHost } from '@bliprank/taxonomy'
import { ENGINES } from '@bliprank/contracts'
import { MAX_CUSTOM_PROMPTS, PROMPT_MAX, PROMPT_MIN, applyCustomPromptsIn, filePromptRequestIn } from '../../../../../services/grader/src/custom-prompts.js'
import { promptCost } from '../../../../../services/grader/src/prompts.js'
import { allCategories } from '../../../../../services/grader/src/resolve-category.js'
import { categoryRecordIn, customPromptsIn } from '../../../../../services/grader/src/store/documents.js'
import {
  DEFAULT_VISITOR_WINDOW_MS,
  checkVisitorThrottle,
  extractClientIp,
  recordVisitorScan,
  type VisitorThrottleConfig,
} from '../../../../../services/grader/src/visitor-throttle.js'
import type { CustomPromptStatus } from '../../../lib/custom-prompt-request'
import { applies, isForeignPending, isStaleVersion, PENDING_BY_ANOTHER, READ_AGAIN, workspaceAccess, type WorkspaceAccess } from '@/lib/workspace-access'

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
 * The workspace is the session's (MVP_PLAN B3b): the record, the set and the
 * requests live in the store the session's token scopes, and nothing in the
 * request names one.
 */

export const dynamic = 'force-dynamic'
// JSON reads and one small write; the plan default (300s) is a runaway ceiling, not a need.
export const maxDuration = 30

const DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR = 5
const DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR = 6
type Access = WorkspaceAccess & { ok: true }
const fileCfg = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_PROMPT_REQUESTS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_VISITOR_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/prompt-request-throttle.json`,
  ledger: access.ledgers.doc('prompt-request-throttle.json'),
})
const domainCfg = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_PROMPT_REQUESTS_PER_DOMAIN_PER_HOUR'] ?? DEFAULT_MAX_REQUESTS_PER_DOMAIN_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/prompt-request-domain-cap.json`,
  ledger: access.ledgers.doc('prompt-request-domain-cap.json'),
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

type RequestBody = { readonly prompts: readonly string[]; readonly reason: string }

export async function GET(req: Request): Promise<Response> {
  const env = process.env
  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain) return json({ kind: 'input', message: 'Pass ?domain=example.com' }, 400)

  const access = await workspaceAccess(env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  const { store, dataDir: data } = access

  const record = await categoryRecordIn(store, domain)
  if (!record) return json({ kind: 'no-record', message: `${domain} has no category on record in this workspace, so there is no cycle for its prompts to join. A first scan decides one.` }, 404)
  const names = new Map(allCategories(data).map((c) => [c.slug, c.displayName]))
  const set = await customPromptsIn(store, domain)
  const pending = await store.requests.pending<RequestBody>('custom-prompts', domain)
  const one = promptCost(1, env)
  const body: CustomPromptStatus = {
    domain,
    category: { slug: record.slug, name: names.get(record.slug) ?? record.slug },
    set: set ? { version: set.version, prompts: set.prompts, at: set.at, by: set.by, reason: set.reason } : null,
    limits: { maxPrompts: MAX_CUSTOM_PROMPTS, promptMin: PROMPT_MIN, promptMax: PROMPT_MAX },
    perPrompt: { cells: ENGINES.length, usd: one.usd, plan: one.plan },
    pending: pending ? { prompts: pending.body.prompts, requestedAt: pending.requestedAt } : null,
    history: (await store.requests.forHost<RequestBody>('custom-prompts', domain))
      .filter((r): r is typeof r & { status: 'applied' | 'declined' } => r.status !== 'pending')
      .map((r) => ({ status: r.status, requestedAt: r.requestedAt, resolvedAt: r.resolvedAt ?? '', note: r.note ?? '' })),
  }
  return json(body)
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const raw = (await req.json().catch(() => ({}))) as { domain?: unknown; prompts?: unknown; reason?: unknown }
  const domain = normaliseHost(String(raw.domain ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Pass the domain the record is about.' }, 400)
  if (!Array.isArray(raw.prompts) || !raw.prompts.every((p) => typeof p === 'string')) return json({ kind: 'input', message: 'Prompts are a list of sentences.' }, 400)
  const reason = typeof raw.reason === 'string' ? raw.reason : ''

  const access = await workspaceAccess(env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  const { store, dataDir: data } = access

  if (!(await categoryRecordIn(store, domain))) return json({ kind: 'no-record', message: `${domain} has no category on record in this workspace, so there is no cycle for its prompts to join yet.` }, 404)

  const now = new Date()
  const perDomain = domainCfg(access, env)
  if (!(await checkVisitorThrottle(`${access.workspaceId}:${domain}`, perDomain, now)).ok) return json({ kind: 'rate-limit', message: `Prompt requests about ${domain} have been filed ${perDomain.maxScansPerHour} times in the last hour. The pending one stands; try again later.` }, 429)
  const cfg = fileCfg(access, env)
  const ip = extractClientIp(req, env)
  const verdict = await checkVisitorThrottle(ip, cfg, now)
  if (!verdict.ok) return json({ kind: 'rate-limit', message: verdict.message }, 429)

  if (applies(access)) {
    let written: Awaited<ReturnType<typeof applyCustomPromptsIn>>
    try {
      written = await applyCustomPromptsIn(store, data, { host: domain, prompts: raw.prompts as string[], reason, by: access.who })
    } catch (e) {
      if (isStaleVersion(e)) return json({ kind: 'read-again', message: READ_AGAIN }, 409)
      throw e
    }
    if ('refuse' in written) {
      const status = written.kind === 'input' || written.kind === 'no-change' ? 400 : written.kind === 'no-record' ? 404 : 422
      return json({ kind: written.kind, message: written.refuse }, status)
    }
    const pending = await store.requests.pending<RequestBody>('custom-prompts', domain)
    if (pending && pending.body.prompts.length === written.prompts.length && pending.body.prompts.every((p, i) => p === written.prompts[i])) {
      await store.requests.resolve('custom-prompts', domain, pending.requestedAt, { status: 'applied', by: access.who })
    }
    await recordVisitorScan(`${access.workspaceId}:${domain}`, perDomain, now)
    await recordVisitorScan(ip, cfg, now)
    return json({ applied: true, version: written.version, request: { host: domain, prompts: written.prompts, reason: written.reason, requestedAt: written.at, status: 'applied' } })
  }

  let filed: Awaited<ReturnType<typeof filePromptRequestIn>>
  try {
    filed = await filePromptRequestIn(store, data, { host: domain, prompts: raw.prompts as string[], reason })
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
  return json({ request: filed, pendingAcrossStore: (await store.requests.allPending('custom-prompts')).length })
}

