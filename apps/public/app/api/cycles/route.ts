import { normaliseHost } from '@bliprank/taxonomy'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listCycles } from '../../../../../services/grader/src/cycles.js'

/**
 * Every collected cycle this machine holds for one domain, oldest first.
 *
 * WHY THIS EXISTS. The browser registry and the server store are two stores,
 * and the browser's is the one that forgets: a cycle whose run finished after
 * the tab closed was filed on disk and never reached `rememberScan`, so the
 * record said "1 cycle" and the button said "already collected today", and
 * nothing a person could click reconciled the two. The same shape appeared in
 * any other browser and after cleared site data. The record now asks this
 * route once on load and remembers what the server holds that it does not.
 *
 * On the deployment (Vercel, ADR-0002 Amendment 1) this route exists and lists
 * what that deployment's store holds, which until MVP_PLAN B3 is one machine's
 * disk: a domain scanned elsewhere 404s, and the client treats that as a fact
 * about the deployment and says nothing. Reads disk only: no key, no provider,
 * no path that can collect or spend. The domain is normalised and host-shape checked
 * and never reaches a path segment unvalidated — `listCycles` builds the path
 * from a sanitised name and checks the domain inside every file it lists.
 */

export const dynamic = 'force-dynamic'
// A directory listing; the plan default (300s) is a runaway ceiling, not a need.
export const maxDuration = 30

const resolveRoot = (): string => {
  let curr = process.cwd()
  while (curr && curr !== dirname(curr)) {
    if (existsSync(join(curr, 'services', 'grader'))) return curr
    curr = dirname(curr)
  }
  return join(process.cwd(), '..', '..')
}
const dataDir = (env: NodeJS.ProcessEnv): string => env['GRADER_DATA_DIR'] || join(resolveRoot(), 'services', 'grader', 'data-live')


export async function GET(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain) return json({ message: 'Pass ?domain=example.com' }, 400)

  const cycles = listCycles(dataDir(process.env), domain)
  if (cycles.length === 0) return json({ message: `this machine holds no cycle of ${domain}` }, 404)
  return json({ domain, cycles: cycles.map((c) => c.result) })
}
