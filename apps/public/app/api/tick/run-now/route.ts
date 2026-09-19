import { runLocalTick } from '@/lib/local-tick'

/**
 * POST /api/tick/run-now — "Run today's checks now" (MVP_PLAN P1).
 *
 * THE MACHINE'S OWN ENTRY, AND ONLY THE MACHINE'S. The signed route beside
 * this one (`/api/tick`) is a deployment's transport: it verifies a QStash
 * signature before it reads anything (ADR-0018), and it is not touched. This
 * one is unsigned because on the owner's machine, with identity off, there is
 * nobody to sign; so it EXISTS only there. With identity on, on a fleet, or on
 * any runtime that is not a declared single process it answers 404, the
 * answer a path that is not there gives.
 *
 * It runs `runLocalTick`, which is `runTick`: the same tick path, the same
 * daily cap, the same gates, in the same order as the operator's command.
 * With the cap, the live flag or a tracked domain absent it answers 409 with
 * one fixed sentence, and nothing has been asked of anyone.
 *
 * ⚠️ A BROWSER ON THIS MACHINE CAN BE MADE TO POST HERE BY ANOTHER SITE. The
 * server answers this machine only (`-H 127.0.0.1`, C3r item 14), which stops
 * another machine and does not stop a page open in the owner's own browser.
 * So a request that says it comes from another origin is refused before
 * anything is read. What a forged press could cause is bounded either way
 * (today's checks, once, under the day's cap); it is refused because starting
 * a spend is the owner's act.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

/** Same-origin, by the two headers a browser sets and a page cannot forge. A client that sends neither (curl on this machine) is the operator. */
function crossSite(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.get('origin')
  if (origin === null) return false
  try {
    return new URL(origin).host !== new URL(req.url).host
  } catch {
    return true
  }
}

export async function POST(req: Request): Promise<Response> {
  if (crossSite(req)) return json({ kind: 'origin', message: 'Daily checks are started from this app only.' }, 403)
  const result = await runLocalTick('button')
  if (!result.ok) return json({ kind: result.kind, message: result.message }, result.status)
  return json({ report: result.report })
}
