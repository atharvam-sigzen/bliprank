import { describe, expect, it } from 'vitest'
import { cacheCell } from '@bliprank/contracts'
import { AnswerIndex, MemoryKV, UpstashKV, r2KeyFor, type KV } from './cache-index.js'

const cellOf = (prompt: string, day = '2026-08-20') => cacheCell({ prompt, engine: 'chatgpt', locale: 'en-US', geo: 'US', dateBucket: day })

describe('AnswerIndex on MemoryKV', () => {
  it('lookup misses before markCollected, hits after; hit carries the R2 pointer, never a payload', async () => {
    const idx = new AnswerIndex(new MemoryKV(), 86_400, () => new Date('2026-08-20T06:00:00Z'))
    const cells = [cellOf('Best CRM for a small business?'), cellOf('Best CRM for consultants')]
    const before = await idx.lookup(cells)
    expect(before.hits.size).toBe(0)
    expect(before.misses).toHaveLength(2)

    await idx.markCollected(cells[0]!, 'openwebninja:chatgpt', 10)
    const after = await idx.lookup(cells)
    expect(after.misses.map((c) => c.key)).toEqual([cells[1]!.key])
    const hit = after.hits.get(cells[0]!.key)!
    expect(hit).toEqual({ r2Key: r2KeyFor(cells[0]!), adapter: 'openwebninja:chatgpt', runs: 10, storedAt: '2026-08-20T06:00:00.000Z' })
    expect(hit.r2Key).toBe(`answers/2026-08-20/chatgpt/${cells[0]!.key}.json`)
  })

  it('path-qualified lookup: the alternate path is NOT short-circuited by the primary entry (ADR-0003)', async () => {
    const idx = new AnswerIndex(new MemoryKV())
    const cell = cellOf('best crm')
    await idx.markCollected(cell, 'openwebninja:chatgpt', 10)
    expect((await idx.lookup([cell])).hits.size).toBe(1) // any-path: collected
    expect((await idx.lookup([cell], 'openwebninja:chatgpt')).hits.size).toBe(1) // primary path: collected
    expect((await idx.lookup([cell], 'stubsearch:chatgpt')).hits.size).toBe(0) // alternate path: must still collect
    await idx.markCollected(cell, 'stubsearch:chatgpt', 7)
    expect((await idx.lookup([cell], 'stubsearch:chatgpt')).hits.size).toBe(1)
    // the plain "collected at all?" entry keeps the FIRST writer's runs/adapter,
    // not the alternate path's — only qualified entries are authoritative
    const plain = (await idx.lookup([cell])).hits.get(cell.key)!
    expect(plain.adapter).toBe('openwebninja:chatgpt')
    expect(plain.runs).toBe(10)
    expect((await idx.lookup([cell], 'stubsearch:chatgpt')).hits.get(cell.key)!.runs).toBe(7)
  })

  it('shared prompt-pool dedupe: identical prompts from different workspaces are one cell, one claim, one collection', async () => {
    const idx = new AnswerIndex(new MemoryKV())
    // two agency clients in the same category ask the same question with cosmetic differences
    const clientA = cellOf('  Best CRM for a small business?  ')
    const clientB = cellOf('best crm for a small business')
    expect(clientA.key).toBe(clientB.key) // normalisation makes them the same cell — the dedupe
    expect(await idx.claim(clientA, 'openwebninja:chatgpt', 'job-A')).toBe(true)
    expect(await idx.claim(clientB, 'openwebninja:chatgpt', 'job-B')).toBe(false) // B waits for A's result
    // a different adapter path is a separate claim (agreement monitor re-collection)
    expect(await idx.claim(clientB, 'stubsearch:chatgpt', 'job-C')).toBe(true)
  })

  it('claims lease-expire so a crashed winner does not orphan the cell; entries honour TTL', async () => {
    let t = 0
    const kv = new MemoryKV(() => t)
    const idx = new AnswerIndex(kv, 60, () => new Date(t))
    const cell = cellOf('best crm')
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-A', 10)).toBe(true)
    t = 9_000
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-B', 10)).toBe(false)
    t = 11_000 // lease expired: the cell is claimable again
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-B', 10)).toBe(true)
    await idx.markCollected(cell, 'openwebninja:chatgpt', 5)
    t = 11_000 + 61_000 // entry TTL passed
    expect((await idx.lookup([cell])).hits.size).toBe(0)
  })

  it('a corrupt index entry is a miss, never a crash', async () => {
    const kv = new MemoryKV()
    const idx = new AnswerIndex(kv)
    const cell = cellOf('best crm')
    await kv.set(AnswerIndex.keyFor(cell.key), '{not json')
    const r = await idx.lookup([cell])
    expect(r.hits.size).toBe(0)
    expect(r.misses).toHaveLength(1)
  })
})

