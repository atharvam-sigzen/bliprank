import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Budget, KvSpendLedger, LocalSpendLedger, detectMultiInstanceRuntime, type SpendLedger } from '@bliprank/collector'
import { answerStores } from './answer-stores.js'
import { fileLedgerDoc, kvLedgerDoc, withRunAllowance, type LedgerDoc } from './ledger-doc.js'

export { detectMultiInstanceRuntime }

/**
 * WHERE THE LEDGERS LIVE — Upstash when the deployment is configured for the
 * answer store, this machine's data directory otherwise, and refused outright
 * on a runtime that is many instances with no shared store. MVP_PLAN B3b,
 * rule R3.
 *
 * One decision, taken where `answerStores` takes its own: the six variables
 * that put raw answers in R2 and their index in Upstash also put every ledger
 * in Upstash, because a deployment with an index it can reach and ledgers it
 * cannot is a deployment where every instance has its own cap. The file
 * backend is what every CLI and test uses, and what the local Grader uses.
 *
 * Two kinds of ledger, two shapes:
 *   - `doc(name)`: a count ledger, one JSON value replaced under a lock
 *     (ledger-doc.ts): scans today, cycles this month, a visitor's hour.
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

const REASON = 'grader on one machine: one process over its data directory, no fleet marker set'

export function ledgerStores(dataDir: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): LedgerStores {
  const answers = answerStores(dataDir, env, fetchImpl)
  if (answers.backend === 'r2+upstash') {
    const kv = answers.kv
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
  const marker = detectMultiInstanceRuntime(env)
  if (marker) {
    throw new Error(`ledgers: ${marker} is set, so this runtime is many instances, and a file ledger would be a cap per instance (R3). Set all of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN so the ledgers live in Upstash.`)
  }
  return {
    backend: 'file',
    doc: (name) => fileLedgerDoc(join(dataDir, name)),
    spend(name, capUsd, priceUsd, opts = {}) {
      // `Budget` refuses to raise a cap from code and lowers one on request;
      // that rule is the file's and stays the file's.
      const budget = new Budget(join(dataDir, name), capUsd, priceUsd, () => new Date(), opts.runAllowanceCalls)
      return LocalSpendLedger.forSingleProcess(budget, { iUnderstandThisCapIsPerProcess: true, reason: REASON, env: { ...env, COLLECTOR_TOPOLOGY: 'single-process' } })
    },
  }
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
