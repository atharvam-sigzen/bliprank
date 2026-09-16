import type { SigningKey } from '@bliprank/db/token'

/**
 * IDENTITY IS CONFIGURED OR IT IS OFF, and off is quiet.
 *
 * Every variable below is read at request time from the process environment.
 * With none of them set — a local demo, a test, the reference deployment
 * before B3 — identity is off: the sign-in routes answer 503 with a fixed
 * sentence, the middleware passes every request through, and nothing else in
 * the app changes. With some set, identity is still off, and the route says
 * which names are missing (names only, never values) so a half-configured
 * deployment fails loudly rather than half-working.
 *
 * `DATABASE_URL` is the tenant login role's DSN — a member of `app_rw` and of
 * nothing else (migration 0000, `assert_role_exclusivity`). The web tier holds
 * no other database credential: onboarding goes through the three definer
 * functions of migration 0003.
 */
export interface IdentityConfig {
  readonly supabaseUrl: string
  readonly supabaseKey: string
  readonly databaseUrl: string
  readonly key: SigningKey
  /** the deployment's own origin, e.g. https://bliprank.com; every redirect and the magic link's return URL are built on it, never on a request header */
  readonly siteUrl: string
}

export type Identity = { readonly on: true; readonly config: IdentityConfig } | { readonly on: false; readonly missing: readonly string[] }

export const IDENTITY_ENV = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DATABASE_URL', 'AUTH_SIGNING_KID', 'AUTH_SIGNING_SECRET', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'SITE_URL'] as const

export function identityConfig(env: NodeJS.ProcessEnv = process.env): Identity {
  const missing = IDENTITY_ENV.filter((k) => !env[k])
  if (missing.length > 0) return { on: false, missing }
  // The origin only: a path or query here would smuggle itself into every
  // redirect. A value that is not an absolute http(s) URL keeps identity off.
  let siteUrl: string
  try {
    const u = new URL(env['SITE_URL']!)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme')
    siteUrl = u.origin
  } catch {
    return { on: false, missing: ['SITE_URL (not an absolute http(s) URL)'] }
  }
  return {
    on: true,
    config: {
      supabaseUrl: env['SUPABASE_URL']!,
      supabaseKey: env['SUPABASE_PUBLISHABLE_KEY']!,
      databaseUrl: env['DATABASE_URL']!,
      key: { kid: env['AUTH_SIGNING_KID']!, secret: env['AUTH_SIGNING_SECRET']!, issuer: env['AUTH_ISSUER']!, audience: env['AUTH_AUDIENCE']! },
      siteUrl,
    },
  }
}

/** What a visitor is told when identity is off. The missing names go to the server log only. */
export const IDENTITY_OFF = 'Sign-in is not configured on this deployment.'
