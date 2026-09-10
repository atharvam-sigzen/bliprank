import { createHmac } from 'node:crypto'

/**
 * The workspace token the web tier presents to `set_workspace_jwt()`
 * (migrations 0001/0002): HS256, one key id, issuer and audience bound to the
 * key, `sub` = the account, `workspace_id` = the workspace. The database
 * verifies it and refuses a workspace the subject is not a member of, so the
 * only fact this function asserts is WHO — and the server asserts it after
 * verifying the person's Supabase session.
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

export interface WorkspaceClaims {
  /** the account id (`accounts.id`), not the auth uid */
  readonly sub: string
  readonly workspaceId: string
  /** seconds; must stay under the key's `max_lifetime_s` (43200 by default) */
  readonly ttlSec?: number
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function mintWorkspaceToken(key: SigningKey, claims: WorkspaceClaims, now: () => number = Date.now): string {
  const ttl = claims.ttlSec ?? 3600
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error(`mintWorkspaceToken: ttlSec must be a positive integer, got ${String(claims.ttlSec)}`)
  const head = b64url({ alg: 'HS256', typ: 'JWT', kid: key.kid })
  const body = b64url({
    sub: claims.sub,
    workspace_id: claims.workspaceId,
    iss: key.issuer,
    aud: key.audience,
    exp: Math.floor(now() / 1000) + ttl,
  })
  const sig = createHmac('sha256', key.secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
