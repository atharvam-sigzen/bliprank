/**
 * `pnpm grader:competitors` — the only way a domain's competitor set is
 * adjusted. ADR-0016, decision 3.
 *
 *   pnpm grader:competitors                                          every pending request, with the set it would produce
 *   pnpm grader:competitors -- --domain acme.com                     the set in force, the override history, the pending request
 *   pnpm grader:competitors -- --domain acme.com --exclude zoho-crm --include freshsales --reason "Zoho is our integration partner" --apply
 *   pnpm grader:competitors -- --domain acme.com --apply             apply the pending request as filed
 *   pnpm grader:competitors -- --domain acme.com --decline --note "Zoho competes on the same deals"
 *   GRADER_DATA_DIR=<dir> pnpm grader:competitors                    any of the above against another store (also --data <dir>)
 *   --by <name>                                                      who applied it; 'operator' when absent
 *   --includable                                                     list every includable id, grouped by bank, instead of the count
 *
 * ⚠️ `--apply` IS A HUMAN ACT. The competitor set decides `position`, which
 * decides the score; CLAUDE.md §4 puts it on the human side of the line. An
 * include is accepted only from the reviewed sources (a leader of any bank
 * this build holds) and never from free text. An exclude is always accepted.
 * `--exclude` and `--include` are the WHOLE override, not a delta: what is
 * passed is what stands afterwards.
 *
 * ⚠️ IT MOVES THE BASIS. From the first override on, every measurement of the
 * domain carries `set=<version>`; the next cycle is not comparable with the
 * last and the record says why. This command says so before writing. Spends
 * nothing: the next cycle costs what it always cost.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allPendingCompetitorRequests, applyOverride, competitorRequestsFor, competitorsFor, pendingCompetitorRequest, readOverride, resolveCompetitorRequest, reviewedLeaders, type CompetitorRequest } from './competitor-overrides.js'
import { allBanks, readCategoryRecord } from './resolve-category.js'
import { subjectFor } from './scan.js'

export interface CompetitorsOptions {
  readonly dataDir: string
  readonly domain?: string
  readonly exclude?: readonly string[]
  readonly include?: readonly string[]
  readonly reason?: string
  readonly by: string
  readonly note?: string
  readonly apply: boolean
  readonly decline: boolean
  /** Print every includable id, grouped by bank, instead of the count. */
  readonly includable: boolean
}

const list = (v: string | undefined): string[] => (v === undefined || v === 'true' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean))

export function parseCompetitorsArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CompetitorsOptions | { readonly refuse: string } {
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
  const change = args.has('exclude') || args.has('include')
  if (apply && decline) return { refuse: '--apply and --decline are two different acts; pass one' }
  if ((apply || decline) && !domain) return { refuse: `--${apply ? 'apply' : 'decline'} needs --domain` }
  if (change && !args.has('reason')) return { refuse: '--exclude/--include need --reason: an override carries why, for whoever reads the number later' }
  if (decline && (change || args.has('reason'))) return { refuse: '--decline takes --note only; --exclude, --include and --reason belong to an override' }
  return {
    dataDir: args.get('data') ?? env['GRADER_DATA_DIR'] ?? join(here, '..', 'data-live'),
    ...(domain ? { domain } : {}),
    ...(args.has('exclude') ? { exclude: list(args.get('exclude')) } : {}),
    ...(args.has('include') ? { include: list(args.get('include')) } : {}),
    ...(args.has('reason') ? { reason: args.get('reason')! } : {}),
    by: args.get('by') ?? 'operator',
    ...(args.has('note') ? { note: args.get('note')! } : {}),
    apply,
    decline,
    includable: args.has('includable'),
  }
}

const line = (s: string) => process.stdout.write(`${s}\n`)

