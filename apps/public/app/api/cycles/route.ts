import { normaliseHost } from '@bliprank/taxonomy'
import { workspaceAccess } from '@/lib/workspace-access'

/**
 * Every collected cycle the workspace holds for one domain, oldest first.
 *
 * WHY THIS EXISTS. The browser registry and the server store are two stores,
 * and the browser's is the one that forgets: a cycle whose run finished after
 * the tab closed was filed and never reached `rememberScan`, so the record
 * said "1 cycle" and the button said "already collected today", and nothing a
 * person could click reconciled the two. The same shape appeared in any other
 * browser and after cleared site data. The record now asks this route once on
 * load and remembers what the server holds that it does not.
 *
 * THE WORKSPACE IS THE SESSION'S (MVP_PLAN B3b). On the deployment the store
 * is Postgres, scoped by the token minted for the signed-in account's
 * workspace; nothing in the request names a workspace. On a machine with
 * identity off it is that machine's files. Reads only: no key, no provider,
 * no path that can collect or spend. The domain is normalised and host-shape
 * checked; the file store builds its path from a sanitised name and checks
 * the domain inside every file it lists.
 */

export const dynamic = 'force-dynamic'
// A listing; the plan default (300s) is a runaway ceiling, not a need.
export const maxDuration = 30

export async function GET(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain) return json({ message: 'Pass ?domain=example.com' }, 400)

  const access = await workspaceAccess(process.env)
  if (!access.ok) return json({ message: access.message }, access.status)

  const cycles = await access.store.cycles.list(domain)
  if (cycles.length === 0) return json({ message: `this workspace holds no cycle of ${domain}` }, 404)
  return json({ domain, cycles: cycles.map((c) => c.result) })
}
