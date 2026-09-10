import type { Db } from '@bliprank/db/client'

/**
 * THE WORKSPACE STORE — the grader's per-domain state, read and written
 * through migration 0004's tables and functions. MVP_PLAN B3.
 *
 * WHAT THIS IS. Cycles (one scored result per host, day and algorithm
 * version), versioned documents (the category record, the competitor
 * override, the custom prompt set — each with its history), and the requests
 * visitors file. The document bodies are the TypeScript types the grader's
 * modules already define (`CategoryRecord`, `CompetitorOverride`,
 * `CustomPromptSet`, the three request types) minus the `superseded` array,
 * which here is rows: `latest()` and `at()` reassemble it so a caller sees
 * the same shape the file store gave it.
 *
 * WHAT THIS IS NOT. It holds no invariant of its own beyond what the database
 * enforces (the version sequence, one pending request per host, who may
 * write): write-once first decisions, "a correction is not the same
 * category", PROPERTY 2 on custom prompts, the no-change refusal — all of
 * that stays in the grader modules that decide, and they call `put` only
 * after deciding. The file modules under services/grader/src are the same
 * decisions over files; moving them onto this interface is the second half
 * of B3 (see docs/MVP_PLAN.md).
 *
 * TENANCY IS THE CALLER'S TRANSACTION. Every method runs on the `Db` it was
 * given, which must be inside `withWorkspace()` (packages/db/client): the
 * functions take the workspace from the verified context and refuse without
 * one, and the reads see only that workspace's rows. Nothing here names a
 * workspace, and nothing here could.
 */

export type DocumentKind = 'category-record' | 'competitor-override' | 'custom-prompts'
export type RequestKind = 'category' | 'competitors' | 'custom-prompts'
export type RequestStatus = 'pending' | 'applied' | 'declined'

export interface CycleInput {
  readonly host: string
  /** YYYY-MM-DD, the UTC day the cycle was collected */
  readonly day: string
  readonly algoVersion: string
  readonly comparisonBasis: string
  /** the ScanResultFile the app serves, as written by the runner */
  readonly result: Record<string, unknown>
}

export interface StoredCycle {
  readonly host: string
  readonly day: string
  readonly algoVersion: string
  readonly comparisonBasis: string
  readonly result: Record<string, unknown>
  readonly writtenAt: string
}

export interface Versioned<T> {
  readonly version: number
  readonly body: T
  readonly writtenAt: string
  /** earlier versions, newest first, each without its own history */
  readonly superseded: readonly Omit<Versioned<T>, 'superseded'>[]
}

export interface StoredRequest<T> {
  readonly id: string
  readonly host: string
  readonly body: T
  readonly requestedAt: string
  readonly status: RequestStatus
  readonly resolvedAt: string | null
  readonly resolvedBy: string | null
  readonly note: string | null
}

