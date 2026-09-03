/**
 * `pnpm grader:prompts` — the only way a domain's custom prompts reach a
 * cycle. ADR-0016, decision 4.
 *
 *   pnpm grader:prompts                                              every pending request, with the set it would produce
 *   pnpm grader:prompts -- --domain acme.com                         the set in force, its history, the pending request
 *   pnpm grader:prompts -- --domain acme.com --apply                 apply the pending request as filed
 *   pnpm grader:prompts -- --domain acme.com --set "q one|q two" --reason "…" --apply     the whole set, pipe-separated
 *   pnpm grader:prompts -- --domain acme.com --set "" --reason "…" --apply                clear it
 *   pnpm grader:prompts -- --domain acme.com --decline --note "…"
 *   GRADER_DATA_DIR=<dir> pnpm grader:prompts                        any of the above against another store (also --data <dir>)
 *   --by <name>                                                      who applied it; 'operator' when absent
 *
 * ⚠️ `--apply` IS A HUMAN ACT. The prompts are a scoring input (CLAUDE.md §4):
 * they decide which questions are asked. Every prompt is held to PROPERTY 2
 * with the scorer's own matcher, whoever typed it. `--set` is the WHOLE set,
 * not a delta.
 *
 * ⚠️ WHAT IT COSTS, SAID FIRST. Each custom prompt is one more cell per
 * engine per cycle; this command prints the added requests and their price
 * at the plan in the environment before writing. The headline measurement is
 * unchanged: custom prompts are a second block with their own basis.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRICE_USD_PER_CALL, type OwnPlan } from '@bliprank/collector'
import { ENGINES } from '@bliprank/contracts'
import { allPendingPromptRequests, applyCustomPrompts, checkCustomPrompts, pendingPromptRequest, promptRequestsFor, readCustomPromptSet, resolvePromptRequest, type PromptRequest } from './custom-prompts.js'
import { readCategoryRecord } from './resolve-category.js'

export interface PromptsOptions {
  readonly dataDir: string
  readonly domain?: string
  readonly set?: readonly string[]
  readonly reason?: string
  readonly by: string
  readonly note?: string
  readonly apply: boolean
  readonly decline: boolean
}

export function parsePromptsArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): PromptsOptions | { readonly refuse: string } {
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
  if ((apply || decline) && !domain) return { refuse: `--${apply ? 'apply' : 'decline'} needs --domain` }
  if (args.has('set') && !args.has('reason')) return { refuse: '--set needs --reason: a prompt set carries why, for whoever reads the number later' }
  if (decline && (args.has('set') || args.has('reason'))) return { refuse: '--decline takes --note only; --set and --reason belong to a prompt set' }
  const setRaw = args.get('set')
  return {
    dataDir: args.get('data') ?? env['GRADER_DATA_DIR'] ?? join(here, '..', 'data-live'),
    ...(domain ? { domain } : {}),
    ...(args.has('set') ? { set: setRaw === undefined || setRaw === 'true' ? [] : setRaw.split('|').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(args.has('reason') ? { reason: args.get('reason')! } : {}),
    by: args.get('by') ?? 'operator',
    ...(args.has('note') ? { note: args.get('note')! } : {}),
    apply,
    decline,
  }
}

/** What a set of this size adds to every cycle: cells and money, at the plan in the environment. */
export function promptCost(count: number, env: NodeJS.ProcessEnv): { readonly cells: number; readonly usd: number; readonly plan: OwnPlan } {
  const planRaw = env['OPENWEBNINJA_PLAN']
  const plan: OwnPlan = planRaw === 'pro' || planRaw === 'ultra' || planRaw === 'mega' ? planRaw : 'payg'
  const perPrompt = ENGINES.reduce((n, e) => n + PRICE_USD_PER_CALL[plan][e], 0)
  return { cells: count * ENGINES.length, usd: perPrompt * count, plan }
}

const line = (s: string) => process.stdout.write(`${s}\n`)

function showSet(dataDir: string, domain: string, env: NodeJS.ProcessEnv): boolean {
  const record = readCategoryRecord(dataDir, domain)
  if (!record) {
    line(`${domain}\n  no category record, so no cycle for prompts to join. A first scan decides one.`)
    return false
  }
  const set = readCustomPromptSet(dataDir, domain)
  line(`${domain}`)
  line(`  category ${record.slug} · custom prompts: ${set ? `set ${set.version}, ${set.prompts.length} prompt(s)` : 'none'}`)
  if (set) {
    for (const p of set.prompts) line(`    · ${p}`)
    line(`  set ${set.version} by ${set.by} on ${set.at.slice(0, 10)}: ${set.reason}`)
    for (const s of set.superseded ?? []) line(`  earlier: set ${s.version} · ${s.prompts.length} prompt(s) · ${s.at.slice(0, 10)}`)
    const c = promptCost(set.prompts.length, env)
    line(`  each cycle asks them on ${ENGINES.length} engines: ${c.cells} requests, about $${c.usd.toFixed(3)} at ${c.plan}, on top of the curated bank`)
  }
  return true
}

