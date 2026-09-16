import { createHmac } from 'node:crypto'

/**
 * The workspace token the web tier presents to `set_workspace_jwt()`
 * (migrations 0001/0002/0005): HS256, one key id, issuer and audience bound
 * to the key, `sub` = the account, `workspace_id` = the workspace, `role` =
 * the account's role in it. The database verifies it and refuses a
 * workspace the subject is not a member of, and a role the membership does
 * not hold, so the facts this function asserts are WHO and AS WHAT — and
 * the server asserts both after verifying the person's Supabase session and
 * reading `workspaces_of` (MVP_PLAN B3c item 8).
 *
 * Pure: no clock of its own beyond `now`, no I/O. The secret never leaves
 * this process; the database holds its copy in `auth_signing_keys`.
 */
export interface SigningKey {
  readonly kid: string
  readonly secret: string
  readonly issuer: string
  readonly audience: string
}

/** The roles migration 0000 admits on `workspace_members`. */
export type WorkspaceRole = 'owner' | 'admin' | 'member'
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member']

export interface WorkspaceClaims {
  /** the account id (`accounts.id`), not the auth uid */
  readonly sub: string
  readonly workspaceId: string
  /** the account's role in that workspace, as `workspaces_of` reported it; the database checks it against membership on every presentation */
  readonly role: WorkspaceRole
  /** seconds; must stay under the key's `max_lifetime_s` (43200 by default) */
  readonly ttlSec?: number
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function mintWorkspaceToken(key: SigningKey, claims: WorkspaceClaims, now: () => number = Date.now): string {
  const ttl = claims.ttlSec ?? 3600
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error(`mintWorkspaceToken: ttlSec must be a positive integer, got ${String(claims.ttlSec)}`)
  // Refused here as well as in the database: a token that could not verify
  // is not worth signing, and the error names the call site rather than a
  // failed transaction later.
  if (!WORKSPACE_ROLES.includes(claims.role)) throw new Error(`mintWorkspaceToken: role must be one of ${WORKSPACE_ROLES.join(', ')}, got ${JSON.stringify(claims.role)}`)
  const head = b64url({ alg: 'HS256', typ: 'JWT', kid: key.kid })
  const body = b64url({
    sub: claims.sub,
    workspace_id: claims.workspaceId,
    role: claims.role,
    iss: key.issuer,
    aud: key.audience,
    exp: Math.floor(now() / 1000) + ttl,
  })
  const sig = createHmac('sha256', key.secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
