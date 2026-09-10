import { IDENTITY_OFF, identityConfig } from '@/lib/auth/config'
import { appDb } from '@/lib/auth/db'
import { createWorkspace } from '@/lib/auth/handlers'
import { currentUser } from '@/lib/auth/supabase'

/**
 * POST `{ name }`: a workspace owned by the signed-in account, through
 * migration 0003's `create_workspace`. A brand account's second is a 409
 * with a sentence; the rule is the database's trigger, not this route's.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function POST(req: Request): Promise<Response> {
  const identity = identityConfig(process.env)
  if (!identity.on) return json({ message: IDENTITY_OFF }, 503)
  let name: unknown
  try {
    name = ((await req.json()) as { name?: unknown }).name
  } catch {
    name = ''
  }
  const r = await createWorkspace({ user: () => currentUser(identity.config), db: appDb(identity.config) }, name)
  return json(r.body, r.status)
}
