import { IDENTITY_OFF, identityConfig } from '@/lib/auth/config'
import { appDb } from '@/lib/auth/db'
import { me } from '@/lib/auth/handlers'
import { currentUser } from '@/lib/auth/supabase'

/** The signed-in account and its workspaces (migration 0003, `workspaces_of`). */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function GET(): Promise<Response> {
  const identity = identityConfig(process.env)
  if (!identity.on) return json({ message: IDENTITY_OFF }, 503)
  const r = await me({ user: () => currentUser(identity.config), db: appDb(identity.config) })
  return json(r.body, r.status)
}
