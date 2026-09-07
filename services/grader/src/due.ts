/**
 * THE DUE LIST — which tracked domains a daily tick would collect today, what
 * each would cost, and why the others are not due. ADR-0017 (Proposed).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS THE FIRST PIECE OF A SCHEDULER, AND NOT THE LOOP.
 *
 * "Prompts re-check daily" is the product's promise and today a person starts
 * every cycle. The first honest step is not a timer: it is the pure function
 * every transport (an OS cron on the machine that holds the store, a Vercel
 * cron, a QStash schedule) would call to learn WHAT to collect, with the same
 * refusals `/api/scan` applies to a person's click. A timer that cannot say
 * what it will spend before it spends is the thing R3 exists to prevent.
 *
 * TRACKED IS OPT-IN. A category record exists for every domain anyone ever
 * previewed, demo lookups included; collecting all of them daily would bill
 * for curiosity. A domain is due only when a person has switched it on
 * (`pnpm grader:track`), and that switch is a file beside the record store.
 *
 * Pure: reads the stores, computes, writes nothing, spends nothing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRICE_USD_PER_CALL, type OwnPlan } from '@bliprank/collector'
import { normaliseHost } from '@bliprank/taxonomy'
import { readCustomPromptSet } from './custom-prompts.js'
import { listCycles } from './cycles.js'
import { defaultGateConfig } from './live-gate.js'
import { allBanks, readCategoryRecord, withRecordLock } from './resolve-category.js'
import { basisOf, promptsFor } from './scan.js'

// ---------------------------------------------------------------- tracked domains

export interface TrackedEntry {
  readonly host: string
  readonly since: string
  readonly by: string
  readonly reason: string
}

const trackedFile = (dataDir: string): string => join(dataDir, 'tracked.json')

/**
 * The tracked list. A MISSING file is nobody tracked; a CORRUPT file is an
 * error, thrown, because reading it as empty would switch every customer off
 * the daily list without a word, and the next `--on` would then overwrite the
 * file and make the loss permanent. Found by the step review.
 */
