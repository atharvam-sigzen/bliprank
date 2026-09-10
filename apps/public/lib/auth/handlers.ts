import type { Db } from '@bliprank/db/client'
import type { AuthUser } from './supabase'

/**
 * The identity handlers, with their dependencies passed in so a test runs
 * them against a real migrated database (`@bliprank/db/testing`) and a fake
 * session, and the route files only bind the real ones.
 *
 * Every write goes through a definer function of migration 0003; nothing here
 * touches an identity table directly, and the tenant role could not anyway.
 */
export interface Deps {
  readonly user: () => Promise<AuthUser | null>
  readonly db: Db
}

export interface Reply {
  readonly status: number
  /** serialised as JSON by the route; a fixed sentence under `message` on every non-2xx */
  readonly body: unknown
}

export type AccountKind = 'brand' | 'agency'
export const isKind = (v: unknown): v is AccountKind => v === 'brand' || v === 'agency'

export interface Me {
  readonly account: { readonly id: string; readonly email: string; readonly kind: AccountKind }
  readonly workspaces: readonly { readonly id: string; readonly name: string; readonly role: 'owner' | 'admin' | 'member' }[]
}

interface Row {
  account_id: string
  email: string
  kind: AccountKind
  workspace_id: string | null
  workspace_name: string | null
  role: 'owner' | 'admin' | 'member' | null
}

export const NOT_SIGNED_IN = 'Sign in first.'
export const NO_ACCOUNT = 'This sign-in has no account yet. Open the link in your sign-in email again.'
export const WORKSPACE_FAILED = 'The workspace could not be created because of an error on our side; the cause has been logged.'
export const BRAND_OWNS_ONE = 'A brand account has one workspace. To manage several, the account needs to be an agency.'
export const WORKSPACE_NAME = 'Give the workspace a name of 1 to 80 characters.'
// The sign-in route's sentences live here because a Next route module may export handlers and config only.
export const LINK_SENT = 'If that address can sign in, a link is on its way. It is valid for a short while and works once.'
export const BAD_REQUEST = 'Send an email address and whether the account is a brand or an agency.'
export const SEND_FAILED = 'The sign-in link could not be sent because of an error on our side; the cause has been logged.'

/** The account and workspaces behind the session, or null when no account exists yet. */
export async function meOf(deps: Deps): Promise<Me | null> {
  const user = await deps.user()
  if (!user) return null
  const rows = await deps.db.query<Row>('SELECT * FROM workspaces_of($1)', [user.id])
  const first = rows[0]
  if (!first) return null
  return {
    account: { id: first.account_id, email: first.email, kind: first.kind },
    workspaces: rows.filter((r) => r.workspace_id).map((r) => ({ id: r.workspace_id!, name: r.workspace_name!, role: r.role! })),
  }
}

export async function me(deps: Deps): Promise<Reply> {
  if (!(await deps.user())) return { status: 401, body: { message: NOT_SIGNED_IN } }
  const got = await meOf(deps)
  if (!got) return { status: 404, body: { message: NO_ACCOUNT } }
  return { status: 200, body: got }
}

/**
 * After the magic link is verified: the account for this auth user, created
 * with `kind` on first sign-in and found afterwards (the kind argument is
 * then ignored by the database, deliberately).
 */
export async function confirmAccount(deps: Deps, kind: unknown): Promise<{ readonly kind: AccountKind } | null> {
  const user = await deps.user()
  if (!user) return null
  await deps.db.query('SELECT ensure_account($1, $2, $3)', [user.id, user.email, isKind(kind) ? kind : 'brand'])
  const got = await meOf(deps)
  return got ? { kind: got.account.kind } : null
}

export async function createWorkspace(deps: Deps, name: unknown, log: (e: unknown) => void = console.error): Promise<Reply> {
  const user = await deps.user()
  if (!user) return { status: 401, body: { message: NOT_SIGNED_IN } }
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length < 1 || trimmed.length > 80) return { status: 400, body: { message: WORKSPACE_NAME } }
  try {
    const [row] = await deps.db.query<{ id: string }>('SELECT create_workspace($1, $2) AS id', [user.id, trimmed])
    return { status: 201, body: { id: row!.id, name: trimmed } }
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    if (/brand account owns one workspace/.test(text)) return { status: 409, body: { message: BRAND_OWNS_ONE } }
    if (/no account for that auth uid/.test(text)) return { status: 404, body: { message: NO_ACCOUNT } }
    log(e)
    return { status: 500, body: { message: WORKSPACE_FAILED } }
  }
}
