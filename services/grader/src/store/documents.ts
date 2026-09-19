import { distinctPrompts } from '@bliprank/contracts'
import type { CustomPromptSet, SupersededSet } from '../custom-prompts.js'
import type { CompetitorOverride, SupersededOverride } from '../override-store.js'
import type { CategoryRecord, CategoryRecordStore, NewCategoryRecord } from '../resolve-category.js'
import type { CycleInput, Versioned, WorkspaceStore } from './pg-store.js'

/**
 * The grader's three document types, read back from a `WorkspaceStore` in the
 * shape their modules define: `version` from the store's row, `superseded`
 * reassembled oldest first the way the files hold it. One assembly for both
 * stores, so a route and the runner see the same record whichever backend
 * is configured (MVP_PLAN B3b).
 */
function assemble<T extends object>(v: Versioned<T>): T & { readonly version: number; readonly superseded?: readonly (T & { readonly version: number })[] } {
  const history = [...v.superseded].reverse().map((s) => ({ ...s.body, version: s.version }))
  return { ...v.body, version: v.version, ...(history.length ? { superseded: history } : {}) }
}

export async function categoryRecordIn(store: WorkspaceStore, host: string): Promise<CategoryRecord | null> {
  const v = await store.documents.latest<Omit<CategoryRecord, 'version' | 'superseded'>>('category-record', host)
  return v ? (assemble(v) as CategoryRecord) : null
}

export async function overrideIn(store: WorkspaceStore, host: string): Promise<CompetitorOverride | null> {
  const v = await store.documents.latest<Omit<CompetitorOverride, 'version' | 'superseded'>>('competitor-override', host)
  return v ? (assemble(v) as CompetitorOverride) : null
}

/** The override in force at `version`, without history: what a stored cycle was measured against. */
export async function overrideAtIn(store: WorkspaceStore, host: string, version: number): Promise<SupersededOverride | null> {
  const v = await store.documents.at<Omit<CompetitorOverride, 'version' | 'superseded'>>('competitor-override', host, version)
  return v ? { ...v.body, version: v.version } : null
}

// A set is read the way the file twin reads one (`shapeSet`, custom-prompts.ts): each question once (C3r item 8). The
// database's writer takes the body the checker produced, so a repeat here means a document that reached the table some other way.
const oncePer = <T extends { readonly prompts: readonly string[] }>(set: T): T => ({ ...set, prompts: distinctPrompts(Array.isArray(set.prompts) ? set.prompts.filter((p): p is string => typeof p === 'string') : []) })

export async function customPromptsIn(store: WorkspaceStore, host: string): Promise<CustomPromptSet | null> {
  const v = await store.documents.latest<Omit<CustomPromptSet, 'version' | 'superseded'>>('custom-prompts', host)
  if (!v) return null
  const set = assemble(v) as CustomPromptSet
  return { ...oncePer(set), ...(set.superseded ? { superseded: set.superseded.map(oncePer) } : {}) }
}

export async function customPromptsAtIn(store: WorkspaceStore, host: string, version: number): Promise<SupersededSet | null> {
  const v = await store.documents.at<Omit<CustomPromptSet, 'version' | 'superseded'>>('custom-prompts', host, version)
  return v ? oncePer({ ...v.body, version: v.version }) : null
}

/**
 * The resolver's record store over a `WorkspaceStore`. Write-once is kept by
 * the store: the first decision is written against version 0, so two scans
 * deciding at once cannot both land — the second reads the winner's record
 * back instead of stacking a version 2 on it.
 */
export function recordsIn(store: WorkspaceStore): CategoryRecordStore {
  return {
    read: (host) => categoryRecordIn(store, host),
    async write(record: NewCategoryRecord) {
      const existing = await categoryRecordIn(store, record.host)
      if (existing) return existing
      try {
        const version = await store.documents.put('category-record', record.host, record, 0)
        return { ...record, version }
      } catch (e) {
        const won = await categoryRecordIn(store, record.host)
        if (won) return won
        throw e
      }
    },
  }
}

/** A finished scan as the store files it: the day, the version and the basis the result itself names. */
export function cycleInputOf(result: { readonly domain: string }): CycleInput {
  const r = result as unknown as Record<string, unknown>
  const run = r['run'] as { day?: unknown } | undefined
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    host: result.domain,
    day: str(run?.day) || str(r['collectedAt']).slice(0, 10),
    algoVersion: str(r['algoVersion']),
    comparisonBasis: str(r['comparisonBasis']),
    result: r,
  }
}

