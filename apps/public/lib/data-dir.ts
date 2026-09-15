import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Where the grader's data directory is, for a route: `GRADER_DATA_DIR` when
 * set (a test's scratch directory, a deployment's writable /tmp), else
 * services/grader/data-live under the repo root. One copy, where there were
 * eight (MVP_PLAN B3b).
 *
 * On the deployment the directory holds the shared corpus the routes read
 * (generated banks) and the scratch files the runner writes; workspace state
 * and the ledgers do not live in it there (lib/workspace-access.ts).
 */
export const ROOT: string = (() => {
  let curr = process.cwd()
  while (curr && curr !== dirname(curr)) {
    if (existsSync(join(curr, 'services', 'grader'))) return curr
    curr = dirname(curr)
  }
  return join(process.cwd(), '..', '..')
})()

export const dataDir = (env: NodeJS.ProcessEnv = process.env): string => env['GRADER_DATA_DIR'] || join(ROOT, 'services', 'grader', 'data-live')
