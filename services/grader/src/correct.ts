/**
 * `pnpm grader:correct` — the only way a recorded category changes. ADR-0016.
 *
 *   pnpm grader:correct                                        every pending request, with what applying it would do
 *   pnpm grader:correct -- --domain acme.com                   the record, its history, its pending request, the consequences
 *   pnpm grader:correct -- --domain acme.com --to erp-software --reason "sells ERP, see /pricing" --apply
 *   pnpm grader:correct -- --domain acme.com --apply           apply the pending request as filed
 *   pnpm grader:correct -- --domain acme.com --decline --note "the homepage says CRM"
 *   GRADER_DATA_DIR=<dir> pnpm grader:correct             any of the above against another store (also --data <dir>)
 *
 * ⚠️ `--apply` IS A HUMAN ACT AND THE CODE TREATS IT AS ONE. A category
 * decides which prompts are asked and which rivals the number is ranked
 * against; CLAUDE.md §4 puts that on the human side of the line. So a
 * correction is never derived here: the slug is the one on the command line
 * or in the visitor's request, checked only for being a category this build
 * can measure. Nothing fetches the homepage and nothing runs the classifier.
 *
 * ⚠️ SPENDS NOTHING, and says what WILL spend. A correction changes what the
 * next cycle measures, and the next cycle is a fresh collection: the result
 * cache keys on the recorded category, so nothing stored answers the new
 * question. The consequences line prints that cost before `--apply`, from the
 * gate's prompt count, the engine set and the provider's price for the plan
 * in the environment (pay-as-you-go when unset, the dearest).
 *
 * Reads and writes the record and request stores on disk. No provider, no
 * model, no network.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allPending, consequencesOf, pendingRequest, requestsFor, resolveRequest, type CategoryRequest } from './category-requests.js'
import { allCategories, correctCategory, readCategoryRecord, type CategoryRecord } from './resolve-category.js'

export interface CorrectOptions {
  readonly dataDir: string
  readonly domain?: string
  readonly to?: string
  readonly reason?: string
  readonly by: string
  readonly note?: string
  readonly apply: boolean
  readonly decline: boolean
}

export function parseCorrectArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CorrectOptions | { readonly refuse: string } {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(a.slice(2), v)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const apply = args.has('apply')
  const decline = args.has('decline')
  const domain = args.get('domain')
  if (apply && decline) return { refuse: '--apply and --decline are two different acts; pass one' }
  if (decline && (args.has('to') || args.has('reason'))) return { refuse: '--decline takes --note only; --to and --reason belong to a correction' }
  if ((apply || decline) && !domain) return { refuse: `--${apply ? 'apply' : 'decline'} needs --domain` }
  if (args.has('to') && !args.has('reason')) return { refuse: '--to needs --reason: a correction carries why, for whoever reads the number later' }
  return {
    // The same variable the routes read, so a scratch store needs no flag: GRADER_DATA_DIR=<dir> pnpm grader:correct
    dataDir: args.get('data') ?? env['GRADER_DATA_DIR'] ?? join(here, '..', 'data-live'),
    ...(domain ? { domain } : {}),
    ...(args.has('to') ? { to: args.get('to')! } : {}),
    ...(args.has('reason') ? { reason: args.get('reason')! } : {}),
    by: args.get('by') ?? 'operator',
    ...(args.has('note') ? { note: args.get('note')! } : {}),
    apply,
    decline,
  }
}

export { consequencesOf } from './category-requests.js'

const line = (s: string) => process.stdout.write(`${s}\n`)

function showRecord(dataDir: string, record: CategoryRecord, env: NodeJS.ProcessEnv): void {
  const names = new Map(allCategories(dataDir).map((c) => [c.slug, c.displayName]))
  line(`${record.host}`)
  line(`  recorded as ${record.slug} (${names.get(record.slug) ?? 'no bank in this build'}) · version ${record.version} · ${record.source} · decided ${record.decidedAt.slice(0, 10)}`)
  if (record.correction) line(`  corrected from ${record.correction.from} by ${record.correction.by} on ${record.correction.at.slice(0, 10)}: ${record.correction.reason}`)
  for (const s of record.superseded ?? []) line(`  earlier: version ${s.version} · ${s.slug} · ${s.source} · ${s.decidedAt.slice(0, 10)}`)
  const c = consequencesOf(dataDir, record.host, env)
  line(`  ${c.earlierCycles} stored cycle(s), each kept under its own category and left off a corrected trend`)
  line(`  the next cycle after a correction is a fresh collection: ${c.prompts} prompts × ${c.engines} engines = ${c.cells} cells, about $${c.usd.toFixed(3)} at ${c.plan} before retries`)
}

function showRequest(r: CategoryRequest): void {
  line(`  ${r.status.padEnd(8)} → ${r.slug.padEnd(28)} ${r.requestedAt.slice(0, 16)}  "${r.reason}"${r.note ? `  note: ${r.note}` : ''}`)
}

async function main(): Promise<void> {
  const parsed = parseCorrectArgs(process.argv.slice(2))
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  const o = parsed
  const env = process.env

  if (!o.domain) {
    const pending = allPending(o.dataDir)
    line(`correct · ${pending.length} pending request(s). Nothing here is applied without --domain and --apply.`)
    for (const r of pending) {
      const record = readCategoryRecord(o.dataDir, r.host)
      line('')
      if (record) showRecord(o.dataDir, record, env)
      else line(`${r.host}\n  no record any more`)
      showRequest(r)
    }
    return
  }

  const record = readCategoryRecord(o.dataDir, o.domain)
  if (!record) {
    process.stderr.write(`refusing: ${o.domain} has no category record. A first scan decides one; a correction replaces a decision, not an absence.\n`)
    process.exit(2)
  }
  showRecord(o.dataDir, record, env)
  const history = requestsFor(o.dataDir, o.domain)
  if (history.length) {
    line('  requests:')
    for (const r of history) showRequest(r)
  }
  const pending = pendingRequest(o.dataDir, o.domain)

  if (o.decline) {
    const done = resolveRequest(o.dataDir, o.domain, { status: 'declined', by: o.by, ...(pending ? { expectRequestedAt: pending.requestedAt } : {}), ...(o.note ? { note: o.note } : {}) })
    if ('refuse' in done) {
      process.stderr.write(`refusing: ${done.refuse}\n`)
      process.exit(2)
    }
    line(`  declined the request for ${done.slug}. The record is unchanged.`)
    return
  }

  // What would be applied: the command line's slug and reason, or the pending request's own.
  const to = o.to ?? pending?.slug
  const reason = o.reason ?? pending?.reason
  if (!to || !reason) {
    line(o.apply ? '  nothing to apply: no --to/--reason and no pending request' : '  DRY RUN. Pass --to <slug> --reason "…" --apply, or --apply to apply the pending request, or --decline.')
    return
  }
  line(`  would correct ${record.host}: ${record.slug} → ${to}, because "${reason}"`)
  if (!o.apply) {
    line('  DRY RUN. Nothing was written. Re-run with --apply.')
    return
  }

  const written = correctCategory(o.dataDir, { host: record.host, slug: to, reason, by: o.by })
  if ('refuse' in written) {
    process.stderr.write(`refusing: ${written.refuse}\n`)
    process.exit(2)
  }
  line(`  written: version ${written.version}, ${written.slug}, source ${written.source}. Earlier records kept: ${written.superseded?.length ?? 0}.`)
  if (pending) {
    if (pending.slug === to) {
      const marked = resolveRequest(o.dataDir, o.domain, { status: 'applied', by: o.by, expectRequestedAt: pending.requestedAt, ...(o.note ? { note: o.note } : {}) })
      line('refuse' in marked ? `  ⚠️ ${marked.refuse}. The correction is written; the request is left as it now stands.` : '  the pending request is marked applied.')
    } else {
      line(`  the pending request asked for ${pending.slug}, not ${to}; it is left pending for a separate decision.`)
    }
  }
  line('  No stored cycle changed. The next cycle collects fresh answers under the new category.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
