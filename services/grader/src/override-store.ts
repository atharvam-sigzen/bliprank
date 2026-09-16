/**
 * The competitor-override store, read side only. ADR-0016, decision 3.
 *
 * Split from `competitor-overrides.ts` so `resolve-category.ts` can ask "is an
 * override in force?" before correcting a category, without a dependency
 * cycle: this file imports nothing of the grader's own.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normaliseHost } from '@bliprank/taxonomy'

export interface CompetitorOverride {
  readonly host: string
  /** 1 on the first override, one more per change. The basis carries it as `set=`. */
  readonly version: number
  /** Leader ids removed from the category's set. */
  readonly exclude: readonly string[]
  /** Leader ids added from the reviewed sources. */
  readonly include: readonly string[]
  readonly reason: string
  readonly by: string
  readonly at: string
  /** Every earlier override, whole, oldest first. */
  readonly superseded?: readonly SupersededOverride[]
}
export type SupersededOverride = Omit<CompetitorOverride, 'superseded'>

export const overridesFile = (dataDir: string): string => join(dataDir, 'competitor-overrides.json')

/** A leader id as the banks write them: a slug, or promotion's `promoted:<key>`. Never free text. */
export const isLeaderId = (s: unknown): s is string => typeof s === 'string' && /^(promoted:)?[a-z0-9._-]{1,80}$/.test(s)

/** Unique, sorted, valid ids; anything else dropped. */
export const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter(isLeaderId))].sort() : [])

function shapeOverride(host: string, value: unknown, withHistory: boolean): CompetitorOverride | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Partial<CompetitorOverride>
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return null
  if (typeof r.reason !== 'string' || typeof r.by !== 'string' || typeof r.at !== 'string') return null
  const superseded = withHistory && Array.isArray(r.superseded) ? r.superseded.map((v) => shapeOverride(host, v, false)).filter((v): v is CompetitorOverride => v !== null) : []
  return { host, version: r.version, exclude: ids(r.exclude), include: ids(r.include), reason: r.reason, by: r.by, at: r.at, ...(superseded.length ? { superseded } : {}) }
}

export function readOverrides(dataDir: string): Record<string, CompetitorOverride> {
  const f = overridesFile(dataDir)
  try {
    if (!existsSync(f)) return {}
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, CompetitorOverride> = {}
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      const o = shapeOverride(host, value, true)
      if (o) out[host] = o
    }
    return out
  } catch {
    return {}
  }
}

/** The override in force for a domain now, or null when the category's set applies alone. */
export function readOverride(dataDir: string, domain: string): CompetitorOverride | null {
  const host = normaliseHost(domain)
  return host ? (readOverrides(dataDir)[host] ?? null) : null
}

/** The override that was in force at `version`, for reading a stored cycle back under the set it was measured with. */
export function overrideAt(dataDir: string, domain: string, version: number): SupersededOverride | null {
  const current = readOverride(dataDir, domain)
  if (!current) return null
  if (current.version === version) {
    const { superseded: _h, ...now } = current
    return now
  }
  return current.superseded?.find((s) => s.version === version) ?? null
}
