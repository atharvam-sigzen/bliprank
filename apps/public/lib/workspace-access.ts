import { mintWorkspaceToken } from '@bliprank/db/token'
import { LOCAL_WORKSPACE } from '../../../services/grader/src/domain-ceiling.js'
import { ledgerStores, resolveTopology, type LedgerStores } from '../../../services/grader/src/ledger-stores.js'
import { readFlag } from '../../../services/grader/src/load-key.js'
import { fileWorkspaceStore } from '../../../services/grader/src/store/file-store.js'
import { sessionWorkspaceStore, type WorkspaceStore } from '../../../services/grader/src/store/pg-store.js'
import { identityConfig } from './auth/config'
import { appDb } from './auth/db'
import { meOf, NOT_SIGNED_IN, NO_ACCOUNT } from './auth/handlers'
import { currentUser } from './auth/supabase'
import { dataDir, ROOT } from './data-dir'

/**
 * THE ONE WAY A ROUTE REACHES WORKSPACE STATE. MVP_PLAN B3b.
 *
 * A route that reads or writes a cycle, a record, an override, a prompt set
 * or a request calls this first and uses only what it returns. The workspace
 * is derived from the verified session and from nothing else: the request
 * carries no workspace and no account, and a body or query that names one is
 * a field nothing reads.
 *
 * WITH IDENTITY CONFIGURED (the deployment): the Supabase session names the
 * person, `workspaces_of` names the account and its workspaces, the server
 * mints a workspace token for the ONE workspace the account has, and every
 * store call opens its own transaction with that token, so the database
 * refuses anything the token does not cover (migrations 0002–0004). An
 * account with no workspace is told to create one; an account with several
 * (an agency) is told that choosing one is not built yet — that is Stage D1's
 * portfolio, and until it exists no route silently picks a client.
 *
 * WITH IDENTITY OFF (a laptop running the Grader, the CLIs, every test): the
 * file store over this machine's data directory. There is no workspace
 * because the machine is the tenant. Never on a deployment: a runtime that
 * is many instances, by a PaaS marker or by a declared
 * `COLLECTOR_TOPOLOGY=fleet` (`resolveTopology`, ADR-0006), is refused the
 * file store outright, so a half-configured deployment says so rather than
 * serving one instance's disk as if it were a store. And the machine has to
 * SAY it is one process: the ledgers open on files only under a declared
 * `single-process`, read from the environment or the repo-root `.env.local`
 * exactly as the two collection flags are, and never declared by a route
 * (B3c item 4).
 *
 * WHO MAY APPLY (MVP_PLAN B4). The session's role in the workspace comes back
 * too: an owner or admin applies a correction directly (the POST on
 * /api/category, /api/competitors, /api/custom-prompts writes version N+1
 * and marks a matching pending request applied); a member files a request
 * for them; on the file store everyone files, and the CLIs apply. Corrections
 * are versioned and never re-derived on every path (PRODUCT_GOAL point 7).
 *
 * THE LEDGERS COME WITH THE STORE, decided the same way (ledger-stores.ts):
 * Upstash when the deployment is configured for it, files on a machine,
 * refused on a fleet with neither.
 */
export const NO_STORE = 'This deployment has no workspace store configured, so it cannot read or write workspace state.'
export const NO_WORKSPACE = 'This account has no workspace yet. Create one first.'
export const SEVERAL_WORKSPACES = 'This account has several workspaces, and choosing one is not built yet.'

export type WorkspaceAccess =
  | {
      readonly ok: true
      readonly backend: 'postgres' | 'file'
      readonly store: WorkspaceStore
      readonly ledgers: LedgerStores
      readonly dataDir: string
      /** the account id behind the session, or `local` on the file store: who a filing or a correction is by */
      readonly who: string
      /** the session's role in the workspace (migration 0000): owner and admin may apply a correction; a member files a request; the file store is `local` and files */
      readonly role: 'owner' | 'admin' | 'member' | 'local'
      /** the workspace the token names, or `local` on the file store: what a per-domain cap is keyed by, so one workspace's filings never count against another's (B4 tenancy audit) */
      readonly workspaceId: string
    }
  | { readonly ok: false; readonly status: number; readonly message: string }

