/**
 * Read the provider key from `.env.local` / `.env`, and nothing else from them.
 *
 * SECRETS COME FROM THE FILE; DECISIONS COME FROM THE COMMAND LINE — for the
 * CLI. `loadApiKey` loads `OPENWEBNINJA_API_KEY` only, and deliberately not
 * `OPENWEBNINJA_PLAN` or any cap: a runner that picks those up from a file
 * someone edited last month is not making a deliberate choice.
 *
 * ⚠️ THE ROUTE IS A DIFFERENT CASE, AND THE TWO DISAGREED. A long-lived dev
 * server has no command line per scan, so its flags can only come from its
 * environment or from a file. CLAUDE.md §7 says plainly that
 * `COLLECTION_ENABLED` lives in `.env.local`; this module refused to read it
 * from there. Both statements were in the repo at once, and the visible symptom
 * was an edit to `.env.local` that changed nothing, silently, with no error —
 * because Next only loads env files from the directory it runs in
 * (`apps/public`), never from the repo root where the key is kept.
 *
 * `readFlag` closes that gap for the route, and keeps the "deliberate act"
 * property by other means: it reads only an explicit allow-list of names, it
 * reports WHICH source set the value so the answer is never a guess, and the
 * route still requires two independent flags rather than one.
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

/**
 * Secrets this may be asked for. An allow-list, mirroring `FILE_FLAGS` below and
 * for the same reason: a general "read any variable from the dotenv file"
 * loader is a way for a name typed at a call site to reach a value nobody
 * intended to expose. Both keys here are named in CLAUDE.md §7.
 */
const SECRETS = new Set([NAME, 'ANTHROPIC_API_KEY'])

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
export function loadApiKey(root: string, env: NodeJS.ProcessEnv = process.env, name: string = NAME): { key: string; from: string } | undefined {
  // Parameterised rather than copied. `resolve-category.ts` needs
  // ANTHROPIC_API_KEY from the same two files, with the same precedence and the
  // same CRLF handling, and a second loader is a second thing to keep correct —
  // the one that would drift is whichever is touched less, which is exactly the
  // shape of the bug this file's own docblock describes.
  if (!SECRETS.has(name)) return undefined
  const fromEnv = env[name]?.trim()
  if (fromEnv) return { key: fromEnv, from: 'environment' }
  for (const f of ['.env.local', '.env']) {
    const p = join(root, f)
    if (!existsSync(p)) continue
    const v = readVar(readFileSync(p, 'utf8'), name)
    if (v) return { key: v, from: f }
  }
  return undefined
}

/**
 * Flags the route may read from a file. An allow-list, not a general loader:
 * anything not named here still has to come from the environment.
 */
const FILE_FLAGS = new Set(['COLLECTION_ENABLED', 'GRADER_LIVE_SCAN'])

/**
 * Resolve one boolean-ish flag, reporting where it came from.
 *
 * Environment first, so an explicit `GRADER_LIVE_SCAN=true pnpm dev` still wins
 * over the file, then the repo-root `.env.local`, then `.env` — the same
 * precedence and the same root as `loadApiKey`, so the key and the flags that
 * govern it can no longer be read from two different places.
 */
export function readFlag(root: string, name: string, env: NodeJS.ProcessEnv = process.env): { value: string | undefined; from: string } {
  if (!FILE_FLAGS.has(name)) return { value: env[name]?.trim(), from: 'environment' }
  const fromEnv = env[name]?.trim()
  if (fromEnv) return { value: fromEnv, from: 'environment' }
  for (const f of ['.env.local', '.env']) {
    const p = join(root, f)
    if (!existsSync(p)) continue
    const v = readVar(readFileSync(p, 'utf8'), name)
    if (v) return { value: v, from: f }
  }
  return { value: undefined, from: 'unset' }
}
