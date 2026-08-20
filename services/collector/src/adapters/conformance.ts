/**
 * Contract-conformance suite — the standing test PHASES.md requires at every
 * gate: "every adapter satisfies EngineAdapter, from fixtures only". A new
 * provider registers its adapter factory plus fixture payloads here and gets
 * the whole contract checked with zero network.
 */

import { describe, expect, it } from 'vitest'
import { AdapterError, cacheCell, ENGINES, type AnswerBody, type EngineAdapter, type EngineId } from '@bliprank/contracts'

export interface AdapterFixtures {
  /** A payload normalise() must accept, with what it must produce. */
  readonly valid: { payload: unknown; expect: AnswerBody }[]
  /** Payloads normalise() must refuse as unparseable (never guess). */
  readonly malformed: unknown[]
}

export interface ConformanceTarget {
  readonly providerName: string
  readonly makeAdapter: (engine: EngineId) => EngineAdapter
  readonly fixtures: AdapterFixtures
  /** Set when collect() works offline (stubs); network adapters test collect elsewhere with a mocked fetch. */
  readonly offlineCollect?: boolean
}

export function describeAdapterConformance(target: ConformanceTarget): void {
  const { providerName, makeAdapter, fixtures } = target

  describe(`EngineAdapter conformance: ${providerName}`, () => {
    it('declares the contract for every engine: id shape, provider bucket, disclosed collection path, sane rate limit', () => {
      for (const engine of ENGINES) {
        const a = makeAdapter(engine)
        expect(a.id).toBe(`${a.provider}:${engine}`)
        expect(a.provider).toMatch(/^[a-z][a-z0-9-]*$/)
        expect(a.engine).toBe(engine)
        expect(['official-api', 'third-party-grounded']).toContain(a.collectionPath)
        const rl = a.rateLimit()
        expect(rl.rps).toBeGreaterThan(0)
        expect(rl.burst).toBeGreaterThanOrEqual(1)
      }
    })

    it('normalise() maps every valid fixture to the exact AnswerBody, deterministically', () => {
      const a = makeAdapter(ENGINES[0])
      for (const f of fixtures.valid) {
        const once = a.normalise(f.payload)
        expect(once).toEqual(f.expect)
        expect(a.normalise(f.payload)).toEqual(once) // pure: same input, same output
        for (const [i, c] of once.citations.entries()) {
          expect(c.position).toBe(i) // positions are 0-based and in order
          expect(() => new URL(c.url)).not.toThrow()
          // ADR-0005: metadata is preserved, not flattened. When present it is a flat
          // bag of scalars (no nested junk into R2) — pins the invariant for any adapter.
          if (c.meta !== undefined) {
            for (const v of Object.values(c.meta)) expect(['string', 'number']).toContain(typeof v)
          }
        }
      }
    })

    it('normalise() refuses malformed payloads as AdapterError(unparseable), never retryable, never a guess', () => {
      const a = makeAdapter(ENGINES[0])
      for (const payload of fixtures.malformed) {
        try {
          a.normalise(payload)
          expect.unreachable(`accepted malformed payload: ${JSON.stringify(payload)?.slice(0, 80)}`)
        } catch (e) {
          expect(e).toBeInstanceOf(AdapterError)
          const err = e as AdapterError
          expect(err.kind).toBe('unparseable')
          // kind and retryable must agree — retryDecision trusts this blindly (a cost bug if wrong)
          expect(err.retryable).toBe(false)
          expect(['unparseable', 'rejected']).toContain(err.kind) // the non-retryable kinds
        }
      }
    })

    if (target.offlineCollect) {
      it('collect() honours an already-aborted signal (the contract: abort promptly)', async () => {
        const a = makeAdapter(ENGINES[0])
        const cell = cacheCell({ prompt: 'best crm', engine: ENGINES[0], locale: 'en-US', geo: 'US', dateBucket: '2026-08-20' })
        const ac = new AbortController()
        ac.abort()
        // A stub may legitimately ignore an abort (no I/O), but if it throws it must be a timeout AdapterError.
        try {
          await a.collect({ cell, prompt: 'best crm', run: 0, signal: ac.signal })
        } catch (e) {
          expect(e).toBeInstanceOf(AdapterError)
          expect((e as AdapterError).kind).toBe('timeout')
        }
      })

      it('collect() returns a self-describing RawAnswer for every engine (offline)', async () => {
        for (const engine of ENGINES) {
          const a = makeAdapter(engine)
          const cell = cacheCell({ prompt: 'Best CRM for a small business?', engine, locale: 'en-US', geo: 'US', dateBucket: '2026-08-20' })
          const ans = await a.collect({ cell, prompt: 'Best CRM for a small business?', run: 2 })
          expect(ans).toMatchObject({ cell, prompt: 'Best CRM for a small business?', run: 2, adapter: a.id, collectionPath: a.collectionPath })
          expect(typeof ans.collectedAt).toBe('string')
          expect(Number.isFinite(ans.latencyMs)).toBe(true)
          expect(Number.isInteger(ans.providerCalls)).toBe(true)
          expect(ans.payload).toBeDefined()
          // the RawAnswer body must be exactly what normalise() makes of its own payload
          expect({ text: ans.text, citations: ans.citations }).toEqual(a.normalise(ans.payload))
        }
      })

      it('collect() is deterministic for the same (cell, run) — reproducibility is the product', async () => {
        const a = makeAdapter('gemini')
        const cell = cacheCell({ prompt: 'best crm', engine: 'gemini', locale: 'en-US', geo: 'US', dateBucket: '2026-08-20' })
        const req = { cell, prompt: 'best crm', run: 1 }
        const [x, y] = [await a.collect(req), await a.collect(req)]
        expect(x.text).toBe(y.text)
        expect(x.citations).toEqual(y.citations)
      })
    }
  })
}
