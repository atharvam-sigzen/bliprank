import { dailyChecksStatus } from '@/lib/daily-checks-status'

/**
 * GET /api/tick/status — what the daily checks did, for the panel on the
 * record (MVP_PLAN P2). Reads the machine's own store: today's and
 * yesterday's outcome per tracked domain, whether a run could start now, and
 * whether this morning's scheduled run was missed. It starts nothing and
 * spends nothing. Off the owner's machine (identity on, a fleet) it answers
 * 404, as the button's route does: there is no local loop there to report on.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(): Promise<Response> {
  const status = await dailyChecksStatus()
  if (!status.local) return new Response(JSON.stringify({ kind: 'not-local', message: 'There is no local daily loop on this deployment.' }), { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  return new Response(JSON.stringify(status), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
