import { mintWorkspaceToken } from '@bliprank/db/token'
import { QStashClient } from '../../../services/collector/src/qstash.js'
import { verifyQStashRequest } from '../../../services/collector/src/qstash-verify.js'
import { isTickJob, loopModeOf, runDomainJob, runFanOut, type DomainJob, type TickMode } from '../../../services/grader/src/daily-loop.js'
import { LOCAL_WORKSPACE } from '../../../services/grader/src/domain-ceiling.js'
import { readTrackedIn, type TrackedEntry } from '../../../services/grader/src/due.js'
import { ledgerStores, resolveTopology, type LedgerStores } from '../../../services/grader/src/ledger-stores.js'
import { readFlag } from '../../../services/grader/src/load-key.js'
import { TICK_PATH, TICK_RETRIES, TICK_TIMEOUT_SEC } from '../../../services/grader/src/schedule.js'
import { fileWorkspaceStore } from '../../../services/grader/src/store/file-store.js'
import { sessionWorkspaceStore, type WorkspaceStore } from '../../../services/grader/src/store/pg-store.js'
import { identityConfig, type IdentityConfig } from './auth/config'
import { appDb } from './auth/db'
import { dataDir, ROOT } from './data-dir'
import { NO_STORE } from './workspace-access'

/**
 * THE TICK ROUTE'S DECISIONS (ADR-0018), kept out of the route module because
 * a Next route file may export handlers and config and nothing else.
 *
 * ORDER, AND WHY. (1) Configuration: without a signing key or the site's own
 * origin nothing can be verified, so the answer is 503 and nothing is read.
 * (2) Verification: the raw body's bytes against the `Upstash-Signature`
 * JWT — issuer, this route's URL as the subject, expiry, not-before, the
 * body hash, the current and the next key — BEFORE the body is parsed. A
 * request that does not verify is 401 and touches no store, no ledger and
 * no provider: an unverified collection endpoint is a public button that
 * bills us (R3, `qstash.ts`). (3) Shape: one of the two jobs or 400. (4) The
 * mode, from the environment only: `armed` is live, `fixture` is offline and
 * only with identity off, anything else answers "not armed" and does
 * nothing. (5) The stores: the deployment's ledgers and, per tracked entry,
 * the workspace's store through a token minted for the account that switched
 * the domain on (D6). (6) The job, through `daily-loop.ts`, which is the same
 * loop the CLI runs.
 *
 * STATUS CODES ARE THE SPEND RULE (D9). QStash retries every non-2xx and
 * every timeout, and a retry re-enters this route. So a non-2xx must mean
 * "nothing was spent and trying again is safe": 401 (not QStash), 400 (not a
 * job), 503 (not configured, or a ledger lock could not be taken). Every
 * outcome of a job that may have spent — ran, failed, refused at a gate — is
 * 200 with the outcome in the body, and the ledger's own line is what a retry
 * meets (`already-booked`). The unauthenticated answers carry fixed sentences;
 * the cause goes to the server log. A verified caller is the operator's own
 * QStash, so a job's outcome may name hosts and ledgers.
 */
export const NOT_CONFIGURED = 'This deployment is not configured for the daily tick.'
export const NOT_QSTASH = 'The request did not verify as a QStash delivery for this route.'
export const NOT_A_JOB = 'The body is not a tick job.'
export const LEDGER_UNAVAILABLE = 'A ledger could not be read or locked; nothing was collected. Try again.'

/** A job's token lives for the invocation and a margin, not a session's hour: the route's maxDuration is 300 s (C2 tenancy review, MINOR-3). */
export const JOB_TOKEN_TTL_SEC = 600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TickReply {
  readonly status: number
  readonly body: Record<string, unknown>
}

export interface TickDeps {
  readonly now?: () => Date
  readonly log?: (...a: unknown[]) => void
  /** The QStash client's fetch, for a test; production uses the global. */
  readonly fetchImpl?: typeof fetch
}