function showSet(dataDir: string, domain: string, listIncludable = false): { readonly ok: true; readonly subjectId: string } | { readonly ok: false } {
  const record = readCategoryRecord(dataDir, domain)
  if (!record) {
    line(`${domain}\n  no category record, so no competitor set to adjust. A first scan decides one.`)
    return { ok: false }
  }
  const bank = allBanks(dataDir).find((b) => b.category === record.slug)
  if (!bank) {
    line(`${domain}\n  no bank for ${record.slug} in this build`)
    return { ok: false }
  }
  const subjectId = subjectFor(domain, bank, record.brandName).spec.id
  const now = competitorsFor(dataDir, domain, bank, subjectId)!
  const override = readOverride(dataDir, domain)
  line(`${domain}`)
  line(`  category ${record.slug} (bank version ${bank.version}) · competitor set ${override ? `override version ${override.version}` : 'the category\'s own, no override'}`)
  line(`  measured against: ${now.competitors.length ? now.competitors.map((c) => `${c.name} [${c.id}]`).join(', ') : 'nobody (no competitor set)'}`)
  if (override) {
    line(`  excluded: ${override.exclude.join(', ') || 'none'} · included: ${override.include.join(', ') || 'none'}`)
    line(`  set ${override.version} by ${override.by} on ${override.at.slice(0, 10)}: ${override.reason}`)
    for (const s of override.superseded ?? []) line(`  earlier: set ${s.version} · excluded ${s.exclude.join(', ') || 'none'} · included ${s.include.join(', ') || 'none'} · ${s.at.slice(0, 10)}`)
  }
  const reviewed = [...reviewedLeaders(dataDir).values()].filter((l) => l.id !== subjectId && !now.competitors.some((c) => c.id === l.id))
  // A hundred-odd ids is a wall, not a list. The count by default; --includable prints them, grouped by bank.
  if (listIncludable) {
    const byBank = new Map<string, string[]>()
    for (const l of reviewed) byBank.set(l.bank, [...(byBank.get(l.bank) ?? []), l.id])
    line(`  includable (reviewed, not in the set): ${reviewed.length}`)
    for (const [bank, list] of [...byBank.entries()].sort()) line(`    ${bank}: ${list.join(', ')}`)
  } else line(`  includable (reviewed, not in the set): ${reviewed.length} ids across ${new Set(reviewed.map((l) => l.bank)).size} banks; pass --includable to list them`)
  return { ok: true, subjectId }
}

function showRequest(r: CompetitorRequest): void {
  line(`  ${r.status.padEnd(8)} exclude [${r.exclude.join(', ')}] include [${r.include.join(', ')}]  ${r.requestedAt.slice(0, 16)}  "${r.reason}"${r.note ? `  note: ${r.note}` : ''}`)
}

async function main(): Promise<void> {
  const parsed = parseCompetitorsArgs(process.argv.slice(2))
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  const o = parsed

  if (!o.domain) {
    const pending = allPendingCompetitorRequests(o.dataDir)
    line(`competitors · ${pending.length} pending request(s). Nothing here is applied without --domain and --apply.`)
    for (const r of pending) {
      line('')
      showSet(o.dataDir, r.host)
      showRequest(r)
    }
    return
  }

  const shown = showSet(o.dataDir, o.domain, o.includable)
  if (!shown.ok) process.exit(2)
  const history = competitorRequestsFor(o.dataDir, o.domain)
  if (history.length) {
    line('  requests:')
    for (const r of history) showRequest(r)
  }
  const pending = pendingCompetitorRequest(o.dataDir, o.domain)

  if (o.decline) {
    const done = resolveCompetitorRequest(o.dataDir, o.domain, { status: 'declined', by: o.by, ...(pending ? { expectRequestedAt: pending.requestedAt } : {}), ...(o.note ? { note: o.note } : {}) })
    if ('refuse' in done) {
      process.stderr.write(`refusing: ${done.refuse}\n`)
      process.exit(2)
    }
    line('  declined the request. The competitor set is unchanged.')
    return
  }

  const fromArgs = o.exclude !== undefined || o.include !== undefined
  const exclude = fromArgs ? (o.exclude ?? []) : pending?.exclude
  const include = fromArgs ? (o.include ?? []) : pending?.include
  const reason = o.reason ?? pending?.reason
  if (exclude === undefined || include === undefined || !reason) {
    line(o.apply ? '  nothing to apply: no --exclude/--include with --reason, and no pending request' : '  DRY RUN. Pass --exclude/--include with --reason and --apply, or --apply to apply the pending request, or --decline.')
    return
  }
  line(`  would set ${o.domain}'s override to: exclude [${exclude.join(', ')}] include [${include.join(', ')}], because "${reason}"`)
  line('  the basis moves: the next cycle carries set=<new version> and is not comparable with the last; the record says why. Cost is unchanged.')
  if (!o.apply) {
    line('  DRY RUN. Nothing was written. Re-run with --apply.')
    return
  }
  const written = applyOverride(o.dataDir, { host: o.domain, exclude, include, reason, by: o.by })
  if ('refuse' in written) {
    process.stderr.write(`refusing: ${written.refuse}\n`)
    process.exit(2)
  }
  line(`  written: set ${written.version}, excluded [${written.exclude.join(', ')}], included [${written.include.join(', ')}]. Earlier overrides kept: ${written.superseded?.length ?? 0}.`)
  if (pending) {
    const sameAsPending = !fromArgs || (pending.exclude.join() === exclude.join() && pending.include.join() === include.join())
    if (sameAsPending) {
      const marked = resolveCompetitorRequest(o.dataDir, o.domain, { status: 'applied', by: o.by, expectRequestedAt: pending.requestedAt, ...(o.note ? { note: o.note } : {}) })
      line('refuse' in marked ? `  ⚠️ ${marked.refuse}. The override is written; the request is left as it now stands.` : '  the pending request is marked applied.')
    } else line('  the pending request asked for something else; it is left pending for a separate decision.')
  }
  line('  No stored cycle changed. The next cycle measures against the new set.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
