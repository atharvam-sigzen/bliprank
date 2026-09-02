/**
 * Collection CYCLES of one domain, on disk — the store that lets a second scan
 * coexist with the first instead of overwriting it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A CYCLE IS. One scan of one domain on one UTC day. The day is part of
 * the cache key (ADR-0003: `date_bucket`), so two scans on the same day read
 * the same cells and are the same measurement; two scans on different days are
 * different cells, bought separately, and are the two points a trend needs.
 * That makes the day the natural identity of a cycle, and this module keys on
 * nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LAYOUT, AND WHY THE LATEST FILE STAYS WHERE IT WAS.
 *
 *   results/<domain>.json                 the latest cycle — unchanged
 *   results/cycles/<domain>/<day>.json    every cycle, one file per day
 *
 * `results/<domain>.json` is read by name in four places (`/api/scan`'s cache,
 * `rescore.ts`, `answers.ts`, `promote.ts`) and the three results already on
 * disk have no cycles directory. Keeping the latest file exactly where it was
 * means none of those readers change and none of those files migrate: a domain
 * with no cycles directory has exactly one cycle, its latest, and `listCycles`
 * says so. A subdirectory rather than `<domain>.<day>.json` beside the latest,
 * because `storedResults` in rescore.ts globs `results/*.json` and a sibling
 * file would be listed as a domain called `pipedrive.com.2026-09-03`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO. It does not schedule anything. A cycle is written when
 * a person starts a scan and the scan finishes; there is no timer, no queue and
 * no cron anywhere in this build (see `planned.tsx`). It does not collect: it
 * takes a finished result and files it. And it never re-derives a category —
 * the result it is handed carries the one the scan ran under, and `/api/scan`
 * reaches this only after `resolveCategory` returned the RECORDED decision.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The subset of a stored result this module reads. Everything else passes through untouched. */
export interface CycleResult {
  readonly status: string
  readonly domain: string
  readonly run?: { readonly day?: string }
  readonly collectedAt?: string
}

export interface StoredCycle<T extends CycleResult = CycleResult> {
  readonly day: string
  readonly file: string
  readonly result: T
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Same rule `/api/scan` applies to a result file name. */
export const safeName = (domain: string): string => domain.replace(/[^a-z0-9.-]/g, '_')

export const latestPath = (dataDir: string, domain: string): string => join(dataDir, 'results', `${safeName(domain)}.json`)
export const cyclesDir = (dataDir: string, domain: string): string => join(dataDir, 'results', 'cycles', safeName(domain))
export const cyclePath = (dataDir: string, domain: string, day: string): string => join(cyclesDir(dataDir, domain), `${day}.json`)

/**
 * The day a result's answers were bought. `run.day` when the runner stamped
 * one, else the date of `collectedAt` — the same derivation `runInfoOf` and
 * `rescore.ts` make, because it is the cache key's own day and nothing else
 * would find the cells again. Null when the file says nothing usable.
 */
export function dayOf(result: CycleResult): string | null {
  const stamped = result.run?.day
  if (typeof stamped === 'string' && DAY.test(stamped)) return stamped
  const collected = (result.collectedAt ?? '').slice(0, 10)
  return DAY.test(collected) ? collected : null
}

function readResult<T extends CycleResult>(file: string): T | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const r = parsed as Partial<CycleResult>
    return typeof r.status === 'string' && typeof r.domain === 'string' ? (parsed as T) : null
  } catch {
    return null
  }
}

/**
 * File a finished scan as a cycle AND as the latest.
 *
 * Both writes, always, so the two views cannot disagree: a reader of the latest
 * file sees exactly what the cycle file holds for that day. A result with no
 * usable day is refused rather than filed under a guess — the day is the
 * cycle's identity, and a wrong one would put this cycle's number on another
 * cycle's point of the trend.
 */
export function writeCycle(dataDir: string, result: CycleResult): { readonly day: string; readonly latest: string; readonly cycle: string } | { readonly refuse: string } {
  if (result.status !== 'scanned') return { refuse: `only a scanned result is a cycle, got status ${result.status}` }
  const day = dayOf(result)
  if (!day) return { refuse: `${result.domain}: the result records no collection day, so it cannot be filed as a cycle` }
  const body = JSON.stringify(result, null, 2) + '\n'
  const cycle = cyclePath(dataDir, result.domain, day)
  const latest = latestPath(dataDir, result.domain)
  mkdirSync(cyclesDir(dataDir, result.domain), { recursive: true })

  /*
   * ⚠️ THE LATEST FILE MAY BE THE ONLY COPY OF AN EARLIER CYCLE. Every domain
   * scanned before this store existed has exactly that shape, and the first new
   * cycle would have overwritten it — the earlier point of the trend destroyed
   * by the act of adding the second. Caught by the test for exactly this case.
   * So an earlier cycle living only in the latest file is filed under its own
   * day first, byte for byte, and only then is the latest replaced.
   */
  const prior = readResult(latest)
  const priorDay = prior ? dayOf(prior) : null
  if (prior && priorDay && priorDay !== day && prior.status === 'scanned' && prior.domain === result.domain && !existsSync(cyclePath(dataDir, result.domain, priorDay))) {
    writeFileSync(cyclePath(dataDir, result.domain, priorDay), readFileSync(latest, 'utf8'))
  }

  writeFileSync(cycle, body)
  writeFileSync(latest, body)
  return { day, latest, cycle }
}

/**
 * Every cycle this store holds for a domain, oldest first.
 *
 * The cycles directory, plus the latest file when its day is not already among
 * them — which is every domain scanned before this module existed. A file that
 * does not parse, or that records no day, is left out rather than guessed at;
 * `.audit.json` rows (superseded derivations kept by rescore) are never cycles.
 */
export function listCycles<T extends CycleResult = CycleResult>(dataDir: string, domain: string): readonly StoredCycle<T>[] {
  const byDay = new Map<string, StoredCycle<T>>()
  const dir = cyclesDir(dataDir, domain)
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name.includes('.audit.')) continue
      const file = join(dir, name)
      const result = readResult<T>(file)
      const day = result ? dayOf(result) : null
      // The file is named by its day; a result inside claiming another day is a
      // filing error, and the honest response is to skip it, not to trust either.
      // Likewise a result for another domain: two hosts can share a safeName
      // (`a b.com` and `a_b.com`), and the directory is not the identity.
      if (!result || !day || result.status !== 'scanned' || `${day}.json` !== name || result.domain !== domain) continue
      byDay.set(day, { day, file, result })
    }
  }
  const latestFile = latestPath(dataDir, domain)
  const latest = readResult<T>(latestFile)
  const latestDay = latest ? dayOf(latest) : null
  if (latest && latestDay && latest.status === 'scanned' && latest.domain === domain && !byDay.has(latestDay)) {
    byDay.set(latestDay, { day: latestDay, file: latestFile, result: latest })
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** The most recent cycle, or null when the store holds none. */
export function latestCycle<T extends CycleResult = CycleResult>(dataDir: string, domain: string): StoredCycle<T> | null {
  const all = listCycles<T>(dataDir, domain)
  return all[all.length - 1] ?? null
}

/** One cycle by day: the cycle file, or the latest file when that is the day asked for. */
export function readCycle<T extends CycleResult = CycleResult>(dataDir: string, domain: string, day: string): StoredCycle<T> | null {
  if (!DAY.test(day)) return null
  return listCycles<T>(dataDir, domain).find((c) => c.day === day) ?? null
}