describe('UpstashKV over mocked REST', () => {
  function mock(results: unknown[][]) {
    const calls: { url: string; body: unknown }[] = []
    let i = 0
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      const batch = results[i++] ?? []
      return new Response(JSON.stringify(batch.map((result) => ({ result }))), { status: 200 })
    }) as typeof fetch
    return { f, calls }
  }

  it('sends pipeline commands with the token and parses results', async () => {
    const { f, calls } = mock([['OK'], [['a', null]], [null], ['OK']])
    const kv = new UpstashKV('https://example-redis.upstash.io/', 'tok', f)
    await kv.set('k1', 'v1', { ttlSec: 60 })
    expect(await kv.mget(['k1', 'k2'])).toEqual(['a', null])
    expect(await kv.setnx('k1', 'x')).toBe(false) // null = already existed
    expect(await kv.setnx('k3', 'y', { ttlSec: 5 })).toBe(true)
    expect(calls[0]!.url).toBe('https://example-redis.upstash.io/pipeline')
    expect(calls[0]!.body).toEqual([['SET', 'k1', 'v1', 'EX', 60]])
    expect(calls[1]!.body).toEqual([['MGET', 'k1', 'k2']])
    expect(calls[2]!.body).toEqual([['SET', 'k1', 'x', 'NX']])
    expect(calls[3]!.body).toEqual([['SET', 'k3', 'y', 'NX', 'EX', 5]])
  })

  it('surfaces HTTP and command errors', async () => {
    const f500 = (async () => new Response('boom', { status: 500 })) as typeof fetch
    await expect(new UpstashKV('https://x.upstash.io', 't', f500).get('k')).rejects.toThrow(/HTTP 500/)
    const fErr = (async () => new Response(JSON.stringify([{ error: 'WRONGTYPE' }]), { status: 200 })) as typeof fetch
    await expect(new UpstashKV('https://x.upstash.io', 't', fErr).get('k')).rejects.toThrow(/WRONGTYPE/)
  })

  it('mget of nothing is a no-op with no network call', async () => {
    const { f, calls } = mock([])
    const kv = new UpstashKV('https://x.upstash.io', 't', f)
    expect(await kv.mget([])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('release — the claim ends with the collection, not with the lease (fixed 2026-09-07)', () => {
  it('only the owner can release, and a released cell is claimable again inside the lease window', async () => {
    let t = 0
    const idx = new AnswerIndex(new MemoryKV(() => t), 60, () => new Date(t))
    const cell = cellOf('best crm')
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-A', 1800)).toBe(true)
    // Not job-B's to release: A's claim stands and B still waits.
    expect(await idx.release(cell, 'openwebninja:chatgpt', 'job-B')).toBe(false)
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-B', 1800)).toBe(false)
    t = 5_000 // well inside A's thirty-minute lease, where the old code left the cell stuck
    expect(await idx.release(cell, 'openwebninja:chatgpt', 'job-A')).toBe(true)
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-B', 1800)).toBe(true)
    // Releasing what is no longer held is a no-op, not an error.
    expect(await idx.release(cell, 'openwebninja:chatgpt', 'job-A')).toBe(false)
  })

  it('a claim that lapsed and was re-won by another worker is not deleted by the late release', async () => {
    let t = 0
    const idx = new AnswerIndex(new MemoryKV(() => t), 60, () => new Date(t))
    const cell = cellOf('best crm')
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-A', 10)).toBe(true)
    t = 11_000 // A's lease lapsed; B wins the cell
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-B', 10)).toBe(true)
    expect(await idx.release(cell, 'openwebninja:chatgpt', 'job-A')).toBe(false)
    expect(await idx.claim(cell, 'openwebninja:chatgpt', 'job-C', 10)).toBe(false) // B still holds it
  })

  it('a value the index did not write is left to its lease', async () => {
    const kv = new MemoryKV()
    const idx = new AnswerIndex(kv)
    const cell = cellOf('best crm')
    await kv.set(`claim:${cell.key}:openwebninja:chatgpt`, 'not json')
    expect(await idx.release(cell, 'openwebninja:chatgpt', 'job-A')).toBe(false)
    expect(await kv.get(`claim:${cell.key}:openwebninja:chatgpt`)).toBe('not json')
  })
})

describe('UpstashKV.delIfEquals', () => {
  it('is one server-side compare-and-delete, never a GET followed by a DEL', async () => {
    const calls: unknown[] = []
    const results = [[1], [0]]
    const f = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify((results.shift() ?? []).map((result) => ({ result }))), { status: 200 })
    }) as typeof fetch
    const kv = new UpstashKV('https://x.upstash.io', 't', f)
    expect(await kv.delIfEquals('claim:k', 'v')).toBe(true)
    expect(await kv.delIfEquals('claim:k', 'v')).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual([['EVAL', expect.stringMatching(/GET.*ARGV\[1\].*DEL/s), 1, 'claim:k', 'v']])
  })
})

