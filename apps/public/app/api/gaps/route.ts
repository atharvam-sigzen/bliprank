import { normaliseHost } from '@bliprank/taxonomy'
import { gapReportFor } from '../../../../../services/grader/src/gaps.js'
import {
  DEFAULT_VISITOR_WINDOW_MS,
  checkVisitorThrottle,
  extractClientIp,
  recordVisitorScan,
  type VisitorThrottleConfig,
} from '../../../../../services/grader/src/visitor-throttle.js'
import { workspaceAccess, type WorkspaceAccess } from '@/lib/workspace-access'

/**
 * The gap report for a domain the workspace has scanned: its homepage, read
 * once now, against the prompts its stored cycle was measured over. ADR-0014.
 *
 * On the deployment (Vercel, ADR-0002 Amendment 1) this route exists; the
 * bundled reference scan still ships its report as a static file and the
 * client reads that first (`lib/gaps.ts`). The store is the session's
 * workspace (MVP_PLAN B3b), so a domain it never scanned is a 404 before any
 * fetch.
 *
 * ⚠️ IT MAKES ONE OUTBOUND GET TO A CALLER-NAMED HOST, which is an amplifier,
 * so it is bounded three ways, and the first two do not trust the caller:
 *
 *   - only a domain with a STORED CYCLE is fetched. Anything else is a 404
 *     before any request leaves, so this is not a proxy for arbitrary hosts;
 *   - a per-DOMAIN rolling-window cap, shared by every visitor. The visitor
 *     throttle keys on the one header `TRUSTED_PROXY` names, and on a
 *     deployment that names none every caller is one visitor; either way a
 *     loop cannot be more than this many reads of one homepage an hour,
 *     whatever it calls itself. Found by the ADR-0014 review;
 *     `/api/preview` shares the weaker bound and is noted there;
 *   - at most a couple of reads in flight at once, so a slow homepage cannot
 *     be used to pile up sockets;
 *   - and, for ordinary fairness, a per-visitor throttle on its own ledger.
 *
 * The fetch itself is `fetch-site.ts`'s: address pinning, redirect re-checks,
 * a byte ceiling, a timeout. No provider, no model, no spend.
 */

export const dynamic = 'force-dynamic'
// One homepage read under fetch-site's 6s-per-hop timeout; 60s is the ceiling
// on a slow redirect chain, not a need.
export const maxDuration = 60

const DEFAULT_MAX_GAP_REPORTS_PER_VISITOR_PER_HOUR = 20
/** Reads of ONE domain's homepage an hour, across every visitor. A page does not change six times an hour. */
const DEFAULT_MAX_GAP_REPORTS_PER_DOMAIN_PER_HOUR = 6
const MAX_IN_FLIGHT = 2
let inFlight = 0

const throttleConfig = (access: WorkspaceAccess & { ok: true }, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_GAP_REPORTS_PER_VISITOR_PER_HOUR'] ?? DEFAULT_MAX_GAP_REPORTS_PER_VISITOR_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  // Its own ledger. A throttle shared with scans would let gap reports use up
  // a visitor's scan allowance, and the other way round.
  ledgerFile: `${access.dataDir}/gaps-throttle.json`,
  ledger: access.ledgers.doc('gaps-throttle.json'),
})

/** The same rolling-window machinery, keyed by the DOMAIN read rather than by who asked. */
const domainCapConfig = (access: WorkspaceAccess & { ok: true }, env: NodeJS.ProcessEnv): VisitorThrottleConfig => ({
  maxScansPerHour: Number(env['GRADER_MAX_GAP_REPORTS_PER_DOMAIN_PER_HOUR'] ?? DEFAULT_MAX_GAP_REPORTS_PER_DOMAIN_PER_HOUR),
  windowMs: DEFAULT_VISITOR_WINDOW_MS,
  ledgerFile: `${access.dataDir}/gaps-domain-cap.json`,
  ledger: access.ledgers.doc('gaps-domain-cap.json'),
})

export async function GET(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const env = process.env
  const url = new URL(req.url)
  const domain = normaliseHost(url.searchParams.get('domain') ?? '')
  if (!domain) return json({ message: 'Pass ?domain=example.com' }, 400)
  const dayParam = url.searchParams.get('day') ?? ''
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : undefined

  const access = await workspaceAccess(env)
  if (!access.ok) return json({ message: access.message }, access.status)

  // Bounded to scanned domains, and to a cycle that exists when a day is
  // named, BEFORE any throttle: an unknown name or day costs neither a request
  // nor a slot of anyone's allowance.
  const cycle = day ? await access.store.cycles.read(domain, day) : await access.store.cycles.latest(domain)
  if (!cycle) {
    return json({ message: day ? `this workspace holds no cycle of ${domain} for ${day}` : `this workspace holds no cycle of ${domain}, so there is no cycle to report the page against` }, 404)
  }

  const now = new Date()
  // The bound that does not trust the caller: this many reads of THIS homepage
  // an hour, whoever asks. Checked first, so a loop cannot even consume its own
  // visitor allowance against a domain that is already at its cap.
  //
  // Keyed by the WORKSPACE and the domain, as the three correction routes key
  // theirs: the ledger is the deployment's, so a bare domain key would let one
  // workspace's reads of a host exhaust the cap for every other workspace that
  // scanned the same host, and the 429 would be an oracle for it (B3c item 2).
  const perDomain = domainCapConfig(access, env)
  const domainKey = `${access.workspaceId}:${domain}`
  const domainVerdict = await checkVisitorThrottle(domainKey, perDomain, now)
  if (!domainVerdict.ok) {
    return json({ message: `${domain}'s homepage has already been read ${perDomain.maxScansPerHour} times in the last hour for gap reports, and a page does not change that often. Try again later; nothing was fetched.` }, 429)
  }
  const cfg = throttleConfig(access, env)
  const ip = extractClientIp(req, env)
  const verdict = await checkVisitorThrottle(ip, cfg, now)
  if (!verdict.ok) return json({ message: verdict.message }, 429)
  if (inFlight >= MAX_IN_FLIGHT) return json({ message: 'The gap report service is busy reading other pages. Try again in a moment; nothing was fetched.' }, 503)

  // Booked before the fetch, not after: a refused or failed read still made
  // the request, and an allowance that only counts successes is not one.
  await recordVisitorScan(domainKey, perDomain, now)
  await recordVisitorScan(ip, cfg, now)

  inFlight += 1
  try {
    const report = await gapReportFor(access.dataDir, domain, { ...(day ? { day } : {}), store: access.store })
    if ('refuse' in report) return json({ message: report.refuse }, 422)
    return json(report)
  } finally {
    inFlight -= 1
  }
}
