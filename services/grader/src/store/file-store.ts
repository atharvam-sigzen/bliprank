import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allPending, requestsFor } from '../category-requests.js'
import { allPendingCompetitorRequests, competitorRequestsFor } from '../competitor-overrides.js'
import { allPendingPromptRequests, promptRequestsFor, readCustomPromptSet } from '../custom-prompts.js'
import { latestCycle, listCycles, readCycle, writeCycle, type CycleResult, type StoredCycle as FileCycle } from '../cycles.js'
import { readOverride } from '../override-store.js'
import { detectMultiInstanceRuntime } from '../ledger-stores.js'
import { readCategoryRecord, withRecordLock } from '../resolve-category.js'
import type { DocumentKind, RequestKind, StoredCycle, StoredRequest, Versioned, WorkspaceStore } from './pg-store.js'

/**
 * THE FILE STORE — the `WorkspaceStore` interface over the layout
 * services/grader/data-live has always had, for the CLIs and the local demo.
 * MVP_PLAN B3b.
 *
 * One machine, one tenant: there is no workspace here because the directory
 * IS the workspace. The deployment never uses this (apps/public/lib/workspace-
 * access.ts refuses it on a multi-instance runtime); a laptop running the
 * Grader with identity off does, and so do `pnpm grader:correct` and its
 * siblings, which keep their own file functions and never see this module.
 *
 * READS ARE THE MODULES' OWN. A hand-edited file is a trust boundary the
 * modules already guard (`readCategoryRecord`, `readOverride`,
 * `readCustomPromptSet`, the three request readers validate shape and drop
 * what fails), so every read here goes through them rather than through a
 * second parser. Writes are generic: the three document files share one shape
 * (a record per host with `version` and `superseded`), and so do the three
 * request files (a list per host with `requestedAt` and `status`), so one
 * writer serves each family under the same lock the modules take.
 *
 * NEVER AUTHORITATIVE BESIDE THE POSTGRES STORE. Their version sequences are
 * independent, so a correction applied through one is invisible to the
 * other's write-once check (the 0004 audit, Q6). A deployment has one store.
 */

const DOC_FILE: Record<DocumentKind, string> = { 'category-record': 'domain-categories.json', 'competitor-override': 'competitor-overrides.json', 'custom-prompts': 'custom-prompts.json' }
const REQ_FILE: Record<RequestKind, string> = { category: 'category-requests.json', competitors: 'competitor-requests.json', 'custom-prompts': 'custom-prompt-requests.json' }
/** Resolved requests kept per host, most recent last: the modules' own figure. */
const HISTORY_PER_HOST = 20

type Doc = Record<string, unknown> & { readonly version: number; readonly superseded?: readonly Record<string, unknown>[] }
type Req = Record<string, unknown> & { readonly host: string; readonly requestedAt: string; readonly status: 'pending' | 'applied' | 'declined'; readonly resolvedAt?: string; readonly resolvedBy?: string; readonly note?: string }

