import { normaliseHost } from '@bliprank/taxonomy'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readScanAnswers } from '../../../../../services/grader/src/answers.js'

/**
 * THE EVIDENCE, SERVED BACK — the answers behind one scan's numbers.
 *
 * ⚠️ IT SPENDS NOTHING AND CAN COLLECT NOTHING. It reads the blob store off
 * disk for a domain this machine has already scanned. There is no adapter, no
 * provider key, no budget and no code path from here to OpenWeb Ninja, so R3
 * does not govern it and neither `COLLECTION_ENABLED` nor `GRADER_LIVE_SCAN`
 * gates it. It cannot cause a charge.
 *
 * ⚠️ AND IT IS NOT AN OPEN READER OF THE FILESYSTEM. The only thing a caller
 * supplies is a domain, and a domain is only answerable if this machine holds a
 * finished result for it — `readScanAnswers` refuses on a missing result file, a
 * missing category record, or a day it cannot establish. The path is built from
 * the recorded category's own bank and the cache keys that follow from it, never
 * from anything in the request, so there is no traversal to attempt. The domain
 * is still normalised to the same shape every other route uses, because a
 * defence that depends on a downstream function is a defence somebody can move.
 *
 * ⚠️ NO RATE LIMIT, DELIBERATELY, AND HERE IS THE REASONING. `/api/preview` has
 * one because it makes an OUTBOUND fetch to a caller-named host, which is an
 * amplifier. This makes none: worst case it reads a few hundred kilobytes of
 * local JSON for a domain already on disk. The visitor throttle exists to
 * protect provider quota and there is no quota here to protect. If this ever
 * grows a path that leaves the machine, that reasoning expires with it.
 *
 * ON THE DEPLOYMENT (Vercel, ADR-0002 Amendment 1) this route exists and reads
 * the store that deployment holds. Until MVP_PLAN B3 moves the store off one
 * machine's disk, a domain scanned elsewhere is a 404 here, and `loadAnswers`
 * reports that as a fact about the deployment rather than about the scan.
 */

export const dynamic = 'force-dynamic'
// One JSON read; the plan default (300s) is a runaway ceiling, not a need.
export const maxDuration = 30

const resolveRoot = (): string => {
  let curr = process.cwd()
  while (curr && curr !== dirname(curr)) {
    if (existsSync(join(curr, 'services', 'grader'))) return curr
    curr = dirname(curr)
  }
  return join(process.cwd(), '..', '..')
}
// Per request, like every other route, so a test or a deployment can point it
// at another directory through `GRADER_DATA_DIR`; this was the one route that
// ignored the variable.
const dataDir = (env: NodeJS.ProcessEnv): string => env['GRADER_DATA_DIR'] || join(resolveRoot(), 'services', 'grader', 'data-live')

/** The same normalisation /api/scan and /api/preview apply, so one typed domain resolves once. */

export async function GET(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  const domain = normaliseHost(new URL(req.url).searchParams.get('domain') ?? '')
  // Host shape, checked here rather than inferred downstream. Nothing else in
  // the request reaches a path.
  if (!domain) return json({ message: 'Pass ?domain=example.com' }, 400)

  // A specific cycle, when the client names one. Day-shaped or nothing: the
  // value reaches a file name inside `readCycle`, which refuses anything else.
  const dayParam = new URL(req.url).searchParams.get('day') ?? ''
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : undefined
  const got = await readScanAnswers(dataDir(process.env), domain, day)
  if ('refuse' in got) {
    // 404 rather than 500: "this machine holds no evidence for that domain" is
    // an absence, and the client renders an absence differently from a fault.
    return json({ message: got.refuse }, 404)
  }
  return json(got)
}
