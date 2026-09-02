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
 * ⚠️ LOCAL DEMO ONLY, like /api/scan and /api/answers. ADR-0002 puts this app
 * on Cloudflare Pages as static assets; there this route does not exist, the
 * client's request 404s, and the client treats that as a fact about the
 * deployment and says nothing. Reads disk only: no key, no provider, no path
 * that can collect or spend. The domain is normalised and host-shape checked
 * and never reaches a path segment unvalidated — `listCycles` builds the path
 * from a sanitised name and checks the domain inside every file it lists.
 */

export const dynamic = 'force-dynamic'

const resolveRoot = (): string => {
  let curr = process.cwd()
  while (curr && curr !== dirname(curr)) {
    if (existsSync(join(curr, 'services', 'grader'))) return curr
    curr = dirname(curr)
  }
  return join(process.cwd(), '..', '..')
}
const dataDir = (env: NodeJS.ProcessEnv): string => env['GRADER_DATA_DIR'] || join(resolveRoot(), 'services', 'grader', 'data-live')

const normalise = (d: string): string =>
  d.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '')

export async function GET(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const domain = normalise(new URL(req.url).searchParams.get('domain') ?? '')
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return json({ message: 'Pass ?domain=example.com' }, 400)

  const cycles = listCycles(dataDir(process.env), domain)
  if (cycles.length === 0) return json({ message: `this machine holds no cycle of ${domain}` }, 404)
  return json({ domain, cycles: cycles.map((c) => c.result) })
}
