import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { RunAllowanceExceeded, type KV, type SpendLedger } from '@bliprank/collector'

/**
 * A LEDGER DOCUMENT — one JSON value, read whole and replaced whole under a
 * lock, wherever the deployment can reach it. MVP_PLAN B3b.
 *
 * The grader's count ledgers (scans today, cycles this month, a visitor's
 * scans this hour, the daily loop's day) were each a JSON file rewritten
 * after every change, correct on one machine because one process wrote it.
 * A deployment is many instances with no shared disk, so the same documents
 * now live behind this interface: files on a machine, Upstash on the
 * deployment, chosen once in ledger-stores.ts.
 *
 * `update` is the whole write path: read, decide, replace, under a lock. On
 * KV the lock is a `setnx` key with a short TTL, held for the round-trip and
 * released with `delIfEquals`; two instances recording the same scan
 * therefore serialise instead of one overwriting the other's count.
 *
 * ⚠️ HUMAN-OWNED area (CLAUDE.md §4: rate-limit and spend-control logic). The
 * dollar caps do not go through this: they are `SpendLedger`s with atomic
 * increments (the collector's `KvSpendLedger`), and a count here only ever
 * admits or refuses a scan that the dollar cap then bounds.
 */
/** What `update` hands its function when the stored text is not JSON: the writer decides, as each ledger module always has. */
export const CORRUPT: unique symbol = Symbol('corrupt ledger')

export interface LedgerDoc {
  /** The stored value, `null` when nothing was ever written. Throws when the stored text is not JSON: a corrupt ledger is the caller's decision. */
  read(): Promise<unknown>
  /** Replace the value with `fn(current)`, exclusively; `current` is CORRUPT when the stored text is not JSON. Returns what was written. */
  update<T>(fn: (current: unknown) => T): Promise<T>
}

const readOrCorrupt = async (read: () => Promise<unknown> | unknown): Promise<unknown> => {
  try {
    return await read()
  } catch {
    return CORRUPT
  }
}

/** How long a lock may be held before it is presumed abandoned, and how long a waiter tries. The same figures on both backends. */
const LOCK_TTL_SEC = 10
const LOCK_ATTEMPTS = 40
const LOCK_WAIT_MS = 50
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A file document, written under an EXCLUSIVE LOCK FILE (B3c cost review).
 *
 * The first version read, computed and wrote with nothing around it, on the
 * argument that one process runs on a machine. Two things were wrong with
 * that. The tick lock this replaced was a file opened `wx`, which the OS
 * makes exclusive across processes, so two `tick` commands started in the
 * same instant from two shells could not both win; a plain read-modify-write
 * lets both. And the read sat behind an `await`, so even inside ONE process
 * two updates could interleave and one count be lost.
 *
 * Now `${file}.lock` is created `wx` (the OS refuses a second creator), and
 * from the moment it is held to the moment the file is written there is no
 * `await`: the critical section is synchronous, so a second update in this
 * process cannot run inside it, and a second process cannot take the lock.
 * A lock older than the TTL belongs to a process that died and is reclaimed;
 * a waiter tries for as long as a KV waiter does and then fails CLOSED. The
 * shape is the KV one: setnx with a TTL, release after the write.
 */
export function fileLedgerDoc(file: string, sleep: (ms: number) => Promise<void> = defaultSleep): LedgerDoc {
  const read = (): unknown => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null)
  const lock = `${file}.lock`
  /** The lock's descriptor, or null while another writer holds a fresh one. */
  const tryLock = (): number | null => {
    try {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_TTL_SEC * 1000) rmSync(lock, { force: true })
    } catch {
      /* vanished between the check and the stat: the open below decides */
    }
    try {
      return openSync(lock, 'wx')
    } catch {
      return null
    }
  }
  return {
    async read() {
      return read()
    },
    async update(fn) {
      mkdirSync(dirname(file), { recursive: true })
      let fd: number | null = null
      for (let i = 0; i < LOCK_ATTEMPTS && fd === null; i++) {
        fd = tryLock()
        if (fd === null) await sleep(LOCK_WAIT_MS)
      }
      if (fd === null) throw new Error(`ledger ${file}: could not take its lock in ${(LOCK_ATTEMPTS * LOCK_WAIT_MS) / 1000}s; another writer holds ${lock}, or a process left it behind less than ${LOCK_TTL_SEC}s ago`)
      try {
        // No await from here to the write.
        let current: unknown
        try {
          current = read()
        } catch {
          current = CORRUPT
        }
        const next = fn(current)
        writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
        return next
      } finally {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
        rmSync(lock, { force: true })
      }
    },
  }
}

export function kvLedgerDoc(kv: KV, key: string, sleep: (ms: number) => Promise<void> = defaultSleep): LedgerDoc {
  const read = async (): Promise<unknown> => {
    const raw = await kv.get(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  }
  return {
    read,
    async update(fn) {
      const lockKey = `${key}:lock`
      const token = randomUUID()
      let held = false
      for (let i = 0; i < LOCK_ATTEMPTS && !held; i++) {
        held = await kv.setnx(lockKey, token, { ttlSec: LOCK_TTL_SEC })
        if (!held) await sleep(LOCK_WAIT_MS)
      }
      // Fail CLOSED: a ledger that cannot be locked is not written and the
      // caller does not proceed on a count it could not book.
      if (!held) throw new Error(`ledger ${key}: could not take its lock in ${(LOCK_ATTEMPTS * LOCK_WAIT_MS) / 1000}s; another writer holds it or the store is unreachable`)
      try {
        const next = fn(await readOrCorrupt(read))
        await kv.set(key, JSON.stringify(next))
        return next
      } finally {
        await kv.delIfEquals(lockKey, token)
      }
    },
  }
}

/**
 * The per-run allowance of ADR-0017 over any `SpendLedger`: at most `calls`
 * attempts from THIS wrapper, retries included, checked before the ledger's
 * own cap so a refusal here never marks the shared ledger exhausted. `Budget`
 * carries the same rule for the file path; this is the same rule for a
 * ledger that lives in KV.
 */
export function withRunAllowance(ledger: SpendLedger, calls: number): SpendLedger & { readonly runCalls: number } {
  if (!Number.isInteger(calls) || calls < 0) throw new RangeError(`runAllowanceCalls must be a non-negative integer, got ${calls}`)
  let made = 0
  return {
    get capUsd() {
      return ledger.capUsd
    },
    get runCalls() {
      return made
    },
    async charge(engine) {
      if (made + 1 > calls) {
        const spentUsd = await ledger.spentUsd()
        throw new RunAllowanceExceeded({ capUsd: ledger.capUsd, spentUsd, calls: made, byEngine: {}, updatedAt: new Date().toISOString() }, 0, made, calls)
      }
      await ledger.charge(engine)
      made += 1
    },
    spentUsd: () => ledger.spentUsd(),
    breakdown: () => ledger.breakdown(),
  }
}
