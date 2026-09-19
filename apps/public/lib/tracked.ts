/**
 * The daily re-check as a workspace action: the words and shapes shared by the
 * route (`app/api/tracked/route.ts`), the switch on the record
 * (`components/track-daily.tsx`) and the entry flow (MVP_PLAN C3, ADR-0018 D6,
 * ADR-0016 Amendment 1).
 *
 * Kept out of the route module because a Next route file may export handlers
 * and config and nothing else (the C3 tenancy review, BLOCKER 1: a stray
 * export fails `next build`'s type guard while `pnpm typecheck` stays green).
 */

/** The hosts one workspace may re-check daily until D2 gates the count by plan (B6). Overridden by `GRADER_MAX_TRACKED_PER_WORKSPACE`. */
export const DEFAULT_MAX_TRACKED_PER_WORKSPACE = 3
/** The longest instruction a person can give in one go, in days. A longer re-check is a second instruction, given later, with the trend in view. */
export const MAX_TRACK_DAYS = 90
export const DEFAULT_TRACK_DAYS = 7

export const ONLY_OWNER_OR_ADMIN = 'Only an owner or admin switches daily re-checks on or off; a member can ask one to.'
export const NO_RECORD = 'has no category on record in this workspace. A first scan decides one; only then is there something to re-check daily.'

/** What `/api/tracked` says about one domain in the session's workspace. */
export interface TrackedStatus {
  readonly domain: string
  readonly tracked: boolean
  readonly since?: string
  /** the last UTC day the re-check runs, inclusive */
  readonly until?: string
  /** days left including today; 0 on the last day; absent when not tracked or open-ended */
  readonly daysLeft?: number
  /**
   * The version of the domain's own prompt set IN FORCE NOW: what tomorrow's
   * cycle will ask and what its number will carry. Read from the store at the
   * time of asking, never from the entry, because the loop asks the set in
   * force and a status that named an older version would contradict the basis
   * of the number it sits beside (C3 stats review, MAJOR 3). Absent: the bank's.
   */
  readonly prompts?: number
  /** the version in force when the re-check was switched on: provenance of the instruction, not of any number */
  readonly promptsAtSwitch?: number
  readonly reason?: string
  /** whether this session may switch it: an owner or admin on the store, or the machine's own file store */
  readonly may: boolean
  readonly trackedInWorkspace: number
  /**
   * Which store answered. The surfaces offer the switch only on `file`, the
   * machine's own store (identity off, MVP_PLAN C3): the session-derived path
   * on a deployment is built and tested and deliberately wired to no surface
   * in this scope, so on `postgres` a surface states the fact in words and
   * offers nothing.
   */
  readonly backend: 'file' | 'postgres'
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The UTC day `days` after `from` (YYYY-MM-DD). `days` is a positive integer at most MAX_TRACK_DAYS, or null. */
export function untilDay(from: string, days: unknown): string | null {
  if (!DAY.test(from) || typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_TRACK_DAYS) return null
  const t = Date.parse(`${from}T00:00:00.000Z`)
  if (!Number.isFinite(t)) return null
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

/** Days of re-checking left on `today`, `until` included; negative means expired. */
export function daysLeftOn(today: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000)
}

/**
 * A limit from the environment, or its default. A value that is not a positive
 * integer KEEPS THE DEFAULT: `Number('ten')` is NaN, every comparison with NaN
 * is false, and a limit read that way is a limit a typo switches off (C3
 * tenancy review MINOR 4, and the re-check's finding on the two throttles).
 */
export function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

/** The per-workspace ceiling from the environment, or the default. */
export const maxTrackedPerWorkspace = (env: NodeJS.ProcessEnv): number => positiveIntOr(env['GRADER_MAX_TRACKED_PER_WORKSPACE'], DEFAULT_MAX_TRACKED_PER_WORKSPACE)