describe('KV.setIfHeld — the lock-fenced write (MVP_PLAN C2r item 1)', () => {
  it('on MemoryKV: writes only while the lock still holds the token; a lapsed or re-won lease writes nothing', async () => {
    let t = 1_000
    const kv = new MemoryKV(() => t)
    expect(await kv.setnx('doc:lock', 'A', { ttlSec: 10 })).toBe(true)
    expect(await kv.setIfHeld('doc', 'by A', 'doc:lock', 'A')).toBe(true)
    expect(await kv.get('doc')).toBe('by A')
    t += 10_001 // A's lease lapses
    expect(await kv.setIfHeld('doc', 'by A, late', 'doc:lock', 'A')).toBe(false)
    expect(await kv.get('doc')).toBe('by A')
    expect(await kv.setnx('doc:lock', 'B', { ttlSec: 10 })).toBe(true) // B re-wins the lapsed lock
    expect(await kv.setIfHeld('doc', 'by A, later still', 'doc:lock', 'A')).toBe(false)
    expect(await kv.setIfHeld('doc', 'by B', 'doc:lock', 'B')).toBe(true)
    expect(await kv.get('doc')).toBe('by B')
  })

  it('on UpstashKV: one server-side compare-the-lock-and-set, never a GET followed by a SET, with the real command shape pinned', async () => {
    const calls: unknown[] = []
    const results = [[1], [0]]
    const f = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify((results.shift() ?? []).map((result) => ({ result }))), { status: 200 })
    }) as typeof fetch
    const kv = new UpstashKV('https://x.upstash.io', 't', f)
    expect(await kv.setIfHeld('ledger:daily-spend', '{"2026-09-16":{}}', 'ledger:daily-spend:lock', 'tok')).toBe(true)
    expect(await kv.setIfHeld('ledger:daily-spend', '{"2026-09-16":{}}', 'ledger:daily-spend:lock', 'tok')).toBe(false)
    expect(calls).toHaveLength(2)
    // Two keys (the document, then the lock) and two arguments (the value, then
    // the token): the script compares KEYS[2] with ARGV[2] and sets KEYS[1] to
    // ARGV[1]. Pinned, because the order is the whole contract.
    expect(calls[0]).toEqual([
      ['EVAL', expect.stringMatching(/GET', KEYS\[2\]\) == ARGV\[2\][^]*SET', KEYS\[1\], ARGV\[1\]/), 2, 'ledger:daily-spend', 'ledger:daily-spend:lock', '{"2026-09-16":{}}', 'tok'],
    ])
  })
})
