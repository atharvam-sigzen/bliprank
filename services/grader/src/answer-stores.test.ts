import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANSWER_STORE_ENV, answerStores } from './answer-stores.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-answer-stores-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FULL: NodeJS.ProcessEnv = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'sk',
  R2_BUCKET: 'answers',
  UPSTASH_REDIS_REST_URL: 'https://kv.example',
  UPSTASH_REDIS_REST_TOKEN: 'tok',
}

describe('answerStores picks one backend for both halves', () => {
  it('with none of the six set it is the file store under dataDir, and it works', async () => {
    const s = answerStores(dir, {})
    expect(s.backend).toBe('file')
    await s.blob.put('answers/2026-09-10/chatgpt/k__a.json', '{"runs":[]}')
    expect(await s.blob.get('answers/2026-09-10/chatgpt/k__a.json')).toBe('{"runs":[]}')
    await s.kv.set('answer:k', 'v')
    expect(await s.kv.get('answer:k')).toBe('v')
  })

  it('with all six set it is R2 + Upstash, and nothing is fetched until a method is called', () => {
    const calls: string[] = []
    const f = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    const s = answerStores(dir, FULL, f)
    expect(s.backend).toBe('r2+upstash')
    expect(calls).toEqual([])
  })

  it('a partial configuration is refused, naming what is missing and never the values', () => {
    const partial = { ...FULL }
    delete partial['UPSTASH_REDIS_REST_TOKEN']
    expect(() => answerStores(dir, partial)).toThrow(/partly configured .*missing UPSTASH_REDIS_REST_TOKEN/)
    for (const k of ANSWER_STORE_ENV) {
      const one: NodeJS.ProcessEnv = { [k]: 'x' }
      expect(() => answerStores(dir, one)).toThrow(/partly configured/)
    }
    expect(() => answerStores(dir, partial)).not.toThrow(/tok|sk|ak/)
  })
})
