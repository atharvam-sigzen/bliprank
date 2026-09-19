import { normaliseHost } from '@bliprank/taxonomy'
import { readTrackedIn, setTrackedIn, workspaceOf, TRACKED, TrackedCeilingReached, type TrackedEntry } from '../../../../../services/grader/src/due.js'
import { categoryRecordIn, customPromptsIn } from '../../../../../services/grader/src/store/documents.js'
import { DEFAULT_VISITOR_WINDOW_MS, checkVisitorThrottle, extractClientIp, recordVisitorScan, type VisitorThrottleConfig } from '../../../../../services/grader/src/visitor-throttle.js'
import { utcDay } from '../../../../../services/grader/src/live-gate.js'
import { applies, workspaceAccess, type WorkspaceAccess } from '@/lib/workspace-access'
import { NO_RECORD, ONLY_OWNER_OR_ADMIN, daysLeftOn, maxTrackedPerWorkspace, positiveIntOr, untilDay, type TrackedStatus } from '@/lib/tracked'

/**
 * THE DAILY RE-CHECK, AS A WORKSPACE ACTION (MVP_PLAN C3, ADR-0018 D6,
 * ADR-0016 Amendment 1; PRODUCT_GOAL point 6). GET says whether this workspace
 * re-checks a domain daily and until when; POST switches it on for a number of
 * days, or off.
 *
 * THE FLOW THIS SERVES (owner decision 2026-09-16, identity OFF on the owner's
 * machine): a person enters a domain, sees the prompts the cycle would ask,
 * edits them (saved as the domain's prompt set, version V, through
 * `/api/custom-prompts`), enters a number of days, and the first cycle runs
 * now while this route writes the entry `{ host, since, until, by, prompts: V }`
 * into the deployment's `tracked.json` ledger document; the daily tick asks
 * that set on every engine each day until `until`, then refuses `expired`.
 *
 * EVERYTHING ABOUT WHO IS THE SESSION'S. The workspace, the account and the
 * role come from `workspaceAccess()` and from nothing in the body: the body
 * names a domain, a direction and a number of days, and that is all it can
 * name (the C2 tenancy review, MAJOR-2: the tracked document authorises
 * cross-workspace collection from outside the database, so nothing a caller
 * writes may choose the workspace it lands in). The role is re-read from the
 * session at EVERY write; the database re-verifies it against membership when
 * a job presents the entry's token (migration 0005), and a change after
 * tracking refuses the job and collects nothing. With identity on, an owner or
 * admin switches and a member is refused; that path is built and tested over
 * PGlite and is not wired to a surface in this scope. On a machine's own file
 * store (identity off) the person at the keyboard is its operator, and the
 * route writes the CLI's own form (`by: local`, no workspace, no role).
 *
 * WHAT IT REFUSES: a domain with no category record in THIS workspace's store
 * (the record is a measurement's precondition, B3d item 2); a number of days
 * that is not 1..MAX_TRACK_DAYS; a workspace already tracking its interim
 * ceiling of hosts (`GRADER_MAX_TRACKED_PER_WORKSPACE`, default 3, decided
 * INSIDE the locked write, until D2 gates the count by plan). POST is bounded
 * per visitor and per domain by the same hourly ledgers the filing routes use:
 * a tracked host is a daily spend once the loop is armed, so the write that
 * enrols it is not free to repeat (C3 tenancy review, MAJOR 2). Nothing here
 * collects: switching on writes an entry the next tick reads, and only an
 * armed loop ever runs it.
 *
 * WHAT GET SAYS, AND DOES NOT. The workspace's own entry for the domain and
 * nothing about any other workspace: the tracked document is deployment-wide,
 * and listing it would hand one tenant another's client list (B3c item 1).
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const DEFAULT_MAX_SWITCHES_PER_VISITOR_PER_HOUR = 10
const DEFAULT_MAX_SWITCHES_PER_DOMAIN_PER_HOUR = 12

type Access = WorkspaceAccess & { ok: true }
const visitorCfg = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: positiveIntOr(env['GRADER_MAX_TRACK_SWITCHES_PER_VISITOR_PER_HOUR'], DEFAULT_MAX_SWITCHES_PER_VISITOR_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/tracked-switch-throttle.json`,
  ledger: access.ledgers.doc('tracked-switch-throttle.json'),
})
const domainCfg = (access: Access, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: positiveIntOr(env['GRADER_MAX_TRACK_SWITCHES_PER_DOMAIN_PER_HOUR'], DEFAULT_MAX_SWITCHES_PER_DOMAIN_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/tracked-switch-domain-cap.json`,
  ledger: access.ledgers.doc('tracked-switch-domain-cap.json'),
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

/** The workspace's own entries, and nothing of any other's. */
const mine = (access: Access, entries: readonly TrackedEntry[]): readonly TrackedEntry[] => entries.filter((t) => workspaceOf(t) === access.workspaceId)

