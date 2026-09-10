import { IDENTITY_OFF, identityConfig } from '@/lib/auth/config'
import { BAD_REQUEST, LINK_SENT, SEND_FAILED, isKind } from '@/lib/auth/handlers'
import { serverSupabase } from '@/lib/auth/supabase'

/**
 * Sends the magic link. POST `{ email, kind }`; `kind` (brand | agency) is
 * carried in the confirm URL and read once, at account creation (migration
 * 0003: a later sign-in cannot relabel the account).
 *
 * WHAT BOUNDS IT. An email send per call is an amplifier. Supabase enforces
 * its own per-address and per-hour limits on magic links, and that is the
 * bound this build relies on. ponytail: the per-visitor throttle the grader
 * routes use writes a ledger file, which the Vercel function cannot; it
 * joins this route when B3 gives the throttle a store.
 *
 * The visitor is told the link was sent whether or not the address is known:
 * Supabase does not reveal that either, and the difference would be an
 * address oracle.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function POST(req: Request): Promise<Response> {
  const identity = identityConfig(process.env)
  if (!identity.on) {
    console.error(`[auth] sign-in refused: identity is off (missing ${identity.missing.join(', ')})`)
    return json({ message: IDENTITY_OFF }, 503)
  }
  let body: { email?: unknown; kind?: unknown }
  try {
    body = (await req.json()) as { email?: unknown; kind?: unknown }
  } catch {
    return json({ message: BAD_REQUEST }, 400)
  }
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !isKind(body.kind)) return json({ message: BAD_REQUEST }, 400)

  // The return URL is the configured origin, never the request's host header:
  // a header-derived origin would mail the confirm token to whichever host the
  // request named (2026-09-10 tenancy audit, MEDIUM-2).
  const supabase = await serverSupabase(identity.config)
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${identity.config.siteUrl}/auth/confirm?kind=${body.kind}` },
  })
  if (error) {
    console.error('[auth] signInWithOtp failed:', error.message)
    return json({ message: SEND_FAILED }, 502)
  }
  return json({ message: LINK_SENT })
}