export function readTracked(dataDir: string): readonly TrackedEntry[] {
  const f = trackedFile(dataDir)
  if (!existsSync(f)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    throw new Error(`${f} is not readable JSON (${(e as Error).message}); nothing is tracked or untracked until a person repairs it`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${f} is not a list; nothing is tracked or untracked until a person repairs it`)
  return parsed
    .filter((t): t is TrackedEntry => typeof t === 'object' && t !== null && typeof (t as TrackedEntry).host === 'string' && typeof (t as TrackedEntry).since === 'string')
    .map((t) => ({ host: normaliseHost(t.host) || t.host, since: t.since, by: typeof t.by === 'string' ? t.by : 'operator', reason: typeof t.reason === 'string' ? t.reason : '' }))
}

/** Switch a domain's daily collection on or off. A person's act; it refuses a domain with no record, because there is nothing to collect under. */
export function setTracked(dataDir: string, domain: string, on: boolean, who: { readonly by: string; readonly reason: string; readonly at?: string }): readonly TrackedEntry[] | { readonly refuse: string } {
  const host = normaliseHost(domain)
  if (!host) return { refuse: 'not a domain' }
  if (on && !readCategoryRecord(dataDir, host)) return { refuse: `${host} has no category on record; a first scan decides one, and only then is there something to re-check daily` }
  return withRecordLock(dataDir, () => {
    const current = readTracked(dataDir).filter((t) => t.host !== host)
    const next = on ? [...current, { host, since: who.at ?? new Date().toISOString(), by: who.by, reason: who.reason }] : current
    writeFileSync(trackedFile(dataDir), JSON.stringify(next, null, 2) + '\n')
    return next
  })
}

// ---------------------------------------------------------------- the due list

export interface DueDomain {
  readonly host: string
  readonly category: string
  readonly curatedPrompts: number
  readonly customPrompts: number
  readonly cells: number
  readonly usd: number
}

export interface NotDue {
  readonly host: string
  readonly reason: 'no-record' | 'no-bank' | 'cycle-today' | 'basis-moved'
  readonly detail: string
}

export interface TrackedCost {
  readonly host: string
  readonly cells: number
  readonly usd: number
}

export interface DueList {
  readonly day: string
  readonly plan: OwnPlan
  readonly due: readonly DueDomain[]
  readonly notDue: readonly NotDue[]
  readonly cells: number
  readonly usd: number
  /** Every tracked domain's expected cycle cost, due or not: the daily cap is derived from this (ADR-0017 decision 2). */
  readonly tracked: readonly TrackedCost[]
  /** Set when the environment cannot size a scan at all; then nothing is due, as the route would refuse. */
  readonly config?: string
}

/**
 * Everything a tick would do today, decided the way `/api/scan` decides a
 * person's click for the gates that are FACTS ABOUT THE STORE: a record and a
 * bank, no cycle yet today, the prior cycle's prompt count and engine set
 * unchanged (or the new cycle could not join the trend), and a prompt count
 * the environment can size. The MANUAL per-domain ceiling is not consulted:
 * it counts hand-started cycles and the loop has its own bounds (ADR-0017).
 *
 * ⚠️ NOT MIRRORED, and a loop must still meet them at run time: the two enable
 * flags, the provider key, the shared burst cap, the provider's own remaining
 * quota, and the per-visitor throttle (a cron has no visitor). A domain shown
 * here as due can still be refused by those; the bill is an upper bound on
 * what the store permits, not a promise of what the provider will.
 *
 * Cost is the plan's marginal price per engine, summed over the engines a cycle
 * asks, times the prompts, before retries; pay-as-you-go when the plan is unset.
 */
export function dueToday(dataDir: string, env: NodeJS.ProcessEnv, day: string = new Date().toISOString().slice(0, 10)): DueList {
  const gate = defaultGateConfig(dataDir, env)
  const planRaw = env['OPENWEBNINJA_PLAN']
  const plan: OwnPlan = planRaw === 'pro' || planRaw === 'ultra' || planRaw === 'mega' ? planRaw : 'payg'
  const perPrompt = gate.engines.reduce((n, e) => n + PRICE_USD_PER_CALL[plan][e], 0)
  const due: DueDomain[] = []
  const notDue: NotDue[] = []
  const tracked: TrackedCost[] = []
  // The route's own guard (`/api/scan`): a prompt count that is not a positive integer cannot size a scan, and nothing is collected.
  if (!Number.isInteger(gate.callsPerEngine) || gate.callsPerEngine <= 0) {
    return { day, plan, due, notDue, cells: 0, usd: 0, tracked, config: `GRADER_PROMPTS_PER_SCAN is ${JSON.stringify(env['GRADER_PROMPTS_PER_SCAN'])}, which cannot size a scan; nothing is due until it is a positive integer` }
  }
  for (const t of readTracked(dataDir)) {
    const record = readCategoryRecord(dataDir, t.host)
    if (!record) {
      notDue.push({ host: t.host, reason: 'no-record', detail: 'no category record' })
      continue
    }
    const bank = allBanks(dataDir).find((b) => b.category === record.slug)
    if (!bank) {
      notDue.push({ host: t.host, reason: 'no-bank', detail: `no bank for ${record.slug} in this build` })
      continue
    }
    // Expected cost is a fact about the tracked domain, due today or not: the day's cap is the sum over all of them.
    const curatedCount = promptsFor(bank, gate.callsPerEngine).length
    const customCount = readCustomPromptSet(dataDir, t.host)?.prompts.length ?? 0
    tracked.push({ host: t.host, cells: (curatedCount + customCount) * gate.engines.length, usd: (curatedCount + customCount) * perPrompt })
    const cycles = listCycles(dataDir, t.host)
    const prior = cycles[cycles.length - 1]
    if (prior && prior.day === day) {
      notDue.push({ host: t.host, reason: 'cycle-today', detail: `a cycle for ${day} is already stored` })
      continue
    }
    const curated = promptsFor(bank, gate.callsPerEngine).length
    if (prior) {
      const was = basisOf((prior.result as { comparisonBasis?: string }).comparisonBasis ?? '')
      const engines = [...gate.engines].sort().join(',')
      const priorEngines = was.engines ? [...was.engines].sort().join(',') : engines
      if ((was.maxPrompts !== undefined && was.maxPrompts !== curated) || priorEngines !== engines) {
        notDue.push({ host: t.host, reason: 'basis-moved', detail: `the prior cycle (${prior.day}) was ${was.maxPrompts ?? '?'} prompts on ${priorEngines}; today would be ${curated} on ${engines}, which could not join the trend` })
        continue
      }
    }
    const custom = readCustomPromptSet(dataDir, t.host)?.prompts.length ?? 0
    const cells = (curated + custom) * gate.engines.length
    due.push({ host: t.host, category: record.slug, curatedPrompts: curated, customPrompts: custom, cells, usd: (curated + custom) * perPrompt })
  }
  return { day, plan, due, notDue, cells: due.reduce((n, d) => n + d.cells, 0), usd: due.reduce((n, d) => n + d.usd, 0), tracked }
}

/** The monthly bill a tracked set implies at one cycle a day. */
export function monthlyEstimate(list: DueList, daysPerMonth = 30): { readonly cellsPerDay: number; readonly usdPerDay: number; readonly usdPerMonth: number } {
  return { cellsPerDay: list.cells, usdPerDay: list.usd, usdPerMonth: list.usd * daysPerMonth }
}