export interface WorkspaceStore {
  readonly cycles: {
    put(cycle: CycleInput): Promise<void>
    /** every day this workspace holds for the host, oldest first, the newest algorithm version of each day */
    list(host: string): Promise<readonly StoredCycle[]>
    latest(host: string): Promise<StoredCycle | null>
    read(host: string, day: string): Promise<StoredCycle | null>
  }
  readonly documents: {
    latest<T>(kind: DocumentKind, host: string): Promise<Versioned<T> | null>
    at<T>(kind: DocumentKind, host: string, version: number): Promise<Versioned<T> | null>
    /** the new version number; the database chooses it */
    put<T extends object>(kind: DocumentKind, host: string, body: T): Promise<number>
  }
  readonly requests: {
    pending<T>(kind: RequestKind, host: string): Promise<StoredRequest<T> | null>
    forHost<T>(kind: RequestKind, host: string): Promise<readonly StoredRequest<T>[]>
    allPending<T>(kind: RequestKind): Promise<readonly StoredRequest<T>[]>
    /** files, replacing any pending request for the host; returns the new id */
    file<T extends object>(kind: RequestKind, host: string, body: T, requestedAt: string): Promise<string>
    /** true when the pending request with that requestedAt was resolved; false when it was no longer the one */
    resolve(kind: RequestKind, host: string, expectRequestedAt: string, outcome: { status: 'applied' | 'declined'; by: string; note?: string }): Promise<boolean>
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

interface CycleRow {
  host: string
  day: string
  algo_version: string
  comparison_basis: string
  result: Record<string, unknown>
  written_at: string
}
interface DocRow<T> {
  version: number
  body: T
  written_at: string
}
interface RequestRow<T> {
  id: string
  host: string
  body: T
  requested_at: string
  status: RequestStatus
  resolved_at: string | null
  resolved_by: string | null
  note: string | null
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))
const cycleOf = (r: CycleRow): StoredCycle => ({ host: r.host, day: String(r.day).slice(0, 10), algoVersion: r.algo_version, comparisonBasis: r.comparison_basis, result: r.result, writtenAt: iso(r.written_at) })
const requestOf = <T,>(r: RequestRow<T>): StoredRequest<T> => ({
  id: r.id,
  host: r.host,
  body: r.body,
  requestedAt: iso(r.requested_at),
  status: r.status,
  resolvedAt: r.resolved_at === null ? null : iso(r.resolved_at),
  resolvedBy: r.resolved_by,
  note: r.note,
})

function assertDay(day: string): void {
  if (!DAY.test(day)) throw new Error(`workspace store: a day is YYYY-MM-DD, got ${JSON.stringify(day)}`)
}

/** The store over a `Db` that is already inside a workspace context. */
export function pgWorkspaceStore(db: Db): WorkspaceStore {
  // The newest algorithm version per day: versions are strings ('det-2',
  // 'det-3'), ordered by the write that produced them, which is the order a
  // re-score happens in. `written_at` is the tie-break the reader wants.
  const CYCLES = `
    SELECT DISTINCT ON (host, day) host, day::text AS day, algo_version, comparison_basis, result, written_at
      FROM workspace_cycles WHERE host = $1
     ORDER BY host, day, written_at DESC`

  async function versioned<T>(kind: DocumentKind, host: string, upTo: number | null): Promise<Versioned<T> | null> {
    const rows = await db.query<DocRow<T>>(
      `SELECT version, body, written_at FROM workspace_documents WHERE kind = $1 AND host = $2 AND ($3::int IS NULL OR version <= $3) ORDER BY version DESC`,
      [kind, host, upTo],
    )
    const [head, ...rest] = rows
    if (!head) return null
    return {
      version: head.version,
      body: head.body,
      writtenAt: iso(head.written_at),
      superseded: rest.map((r) => ({ version: r.version, body: r.body, writtenAt: iso(r.written_at) })),
    }
  }

  return {
    cycles: {
      async put(c) {
        assertDay(c.day)
        await db.query('SELECT ws_put_cycle($1, $2::date, $3, $4, $5::jsonb)', [c.host, c.day, c.algoVersion, c.comparisonBasis, JSON.stringify(c.result)])
      },
      async list(host) {
        const rows = await db.query<CycleRow>(`SELECT * FROM (${CYCLES}) c ORDER BY day`, [host])
        return rows.map(cycleOf)
      },
      async latest(host) {
        const rows = await db.query<CycleRow>(`SELECT * FROM (${CYCLES}) c ORDER BY day DESC LIMIT 1`, [host])
        return rows[0] ? cycleOf(rows[0]) : null
      },
      async read(host, day) {
        assertDay(day)
        const rows = await db.query<CycleRow>(`SELECT * FROM (${CYCLES}) c WHERE day = $2`, [host, day])
        return rows[0] ? cycleOf(rows[0]) : null
      },
    },
    documents: {
      latest: <T,>(kind: DocumentKind, host: string) => versioned<T>(kind, host, null),
      async at<T>(kind: DocumentKind, host: string, version: number) {
        const got = await versioned<T>(kind, host, version)
        return got && got.version === version ? got : null
      },
      async put(kind, host, body) {
        const [row] = await db.query<{ v: number }>('SELECT ws_put_document($1, $2, $3::jsonb) AS v', [kind, host, JSON.stringify(body)])
        return row!.v
      },
    },
    requests: {
      async pending(kind, host) {
        const rows = await db.query<RequestRow<never>>(`SELECT * FROM workspace_requests WHERE kind = $1 AND host = $2 AND status = 'pending'`, [kind, host])
        return rows[0] ? requestOf(rows[0]) : null
      },
      async forHost(kind, host) {
        const rows = await db.query<RequestRow<never>>(`SELECT * FROM workspace_requests WHERE kind = $1 AND host = $2 ORDER BY requested_at`, [kind, host])
        return rows.map(requestOf)
      },
      async allPending(kind) {
        const rows = await db.query<RequestRow<never>>(`SELECT * FROM workspace_requests WHERE kind = $1 AND status = 'pending' ORDER BY requested_at`, [kind])
        return rows.map(requestOf)
      },
      async file(kind, host, body, requestedAt) {
        const [row] = await db.query<{ id: string }>('SELECT ws_file_request($1, $2, $3::jsonb, $4::timestamptz) AS id', [kind, host, JSON.stringify(body), requestedAt])
        return row!.id
      },
      async resolve(kind, host, expectRequestedAt, outcome) {
        const [row] = await db.query<{ r: boolean }>('SELECT ws_resolve_request($1, $2, $3::timestamptz, $4, $5, $6) AS r', [kind, host, expectRequestedAt, outcome.status, outcome.by, outcome.note ?? null])
        return row!.r
      },
    },
  }
}
