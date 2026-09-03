/**
 * `pnpm grader:tick` — what a daily tick would collect, and `pnpm grader:track`
 * — which domains a person has switched on. ADR-0017 (Proposed).
 *
 *   pnpm grader:tick                                    the due list for today: domains, cells, cost, and why the rest are not due
 *   pnpm grader:tick -- --day 2026-09-04                the same for a named UTC day
 *   pnpm grader:track -- --domain acme.com --on --reason "paying customer"
 *   pnpm grader:track -- --domain acme.com --off --reason "churned"
 *   GRADER_DATA_DIR=<dir> pnpm grader:tick              against another store (also --data <dir>)
 *
 * ⚠️ THIS TICK DOES NOT COLLECT. Deliberately. The loop that would call it
 * every day is the decision ADR-0017 puts to the owner: where it runs (beside
 * the store, or hosted once the store moves), what it may spend per day, and
 * which domains are switched on. Until that is decided this command is the
 * bill, printed before anything is incurred: a person reads it and starts the
 * due cycles from the record, exactly as today. Nothing here calls a provider,
 * loads a key, or touches a ledger.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dueToday, monthlyEstimate, readTracked, setTracked } from './due.js'

export interface TickOptions {
  readonly dataDir: string
  readonly day?: string
}

export function parseTickArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): TickOptions | { readonly refuse: string } {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(a.slice(2), v)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const day = args.get('day')
  if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { refuse: `--day takes a UTC date, got ${day}` }
  if ([...args.keys()].some((k) => /^(apply|collect)(=|$)/.test(k))) return { refuse: 'this tick does not collect: the loop that would is the decision ADR-0017 puts to the owner. Start the due cycles from the record, as today.' }
  return { dataDir: args.get('data') ?? env['GRADER_DATA_DIR'] ?? join(here, '..', 'data-live'), ...(day ? { day } : {}) }
}

export interface TrackOptions {
  readonly dataDir: string
  readonly domain: string
  readonly on: boolean
  readonly by: string
  readonly reason: string
}

export function parseTrackArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): TrackOptions | { readonly refuse: string } {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(a.slice(2), v)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const domain = args.get('domain')
  if (!domain) return { refuse: '--domain is required' }
  if (args.has('on') === args.has('off')) return { refuse: 'pass exactly one of --on and --off' }
  const reason = args.get('reason') ?? ''
  if (reason.trim().length < 5) return { refuse: '--reason says why this domain is switched on or off, for whoever pays the bill' }
  return { dataDir: args.get('data') ?? env['GRADER_DATA_DIR'] ?? join(here, '..', 'data-live'), domain, on: args.has('on'), by: args.get('by') ?? 'operator', reason }
}

const line = (s: string) => process.stdout.write(`${s}\n`)

export function printDue(dataDir: string, env: NodeJS.ProcessEnv, day?: string): void {
  const list = dueToday(dataDir, env, day)
  const tracked = readTracked(dataDir)
  line(`tick · ${list.day} · ${tracked.length} tracked domain(s) · ${list.due.length} due · ${list.cells} cells · about $${list.usd.toFixed(3)} at ${list.plan} before retries`)
  line('  This tick does not collect. It is the bill for a daily loop nobody has switched on (ADR-0017).')
  line('  Not checked here, and a loop must still meet them: the enable flags, the provider key, the burst cap, the provider quota.')
  if (list.config) line(`  refusing to size any cycle: ${list.config}`)
  for (const d of list.due) {
    line(`  due      ${d.host.padEnd(24)} ${d.category.padEnd(26)} ${d.curatedPrompts} curated${d.customPrompts ? ` + ${d.customPrompts} own` : ''} × ${d.cells / (d.curatedPrompts + d.customPrompts)} engines = ${d.cells} cells · $${d.usd.toFixed(3)} · ceiling ${d.ceiling.used}+${d.cells} of ${d.ceiling.limit}`)
  }
  for (const n of list.notDue) line(`  not due  ${n.host.padEnd(24)} ${n.reason.padEnd(12)} ${n.detail}`)
  const m = monthlyEstimate(list)
  if (list.due.length) line(`  at one cycle a day this set costs about $${m.usdPerDay.toFixed(2)}/day, $${m.usdPerMonth.toFixed(2)}/month at ${list.plan}; the per-domain ceiling was derived for ${m.ceilingCyclesPerMonth} cycles a month, so a daily loop needs a ceiling decision too (ADR-0017).`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // `pnpm grader:track` runs this file with a leading `track` argument; everything else is a tick.
  const mode = argv[0] === 'track' ? 'track' : 'tick'
  if (mode === 'track') {
    const parsed = parseTrackArgs(argv.slice(1))
    if ('refuse' in parsed) {
      process.stderr.write(`refusing: ${parsed.refuse}\n`)
      process.exit(2)
    }
    const next = setTracked(parsed.dataDir, parsed.domain, parsed.on, { by: parsed.by, reason: parsed.reason })
    if ('refuse' in next) {
      process.stderr.write(`refusing: ${next.refuse}\n`)
      process.exit(2)
    }
    line(`${parsed.domain} is ${parsed.on ? 'ON' : 'OFF'} the daily list. Tracked now: ${next.map((t) => t.host).join(', ') || 'nobody'}. Nothing is collected by this; see pnpm grader:tick for what the list would cost.`)
    return
  }
  const parsed = parseTickArgs(argv)
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  printDue(parsed.dataDir, process.env, parsed.day)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