const shape = (access: Access, domain: string, own: readonly TrackedEntry[], today: string, setNow: number | undefined): TrackedStatus => {
  const entry = own.find((t) => t.host === domain)
  return {
    domain,
    tracked: entry !== undefined && (entry.until === undefined || today <= entry.until),
    ...(entry ? { since: entry.since, reason: entry.reason } : {}),
    ...(entry?.until ? { until: entry.until, daysLeft: daysLeftOn(today, entry.until) } : {}),
    // What the next cycle will ask is the set in force NOW; the entry's own figure is only when the switch was pressed.
    ...(setNow ? { prompts: setNow } : {}),
    ...(entry?.prompts ? { promptsAtSwitch: entry.prompts } : {}),
    may: access.backend === 'file' || applies(access),
    trackedInWorkspace: own.filter((t) => t.until === undefined || today <= t.until).length,
    backend: access.backend,
  }
}

const WHERE = `the ${TRACKED} ledger document`

export async function GET(req: Request): Promise<Response> {
  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain) return json({ kind: 'input', message: 'Pass ?domain=example.com' }, 400)
  const access = await workspaceAccess(process.env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  let own: readonly TrackedEntry[]
  try {
    own = mine(access, await readTrackedIn(access.ledgers, WHERE))
  } catch (e) {
    console.error('[tracked]', e)
    return json({ kind: 'ledger', message: `The daily list cannot be read on this deployment until an operator repairs its ${TRACKED} document.` }, 503)
  }
  return json(shape(access, domain, own, utcDay(new Date()), (await customPromptsIn(access.store, domain))?.version))
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const raw = (await req.json().catch(() => ({}))) as { domain?: unknown; on?: unknown; days?: unknown; reason?: unknown }
  const domain = normaliseHost(String(raw.domain ?? ''))
  if (!domain) return json({ kind: 'input', message: 'Pass the domain to re-check daily.' }, 400)
  if (typeof raw.on !== 'boolean') return json({ kind: 'input', message: 'Say whether the daily re-check is on or off.' }, 400)
  const now = new Date()
  const today = utcDay(now)
  const until = raw.on ? untilDay(today, raw.days) : null
  if (raw.on && until === null) return json({ kind: 'input', message: 'Say for how many days, a whole number from 1 to 90.' }, 400)
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 500) : ''

  const access = await workspaceAccess(env)
  if (!access.ok) return json({ kind: 'access', message: access.message }, access.status)
  // The decision is an owner's or admin's; the machine's own store is its operator's.
  if (access.backend === 'postgres' && !applies(access)) return json({ kind: 'role', message: ONLY_OWNER_OR_ADMIN }, 403)

  // Bounded before the store is read: a switch is a write that enrols a daily spend.
  const perDomain = domainCfg(access, env)
  if (!(await checkVisitorThrottle(`${access.workspaceId}:${domain}`, perDomain, now)).ok) {
    return json({ kind: 'rate-limit', message: `The daily re-check for ${domain} has been switched ${perDomain.maxScansPerHour} times in the last hour. What stands, stands; try again later.` }, 429)
  }
  const perVisitor = visitorCfg(access, env)
  const ip = extractClientIp(req, env)
  const visitor = await checkVisitorThrottle(ip, perVisitor, now)
  if (!visitor.ok) return json({ kind: 'rate-limit', message: visitor.message }, 429)

  let prompts: number | undefined
  if (raw.on) {
    // The record is the precondition, in THIS workspace's store; nothing is written finding that out.
    if (!(await categoryRecordIn(access.store, domain))) return json({ kind: 'no-record', message: `${domain} ${NO_RECORD}` }, 404)
    // The set in force is what the instruction was given with (Amendment 1); absent, the bank's, and the entry says nothing.
    prompts = (await customPromptsIn(access.store, domain))?.version
  }

  let own: readonly TrackedEntry[]
  try {
    own = await setTrackedIn(
      access.ledgers,
      WHERE,
      {
        host: domain,
        workspaceId: access.workspaceId,
        by: access.who,
        ...(access.role === 'local' ? {} : { role: access.role }),
        reason: reason || (raw.on ? `re-check daily for ${raw.days as number} day${raw.days === 1 ? '' : 's'}, from the record` : 'switched off from the record'),
        at: now.toISOString(),
        ...(until ? { until } : {}),
        ...(prompts ? { prompts } : {}),
      },
      raw.on,
      { max: maxTrackedPerWorkspace(env), today },
    )
  } catch (e) {
    if (e instanceof TrackedCeilingReached) return json({ kind: 'ceiling', message: `This workspace already re-checks ${e.tracked} domain${e.tracked === 1 ? '' : 's'} daily, its ceiling until plans gate the count. Switch one off first.` }, 422)
    console.error('[tracked]', e)
    return json({ kind: 'ledger', message: `The daily list cannot be written on this deployment until an operator repairs its ${TRACKED} document.` }, 503)
  }
  // Booked after a successful write: a refusal wrote nothing and costs nothing.
  await recordVisitorScan(`${access.workspaceId}:${domain}`, perDomain, now)
  await recordVisitorScan(ip, perVisitor, now)
  return json(shape(access, domain, own, today, prompts ?? (await customPromptsIn(access.store, domain))?.version))
}
