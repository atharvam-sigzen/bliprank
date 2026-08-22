import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cacheCell, type EngineAdapter, type EngineId } from '@bliprank/contracts'
import { MemoryBlobStore } from './blob-store.js'
import { Budget } from './budget.js'
import { LocalSpendLedger } from './spend-ledger.js'

/** The guarded factory, wrapped once so each test reads clearly. */
const localLedger = (b: Budget) =>
  LocalSpendLedger.forSingleProcess(b, { iUnderstandThisCapIsPerProcess: true, reason: 'unit test: one process, no fleet', env: { COLLECTOR_TOPOLOGY: 'single-process' } })

import { AnswerIndex, MemoryKV, r2KeyFor } from './cache-index.js'
import { CollectionHeartbeat } from './collection-heartbeat.js'
import { MemoryDeadLetter } from './dead-letter.js'
import { LocalRateBudget } from './rate-budget.js'
import { stubAdapter } from './adapters/stub.js'
import { CollectionOrchestrator } from './collect-cell.js'
import { handleCollectJob, isCollectJob, QStashClient, QStashError, type CollectJob } from './qstash.js'
import { QStashVerificationError, signQStashToken, verifyQStashRequest } from './qstash-verify.js'

const URL_ = 'https://bliprank.example/api/collect'
const KEY = 'sig_current_key'
const NOW = new Date('2026-08-21T09:00:00Z')

const cellOf = (prompt: string, engine: EngineId = 'chatgpt') => cacheCell({ prompt, engine, locale: 'en-US', geo: 'US', dateBucket: '2026-08-21' })

function jobFor(prompt = 'best crm', runs = 3): CollectJob {
  return { v: 1, cell: cellOf(prompt), prompt, runs, adapterId: 'stubsearch:chatgpt' }
}

function handlerDeps(over: Partial<Parameters<typeof handleCollectJob>[1]> = {}) {
  const ledger = join(mkdtempSync(join(tmpdir(), 'qstash-')), 'ledger.json')
  const counted = { calls: 0 }
  const base = stubAdapter('chatgpt')
  const adapter: EngineAdapter = {
    ...base,
    collect: async (r) => {
      counted.calls++
      return base.collect(r)
    },
  }
  const deadLetter = new MemoryDeadLetter()
  const orchestrator = new CollectionOrchestrator({
    index: new AnswerIndex(new MemoryKV(), 100 * 86_400, () => NOW),
    blob: new MemoryBlobStore(),
    rateBudget: LocalRateBudget.forSingleProcess({ chatgpt: { rps: 1000, burst: 1000 } }, { iUnderstandThisBudgetIsPerProcess: true, reason: 'unit test: one process, no fleet', env: { COLLECTOR_TOPOLOGY: 'single-process' } }),
    budget: localLedger(new Budget(ledger, 100, () => 0.002)),
    deadLetter,
    owner: 'worker-1',
    sleep: async () => {},
    now: () => NOW,
    collectionEnabled: () => true,
  })
  return {
    deps: { orchestrator, adapters: (id: string) => (id === 'stubsearch:chatgpt' ? adapter : undefined), deadLetter, currentSigningKey: KEY, url: URL_, now: () => NOW, ...over },
    counted,
    deadLetter,
  }
}

const signed = (body: string, key = KEY, url = URL_) => signQStashToken({ key, url, body, iat: Math.floor(NOW.getTime() / 1000) })

