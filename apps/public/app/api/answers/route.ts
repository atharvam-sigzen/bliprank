import { normaliseHost } from '@bliprank/taxonomy'
import { readScanAnswers } from '../../../../../services/grader/src/answers.js'
import { workspaceAccess } from '@/lib/workspace-access'

/**
 * THE EVIDENCE, SERVED BACK — the answers behind one scan's numbers.
 *
 * ⚠️ IT SPENDS NOTHING AND CAN COLLECT NOTHING. It reads the answer store (R2
 * on the deployment, this machine's disk otherwise) for a domain the
 * workspace has already scanned. There is no adapter, no provider key, no
 * budget and no code path from here to OpenWeb Ninja, so R3 does not govern
 * it and neither `COLLECTION_ENABLED` nor `GRADER_LIVE_SCAN` gates it. It
 * cannot cause a charge.
 *
 * ⚠️ AND IT IS NOT AN OPEN READER OF THE FILESYSTEM. The only thing a caller
 * supplies is a domain, and a domain is only answerable if the workspace holds
 * a finished result for it — `readScanAnswers` refuses on a missing cycle, a
 * missing category record, or a day it cannot establish. The path is built from
 * the recorded category's own bank and the cache keys that follow from it, never
 * from anything in the request, so there is no traversal to attempt. The domain
 * is still normalised to the same shape every other route uses, because a
 * defence that depends on a downstream function is a defence somebody can move.
 *
 * ⚠️ NO RATE LIMIT, DELIBERATELY, AND HERE IS THE REASONING. `/api/preview` has
 * one because it makes an OUTBOUND fetch to a caller-named host, which is an
 * amplifier. This makes none: worst case it reads a few hundred kilobytes of
 * stored JSON for a domain already scanned. The visitor throttle exists to
 * protect provider quota and there is no quota here to protect. If this ever
 * grows a path that leaves the machine, that reasoning expires with it.
 *
 * THE WORKSPACE IS THE SESSION'S (MVP_PLAN B3b): the cycle, the record and the
 * override version it names are read from the store the session's token
 * scopes; nothing in the request names a workspace.
 */

export const dynamic = 'force-dynamic'
// One stored-cycle read plus the cell objects; the plan default (300s) is a runaway ceiling, not a need.
export const maxDuration = 30

export async function GET(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  // Host shape, checked here rather than inferred downstream. Nothing else in
  // the request reaches a path.
  if (!domain) return json({ message: 'Pass ?domain=example.com' }, 400)

  // A specific cycle, when the client names one. Day-shaped or nothing: the
  // value reaches the store's day key, which refuses anything else.
  const dayParam = new URL(req.url).searchParams.get('day') ?? ''
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : undefined

  const access = await workspaceAccess(process.env)
  if (!access.ok) return json({ message: access.message }, access.status)

  const got = await readScanAnswers(access.dataDir, domain, day, access.store)
  if ('refuse' in got) {
    // 404 rather than 500: "this workspace holds no evidence for that domain" is
    // an absence, and the client renders an absence differently from a fault.
    return json({ message: got.refuse }, 404)
  }
  return json(got)
}
