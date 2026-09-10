import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { identityConfig } from '@/lib/auth/config'

/**
 * SESSION REFRESH, ONCE PER NAVIGATION, BEFORE ANY ROUTE RUNS.
 *
 * `@supabase/ssr`'s design notes call the middleware mandatory: server
 * components cannot set cookies, so an expired access token would never be
 * refreshed if this did not run first. It does one thing — asks Supabase for
 * the user, which refreshes the token when needed and writes the new cookies
 * onto the response — and it protects nothing: which pages need a session is
 * each page's own decision (an unauthenticated /account redirects to sign-in;
 * the Grader never asks).
 *
 * With identity off (no configuration) every request passes through
 * untouched, so the reference deployment and the local demo are unchanged.
 *
 * No database import here: this runs on the edge runtime, and the Postgres
 * driver is Node-only. Identity for a request is established in the routes.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const identity = identityConfig(process.env)
  if (!identity.on) return NextResponse.next({ request })

  let response = NextResponse.next({ request })
  const supabase = createServerClient(identity.config.supabaseUrl, identity.config.supabaseKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of list) response.cookies.set(name, value, options)
      },
    },
  })
  await supabase.auth.getUser()
  return response
}

export const config = {
  // Everything but Next's own assets and the files under public/.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|json|txt|xml)$).*)'],
}