describe('QStash signature verification — R3 provenance', () => {
  const body = JSON.stringify(jobFor())

  it('accepts a token QStash would have produced', () => {
    const claims = verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body, signature: signed(body), now: () => NOW.getTime() })
    expect(claims.iss).toBe('Upstash')
  })

  it('rejects a token signed with the wrong key', () => {
    expect(() => verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body, signature: signed(body, 'attacker_key'), now: () => NOW.getTime() })).toThrow(
      QStashVerificationError,
    )
  })

  it('accepts the NEXT key during a rotation, so collection does not stall', () => {
    const sig = signed(body, 'sig_next_key')
    expect(() => verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body, signature: sig, now: () => NOW.getTime() })).toThrow()
    expect(() =>
      verifyQStashRequest({ currentSigningKey: KEY, nextSigningKey: 'sig_next_key', url: URL_, body, signature: sig, now: () => NOW.getTime() }),
    ).not.toThrow()
  })

  it('rejects a valid token reattached to a DIFFERENT body — the hash covers the job', () => {
    const sig = signed(body)
    const tampered = JSON.stringify({ ...jobFor(), runs: 5000 }) // a spend amplification attempt
    expect(() => verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body: tampered, signature: sig, now: () => NOW.getTime() })).toThrow(/body does not match/)
  })

  it('rejects a token issued for a different destination', () => {
    const sig = signed(body, KEY, 'https://someone-else.example/collect')
    expect(() => verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body, signature: sig, now: () => NOW.getTime() })).toThrow(/issued for/)
  })

  it('rejects an expired token and one that is not yet valid', () => {
    const iat = Math.floor(NOW.getTime() / 1000)
    const expired = signQStashToken({ key: KEY, url: URL_, body, iat: iat - 1000, exp: iat - 600 })
    const future = signQStashToken({ key: KEY, url: URL_, body, iat: iat + 600, nbf: iat + 600 })
    expect(() => verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body, signature: expired, now: () => NOW.getTime() })).toThrow(/expired/)
    expect(() => verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body, signature: future, now: () => NOW.getTime() })).toThrow(/not yet valid/)
  })

  it('rejects a wrong issuer and a missing signature', () => {
    const wrongIss = signQStashToken({ key: KEY, url: URL_, body, iss: 'NotUpstash', iat: Math.floor(NOW.getTime() / 1000) })
    expect(() => verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body, signature: wrongIss, now: () => NOW.getTime() })).toThrow(/issuer/)
    expect(() => verifyQStashRequest({ currentSigningKey: KEY, url: URL_, body, signature: '', now: () => NOW.getTime() })).toThrow(/missing/)
  })

  it('refuses outright when no signing key is configured — never fails open', () => {
    expect(() => verifyQStashRequest({ currentSigningKey: '', url: URL_, body, signature: signed(body), now: () => NOW.getTime() })).toThrow(/no signing key/)
  })
})

