/**
 * What does the provider actually say about remaining quota?
 *
 * This calls the UNDOCUMENTED /usage endpoint only. It is free, it is not
 * metered, and it is the same call `live-gate.ts` makes before every scan — so
 * it is the closest thing to an authoritative number that exists without
 * spending. It makes NO collection call and cannot spend.
 *
 * The key is read in-process from the repo-root env file, exactly the way
 * `loadApiKey` does it, and is never printed beyond a length. That is the whole
 * reason that helper exists: a key on a command line ends up in shell history,
 * in `ps` output and in a terminal transcript.
 *
 * Prints the RAW status, headers and body, because the question is not only
 * "how much is left" but "does this API expose anything about quota at all".
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'd:/bliprank'
const NAME = ['OPENWEBNINJA', 'API', 'KEY'].join('_')

const readVar = (text, name) => {
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

let key = process.env[NAME]
for (const f of ['.env.local', '.env']) {
  if (key) break
  const p = join(ROOT, f)
  if (existsSync(p)) key = readVar(readFileSync(p, 'utf8'), NAME)
}
if (!key) {
  console.error('no key found in environment or repo-root env files')
  process.exit(2)
}
console.log(`key: ${key.length} chars\n`)

const res = await fetch('https://api.openwebninja.com/usage', {
  headers: { 'x-api-key': key, Accept: 'application/json', 'User-Agent': 'bliprank-quota-probe' },
})

console.log(`GET /usage -> ${res.status} ${res.statusText}\n`)
console.log('--- RESPONSE HEADERS ---')
for (const [k, v] of [...res.headers.entries()].sort()) {
  if (/^(set-cookie|x-api-key|authorization)$/i.test(k)) continue
  console.log(`  ${k}: ${v}`)
}

const text = await res.text()
console.log('\n--- RAW BODY ---')
console.log(text.slice(0, 4000))

try {
  const body = JSON.parse(text)
  const items = body?.data?.items ?? []
  if (items.length) {
    console.log('\n--- PARSED PER PRODUCT ---')
    for (const it of items) {
      const q = it.quotas?.[0]
      console.log(
        q
          ? `  ${String(it.api_id).padEnd(20)} used ${String(q.used).padStart(5)} / ${String(q.limit).padEnd(6)} remaining ${String(q.remaining).padStart(6)}  resets ${q.reset_at}`
          : `  ${String(it.api_id).padEnd(20)} (no quota block)`,
      )
    }
  }
} catch {
  console.log('\n(body is not JSON)')
}
