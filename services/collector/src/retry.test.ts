import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AdapterError } from '@bliprank/contracts'
import { JsonlDeadLetter, MemoryDeadLetter } from './dead-letter.js'
import { DEFAULT_RETRY, retryDecision } from './retry.js'

const rng0 = () => 0 // no jitter in assertions

describe('retryDecision', () => {
  it('backs off exponentially for retryable kinds and stops at maxAttempts', () => {
    const err = new AdapterError('provider', 'HTTP 500', true)
    expect(retryDecision(err, 1, DEFAULT_RETRY, rng0)).toEqual({ retry: true, delayMs: 1000, reason: 'retryable' })
    expect(retryDecision(err, 2, DEFAULT_RETRY, rng0)).toEqual({ retry: true, delayMs: 4000, reason: 'retryable' })
    expect(retryDecision(err, 3, DEFAULT_RETRY, rng0)).toEqual({ retry: false, delayMs: 0, reason: 'attempts-exhausted' })
  })

  it('never retries rejected/unparseable, whatever the attempt number', () => {
    for (const kind of ['rejected', 'unparseable'] as const) {
      const err = new AdapterError(kind, 'nope', false)
      expect(retryDecision(err, 1, DEFAULT_RETRY, rng0)).toEqual({ retry: false, delayMs: 0, reason: 'non-retryable-kind' })
    }
  })

  it('honours Retry-After but clamps it to maxDelayMs', () => {
    const polite = new AdapterError('rate-limited', 'HTTP 429', true, 2_000)
    expect(retryDecision(polite, 1, DEFAULT_RETRY, rng0).delayMs).toBe(2_000)
    const hostile = new AdapterError('rate-limited', 'HTTP 429', true, 3_600_000)
    expect(retryDecision(hostile, 1, DEFAULT_RETRY, rng0).delayMs).toBe(60_000)
  })

  it('adds bounded jitter', () => {
    const err = new AdapterError('timeout', 'slow', true)
    const d = retryDecision(err, 1, DEFAULT_RETRY, () => 0.999)
    expect(d.delayMs).toBeGreaterThanOrEqual(1000)
    expect(d.delayMs).toBeLessThan(1000 + DEFAULT_RETRY.jitterMs)
  })
})

describe('dead letter stores', () => {
  const entry = (engine: string, kind = 'rejected') => ({ engine, cellKey: 'k1', prompt: 'p', run: 0, kind, message: 'm', attempts: 3, at: '2026-08-20T00:00:00Z' })

  it('memory and jsonl agree on record/list/count', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dlq-')), 'failures.jsonl')
    for (const dlq of [new MemoryDeadLetter(), new JsonlDeadLetter(file)]) {
      dlq.record(entry('chatgpt'))
      dlq.record(entry('chatgpt', 'timeout'))
      dlq.record(entry('gemini'))
      expect(dlq.list()).toHaveLength(3)
      expect(dlq.list('chatgpt')).toHaveLength(2)
      expect(dlq.count('chatgpt', 'rejected')).toBe(1)
      expect(dlq.count(undefined, 'rejected')).toBe(2)
    }
  })

  it('jsonl matches the pilot failures.jsonl format and survives a torn line', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dlq-')), 'failures.jsonl')
    const dlq = new JsonlDeadLetter(file)
    dlq.record(entry('copilot'))
    const { appendFileSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    appendFileSync(file, '{"engine":"copilot","cellKey"') // crash mid-write
    expect(new JsonlDeadLetter(file).list()).toHaveLength(1)
    const parsed = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!) as Record<string, unknown>
    for (const k of ['engine', 'cellKey', 'prompt', 'run', 'kind', 'message', 'attempts', 'at']) expect(parsed).toHaveProperty(k)
  })
})
