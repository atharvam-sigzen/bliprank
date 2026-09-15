import { handleTick } from '@/lib/tick'

/**
 * The daily tick, as QStash calls it (ADR-0018). Two signed bodies: the
 * scheduled fan-out, which decides the day and publishes one domain job per
 * due domain, and a domain job, which runs one host's cycle through the
 * loop's per-domain path. Every decision is in lib/tick.ts and
 * services/grader/src/daily-loop.ts; this file is the transport.
 *
 * ⚠️ VERIFIED FIRST. Nothing is read from the body until the `Upstash-Signature`
 * JWT verifies against this route's own URL and the deployment's signing keys.
 * A request that does not verify is 401 and touches nothing.
 *
 * ⚠️ DEPLOYED AS A FUNCTION (Vercel, ADR-0002 Amendment 1). `maxDuration` is
 * 300 s — the Hobby maximum and the Pro default, so no dashboard change on
 * either plan — because a domain job is one cycle, the same work the scan
 * route streams inside 300 s; the fan-out publishes in seconds. QStash waits
 * the same 300 s (`Upstash-Timeout`, set at registration) and counts a longer
 * job failed; the job's ledger line is what its retry then meets.
 *
 * ⚠️ NOT ARMED BY DEFAULT. With `GRADER_DAILY_LOOP` unset every verified job
 * is answered 200 "not armed" and nothing runs; the owner arms the deployment
 * by setting it, after registering the schedule with `pnpm grader:schedule`.
 * Two acts (ADR-0018 D8).
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: Request): Promise<Response> {
  const reply = await handleTick(req)
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