/** The route's own absolute URL, built on `SITE_URL` and never on a request header: what QStash signs as `sub`. */
export function tickUrl(env: NodeJS.ProcessEnv): string | null {
  const site = env['SITE_URL']?.trim()
  if (!site) return null
  try {
    const u = new URL(site)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin}${TICK_PATH}`
  } catch {
    return null
  }
}

/**
 * The store a job opens for one tracked entry (ADR-0018 D6). With identity
 * off, this machine's file store, and only for an entry that names no other
 * workspace. With identity on, the workspace the entry names, through a
 * token minted for the account that switched the domain on with the role it
 * recorded; the database re-verifies both against membership on the first
 * call, which is made here so a refusal is a fact about the entry rather
 * than a thrown fan-out.
 */
export async function jobStoreFor(
  entry: Pick<TrackedEntry, 'host' | 'workspaceId' | 'by' | 'role'>,
  identity: ReturnType<typeof identityConfig>,
  data: string,
): Promise<WorkspaceStore | { readonly refuse: string }> {
  const workspaceId = entry.workspaceId ?? LOCAL_WORKSPACE
  if (!identity.on) {
    if (workspaceId !== LOCAL_WORKSPACE) return { refuse: `the entry names workspace ${workspaceId} but identity is off on this machine, whose store is its own` }
    return fileWorkspaceStore(data)
  }
  if (workspaceId === LOCAL_WORKSPACE) return { refuse: 'the entry names no workspace, and this deployment has identity on' }
  // `parseTracked` defaults an absent `by` to the word operator; on a deployment only an account id can be run as (C2 tenancy review, MINOR-5).
  if (!entry.role || !entry.by || !UUID.test(entry.by)) return { refuse: 'the entry names no account or role to run as' }
  const config: IdentityConfig = identity.config
  let store: WorkspaceStore
  try {
    store = sessionWorkspaceStore(appDb(config), mintWorkspaceToken(config.key, { sub: entry.by, workspaceId, role: entry.role, ttlSec: JOB_TOKEN_TTL_SEC }))
    // The database's verdict on the token, taken now: membership and the role claim (migration 0005).
    await store.cycles.latest(entry.host)
  } catch (e) {
    return { refuse: (e as Error).message }
  }
  return store
}

const json = (status: number, body: Record<string, unknown>): TickReply => ({ status, body })

export async function handleTick(req: Request, env: NodeJS.ProcessEnv = process.env, deps: TickDeps = {}): Promise<TickReply> {
  const log = deps.log ?? console.error
  const now = deps.now ?? (() => new Date())

  // 1. Configuration, before anything is read from the request.
  const url = tickUrl(env)
  const currentKey = env['QSTASH_CURRENT_SIGNING_KEY']?.trim()
  if (!url || !currentKey) {
    log('[tick] not configured:', !url ? 'SITE_URL' : 'QSTASH_CURRENT_SIGNING_KEY')
    return json(503, { ok: false, error: NOT_CONFIGURED })
  }

  // 2. Verification over the raw bytes, then 3. the shape.
  const raw = await req.text()
  try {
    const nextKey = env['QSTASH_NEXT_SIGNING_KEY']?.trim()
    verifyQStashRequest({ currentSigningKey: currentKey, ...(nextKey ? { nextSigningKey: nextKey } : {}), url, body: raw, signature: req.headers.get('upstash-signature') ?? '', now: () => now().getTime() })
  } catch (e) {
    log('[tick] refused:', (e as Error).message)
    return json(401, { ok: false, error: NOT_QSTASH })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return json(400, { ok: false, error: NOT_A_JOB })
  }
  if (!isTickJob(parsed)) return json(400, { ok: false, error: NOT_A_JOB })
  const job = parsed

  // 4. The mode is the deployment's, never the body's (D7).
  const mode: TickMode | null = loopModeOf(env)
  if (mode === null) return json(200, { ok: false, kind: job.kind, outcome: 'not-armed', reason: `GRADER_DAILY_LOOP is ${JSON.stringify(env['GRADER_DAILY_LOOP'])}; the loop runs only when it is "armed" (live) or, with identity off, "fixture"` })
  const identity = identityConfig(env)
  if (mode === 'fixture' && identity.on) return json(200, { ok: false, kind: job.kind, outcome: 'refused', reason: 'fixture mode is honoured only with identity off: a deployment holding workspaces never files a fixture cycle' })

  // 5. The ledgers and the data directory, decided as every route decides them (ADR-0002 Amendment 2, B3c item 4).
  const data = dataDir(env)
  const topology = readFlag(ROOT, 'COLLECTOR_TOPOLOGY', env)
  const declared = topology.value ? { ...env, COLLECTOR_TOPOLOGY: topology.value } : env
  let ledgers: LedgerStores
  try {
    ledgers = ledgerStores(data, declared)
  } catch (e) {
    log('[tick]', e)
    return json(503, { ok: false, error: NO_STORE })
  }
  if (!identity.on && resolveTopology(declared).topology === 'fleet') return json(503, { ok: false, error: NO_STORE })

  try {
    if (job.kind === 'fan-out') {
      const token = env['QSTASH_TOKEN']?.trim()
      if (!token) {
        log('[tick] not configured: QSTASH_TOKEN')
        return json(503, { ok: false, error: NOT_CONFIGURED })
      }
      const client = new QStashClient({ token, destination: url, retries: TICK_RETRIES, ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}) })
      const out = await runFanOut(
        {
          dataDir: data,
          env,
          ledgers,
          mode,
          root: ROOT,
          storeFor: (entry) => jobStoreFor(entry, identity, data),
          publish: async (domainJob, o) => {
            await client.publishJson(domainJob, { deduplicationId: o.deduplicationId, timeoutSec: TICK_TIMEOUT_SEC })
          },
        },
        { now, log: (s) => log('[tick]', s) },
      )
      if (out.outcome === 'lease-held') return json(503, { ok: false, kind: 'fan-out', outcome: out.outcome, reason: out.refuse })
      if (out.outcome === 'fanned-out') {
        // The hosts and workspaces go to the server log; the answer QStash keeps
        // in its console carries counts only, so a third party's message log
        // never holds every workspace's client list (C2 tenancy review, MINOR-2).
        log('[tick] fan-out', JSON.stringify({ day: out.day, due: out.list.due.map((d) => ({ host: d.host, workspaceId: d.workspaceId })), notDue: out.list.notDue.map((n) => ({ host: n.host, workspaceId: n.workspaceId, reason: n.reason })), refusedEntries: out.refusedEntries }))
        return json(200, { ok: true, kind: 'fan-out', outcome: out.outcome, day: out.day, capUsd: out.capUsd, published: out.published, failed: out.failed, due: out.list.due.length, notDue: out.list.notDue.length, refusedEntries: out.refusedEntries.length })
      }
      if (out.outcome === 'already-fanned-out') return json(200, { ok: true, kind: 'fan-out', outcome: out.outcome, day: out.day, fanOut: out.fanOut })
      return json(200, { ok: false, kind: 'fan-out', outcome: out.outcome, reason: out.refuse })
    }

    // A domain job: the entry it was published for must still be tracked, and its store is that entry's (D6).
    const entry = (await readTrackedIn(ledgers)).find((t) => t.host === job.host && (t.workspaceId ?? LOCAL_WORKSPACE) === job.workspaceId)
    if (!entry) return json(200, { ok: false, kind: 'domain', outcome: 'not-tracked', host: job.host, reason: `${job.host} is no longer tracked for workspace ${job.workspaceId}; nothing was collected` })
    const store = await jobStoreFor(entry, identity, data)
    if ('refuse' in store) return json(200, { ok: false, kind: 'domain', outcome: 'refused', host: job.host, reason: store.refuse })
    const out = await runDomainJob({ dataDir: data, env, ledgers, store, job: job as DomainJob, mode, root: ROOT, resultFile: !identity.on }, { now, log: (s) => log('[tick]', s) })
    if (out.outcome === 'ran') return json(200, { ok: true, kind: 'domain', outcome: 'ran', host: job.host, day: job.day, run: out.run, spentAfter: out.spentAfter })
    return json(200, { ok: false, kind: 'domain', outcome: out.outcome, host: job.host, day: job.day, reason: out.refuse })
  } catch (e) {
    // A ledger that could not be read or locked, before or after a spend: the
    // reservation line stands where one was written, so a retry books nothing.
    log('[tick] failed', e)
    return json(503, { ok: false, kind: job.kind, error: LEDGER_UNAVAILABLE })
  }
}
