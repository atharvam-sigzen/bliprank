import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** `--key value` / `--key=value` / `--flag` → Map. Positional args are ignored. */
export function parseArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) {
      out.set(a.slice(2, eq), a.slice(eq + 1))
    } else {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.set(a.slice(2), next)
        i++
      } else out.set(a.slice(2), true)
    }
  }
  return out
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))
  return s[idx]!
}

/**
 * Minimal dotenv loader: `.env.local` first, then `.env` (KEY=VALUE, # comments,
 * optional quotes). Existing process.env values win, and `.env.local` wins over
 * `.env`, so a session that pins COLLECTION_ENABLED=false in its environment
 * stays off regardless of either file. Never logs values. Returns the keys it
 * set, tagged with the file they came from.
 */
export const COLLECTOR_ENV_KEYS = ['OPENWEBNINJA_API_KEY', 'OPENWEBNINJA_PLAN', 'COLLECTION_ENABLED', 'COLLECTION_BUDGET_USD'] as const

export function loadDotEnv(root: string, env: NodeJS.ProcessEnv = process.env, only: readonly string[] = COLLECTOR_ENV_KEYS): string[] {
  const loaded: string[] = []
  for (const name of ['.env.local', '.env']) {
    const file = join(root, name)
    if (!existsSync(file)) continue
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      if (!only.includes(key)) continue // least privilege: the collector never needs the other secrets
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
      if (env[key] === undefined || env[key] === '') {
        env[key] = val
        loaded.push(`${key} (${name})`)
      }
    }
  }
  return loaded
}

/** @deprecated kept for one release; use loadDotEnv */
export const loadDotEnvLocal = loadDotEnv
