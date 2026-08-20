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
    await idx.markCollected(cell, 'stubsearch:chatgpt', 10)
    expect((await idx.lookup([cell], 'stubsearch:chatgpt')).hits.size).toBe(1)
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
