import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the grader's data directory is, for a process in this package:
 * `GRADER_DATA_DIR` when set (a test's scratch directory, a deployment's
 * writable /tmp), else services/grader/data-live beside this package. The
 * app has the same rule in apps/public/lib/data-dir.ts (MVP_PLAN B3b); this
 * is its twin for the CLIs and for the one test that reads whatever data the
 * machine holds and must find nothing on a clean checkout (MVP_PLAN B5).
 */
export const defaultDataDir = (env: NodeJS.ProcessEnv = process.env): string => env['GRADER_DATA_DIR'] || join(dirname(fileURLToPath(import.meta.url)), '..', 'data-live')