export async function workspaceAccess(env: NodeJS.ProcessEnv = process.env, log: (e: unknown) => void = console.error): Promise<WorkspaceAccess> {
  const data = dataDir(env)
  const identity = identityConfig(env)
  // The topology as declared, from the environment or the documented dotenv
  // file; a route reads it and never supplies it.
  const topology = readFlag(ROOT, 'COLLECTOR_TOPOLOGY', env)
  const declared = topology.value ? { ...env, COLLECTOR_TOPOLOGY: topology.value } : env
  let ledgers: LedgerStores
  try {
    ledgers = ledgerStores(data, declared)
  } catch (e) {
    log(e)
    return { ok: false, status: 503, message: NO_STORE }
  }
  if (!identity.on) {
    if (resolveTopology(declared).topology === 'fleet') return { ok: false, status: 503, message: NO_STORE }
    return { ok: true, backend: 'file', store: fileWorkspaceStore(data), ledgers, dataDir: data, who: 'local', role: 'local', workspaceId: LOCAL_WORKSPACE }
  }
  const config = identity.config
  const db = appDb(config)
  const me = await meOf({ user: () => currentUser(config), db })
  if (!me) {
    // No session, or a session with no account yet: the same two answers /api/me gives.
    const user = await currentUser(config)
    return user ? { ok: false, status: 404, message: NO_ACCOUNT } : { ok: false, status: 401, message: NOT_SIGNED_IN }
  }
  if (me.workspaces.length === 0) return { ok: false, status: 409, message: NO_WORKSPACE }
  if (me.workspaces.length > 1) return { ok: false, status: 409, message: SEVERAL_WORKSPACES }
  // The role rides in the token (B3c item 8): the database re-checks it
  // against membership on every presentation and stamps the verified role
  // into the context the definer writers read.
  const token = mintWorkspaceToken(config.key, { sub: me.account.id, workspaceId: me.workspaces[0]!.id, role: me.workspaces[0]!.role })
  return { ok: true, backend: 'postgres', store: sessionWorkspaceStore(db, token), ledgers, dataDir: data, who: me.account.id, role: me.workspaces[0]!.role, workspaceId: me.workspaces[0]!.id }
}

/**
 * WHO APPLIES A CORRECTION: an owner or admin, on the Postgres store. One
 * gate for the three correction routes rather than a line in each (B4
 * tenancy audit, MAJOR 1). This decides which PATH a POST takes — apply, or
 * file a request for an operator — and it is no longer the only check: since
 * migration 0005 the token carries the role, the verifier stamps it, and
 * ws_put_document and ws_resolve_request refuse a session that is not an
 * owner or admin, so a route that wrote a document without this gate would
 * be refused by the database rather than write as a member (B3c item 8).
 */
export const applies = (access: WorkspaceAccess & { ok: true }): boolean => access.backend === 'postgres' && (access.role === 'owner' || access.role === 'admin')

/**
 * MAY THIS SESSION WRITE A FIRST CATEGORY RECORD? On the Postgres store a
 * first record goes through ws_put_document, which since migration 0005
 * refuses a member; on a machine's file store everyone records. The preview
 * and scan routes ask this BEFORE resolving a category for a domain with no
 * record, because the resolver may author a bank (a model call, charged to
 * the author's ledger before it is made) and only then write the record —
 * a member would have paid for a record it cannot write (B3c tenancy audit,
 * MAJOR 3). Whether a member should be allowed a first record at all is the
 * human question 0005's header records; this keeps the app and the database
 * saying the same thing until it is decided.
 */
export const recordsFirst = (access: WorkspaceAccess & { ok: true }): boolean => access.backend !== 'postgres' || applies(access)
export const FIRST_RECORD_NEEDS_OPERATOR = "This domain has no category on record in this workspace yet, and recording one is an owner's or admin's act. Ask them to run its first scan. Nothing was fetched, collected or charged."

/** The message the store raises when a write names a version that is no longer the current one: the caller reads again. */
export const isStaleVersion = (e: unknown): boolean => /read it again before deciding/.test(e instanceof Error ? e.message : String(e))
export const READ_AGAIN = 'The record changed while you were deciding. Read it again and decide against what stands now.'