describe('handleCollectJob — spend-safe status mapping', () => {
  it('collects on a verified job and reports the provider calls', async () => {
    const { deps, counted } = handlerDeps()
    const body = JSON.stringify(jobFor('best crm', 3))
    const res = await handleCollectJob({ body, signature: signed(body) }, deps)
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('collected')
    expect(res.body.providerCalls).toBe(3)
    expect(counted.calls).toBe(3)
  })

  it('an unverified request spends NOTHING and gets 401', async () => {
    const { deps, counted } = handlerDeps()
    const body = JSON.stringify(jobFor())
    const res = await handleCollectJob({ body, signature: signed(body, 'attacker_key') }, deps)
    expect(res.status).toBe(401)
    expect(counted.calls).toBe(0)
  })

  it('a second delivery of the same cell is a cache hit, not a second charge (R6)', async () => {
    const { deps, counted } = handlerDeps()
    const body = JSON.stringify(jobFor('best crm', 3))
    await handleCollectJob({ body, signature: signed(body) }, deps)
    const res = await handleCollectJob({ body, signature: signed(body) }, deps)
    expect(res.body.outcome).toBe('cache-hit')
    expect(res.body.providerCalls).toBe(0)
    expect(counted.calls).toBe(3) // unchanged
  })

  it('a malformed or unknown job is 400 — a retry could never succeed', async () => {
    const { deps } = handlerDeps()
    const bad = 'not json'
    expect((await handleCollectJob({ body: bad, signature: signed(bad) }, deps)).status).toBe(400)
    const wrongV = JSON.stringify({ ...jobFor(), v: 2 })
    expect((await handleCollectJob({ body: wrongV, signature: signed(wrongV) }, deps)).status).toBe(400)
    const unknown = JSON.stringify({ ...jobFor(), adapterId: 'nope:chatgpt' })
    const res = await handleCollectJob({ body: unknown, signature: signed(unknown) }, deps)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unknown adapter/)
  })

  it('THE SPEND RULE: an exhausted job returns 200 and dead-letters, so QStash does not retry it', async () => {
    const { deps, deadLetter } = handlerDeps()
    const failing = {
      ...stubAdapter('chatgpt'),
      collect: async () => {
        throw new Error('provider is down')
      },
    } as EngineAdapter
    const d = { ...deps, adapters: () => failing }
    const body = JSON.stringify(jobFor())
    const res = await handleCollectJob({ body, signature: signed(body) }, d)
    expect(res.status).toBe(200) // NOT 5xx — a retry would re-spend for the same result
    expect(res.body.ok).toBe(false)
    expect(res.body.outcome).toBe('failed')
    expect(deadLetter.count()).toBeGreaterThan(0)
  })

  it('a refusal BEFORE any spend returns 503, which is safe to retry', async () => {
    const { deps } = handlerDeps()
    const real = { ...stubAdapter('chatgpt'), offline: false } as EngineAdapter // pretend it spends
    const gated = new CollectionOrchestrator({
      index: new AnswerIndex(new MemoryKV(), 100 * 86_400, () => NOW),
      blob: new MemoryBlobStore(),
      rateBudget: LocalRateBudget.forSingleProcess({ chatgpt: { rps: 1000, burst: 1000 } }, { iUnderstandThisBudgetIsPerProcess: true, reason: 'unit test: one process, no fleet', env: { COLLECTOR_TOPOLOGY: 'single-process' } }),
      budget: localLedger(new Budget(join(mkdtempSync(join(tmpdir(), 'qstash-')), 'ledger.json'), 100, () => 0.002)),
      deadLetter: new MemoryDeadLetter(),
      owner: 'w',
      collectionEnabled: () => false, // R3 gate shut
    })
    const body = JSON.stringify(jobFor())
    const res = await handleCollectJob({ body, signature: signed(body) }, { ...deps, orchestrator: gated, adapters: () => real })
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/COLLECTION_ENABLED/)
  })
})

