import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Budget, KvSpendLedger, LocalSpendLedger, detectMultiInstanceRuntime, resolveTopology, TOPOLOGY_ENV, type KV, type SpendLedger } from '@bliprank/collector'
import { answerStores, ANSWER_STORE_ENV } from './answer-stores.js'
import { fileLedgerDoc, kvLedgerDoc, withRunAllowance, type LedgerDoc } from './ledger-doc.js'

export { detectMultiInstanceRuntime, resolveTopology }

/**
 * WHERE THE LEDGERS LIVE — Upstash when the deployment is configured for the
 * answer store, this machine's data directory when the process has DECLARED
 * itself the only one over it, and refused otherwise. MVP_PLAN B3b and B3c
 * item 4, rule R3, ADR-0006.
 *
 * One decision, taken where `answerStores` takes its own: the six variables
 * that put raw answers in R2 and their index in Upstash also put every ledger
 * in Upstash, because a deployment with an index it can reach and ledgers it
 * cannot is a deployment where every instance has its own cap. The file
 * backend is what every CLI and test uses, and what the local Grader uses.
 *
 * ⚠️ THE FILE BACKEND IS DECLARED, NOT INFERRED (B3c item 4). The first
 * version chose it whenever no PaaS marker was set and then told the
 * collector's guard `COLLECTOR_TOPOLOGY=single-process` on its behalf. That
 * is the guard ADR-0006 exists to keep: a Hetzner fleet sets no PaaS marker,
 * so a declared `COLLECTOR_TOPOLOGY=fleet` with no Upstash got a file ledger
 * per instance and a full cap on each, and the override erased the one
 * declaration that would have refused it. Now `resolveTopology` decides as
 * it decides for the collector: a marker or a declared fleet is refused
 * without Upstash; an undeclared runtime is refused too, because a bare VM
 * looks exactly like a laptop from in here; only `single-process`, declared
 * in the environment the process was given, opens the file backend, and
 * `spend()` hands that environment to the collector unchanged.
 *
 * Two kinds of ledger, two shapes:
 *   - `doc(name)`: a count ledger, one JSON value replaced under a lock
 *     (ledger-doc.ts): scans today, cycles this month, a visitor's hour, the
 *     daily loop's day and its tick lock.
 *   - `spend(name, …)`: a dollar ledger with charge-before-attempt semantics,
 *     the collector's own `Budget` over a file or `KvSpendLedger` over atomic
 *     increments; `runAllowanceCalls` bounds one run's attempts on either.
 *
 * ⚠️ HUMAN-OWNED area (CLAUDE.md §4: spend-control logic).
 */
export interface LedgerStores {
  readonly backend: 'kv' | 'file'
  doc(name: string): LedgerDoc
  spend(name: string, capUsd: number, priceUsd: (engine: string) => number, opts?: { readonly runAllowanceCalls?: number; readonly engines?: readonly string[] }): SpendLedger
}

const REASON = `grader on one machine: one process over its data directory, declared ${TOPOLOGY_ENV}=single-process in its environment (ADR-0006)`
const UPSTASH = `Set all of ${ANSWER_STORE_ENV.join(', ')} so the ledgers live in Upstash`

/** The ledgers over one KV: what the deployment gets over Upstash, and what a test gets over the collector's in-memory double. */
export function kvLedgerStores(kv: KV): LedgerStores {
  return {
    backend: 'kv',
    doc: (name) => kvLedgerDoc(kv, `ledger:${name.replace(/\.json$/, '')}`),
    spend(name, capUsd, priceUsd, opts = {}) {
      // A lifetime figure, as the file it replaces was: the window is `total`.
      const ledger = new KvSpendLedger({ kv, capUsd, priceUsd, keyPrefix: `spend:${name.replace(/\.json$/, '')}`, window: 'total', ...(opts.engines ? { engines: opts.engines } : {}) })
      return opts.runAllowanceCalls === undefined ? ledger : withRunAllowance(ledger, opts.runAllowanceCalls)
    },
  }
}

export function ledgerStores(dataDir: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): LedgerStores {
  const answers = answerStores(dataDir, env, fetchImpl)
  if (answers.backend === 'r2+upstash') return kvLedgerStores(answers.kv)
  const { topology, because } = resolveTopology(env)
  if (topology === 'fleet') {
    throw new Error(`ledgers: ${because}, so this runtime is many instances, and a file ledger would be a cap per instance (R3). ${UPSTASH}.`)
  }
  if (topology === 'undeclared') {
    throw new Error(
      `ledgers: ${because}, so this process cannot show it is the only one over ${dataDir}, and a file ledger there may be a cap per process (R3, ADR-0006). A machine that really is one process declares ${TOPOLOGY_ENV}=single-process; a deployment does not, and instead ${UPSTASH.charAt(0).toLowerCase()}${UPSTASH.slice(1)}.`,
    )
  }
  return {
    backend: 'file',
    doc: (name) => fileLedgerDoc(join(dataDir, name)),
    spend(name, capUsd, priceUsd, opts = {}) {
      // `Budget` refuses to raise a cap from code and lowers one on request;
      // that rule is the file's and stays the file's. The environment goes to
      // the collector's guard as it was given: the declaration is the
      // caller's, never written here.
      const budget = new Budget(join(dataDir, name), capUsd, priceUsd, () => new Date(), opts.runAllowanceCalls)
      return LocalSpendLedger.forSingleProcess(budget, { iUnderstandThisCapIsPerProcess: true, reason: REASON, env })
    },
  }
}

/**
 * The environment a CLI hands to `ledgerStores` when it is one process by
 * construction: the runner holds an exclusive `run.lock` over its data
 * directory, the tick is one command a person runs. It declares
 * `single-process` ONLY when the environment declares nothing. A declared
 * fleet stays declared and is refused, and a PaaS marker wins over any
 * declaration inside `resolveTopology`, so this can never turn a fleet into a
 * laptop; it only spares a person exporting a variable before a manual run,
 * as the collector's own pilot runner does (services/collector, ADR-0006).
 * A route never calls this: on the web tier the declaration comes from the
 * deployment's environment or not at all (apps/public/lib/workspace-access.ts).
 */
export function declaredSingleProcess(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return env[TOPOLOGY_ENV] ? env : { ...env, [TOPOLOGY_ENV]: 'single-process' }
}

/** A file ledger's own cap, when one exists and reads: the figure that wins over a configured default (the rule `ledgerCapUsd` and the bank author apply). */
export function fileCapUsd(file: string): number | null {
  if (!existsSync(file)) return null
  try {
    const cap = (JSON.parse(readFileSync(file, 'utf8')) as { capUsd?: unknown }).capUsd
    return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : null
  } catch {
    return null
  }
}
