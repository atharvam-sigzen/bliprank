/**
 * `pnpm grader:schedule` — the ONE QStash schedule a deployment has, printed
 * by default and registered, listed, paused, resumed or removed by flag.
 * ADR-0018 D8.
 *
 *   pnpm grader:schedule                      print the schedule this environment would register; calls nothing
 *   pnpm grader:schedule -- --register        register it, or update the one that exists under the same id
 *   pnpm grader:schedule -- --list            every schedule QStash holds for the token
 *   pnpm grader:schedule -- --pause           the reversible stop: the cron fires and is ignored
 *   pnpm grader:schedule -- --resume
 *   pnpm grader:schedule -- --remove          delete the schedule; --register creates it afresh
 *
 * ⚠️ TWO ACTS, BOTH THE OWNER'S. Registering spends nothing by itself: QStash
 * will call `${SITE_URL}/api/tick` once a day and the route answers "not
 * armed" and does nothing until `GRADER_DAILY_LOOP=armed` is set on the
 * deployment as well. Unregistering (or pausing) the schedule, or unsetting
 * the variable, stops it — either one. This is the OS task of ADR-0017 in
 * QStash's shape, and as there, nothing in this file registers itself: a
 * person runs it, once, from their own shell, after the go-ahead.
 *
 * ⚠️ THE TOKEN COMES FROM THE SHELL, NEVER FROM A FILE. `QSTASH_TOKEN` is read
 * from the process environment only — not from `.env.local`, which
 * `loadApiKey` reads for the provider key — because whoever can register a
 * schedule can make the deployment run its daily loop, and that is a person
 * exporting a variable on purpose, not a file on a laptop. Without it every
 * action but `print` refuses. The pre-spend hook blocks `--register` and
 * `--resume` in an agent session for the same reason.
 *
 * ⚠️ UTC ONLY. The cron is evaluated in UTC by QStash unless prefixed
 * `CRON_TZ=`, and a `CRON_TZ=` prefix is refused here: the cache key's day
 * (R6) and the loop's "one cycle per UTC day" are UTC, and a schedule in
 * another zone would fire on a day the ledger does not agree with twice a
 * year.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { QStashClient, type QStashSchedule } from '@bliprank/collector'
import { FAN_OUT_JOB, type FanOutJob } from './daily-loop.js'

/** The schedule's caller-chosen id: a second `--register` updates this one rather than adding a second (QStash: "the settings of the existing schedule will be updated"). */
export const TICK_SCHEDULE_ID = 'bliprank-daily-tick'
/** 06:15 UTC, the hour ADR-0017's OS task named. */
export const DEFAULT_TICK_CRON = '15 6 * * *'
export const TICK_PATH = '/api/tick'
/** QStash-side delivery retries. The route answers 2xx for anything that may have spent, so a retry only ever re-asks a refusal. */
export const TICK_RETRIES = 2
/** How long QStash waits on the route: its `maxDuration` (the fan-out publishes in seconds; a domain job is one cycle). */
export const TICK_TIMEOUT_SEC = 300

export interface ScheduleSpec {
  readonly destination: string
  readonly cron: string
  readonly scheduleId: string
  readonly body: FanOutJob
  readonly retries: number
  readonly timeoutSec: number
}

/** Five whitespace-separated cron fields of digits and the usual punctuation; nothing else, and no `CRON_TZ=` prefix. */
const CRON_FIELD = /^[\d*,/-]+$/
export function cronRefusal(cron: string): string | null {
  if (/^CRON_TZ=/i.test(cron.trim())) return 'the cron must be UTC: the cache key\'s day and the loop\'s one-cycle-per-day rule are UTC, so a CRON_TZ= prefix is refused'
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) return `the cron must be five fields of digits, *, comma, slash and dash, got ${JSON.stringify(cron)}`
  return null
}

/**
 * What this environment would register. `SITE_URL` is the deployment's own
 * origin, the same variable every redirect is built on (CLAUDE.md §7), so
 * the destination QStash signs as `sub` is the URL the route verifies
 * against. `GRADER_TICK_CRON` overrides the hour.
 */
export function scheduleSpec(env: NodeJS.ProcessEnv): ScheduleSpec | { readonly refuse: string } {
  const site = env['SITE_URL']?.trim()
  if (!site) return { refuse: 'SITE_URL is not set; the schedule\'s destination is the deployment\'s own origin plus /api/tick' }
  let origin: string
  try {
    const u = new URL(site)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme')
    origin = u.origin
  } catch {
    return { refuse: `SITE_URL is not an absolute http(s) URL: ${JSON.stringify(site)}` }
  }
  const cron = env['GRADER_TICK_CRON']?.trim() || DEFAULT_TICK_CRON
  const bad = cronRefusal(cron)
  if (bad) return { refuse: bad }
  return { destination: `${origin}${TICK_PATH}`, cron, scheduleId: TICK_SCHEDULE_ID, body: FAN_OUT_JOB, retries: TICK_RETRIES, timeoutSec: TICK_TIMEOUT_SEC }
}

