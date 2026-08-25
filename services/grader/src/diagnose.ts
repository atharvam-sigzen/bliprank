/**
 * One raw diagnostic call per engine, with EVERYTHING the provider returned.
 *
 * `--doctor` truncates the body to 500 chars and drops the response headers,
 * and the headers are where quota, plan and rate-limit state normally live. On
 * a 403 the body is also the only place the provider names which product it
 * thinks is unsubscribed, which is the fact that decides what to do next.
 *
 * Costs at most one call per engine — five in total, against a free tier of 50
 * per engine per month. It refuses without COLLECTION_ENABLED like everything
 * else that can spend.
 *
 *   COLLECTION_ENABLED=true pnpm grader:diagnose            # all five
 *   COLLECTION_ENABLED=true pnpm grader:diagnose -- chatgpt # just one
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINES, type EngineId } from '@bliprank/contracts'
import { DEFAULT_BASE_URL } from '../../collector/src/adapters/openwebninja.js'
import { loadApiKey } from './load-key.js'

const REQ: Record<EngineId, { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; query?: Record<string, string> }> = {
  chatgpt: { method: 'POST', path: '/chatgpt/chat', body: { message: 'What is the best CRM for a small business?', markdown: true } },
  gemini: { method: 'POST', path: '/gemini/chat', body: { message: 'What is the best CRM for a small business?', markdown: true } },
  copilot: { method: 'POST', path: '/copilot/copilot', body: { message: 'What is the best CRM for a small business?', mode: 'CHAT', markdown: true } },
  'google-ai-mode': { method: 'GET', path: '/google-ai-mode/ai-mode', query: { prompt: 'What is the best CRM for a small business?', gl: 'us', hl: 'en' } },
  'google-ai-overviews': { method: 'GET', path: '/ai-overviews/ai-overviews', query: { q: 'What is the best CRM for a small business?', gl: 'us', hl: 'en' } },
}

async function probe(engine: EngineId, key: string): Promise<void> {
  const spec = REQ[engine]
  const url = new URL(DEFAULT_BASE_URL + spec.path)
  for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.set(k, v)

  const started = Date.now()
  try {
    const res = await fetch(url.toString(), {
      method: spec.method,
      headers: {
        'x-api-key': key,
        Accept: 'application/json',
        'User-Agent': 'bliprank-diagnose',
        ...(spec.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(spec.body ? { body: JSON.stringify(spec.body) } : {}),
    })
    const text = await res.text()
    console.log(`\n=== ${engine} — ${spec.method} ${spec.path} ===`)
    console.log(`  status  ${res.status} ${res.statusText}  (${Date.now() - started}ms)`)
    // Everything except the echo of our own credential.
    const shown = [...res.headers.entries()].filter(([k]) => !/^(set-cookie|x-api-key|authorization)$/i.test(k))
    for (const [k, v] of shown.sort()) console.log(`  ${k}: ${v}`)
    console.log(`  body: ${text.slice(0, 900)}`)
  } catch (e) {
    console.log(`\n=== ${engine} ===\n  network error: ${(e as Error).message}`)
  }
}

async function main(): Promise<void> {
  if (process.env['COLLECTION_ENABLED'] !== 'true') {
    console.error('refusing: this makes real provider calls. Re-run with COLLECTION_ENABLED=true.')
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const found = loadApiKey(root, process.env)
  if (!found) {
    console.error('refusing: no OPENWEBNINJA_API_KEY in the environment, .env.local or .env')
    process.exit(2)
  }
  console.log(`key: ${found.key.length} chars, from ${found.from}, prefix ${found.key.slice(0, 4)}...`)

  const arg = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0]
  const engines = arg ? [arg as EngineId] : [...ENGINES]
  for (const e of engines) {
    if (!(ENGINES as readonly string[]).includes(e)) {
      console.error(`unknown engine: ${e}`)
      process.exit(2)
    }
    await probe(e, found.key)
  }
}

void main()
