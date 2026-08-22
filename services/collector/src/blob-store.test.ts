import { describe, expect, it } from 'vitest'
import { assertSafeKey, BlobStoreError, MemoryBlobStore, R2BlobStore } from './blob-store.js'
import { r2KeyFor } from './cache-index.js'
import { cacheCell } from '@bliprank/contracts'

/** A fetch stand-in backed by an in-memory bucket, recording what was signed. */
function fakeR2() {
  const objects = new Map<string, string>()
  const seen: { method: string; url: string; headers: Record<string, string>; body?: string }[] = []
  const f: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    const body = init?.body === undefined ? undefined : String(init.body)
    seen.push({ method, url, headers, ...(body === undefined ? {} : { body }) })
    const path = new URL(url).pathname
    if (method === 'PUT') {
      objects.set(path, body ?? '')
      return new Response('', { status: 200 })
    }
    const hit = objects.get(path)
    if (hit === undefined) return new Response('<Error>NoSuchKey</Error>', { status: 404 })
    return new Response(method === 'HEAD' ? '' : hit, { status: 200 })
  }
  return { f, objects, seen }
}

const store = (f: typeof fetch) =>
  new R2BlobStore({
    accountId: 'acct',
    bucket: 'bliprank-answers',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    fetch: f,
    now: () => new Date('2026-08-21T09:00:00Z'),
  })

describe('R2BlobStore over the S3 REST API', () => {
  it('round-trips a fixture payload: put then get returns the same bytes', async () => {
    const { f, seen } = fakeR2()
    const s = store(f)
    const payload = JSON.stringify({ cell: { key: 'abc' }, runs: [{ text: 'fixture answer' }] })
    await s.put('answers/2026-08-21/chatgpt/abc__openwebninja-chatgpt.json', payload)
    expect(await s.get('answers/2026-08-21/chatgpt/abc__openwebninja-chatgpt.json')).toBe(payload)
    expect(seen[0]?.method).toBe('PUT')
    expect(seen[0]?.url).toBe('https://acct.r2.cloudflarestorage.com/bliprank-answers/answers/2026-08-21/chatgpt/abc__openwebninja-chatgpt.json')
  })

  it('every request carries a complete SigV4 authorization', async () => {
    const { f, seen } = fakeR2()
    await store(f).put('answers/k.json', '{}')
    const h = seen[0]!.headers
    expect(h['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=ak\/20260821\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/)
    expect(h['x-amz-date']).toBe('20260821T090000Z')
    expect(h['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
    // The payload hash must be of the body actually sent, not of empty.
    expect(h['authorization']).toContain('x-amz-content-sha256')
  })

  it('has() distinguishes present from absent without downloading the body', async () => {
    const { f, seen } = fakeR2()
    const s = store(f)
    expect(await s.has('answers/missing.json')).toBe(false)
    await s.put('answers/present.json', 'x')
    expect(await s.has('answers/present.json')).toBe(true)
    expect(seen.filter((r) => r.method === 'HEAD')).toHaveLength(2)
  })

  it('get() on a missing key is null, not an error — a cache miss is normal', async () => {
    const { f } = fakeR2()
    expect(await store(f).get('answers/nope.json')).toBeNull()
  })

  it('a non-404 failure throws with the status and operation, never silently succeeds', async () => {
    const f: typeof fetch = async () => new Response('<Error>AccessDenied</Error>', { status: 403 })
    await expect(store(f).get('answers/k.json')).rejects.toThrow(BlobStoreError)
    await expect(store(f).put('answers/k.json', '{}')).rejects.toThrow(/HTTP 403/)
  })

  it('signs the real orchestrator key shape (ADR-0003, path-qualified)', async () => {
    const { f, seen } = fakeR2()
    const cell = cacheCell({ prompt: 'What is the best CRM?', engine: 'chatgpt', locale: 'en-IN', geo: 'IN', dateBucket: '2026-08-21' })
    const key = r2KeyFor(cell, 'openwebninja:chatgpt')
    await store(f).put(key, '{}')
    expect(seen[0]?.url).toContain('/bliprank-answers/answers/2026-08-21/chatgpt/')
    // ':' in the adapter id must be percent-encoded, or the signature and the
    // sent path disagree and R2 returns SignatureDoesNotMatch.
    expect(seen[0]?.url).not.toMatch(/[^:]\/{2}[^/]*:[^/]*\.json$/)
  })
})

describe('assertSafeKey — keys that URL parsing would silently rewrite', () => {
  it('rejects dot segments, which new URL() resolves before signing', () => {
    expect(() => assertSafeKey('answers/a/../b.json')).toThrow(/segment/)
    expect(() => assertSafeKey('answers/./b.json')).toThrow(/segment/)
  })
  it('rejects empty segments and leading slashes', () => {
    expect(() => assertSafeKey('answers//b.json')).toThrow(/empty path segment/)
    expect(() => assertSafeKey('/answers/b.json')).toThrow(/must not start/)
    expect(() => assertSafeKey('')).toThrow(/empty/)
  })
  it('rejects control characters', () => {
    expect(() => assertSafeKey('answers/a\nb.json')).toThrow(/control character/)
  })
  it('accepts the keys we actually write', () => {
    const cell = cacheCell({ prompt: 'p', engine: 'gemini', locale: 'en-GB', geo: 'GB', dateBucket: '2026-08-21' })
    expect(() => assertSafeKey(r2KeyFor(cell, 'openwebninja:gemini'))).not.toThrow()
    expect(() => assertSafeKey(r2KeyFor(cell))).not.toThrow()
  })
})

describe('MemoryBlobStore stays interchangeable with R2BlobStore', () => {
  it('satisfies the same contract', async () => {
    const m = new MemoryBlobStore()
    expect(await m.has('k')).toBe(false)
    expect(await m.get('k')).toBeNull()
    await m.put('k', 'v')
    expect(await m.get('k')).toBe('v')
    expect(m.size).toBe(1)
  })
})
