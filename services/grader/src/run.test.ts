import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { estimateUsd, parseArgs } from './run.js'

/**
 * The runner's gates, tested against the states they exist to refuse.
 *
 * Every one of these is a rule R3 surface. An assertion with no failing case is
 * indistinguishable from one that does nothing, and here the thing that does
 * nothing is a spend gate.
 */

const LIVE_ENV = { OPENWEBNINJA_API_KEY: 'k'.repeat(51), COLLECTION_ENABLED: 'true' } as NodeJS.ProcessEnv
const refusal = (r: ReturnType<typeof parseArgs>) => ('refuse' in r ? r.refuse : null)

/**
 * A root with no `.env.local` and no `.env`, so these gates are tested against a
 * machine that has no key rather than against whichever machine runs them.
 */
const BARE = mkdtempSync(join(tmpdir(), 'grader-noenv-'))
const parse = (argv: string[], env: NodeJS.ProcessEnv) => parseArgs(argv, env, BARE)

describe('a live run is refused unless every gate is deliberately opened', () => {
  it('refuses without a domain', () => {
    expect(refusal(parse(['--fixture'], {}))).toMatch(/no --domain/)
  })

  it('THE COST GATE: refuses without an explicit plan, and never defaults to one', () => {
    // payg is 3.8x mega over a whole scan. A default here is not a convenience,
    // it is the difference between $0.18 and $0.68 a scan, silently.
    expect(refusal(parse(['--domain', 'a.com'], LIVE_ENV))).toMatch(/plan not set/)
    expect(refusal(parse(['--domain', 'a.com', '--plan', 'nonsense'], LIVE_ENV))).toMatch(/unknown plan/)
  })

  it('THE R3 GATE: refuses unless COLLECTION_ENABLED is exactly "true"', () => {
    const base = ['--domain', 'a.com', '--plan', 'mega', '--cap', '1']
    for (const v of [undefined, 'false', 'TRUE', '1', 'yes', '']) {
      const env = { ...LIVE_ENV, ...(v === undefined ? { COLLECTION_ENABLED: undefined } : { COLLECTION_ENABLED: v }) } as NodeJS.ProcessEnv
      expect([v, refusal(parse(base, env))]).toEqual([v, expect.stringMatching(/COLLECTION_ENABLED/)])
    }
  })

  it('refuses without a key', () => {
    expect(refusal(parse(['--domain', 'a.com', '--plan', 'mega', '--cap', '1'], { COLLECTION_ENABLED: 'true' }))).toMatch(/API_KEY/)
  })

  it('THE CEILING GATE: a run that may spend must state its cap', () => {
    expect(refusal(parse(['--domain', 'a.com', '--plan', 'mega'], LIVE_ENV))).toMatch(/no --cap/)
    for (const bad of ['0', '-1', 'abc']) {
      expect([bad, refusal(parse(['--domain', 'a.com', '--plan', 'mega', '--cap', bad], LIVE_ENV))]).toEqual([bad, expect.stringMatching(/--cap must be/)])
    }
  })

  it('refuses an engine that is not in the contract', () => {
    expect(refusal(parse(['--domain', 'a.com', '--fixture', '--engines', 'chatgpt,perplexity'], {}))).toMatch(/unknown engine/)
  })

  it('accepts a fully specified live run', () => {
    const r = parse(['--domain', 'pipedrive.com', '--plan', 'mega', '--cap', '0.50', '--day', '2026-08-24'], LIVE_ENV)
    expect('refuse' in r).toBe(false)
    if ('refuse' in r) return
    expect(r.opts).toMatchObject({ domain: 'pipedrive.com', plan: 'mega', capUsd: 0.5, mode: 'live', day: '2026-08-24' })
    expect(r.opts.engines).toHaveLength(5)
  })
})

describe('an offline run needs none of it, because it cannot spend', () => {
  it('fixture and stub modes skip the plan, key, cap and enablement gates', () => {
    for (const mode of ['--fixture', '--stub']) {
      const r = parse(['--domain', 'pipedrive.com', mode], {})
      expect([mode, 'refuse' in r]).toEqual([mode, false])
      if ('refuse' in r) continue
      expect(r.opts.mode).toBe(mode === '--fixture' ? 'fixture' : 'stub')
    }
  })

  it('estimates zero for any offline mode, whatever the plan says', () => {
    const engines = ['chatgpt', 'gemini', 'copilot', 'google-ai-mode', 'google-ai-overviews'] as const
    expect(estimateUsd({ plan: 'payg', engines, mode: 'fixture' }, 17)).toBe(0)
    expect(estimateUsd({ plan: 'payg', engines, mode: 'stub' }, 17)).toBe(0)
  })
})

describe('the estimate is the bill, printed before it is incurred', () => {
  const engines = ['chatgpt', 'gemini', 'copilot', 'google-ai-mode', 'google-ai-overviews'] as const

  it('a full 17-prompt scan over five engines costs what the cost model says', () => {
    // mega: 4 engines at $0.002 + AI Overviews at $0.001 = $0.009 a prompt.
    expect(estimateUsd({ plan: 'mega', engines, mode: 'live' }, 17)).toBeCloseTo(0.153, 6)
    // payg: 3x$0.007 + $0.008 + $0.005 = $0.034 a prompt.
    expect(estimateUsd({ plan: 'payg', engines, mode: 'live' }, 17)).toBeCloseTo(0.578, 6)
  })

  it('payg is materially more than mega — the reason the plan is never defaulted', () => {
    const mega = estimateUsd({ plan: 'mega', engines, mode: 'live' }, 17)
    const payg = estimateUsd({ plan: 'payg', engines, mode: 'live' }, 17)
    expect(payg / mega).toBeGreaterThan(3.5)
  })

  it('scales with prompts, engines and runs, so a bigger scan cannot look cheap', () => {
    const one = estimateUsd({ plan: 'mega', engines: ['chatgpt'], mode: 'live' }, 1)
    expect(estimateUsd({ plan: 'mega', engines: ['chatgpt'], mode: 'live' }, 10)).toBeCloseTo(one * 10, 9)
    expect(estimateUsd({ plan: 'mega', engines: ['chatgpt'], mode: 'live' }, 1, 3)).toBeCloseTo(one * 3, 9)
  })
})
