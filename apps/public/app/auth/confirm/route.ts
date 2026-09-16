import { NextResponse } from 'next/server'
import { identityConfig } from '@/lib/auth/config'
import { appDb } from '@/lib/auth/db'
import { confirmAccount } from '@/lib/auth/handlers'
import { currentUser, serverSupabase } from '@/lib/auth/supabase'

/**
 * Where the magic link lands. Supabase's email template must send the reader
 * here with `token_hash` and `type=email` (its SSR documentation's confirm
 * pattern; the default template sends a browser-only `access_token` fragment
 * that a server never sees — a deploy prerequisite recorded in CLAUDE.md §7).
 *
 * Verifies the hash with the Supabase server, which sets the session
 * cookies; ensures the account row (migration 0003) with the kind the
 * sign-in form chose; then sends the person to their account page. Every
 * failure is a redirect to the sign-in page with a reason code, never a
 * blank error.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const identity = identityConfig(process.env)
  // Redirects are built on the configured origin, never on the request's
  // host header (2026-09-10 tenancy audit, MEDIUM-2). With identity off there
  // is no configured origin, and a relative redirect is the safe form.
  const back = (reason: string) => NextResponse.redirect(new URL(`/sign-in?error=${reason}`, identity.on ? identity.config.siteUrl : url.origin))
  if (!identity.on) return back('off')

  const tokenHash = url.searchParams.get('token_hash') ?? ''
  const type = url.searchParams.get('type') ?? ''
  if (!tokenHash || (type !== 'email' && type !== 'magiclink')) return back('link')

  const supabase = await serverSupabase(identity.config)
  const { error } = await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash })
  if (error) {
    console.error('[auth] verifyOtp failed:', error.message)
    return back('link')
  }

  const got = await confirmAccount({ user: () => currentUser(identity.config), db: appDb(identity.config) }, url.searchParams.get('kind'))
  if (!got) return back('account')
  if ('refuse' in got) return back('email')
  return NextResponse.redirect(new URL('/account', identity.config.siteUrl))
}