export type ScheduleAction = 'print' | 'register' | 'list' | 'pause' | 'resume' | 'remove'

export function parseScheduleArgs(argv: readonly string[]): { readonly action: ScheduleAction } | { readonly refuse: string } {
  const flags = argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2))
  const actions = flags.filter((f): f is Exclude<ScheduleAction, 'print'> => f === 'register' || f === 'list' || f === 'pause' || f === 'resume' || f === 'remove')
  const unknown = flags.filter((f) => !actions.includes(f as Exclude<ScheduleAction, 'print'>))
  if (unknown.length) return { refuse: `unknown flag(s): ${unknown.map((f) => `--${f}`).join(', ')}; one of --register, --list, --pause, --resume, --remove, or nothing to print` }
  if (actions.length > 1) return { refuse: `one action at a time, got ${actions.map((a) => `--${a}`).join(' and ')}` }
  return { action: actions[0] ?? 'print' }
}

export interface ScheduleDeps {
  readonly fetch?: typeof fetch
  readonly log?: (s: string) => void
}

const describe_ = (s: ScheduleSpec): string[] => [
  `schedule   ${s.scheduleId}`,
  `destination ${s.destination}`,
  `cron       ${s.cron} (UTC)`,
  `body       ${JSON.stringify(s.body)}`,
  `retries    ${s.retries} · timeout ${s.timeoutSec}s (the route's maxDuration)`,
]

/**
 * Run one action. `print` needs no token and calls nothing. Every other action
 * needs `QSTASH_TOKEN` in the environment it was given and talks to QStash
 * through the client's fetch (a test injects one). Nothing here arms the
 * deployment; the message after `--register` says so.
 */
export async function runSchedule(action: ScheduleAction, env: NodeJS.ProcessEnv, deps: ScheduleDeps = {}): Promise<{ readonly ok: true; readonly lines: readonly string[] } | { readonly refuse: string }> {
  const spec = scheduleSpec(env)
  if ('refuse' in spec) return spec
  if (action === 'print') {
    return { ok: true, lines: [...describe_(spec), 'Nothing was registered: pass --register from a shell that holds QSTASH_TOKEN. The deployment runs the loop only once GRADER_DAILY_LOOP=armed is set there as well (ADR-0018 D8).'] }
  }
  const token = env['QSTASH_TOKEN']?.trim()
  if (!token) return { refuse: `QSTASH_TOKEN is not set in this shell; --${action} talks to QStash and refuses without it. It is read from the environment only, never from a file.` }
  const client = new QStashClient({ token, destination: spec.destination, retries: spec.retries, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
  switch (action) {
    case 'register': {
      const { scheduleId } = await client.schedule(spec.cron, spec.body, { scheduleId: spec.scheduleId, retries: spec.retries, timeoutSec: spec.timeoutSec })
      return {
        ok: true,
        lines: [
          ...describe_(spec),
          `registered as ${scheduleId || spec.scheduleId}. QStash will POST the body to the destination at ${spec.cron} UTC, signed; a second --register updates this schedule rather than adding one.`,
          'The deployment spends nothing until GRADER_DAILY_LOOP=armed is set on it as well; until then every delivery is answered "not armed". --pause or --remove stops the schedule; unsetting the variable stops the loop.',
        ],
      }
    }
    case 'list': {
      const all = await client.listSchedules()
      return { ok: true, lines: all.length ? all.map(lineOf) : ['QStash holds no schedule for this token.'] }
    }
    case 'pause':
      await client.pauseSchedule(spec.scheduleId)
      return { ok: true, lines: [`${spec.scheduleId} paused: the cron fires and is ignored until --resume.`] }
    case 'resume':
      await client.resumeSchedule(spec.scheduleId)
      return { ok: true, lines: [`${spec.scheduleId} resumed. It spends only where GRADER_DAILY_LOOP=armed is set.`] }
    case 'remove':
      await client.deleteSchedule(spec.scheduleId)
      return { ok: true, lines: [`${spec.scheduleId} removed. --register creates it afresh.`] }
  }
}

const lineOf = (s: QStashSchedule): string =>
  `${s.scheduleId.padEnd(24)} ${s.cron.padEnd(14)} ${s.destination}${s.isPaused ? ' (paused)' : ''}${typeof s.nextScheduleTime === 'number' ? ` next ${new Date(s.nextScheduleTime).toISOString()}` : ''}`

async function main(): Promise<void> {
  const parsed = parseScheduleArgs(process.argv.slice(2))
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  const out = await runSchedule(parsed.action, process.env)
  if ('refuse' in out) {
    process.stderr.write(`refusing: ${out.refuse}\n`)
    process.exit(2)
  }
  for (const l of out.lines) process.stdout.write(`${l}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