function showRequest(r: PromptRequest, env: NodeJS.ProcessEnv): void {
  line(`  ${r.status.padEnd(8)} ${r.prompts.length} prompt(s)  ${r.requestedAt.slice(0, 16)}  "${r.reason}"${r.note ? `  note: ${r.note}` : ''}`)
  for (const p of r.prompts) line(`             · ${p}`)
  if (r.status === 'pending') {
    const c = promptCost(r.prompts.length, env)
    line(`             would add ${c.cells} requests per cycle, about $${c.usd.toFixed(3)} at ${c.plan}`)
  }
}

async function main(): Promise<void> {
  const parsed = parsePromptsArgs(process.argv.slice(2))
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  const o = parsed
  const env = process.env

  if (!o.domain) {
    const pending = allPendingPromptRequests(o.dataDir)
    line(`prompts · ${pending.length} pending request(s). Nothing here is applied without --domain and --apply.`)
    for (const r of pending) {
      line('')
      showSet(o.dataDir, r.host, env)
      showRequest(r, env)
    }
    return
  }

  if (!showSet(o.dataDir, o.domain, env)) process.exit(2)
  const history = promptRequestsFor(o.dataDir, o.domain)
  if (history.length) {
    line('  requests:')
    for (const r of history) showRequest(r, env)
  }
  const pending = pendingPromptRequest(o.dataDir, o.domain)

  if (o.decline) {
    const done = resolvePromptRequest(o.dataDir, o.domain, { status: 'declined', by: o.by, ...(pending ? { expectRequestedAt: pending.requestedAt } : {}), ...(o.note ? { note: o.note } : {}) })
    if ('refuse' in done) {
      process.stderr.write(`refusing: ${done.refuse}\n`)
      process.exit(2)
    }
    line('  declined the request. The prompt set is unchanged.')
    return
  }

  const prompts = o.set ?? pending?.prompts
  const reason = o.reason ?? pending?.reason
  if (prompts === undefined || !reason) {
    line(o.apply ? '  nothing to apply: no --set with --reason, and no pending request' : '  DRY RUN. Pass --set "…|…" --reason "…" --apply, or --apply to apply the pending request, or --decline.')
    return
  }
  // Checked BEFORE the dry run prints, so the dry run is the decision: a list that would be refused says so now, not at --apply.
  const checked = checkCustomPrompts(o.dataDir, o.domain, prompts, reason)
  if ('refuse' in checked) {
    process.stderr.write(`refusing: ${checked.refuse}\n`)
    process.exit(2)
  }
  const c = promptCost(checked.prompts.length, env)
  line(`  would set ${o.domain}'s custom prompts to ${checked.prompts.length} prompt(s), because "${reason}"`)
  for (const p of checked.prompts) line(`    · ${p}`)
  line(`  the next cycle asks them on ${ENGINES.length} engines: ${c.cells} more requests, about $${c.usd.toFixed(3)} at ${c.plan}. The headline measurement is unchanged; these score in their own block.`)
  if (!o.apply) {
    line('  DRY RUN. Nothing was written. Re-run with --apply.')
    return
  }
  const written = applyCustomPrompts(o.dataDir, { host: o.domain, prompts, reason, by: o.by })
  if ('refuse' in written) {
    process.stderr.write(`refusing: ${written.refuse}\n`)
    process.exit(2)
  }
  line(`  written: set ${written.version}, ${written.prompts.length} prompt(s). Earlier sets kept: ${written.superseded?.length ?? 0}.`)
  if (pending) {
    const sameAsPending = o.set === undefined || pending.prompts.join('\n') === written.prompts.join('\n')
    if (sameAsPending) {
      const marked = resolvePromptRequest(o.dataDir, o.domain, { status: 'applied', by: o.by, expectRequestedAt: pending.requestedAt, ...(o.note ? { note: o.note } : {}) })
      line('refuse' in marked ? `  ⚠️ ${marked.refuse}. The set is written; the request is left as it now stands.` : '  the pending request is marked applied.')
    } else line('  the pending request asked for something else; it is left pending for a separate decision.')
  }
  line('  No stored cycle changed. The next cycle asks the new set beside the curated bank.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
