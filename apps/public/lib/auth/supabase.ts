import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { IdentityConfig } from './config'

/**
 * The server-side Supabase client over Next's cookie store, in the shape
 * `@supabase/ssr` documents: `getAll` reads every cookie, `setAll` writes the
 * ones a session change produced. `setAll` throws from a Server Component
 * (cookies are read-only there) and that is fine — the middleware refreshed
 * the session already, which is why the middleware is mandatory in this
 * design (@supabase/ssr design notes: "session refresh happens in the
 * middleware").
 */
export async function serverSupabase(config: IdentityConfig) {
  const store = await cookies()
  return createServerClient(config.supabaseUrl, config.supabaseKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options)
        } catch {
          // A Server Component cannot set cookies; the middleware did.
        }
      },
    },
  })
}

export interface AuthUser {
  /** the Supabase Auth user id: the `auth_uid` of migration 0003 */
  readonly id: string
  readonly email: string
}

/** The signed-in person, verified with the Supabase server, or null. */
export async function currentUser(config: IdentityConfig): Promise<AuthUser | null> {
  const supabase = await serverSupabase(config)
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user || !data.user.email) return null
  return { id: data.user.id, email: data.user.email }
}
