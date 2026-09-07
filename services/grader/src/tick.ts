/**
 * `pnpm grader:tick` — what a daily tick would collect, and `pnpm grader:track`
 * — which domains a person has switched on. ADR-0017 (Proposed).
 *
 *   pnpm grader:tick                                    the due list for today: domains, cells, cost, the day's cap, and why the rest are not due
 *   pnpm grader:tick -- --day 2026-09-04                the same for a named UTC day
 *   pnpm grader:tick -- --apply --fixture               run the loop OFFLINE against the store: fixture adapter, no key, no spend
 *   pnpm grader:tick -- --apply --live                  run the loop LIVE, for today. Refused unless GRADER_DAILY_LOOP=armed, both
 *                                                       collection flags are "true", a provider key, a plan and COLLECTION_BUDGET_USD_DAILY
 *                                                       are set, and the runner's ledger has room. Arming is the owner's act.
 *   pnpm grader:track -- --domain acme.com --on --reason "paying customer"
 *   pnpm grader:track -- --domain acme.com --off --reason "churned"
 *   GRADER_DATA_DIR=<dir> pnpm grader:tick              against another store (also --data <dir>)
 *
 * ⚠️ DRY BY DEFAULT, ARMED BY A PERSON. Without --apply this prints the bill
 * and touches no ledger. With --apply it runs `daily-loop.ts`: the day's cap is
 * derived from the tracked set and enforced before every domain; live needs
 * the loop armed in the environment on top of every gate a click meets. The OS
 * task that would call this daily is registered by a person, once, after the
 * owner's separate go-ahead (ADR-0017); this file never registers itself.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARMED, dailyCapUsd, formulaCapUsd, hardCeilingUsd, runTick } from './daily-loop.js'
import { RETRY_HEADROOM } from './domain-ceiling.js'
import { dueToday, monthlyEstimate, readTracked, setTracked } from './due.js'

export interface TickOptions {
  readonly dataDir: string
  readonly day?: string
  readonly apply: boolean
  readonly fixture: boolean
  readonly live: boolean
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
  if (args.has('collect')) return { refuse: 'the flag is --apply' }
  if ((args.has('fixture') || args.has('live')) && !args.has('apply')) return { refuse: '--fixture and --live say how to apply; they need --apply' }
  if (args.has('fixture') && args.has('live')) return { refuse: '--fixture and --live are two different runs; pass one' }
  // A live run is named on the command line, every time. An environment that happens to be armed must not make a hand-typed --apply spend.
  if (args.has('apply') && !args.has('fixture') && !args.has('live')) return { refuse: '--apply needs --fixture (offline) or --live (spends). Neither is implied.' }
  if (args.has('live') && day !== undefined) return { refuse: 'a live tick runs for today; --day is for the dry list' }
  return { dataDir: args.get('data') ?? env['GRADER_DATA_DIR'] ?? join(here, '..', 'data-live'), ...(day ? { day } : {}), apply: args.has('apply'), fixture: args.has('fixture'), live: args.has('live') }
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
  const hard = hardCeilingUsd(env)
  line(`  the day's cap: $${dailyCapUsd(list, env).toFixed(3)} = min(formula $${formulaCapUsd(list).toFixed(3)} = every tracked domain's expected cycle ($${list.tracked.reduce((n, t) => n + t.usd, 0).toFixed(3)}) × ${RETRY_HEADROOM} retry headroom, hard ceiling COLLECTION_BUDGET_USD_DAILY ${hard === null ? 'UNSET (a live tick refuses)' : `$${hard.toFixed(3)}`})`)
  line(`  armed: ${env['GRADER_DAILY_LOOP'] === ARMED ? 'YES (GRADER_DAILY_LOOP=armed)' : 'no'} · live collection flags: ${env['COLLECTION_ENABLED'] === 'true' && env['GRADER_LIVE_SCAN'] === 'true' ? 'on' : 'off'}`)
  line('  This listing collects nothing and touches no ledger. Not checked here, and the loop meets them at --apply: the burst cap and the provider quota.')
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
  if (!parsed.apply) return
  line('')
  line(parsed.fixture ? 'applying OFFLINE (fixture adapter): cycles are filed, nothing is spent' : 'applying LIVE: every gate below must pass, and this spends')
  const outcome = await runTick({ dataDir: parsed.dataDir, env: process.env, ...(parsed.day ? { day: parsed.day } : {}), apply: true, mode: parsed.fixture ? 'fixture' : 'live', root: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..') }, { log: line })
  if ('refuse' in outcome) {
    process.stderr.write(`refusing: ${outcome.refuse}\n`)
    process.exit(2)
  }
  line(`loop · ${outcome.mode} · ${outcome.day} · cap $${outcome.capUsd.toFixed(3)} · spent $${outcome.spentBefore.toFixed(3)} → $${outcome.spentAfter.toFixed(3)} · ${outcome.ran.length} ran · ${outcome.refused.length} refused`)
  for (const r of outcome.ran) line(`  ran      ${r.host.padEnd(24)} ${r.status.padEnd(12)} $${r.spentUsd.toFixed(4)} · ${r.calls} calls`)
  for (const r of outcome.refused) line(`  refused  ${r.host.padEnd(24)} ${r.reason}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