describe('QStashClient — publishing a cycle', () => {
  function fakeQStash(status = 200) {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = []
    const f: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ messageId: `msg_${seen.length}` }), { status })
    }
    return { f, seen }
  }

  it('publishes to the destination with auth and a bounded retry count', async () => {
    const { f, seen } = fakeQStash()
    const c = new QStashClient({ token: 'tok', destination: URL_, fetch: f })
    const { messageId } = await c.publish(jobFor())
    expect(messageId).toBe('msg_1')
    expect(seen[0]?.url).toBe(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(URL_)}`)
    expect(seen[0]?.headers['authorization']).toBe('Bearer tok')
    expect(seen[0]?.headers['upstash-retries']).toBe('2')
  })

  it('deduplicates on the path-qualified cache key, so a double-published cycle collapses', async () => {
    const { f, seen } = fakeQStash()
    const c = new QStashClient({ token: 'tok', destination: URL_, fetch: f })
    const job = jobFor()
    await c.publish(job)
    expect(seen[0]?.headers['upstash-deduplication-id']).toBe(`${r2KeyFor(job.cell, job.adapterId)}:${job.runs}`)
    // a different depth is a different unit of work and must NOT be deduped away
    await c.publish({ ...job, runs: 10 })
    expect(seen[1]?.headers['upstash-deduplication-id']).not.toBe(seen[0]?.headers['upstash-deduplication-id'])
  })

  it('publishCycle counts failures instead of aborting the whole cycle', async () => {
    let n = 0
    const f: typeof fetch = async () => {
      n++
      return n === 2 ? new Response('rate limited', { status: 429 }) : new Response(JSON.stringify({ messageId: 'm' }), { status: 200 })
    }
    const c = new QStashClient({ token: 'tok', destination: URL_, fetch: f })
    const r = await c.publishCycle([jobFor('a'), jobFor('b'), jobFor('c')])
    expect(r).toEqual({ published: 2, failed: 1 })
  })

  it('surfaces a rejection rather than pretending the job was queued', async () => {
    const { f } = fakeQStash(401)
    const c = new QStashClient({ token: 'bad', destination: URL_, fetch: f })
    await expect(c.publish(jobFor())).rejects.toThrow(QStashError)
  })

  it('registers the recurring cycle as a cron schedule', async () => {
    const { f, seen } = fakeQStash()
    const c = new QStashClient({ token: 'tok', destination: URL_, fetch: f })
    await c.schedule('0 */12 * * *', { cycle: 'daily' })
    expect(seen[0]?.url).toContain('/v2/schedules/')
    expect(seen[0]?.headers['upstash-cron']).toBe('0 */12 * * *')
  })
})

describe('isCollectJob', () => {
  it('rejects shapes that would spend unpredictably', () => {
    expect(isCollectJob(jobFor())).toBe(true)
    expect(isCollectJob({ ...jobFor(), runs: 0 })).toBe(false)
    expect(isCollectJob({ ...jobFor(), runs: 2.5 })).toBe(false)
    expect(isCollectJob({ ...jobFor(), runs: -1 })).toBe(false)
    expect(isCollectJob(null)).toBe(false)
  })
})

describe('the handler feeds the collection heartbeat', () => {
  it('records a real collection, so silence becomes detectable', async () => {
    const { deps } = handlerDeps()
    const kv = new MemoryKV()
    const hb = new CollectionHeartbeat({ kv, now: () => NOW })
    const body = JSON.stringify(jobFor('best crm', 2))
    await handleCollectJob({ body, signature: signed(body) }, { ...deps, heartbeat: hb })
    const s = await hb.status()
    expect(s.health).toBe('healthy')
    expect(s.collectedInWindow).toBe(1)
  })

  it('does NOT count a cache hit — that proves the cache works, not collection', async () => {
    const { deps } = handlerDeps()
    const kv = new MemoryKV()
    const hb = new CollectionHeartbeat({ kv, now: () => NOW })
    const d = { ...deps, heartbeat: hb }
    const body = JSON.stringify(jobFor('best crm', 2))
    await handleCollectJob({ body, signature: signed(body) }, d) // collected
    await handleCollectJob({ body, signature: signed(body) }, d) // cache hit
    expect((await hb.status()).collectedInWindow).toBe(1)
  })

  it('a 401 storm leaves the heartbeat silent — which is the whole point', async () => {
    const { deps } = handlerDeps()
    const kv = new MemoryKV()
    const hb = new CollectionHeartbeat({ kv, now: () => NOW })
    const body = JSON.stringify(jobFor())
    for (let i = 0; i < 5; i++) {
      const res = await handleCollectJob({ body, signature: signed(body, 'wrong_key') }, { ...deps, heartbeat: hb })
      expect(res.status).toBe(401)
    }
    // Nothing errored loudly enough to page anyone; only the absence shows it.
    expect((await hb.status()).health).toBe('never-collected')
  })

  it('a failing heartbeat never fails the paid job', async () => {
    const { deps } = handlerDeps()
    const broken = { recordCollected: async () => { throw new Error('kv down') } } as unknown as CollectionHeartbeat
    const body = JSON.stringify(jobFor('best crm', 2))
    const res = await handleCollectJob({ body, signature: signed(body) }, { ...deps, heartbeat: broken })
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('collected')
  })
})
