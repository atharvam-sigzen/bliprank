/**
 * THE DUE LIST — which tracked domains a daily tick would collect today, what
 * each would cost, and why the others are not due. ADR-0017 (decision 1),
 * ADR-0018 (the same list, per workspace, for the fan-out).
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
 * (`pnpm grader:track`), and that switch is a document beside the ledgers:
 * the file `tracked.json` on a machine, the same-named ledger document in
 * Upstash on the deployment (ADR-0018 D6). An entry names the workspace the
 * daily cycle is filed in and who switched it on; an entry written before
 * ADR-0018 names neither and is read as this machine's (`local`).
 *
 * ONE DECISION, TWO STORES (MVP_PLAN B3b's shape). `decideDue` is the pure
 * verdict over the facts a store holds for one host; `dueToday` reads those
 * facts from this machine's files, `dueTodayIn` reads them from each entry's
 * `WorkspaceStore`. The CLI's tick and the route's fan-out therefore refuse
 * and admit by the same function, and a branch one took and the other did
 * not would be where a special case would go.
 *
 * Pure: reads the stores, computes, writes nothing, spends nothing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRICE_USD_PER_CALL, type OwnPlan } from '@bliprank/collector'
import { normaliseHost } from '@bliprank/taxonomy'
import { readCustomPromptSet } from './custom-prompts.js'
import { listCycles } from './cycles.js'
import { LOCAL_WORKSPACE } from './domain-ceiling.js'
import type { LedgerStores } from './ledger-stores.js'
import { defaultGateConfig, type GateConfig } from './live-gate.js'
import { allBanks, readCategoryRecord, withRecordLock, type CategoryRecord } from './resolve-category.js'
import { basisOf, promptsFor } from './scan.js'
import { categoryRecordIn, customPromptsIn } from './store/documents.js'
import type { WorkspaceStore } from './store/pg-store.js'

// ---------------------------------------------------------------- tracked domains

export type TrackedRole = 'owner' | 'admin' | 'member'

export interface TrackedEntry {
  readonly host: string
  readonly since: string
  readonly by: string
  readonly reason: string
  /** The workspace the daily cycle is filed in (ADR-0018 D6). Absent on a machine and on an entry written before ADR-0018, and then read as `local`. */
  readonly workspaceId?: string
  /** The role `by` held in that workspace when the domain was switched on; the database re-verifies it against membership when a job presents the token (migration 0005). */
  readonly role?: TrackedRole
}

/** The tracked list's document name: a file under the data directory on a machine, the ledger document of that name on the deployment. */
export const TRACKED = 'tracked.json'
const trackedFile = (dataDir: string): string => join(dataDir, TRACKED)

/** The workspace an entry's cycles are filed in: the one it names, else this machine's. */
export const workspaceOf = (t: Pick<TrackedEntry, 'workspaceId'>): string => t.workspaceId ?? LOCAL_WORKSPACE

const isRole = (v: unknown): v is TrackedRole => v === 'owner' || v === 'admin' || v === 'member'

/**
 * The list's shape, from whatever was stored. A MISSING document is nobody
 * tracked; a document that is NOT A LIST is an error, thrown, because reading
 * it as empty would switch every customer off the daily list without a word,
 * and the next `--on` would then overwrite the file and make the loss
 * permanent. Found by the step review. An entry without a host or a `since`
 * is dropped; a hand-edited host is normalised.
 */
export function parseTracked(parsed: unknown, where: string): readonly TrackedEntry[] {
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) throw new Error(`${where} is not a list; nothing is tracked or untracked until a person repairs it`)
  return parsed
    .filter((t): t is TrackedEntry => typeof t === 'object' && t !== null && typeof (t as TrackedEntry).host === 'string' && typeof (t as TrackedEntry).since === 'string')
    .map((t) => ({
      host: normaliseHost(t.host) || t.host,
      since: t.since,
      by: typeof t.by === 'string' ? t.by : 'operator',
      reason: typeof t.reason === 'string' ? t.reason : '',
      ...(typeof t.workspaceId === 'string' && t.workspaceId ? { workspaceId: t.workspaceId } : {}),
      ...(isRole(t.role) ? { role: t.role } : {}),
    }))
}

/** The tracked list from this machine's file. A CORRUPT file is an error, never an empty list (see `parseTracked`). */
export function readTracked(dataDir: string): readonly TrackedEntry[] {
  const f = trackedFile(dataDir)
  if (!existsSync(f)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    throw new Error(`${f} is not readable JSON (${(e as Error).message}); nothing is tracked or untracked until a person repairs it`)
  }
  return parseTracked(parsed, f)
}

/**
 * The store twin: the deployment's `tracked.json` ledger document — Upstash on
 * the deployment, and on a machine the very file `readTracked` reads, because
 * the file ledger document IS the file (ledger-doc.ts). A corrupt document is
 * an error, as a corrupt file is.
 */