const readRaw = (file: string): Record<string, unknown> => {
  try {
    if (!existsSync(file)) return {}
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
const writeRaw = (dataDir: string, file: string, value: unknown): void => {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

const writtenAtOf = (d: Record<string, unknown>): string => (typeof d['decidedAt'] === 'string' ? d['decidedAt'] : typeof d['at'] === 'string' ? d['at'] : '')

/** The validated current document, superseded history and all, or null. */
function currentDoc(dataDir: string, kind: DocumentKind, host: string): Doc | null {
  switch (kind) {
    case 'category-record':
      return readCategoryRecord(dataDir, host) as Doc | null
    case 'competitor-override':
      return readOverride(dataDir, host) as Doc | null
    case 'custom-prompts':
      return readCustomPromptSet(dataDir, host) as Doc | null
  }
}

/** The chain newest first: the current document, then every superseded one (the file keeps them oldest first). */
function chainOf<T>(cur: Doc): Omit<Versioned<T>, 'superseded'>[] {
  const { superseded = [], ...body } = cur
  const head = { version: cur.version, body: body as T, writtenAt: writtenAtOf(body) }
  const rest = [...superseded].reverse().map((s) => ({ version: Number(s['version']), body: s as T, writtenAt: writtenAtOf(s) }))
  return [head, ...rest]
}

function requestsOf(dataDir: string, kind: RequestKind, host: string): readonly Req[] {
  switch (kind) {
    case 'category':
      return requestsFor(dataDir, host) as unknown as readonly Req[]
    case 'competitors':
      return competitorRequestsFor(dataDir, host) as unknown as readonly Req[]
    case 'custom-prompts':
      return promptRequestsFor(dataDir, host) as unknown as readonly Req[]
  }
}
function allPendingOf(dataDir: string, kind: RequestKind): readonly Req[] {
  switch (kind) {
    case 'category':
      return allPending(dataDir) as unknown as readonly Req[]
    case 'competitors':
      return allPendingCompetitorRequests(dataDir) as unknown as readonly Req[]
    case 'custom-prompts':
      return allPendingPromptRequests(dataDir) as unknown as readonly Req[]
  }
}

const storedOf = <T,>(r: Req): StoredRequest<T> => {
  const { requestedAt, status, resolvedAt, resolvedBy, note, ...body } = r
  return { id: requestedAt, host: r.host, body: body as T, requestedAt, status, resolvedAt: resolvedAt ?? null, resolvedBy: resolvedBy ?? null, note: note ?? null }
}

const cycleOf = (c: FileCycle): StoredCycle => {
  const r = c.result as unknown as Record<string, unknown>
  return { host: c.result.domain, day: c.day, algoVersion: String(r['algoVersion'] ?? ''), comparisonBasis: String(r['comparisonBasis'] ?? ''), result: r, writtenAt: String(r['collectedAt'] ?? '') }
}

export function fileWorkspaceStore(dataDir: string): WorkspaceStore {
  return {
    cycles: {
      async put(c) {
        // The same two guards the database's writer makes before the file's own.
        if (c.result['domain'] !== c.host) throw new Error(`workspace store: the result names domain ${String(c.result['domain'])}, filed under ${c.host}`)
        const stampedDay = (c.result['run'] as { day?: unknown } | undefined)?.day
        if (typeof stampedDay === 'string' && stampedDay !== c.day) throw new Error(`workspace store: the result was collected on ${stampedDay}, filed under ${c.day}`)
        const filed = writeCycle(dataDir, c.result as unknown as CycleResult)
        if ('refuse' in filed) throw new Error(`workspace store: ${filed.refuse}`)
      },
      async list(host) {
        return listCycles(dataDir, host).map(cycleOf)
      },
      async latest(host) {
        const got = latestCycle(dataDir, host)
        return got ? cycleOf(got) : null
      },
      async read(host, day) {
        const got = readCycle(dataDir, host, day)
        return got ? cycleOf(got) : null
      },
    },
    documents: {
      async latest<T>(kind: DocumentKind, host: string) {
        const cur = currentDoc(dataDir, kind, host)
        if (!cur) return null
        const [head, ...rest] = chainOf<T>(cur)
        return { ...head!, superseded: rest }
      },
      async at<T>(kind: DocumentKind, host: string, version: number) {
        const cur = currentDoc(dataDir, kind, host)
        if (!cur) return null
        const chain = chainOf<T>(cur)
        const i = chain.findIndex((v) => v.version === version)
        return i < 0 ? null : { ...chain[i]!, superseded: chain.slice(i + 1) }
      },
      async put(kind, host, body, expectVersion) {
        return withRecordLock(dataDir, () => {
          const file = join(dataDir, DOC_FILE[kind])
          const cur = currentDoc(dataDir, kind, host)
          const have = cur?.version ?? 0
          if (have !== expectVersion) {
            throw new Error(`workspace store: ${kind} for ${host} is at version ${have}, not ${expectVersion}; read it again before deciding`)
          }
          const history = cur ? [...(cur.superseded ?? []), (({ superseded: _h, ...prior }) => prior)(cur)] : []
          const next = { ...body, host, version: have + 1, ...(history.length ? { superseded: history } : {}) }
          writeRaw(dataDir, file, { ...readRaw(file), [host]: next })
          return have + 1
        })
      },
    },
    requests: {
      async pending<T>(kind: RequestKind, host: string) {
        const r = requestsOf(dataDir, kind, host).find((x) => x.status === 'pending')
        return r ? storedOf<T>(r) : null
      },
      async forHost<T>(kind: RequestKind, host: string) {
        return requestsOf(dataDir, kind, host).map((r) => storedOf<T>(r))
      },
      async allPending<T>(kind: RequestKind) {
        return allPendingOf(dataDir, kind).map((r) => storedOf<T>(r))
      },
      async file(kind, host, body, requestedAt) {
        return withRecordLock(dataDir, () => {
          const file = join(dataDir, REQ_FILE[kind])
          const raw = readRaw(file)
          const list = (Array.isArray(raw[host]) ? (raw[host] as Req[]) : []).filter((r) => r.status !== 'pending').slice(-HISTORY_PER_HOST)
          writeRaw(dataDir, file, { ...raw, [host]: [...list, { host, ...body, requestedAt, status: 'pending' }] })
          return requestedAt
        })
      },
      async resolve(kind, host, expectRequestedAt, outcome) {
        return withRecordLock(dataDir, () => {
          const file = join(dataDir, REQ_FILE[kind])
          const raw = readRaw(file)
          const list = Array.isArray(raw[host]) ? (raw[host] as Req[]) : []
          const i = list.findIndex((r) => r.status === 'pending')
          if (i < 0 || list[i]!.requestedAt !== expectRequestedAt) return false
          const resolved: Req = { ...list[i]!, status: outcome.status, resolvedAt: new Date().toISOString(), resolvedBy: outcome.by, ...(outcome.note ? { note: outcome.note } : {}) }
          writeRaw(dataDir, file, { ...raw, [host]: [...list.slice(0, i), ...list.slice(i + 1), resolved].slice(-HISTORY_PER_HOST) })
          return true
        })
      },
    },
  }
}

/**
 * The store a grader function falls back to when its caller passed none:
 * this machine's files — and, on a fleet runtime, a loud refusal. On a
 * deployment the routes pass the session's store; a forgotten argument there
 * would otherwise read and write one instance's shared /tmp as if it were a
 * workspace (B3b tenancy audit). The CLIs run on a machine and get the files.
 */
export function defaultWorkspaceStore(dataDir: string, env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  const marker = detectMultiInstanceRuntime(env)
  if (marker) throw new Error(`workspace store: ${marker} is set, so this runtime is many instances; a caller here must pass the session's store, never fall back to files`)
  return fileWorkspaceStore(dataDir)
}
