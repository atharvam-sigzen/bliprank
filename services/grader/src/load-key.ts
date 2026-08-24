/**
 * Read the provider key from `.env.local` / `.env`, and nothing else from them.
 *
 * SECRETS COME FROM THE FILE; DECISIONS COME FROM THE COMMAND LINE. This loads
 * `OPENWEBNINJA_API_KEY` only. It deliberately does NOT load
 * `COLLECTION_ENABLED`, `OPENWEBNINJA_PLAN` or any cap: CLAUDE.md §7 says
 * enabling collection is "a deliberate, logged act", and a runner that picks up
 * `COLLECTION_ENABLED=true` from a file someone edited last month is not that.
 * Those stay where they are visible in the shell history of the person who ran
 * it.
 *
 * Why this exists rather than passing the key on the command line: a key on a
 * command line ends up in shell history, in `ps` output, and — as happened here
 * — in a terminal transcript the moment any surrounding command misbehaves.
 * Reading it in-process keeps it out of all three.
 *
 * Handles CRLF. A `.env` written on Windows has `KEY=value\r`, and the trailing
 * carriage return silently becomes part of the value: the request then carries a
 * bad header and the provider answers 401 for a key that is actually correct.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'OPENWEBNINJA_API_KEY'

/** Parse one variable out of dotenv-format text. Quotes and CRLF stripped. */
export function readVar(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0 || t.slice(0, eq).trim() !== name) continue
    const raw = t.slice(eq + 1).trim().replace(/\r$/, '')
    const v = /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw
    if (v) return v
  }
  return undefined
}

/**
 * The key from the environment if already set, else from `.env.local`, else
 * `.env`. `.env.local` wins because that is the conventional per-machine
 * override and the file least likely to be shared.
 */
export function loadApiKey(root: string, env: NodeJS.ProcessEnv = process.env): { key: string; from: string } | undefined {
  const fromEnv = env[NAME]?.trim()
  if (fromEnv) return { key: fromEnv, from: 'environment' }
  for (const f of ['.env.local', '.env']) {
    const p = join(root, f)
    if (!existsSync(p)) continue
    const v = readVar(readFileSync(p, 'utf8'), NAME)
    if (v) return { key: v, from: f }
  }
  return undefined
}