export async function readTrackedIn(ledgers: LedgerStores, where: string = `the ${TRACKED} ledger document`): Promise<readonly TrackedEntry[]> {
  let parsed: unknown
  try {
    parsed = await ledgers.doc(TRACKED).read()
  } catch (e) {
    throw new Error(`${where} is not readable JSON (${(e as Error).message}); nothing is tracked or untracked until a person repairs it`)
  }
  return parseTracked(parsed, where)
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
  /** the workspace the cycle is filed in: `local` on a machine (ADR-0018 D6) */
  readonly workspaceId: string
  readonly category: string
  readonly curatedPrompts: number
  readonly customPrompts: number
  readonly cells: number
  readonly usd: number
}

export interface NotDue {
  readonly host: string
  readonly workspaceId: string
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

/** What a store holds about one tracked host, read by either twin and decided by `decideDue`. */
export interface DueFacts {
  readonly record: CategoryRecord | null
  /** the bank for the record's slug in this build, when one exists */
  readonly bank: ReturnType<typeof allBanks>[number] | null
  readonly customPrompts: number
  /** the newest stored cycle, when any */
  readonly prior: { readonly day: string; readonly comparisonBasis: string } | null
}

/** How a scan is sized in this environment: the gate's engines and prompt count, the plan, and the price of one prompt across the engines. */
interface Sizing {
  readonly gate: GateConfig
  readonly plan: OwnPlan
  readonly perPrompt: number
}

const sizingOf = (dataDir: string, env: NodeJS.ProcessEnv): Sizing => {
  const gate = defaultGateConfig(dataDir, env)
  const planRaw = env['OPENWEBNINJA_PLAN']
  const plan: OwnPlan = planRaw === 'pro' || planRaw === 'ultra' || planRaw === 'mega' ? planRaw : 'payg'
  return { gate, plan, perPrompt: gate.engines.reduce((n, e) => n + PRICE_USD_PER_CALL[plan][e], 0) }
}

/** The route's own guard (`/api/scan`): a prompt count that is not a positive integer cannot size a scan, and nothing is collected. */
const cannotSize = (gate: GateConfig, env: NodeJS.ProcessEnv): string | null =>
  !Number.isInteger(gate.callsPerEngine) || gate.callsPerEngine <= 0
    ? `GRADER_PROMPTS_PER_SCAN is ${JSON.stringify(env['GRADER_PROMPTS_PER_SCAN'])}, which cannot size a scan; nothing is due until it is a positive integer`
    : null

/**
 * THE DECISION, for one tracked host, over the facts its store holds. Applies
 * the refusals a person's click meets that are FACTS ABOUT THE STORE: a
 * record and a bank, no cycle yet today, the prior cycle's prompt count and
 * engine set unchanged (or the new cycle could not join the trend). The
 * MANUAL per-domain ceiling is not consulted: it counts hand-started cycles
 * and the loop has its own bounds (ADR-0017). A host with a record and a bank
 * costs the day's cap its expected cycle whether or not it is due today.
 */
export function decideDue(
  entry: Pick<TrackedEntry, 'host' | 'workspaceId'>,
  facts: DueFacts,
  sizing: Sizing,
  day: string,
): { readonly tracked: TrackedCost | null; readonly verdict: { readonly due: DueDomain } | { readonly notDue: NotDue } } {
  const workspaceId = workspaceOf(entry)
  const { gate, perPrompt } = sizing
  if (!facts.record) return { tracked: null, verdict: { notDue: { host: entry.host, workspaceId, reason: 'no-record', detail: 'no category record' } } }
  if (!facts.bank) return { tracked: null, verdict: { notDue: { host: entry.host, workspaceId, reason: 'no-bank', detail: `no bank for ${facts.record.slug} in this build` } } }
  const curated = promptsFor(facts.bank, gate.callsPerEngine).length
  const custom = facts.customPrompts
  const cells = (curated + custom) * gate.engines.length
  const usd = (curated + custom) * perPrompt
  // Expected cost is a fact about the tracked domain, due today or not: the day's cap is the sum over all of them.
  const tracked: TrackedCost = { host: entry.host, cells, usd }
  if (facts.prior && facts.prior.day === day) {
    return { tracked, verdict: { notDue: { host: entry.host, workspaceId, reason: 'cycle-today', detail: `a cycle for ${day} is already stored` } } }
  }
  if (facts.prior) {
    const was = basisOf(facts.prior.comparisonBasis)
    const engines = [...gate.engines].sort().join(',')
    const priorEngines = was.engines ? [...was.engines].sort().join(',') : engines
    if ((was.maxPrompts !== undefined && was.maxPrompts !== curated) || priorEngines !== engines) {
      return {
        tracked,
        verdict: {
          notDue: {
            host: entry.host,
            workspaceId,
            reason: 'basis-moved',
            detail: `the prior cycle (${facts.prior.day}) was ${was.maxPrompts ?? '?'} prompts on ${priorEngines}; today would be ${curated} on ${engines}, which could not join the trend`,
          },
        },
      }
    }
  }
  return { tracked, verdict: { due: { host: entry.host, workspaceId, category: facts.record.slug, curatedPrompts: curated, customPrompts: custom, cells, usd } } }
}

/** The list, from the decisions: totals over what is due, the cap's basis over everything tracked. */
function assemble(day: string, sizing: Sizing, decided: readonly ReturnType<typeof decideDue>[]): DueList {
  const due: DueDomain[] = []
  const notDue: NotDue[] = []
  const tracked: TrackedCost[] = []
  for (const d of decided) {
    if (d.tracked) tracked.push(d.tracked)
    if ('due' in d.verdict) due.push(d.verdict.due)
    else notDue.push(d.verdict.notDue)
  }
  return { day, plan: sizing.plan, due, notDue, cells: due.reduce((n, d) => n + d.cells, 0), usd: due.reduce((n, d) => n + d.usd, 0), tracked }
}

const empty = (day: string, sizing: Sizing, config: string): DueList => ({ day, plan: sizing.plan, due: [], notDue: [], cells: 0, usd: 0, tracked: [], config })

/** The facts from this machine's files. */
function factsFromFiles(dataDir: string, host: string): DueFacts {
  const record = readCategoryRecord(dataDir, host)
  const bank = record ? (allBanks(dataDir).find((b) => b.category === record.slug) ?? null) : null
  const cycles = listCycles(dataDir, host)
  const prior = cycles[cycles.length - 1]
  return {
    record,
    bank,
    customPrompts: readCustomPromptSet(dataDir, host)?.prompts.length ?? 0,
    prior: prior ? { day: prior.day, comparisonBasis: (prior.result as { comparisonBasis?: string }).comparisonBasis ?? '' } : null,
  }
}

/** The facts from a workspace's store; the banks are this build's and the generated ones under the data directory, as the runner reads them. */
async function factsFromStore(store: WorkspaceStore, dataDir: string, host: string): Promise<DueFacts> {
  const record = await categoryRecordIn(store, host)
  const bank = record ? (allBanks(dataDir).find((b) => b.category === record.slug) ?? null) : null
  const prior = await store.cycles.latest(host)
  return {
    record,
    bank,
    customPrompts: (await customPromptsIn(store, host))?.prompts.length ?? 0,
    prior: prior ? { day: prior.day, comparisonBasis: prior.comparisonBasis } : null,
  }
}

/**
 * Everything a tick would do today, decided the way `/api/scan` decides a
 * person's click for the gates that are FACTS ABOUT THE STORE (see
 * `decideDue`), over this machine's tracked file and this machine's files.
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
  const sizing = sizingOf(dataDir, env)
  const config = cannotSize(sizing.gate, env)
  if (config) return empty(day, sizing, config)
  return assemble(
    day,
    sizing,
    readTracked(dataDir).map((entry) => decideDue(entry, factsFromFiles(dataDir, entry.host), sizing, day)),
  )
}

/**
 * The store twin (ADR-0018 D3): the same list over the deployment's tracked
 * entries, each read through the WORKSPACE STORE its entry names — the
 * caller opens one per entry (the fan-out mints a token for the account that
 * switched the domain on; a machine passes its file store). The banks are
 * read from the data directory as the runner reads them: the curated ones
 * are this build's, and a generated one is this instance's until banks move
 * to the database (ADR-0002 Amendment 2).
 */
export async function dueTodayIn(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  day: string,
  tracked: readonly { readonly entry: TrackedEntry; readonly store: WorkspaceStore }[],
): Promise<DueList> {
  const sizing = sizingOf(dataDir, env)
  const config = cannotSize(sizing.gate, env)
  if (config) return empty(day, sizing, config)
  const decided: ReturnType<typeof decideDue>[] = []
  for (const { entry, store } of tracked) decided.push(decideDue(entry, await factsFromStore(store, dataDir, entry.host), sizing, day))
  return assemble(day, sizing, decided)
}

/**
 * One host's decision over its workspace's store, for a domain job that was
 * published by a fan-out and must re-decide at run time (ADR-0018 D4): the
 * cycle may have been filed by a hand-started scan since, or the basis moved.
 */
export async function decideDueIn(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  day: string,
  entry: Pick<TrackedEntry, 'host' | 'workspaceId'>,
  store: WorkspaceStore,
): Promise<{ readonly config: string } | ReturnType<typeof decideDue>> {
  const sizing = sizingOf(dataDir, env)
  const config = cannotSize(sizing.gate, env)
  if (config) return { config }
  return decideDue(entry, await factsFromStore(store, dataDir, entry.host), sizing, day)
}

/** The monthly bill a tracked set implies at one cycle a day. */
export function monthlyEstimate(list: DueList, daysPerMonth = 30): { readonly cellsPerDay: number; readonly usdPerDay: number; readonly usdPerMonth: number } {
  return { cellsPerDay: list.cells, usdPerDay: list.usd, usdPerMonth: list.usd * daysPerMonth }
}
