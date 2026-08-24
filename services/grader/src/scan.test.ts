import {
  AnswerIndex,
  Budget,
  CollectionOrchestrator,
  LocalRateBudget,
  LocalSpendLedger,
  MemoryBlobStore,
  MemoryKV,
  type DeadLetter,
} from '@bliprank/collector'
import type { AnswerBody, CollectRequest, EngineAdapter, EngineId, RawAnswer } from '@bliprank/contracts'
import { DEMO_BANKS, DEMO_TAXONOMY } from '@bliprank/taxonomy'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UNPROMPTED_INTENTS, comparisonBasisFor, runScan, subjectFor } from './scan.js'

/**
 * A controllable offline adapter. The pilot's fixture adapter mentions brands
 * probabilistically, which is right for estimating ρ̂ and wrong here: these tests
 * are about whether the scan counts what it is shown, so what it is shown has to
 * be exact.
 *
 * Zero network, zero spend. `collectionEnabled` is forced false throughout, so
 * the R3 gate would refuse a real adapter even if one were wired by mistake.
 */
function scriptedAdapter(engine: EngineId, textFor: (prompt: string, engine: EngineId) => string): EngineAdapter {
  return {
    id: `scripted:${engine}`,
    provider: 'scripted',
    engine,
    collectionPath: 'third-party-grounded',
    // Declared offline, so the R3 gate in the orchestrator does not apply to it.
    // The gate itself is separately forced closed below, so a real adapter wired
    // here by mistake would still be refused rather than quietly spending.
    offline: true,
    async collect(req: CollectRequest): Promise<RawAnswer> {
      const text = textFor(req.prompt, engine)
      return {
        cell: req.cell,
        prompt: req.prompt,
        run: req.run,
        adapter: `scripted:${engine}`,
        collectionPath: 'third-party-grounded',
        collectedAt: '2026-08-24T00:00:00.000Z',
        latencyMs: 1,
        providerCalls: 1,
        payload: { text },
        text,
        citations: [],
      }
    },
    normalise(payload: unknown): AnswerBody {
      return { text: String((payload as { text?: string }).text ?? ''), citations: [] }
    },
    rateLimit: () => ({ rps: 1000, burst: 1000 }),
  }
}

const ENGINES: EngineId[] = ['chatgpt', 'gemini']
const dirs: string[] = []

function deps(textFor: (prompt: string, engine: EngineId) => string, capUsd = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'grader-'))
  dirs.push(dir)
  const blob = new MemoryBlobStore()
  const kv = new MemoryKV()
  const dead: DeadLetter = { record: async () => {} } as unknown as DeadLetter
  const orchestrator = new CollectionOrchestrator({
    index: new AnswerIndex(kv),
    blob,
    rateBudget: LocalRateBudget.forSingleProcess(
      { chatgpt: { rps: 1000, burst: 1000 }, gemini: { rps: 1000, burst: 1000 } },
      { iUnderstandThisBudgetIsPerProcess: true, reason: 'offline test, no provider is reachable', env: { COLLECTOR_TOPOLOGY: 'single-process' } },
    ),
    budget: LocalSpendLedger.forSingleProcess(new Budget(join(dir, 'ledger.json'), capUsd, () => 0), {
      iUnderstandThisCapIsPerProcess: true,
      reason: 'offline test, price is zero',
      env: { COLLECTOR_TOPOLOGY: 'single-process' },
    }),
    deadLetter: dead,
    owner: 'test',
    // R3: even offline, the gate is asserted rather than assumed.
    collectionEnabled: () => false,
  })
  return { orchestrator, blob, adapterFor: (e: EngineId) => scriptedAdapter(e, textFor) }
}

afterEach(() => {
  dirs.length = 0
})

const req = (domain: string, over: Partial<Parameters<typeof runScan>[0]> = {}) => ({
  domain,
  engines: ENGINES,
  day: '2026-08-24',
  ...over,
})

describe('PROPERTY 1 — a domain that does not classify never spends', () => {
  it('an unclassified domain returns before any cell is requested', async () => {
    const d = deps(() => 'nothing')
    const r = await runScan(req('acme.com'), d)
    expect(r.status).toBe('unclassified')
    // The assertion that matters: not "it returned an error" but "it bought
    // nothing". This is the guard the Grader's input regex was wrongly credited
    // with — junk in the box costs nothing because there is no bank to scan.
    expect(d.blob.size).toBe(0)
  })

  it('an ambiguous domain returns the candidates and buys nothing', async () => {
    const d = deps(() => 'nothing')
    const r = await runScan(req('zoho.com'), d)
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') expect(r.candidates).toEqual(['accounting-software', 'crm-software', 'hr-payroll-software'])
    expect(d.blob.size).toBe(0)
  })

  it('a filename pasted into the box costs nothing', async () => {
    const d = deps(() => 'nothing')
    expect((await runScan(req('report.pdf'), d)).status).toBe('unclassified')
    expect(d.blob.size).toBe(0)
  })
})

describe('PROPERTY 2 — the headline is measured on unprompted prompts only', () => {
  it('scans discovery and problem-led, and never comparison or brand-verification', async () => {
    const seen: string[] = []
    const d = deps((p) => {
      seen.push(p)
      return 'HubSpot is a common answer.'
    })
    await runScan(req('pipedrive.com'), d)

    const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
    const unprompted = bank.prompts.filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent)).map((p) => p.text)
    const branded = bank.prompts.filter((p) => !(UNPROMPTED_INTENTS as readonly string[]).includes(p.intent)).map((p) => p.text)

    expect([...new Set(seen)].sort()).toEqual([...unprompted].sort())
    // Including a "HubSpot vs Salesforce" prompt would guarantee both brands a
    // mention and report our own phrasing back as their visibility.
    for (const b of branded) expect([b, seen.includes(b)]).toEqual([b, false])
  })

  it('the unprompted set still clears the comparison floor after two engines go dark', async () => {
    const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
    const unprompted = bank.prompts.filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent)).length
    // 17 prompts x 3 surviving engines x 80% yield = 40.8, against a floor of 30.
    expect(unprompted * 3 * 0.8).toBeGreaterThanOrEqual(30)
  })
})

describe('PROPERTY 3 — one comparison_basis across every brand in the result', () => {
  it('subject and competitors share a basis, so compare() will actually compare them', async () => {
    const d = deps(() => 'Pipedrive and HubSpot are both options.')
    const r = await runScan(req('pipedrive.com'), d)
    expect(r.status).toBe('scanned')
    if (r.status !== 'scanned') return
    const bases = new Set(r.brands.map((b) => b.metric.comparison_basis))
    expect(bases.size).toBe(1)
    for (const b of r.brands) expect([b.id, b.metric.n]).toEqual([b.id, r.counts.answersScored])
  })

  it('the basis records the prompt subset, so a 17-prompt scan is not comparable with a 30-prompt one', async () => {
    const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
    const a = comparisonBasisFor(bank, ENGINES, 17, 1)
    const b = comparisonBasisFor(bank, ENGINES, 30, 1)
    expect(a).not.toEqual(b)
    // Engine-set order must not change the basis, or two identical scans would
    // read as not-comparable purely from argument ordering.
    expect(comparisonBasisFor(bank, ['gemini', 'chatgpt'], 17, 1)).toEqual(a)
  })
})

describe('the numbers are what the answers said', () => {
  it('counts a brand in every answer as a rate of 1, and an absent brand as 0', async () => {
    const d = deps(() => 'For most teams Pipedrive is the pick.')
    const r = await runScan(req('pipedrive.com'), d)
    if (r.status !== 'scanned') throw new Error(r.status)

    const subject = r.brands.find((b) => b.isSubject)!
    expect(subject.id).toBe('pipedrive')
    expect(subject.mentions).toBe(r.counts.answersScored)
    expect(subject.metric.value).toBeGreaterThan(0.9)

    const absent = r.brands.find((b) => b.id === 'salesforce')!
    expect(absent.mentions).toBe(0)
    // Wilson at k=0 is [0, something], never a bare 0 with no interval (R8).
    expect(absent.metric.ci_low).toBe(0)
    expect(absent.metric.ci_high).toBeGreaterThan(0)
  })

  it('a brand mentioned in half the answers lands near a half, with an interval around it', async () => {
    const d = deps((_p, engine) => (engine === 'chatgpt' ? 'Pipedrive is worth a look.' : 'Try something else entirely.'))
    const r = await runScan(req('pipedrive.com'), d)
    if (r.status !== 'scanned') throw new Error(r.status)
    const subject = r.brands.find((b) => b.isSubject)!
    expect(subject.mentions * 2).toBe(r.counts.answersScored)
    expect(subject.metric.value).toBeGreaterThan(0.4)
    expect(subject.metric.value).toBeLessThan(0.6)
    expect(subject.metric.ci_low).toBeLessThan(subject.metric.value)
    expect(subject.metric.ci_high).toBeGreaterThan(subject.metric.value)
  })

  it('every brand carries full provenance — R8 has no exemption here', async () => {
    const d = deps(() => 'Pipedrive.')
    const r = await runScan(req('pipedrive.com'), d)
    if (r.status !== 'scanned') throw new Error(r.status)
    for (const b of r.brands) {
      expect([b.id, b.metric.algo_version]).toEqual([b.id, 'det-1'])
      expect([b.id, b.metric.collection_path]).toEqual([b.id, 'third-party-grounded'])
      expect([b.id, b.metric.n > 0]).toEqual([b.id, true])
      expect([b.id, b.metric.comparison_basis.length > 0]).toEqual([b.id, true])
    }
  })

  it('a scan with zero answers says so rather than rendering an empty chart', async () => {
    // Every cell fails, so nothing is scored. wilson(0, 0) throws rather than
    // returning a shrug, and no interval over zero answers is defensible.
    const d = deps(() => {
      throw new Error('engine down')
    })
    const r = await runScan(req('pipedrive.com'), d)
    expect(r.status).toBe('no-answers')
  })
})

describe('the subject brand', () => {
  it('is the leader when the domain matched one, with its reviewed alias set', () => {
    const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
    const { spec, source } = subjectFor('blog.pipedrive.com', bank)
    expect([source, spec.id]).toEqual(['leader', 'pipedrive'])
    expect(spec.aliases).toContain('pipedrive')
  })

  it('is derived from the domain label otherwise, and says so', () => {
    const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
    const { spec, source } = subjectFor('acmecrm.io', bank)
    // Labelled `domain-label` rather than presented as equivalent: a brand whose
    // only alias is its domain label is undercounted wherever answers use its
    // real trading name. Recovering that is what 3.1's unbuilt site-content
    // signal is for.
    expect([source, spec.id, spec.aliases]).toEqual(['domain-label', 'domain:acmecrm.io', ['acmecrm']])
  })

  it('the subject is never also listed as its own competitor', async () => {
    const d = deps(() => 'Pipedrive and HubSpot.')
    const r = await runScan(req('pipedrive.com'), d)
    if (r.status !== 'scanned') throw new Error(r.status)
    expect(r.brands.filter((b) => b.id === 'pipedrive')).toHaveLength(1)
    expect(r.brands.filter((b) => b.isSubject)).toHaveLength(1)
  })
})

describe('the cache is the margin lever, and the scan uses it', () => {
  it('a second identical scan makes zero provider calls', async () => {
    const d = deps(() => 'Pipedrive.')
    const first = await runScan(req('pipedrive.com'), d)
    if (first.status !== 'scanned') throw new Error(first.status)
    expect(first.counts.collected).toBeGreaterThan(0)

    const second = await runScan(req('pipedrive.com'), d)
    if (second.status !== 'scanned') throw new Error(second.status)
    expect(second.counts.cacheHits).toBe(second.counts.cellsRequested)
    expect(second.counts.providerCalls).toBe(0)
    // And it must produce the same numbers, or the cache is not serving the
    // same measurement it stored.
    expect(second.brands.map((b) => [b.id, b.mentions])).toEqual(first.brands.map((b) => [b.id, b.mentions]))
  })

  it('R4 — one stored object per cell, not one per answer', async () => {
    const d = deps(() => 'Pipedrive.')
    const r = await runScan(req('pipedrive.com', { maxPrompts: 3 }), d)
    if (r.status !== 'scanned') throw new Error(r.status)
    expect(d.blob.size).toBe(r.counts.cellsRequested)
  })

  it('maxPrompts trims the scan deterministically', async () => {
    const d = deps(() => 'Pipedrive.')
    const r = await runScan(req('pipedrive.com', { maxPrompts: 2 }), d)
    if (r.status !== 'scanned') throw new Error(r.status)
    expect(r.counts.cellsRequested).toBe(2 * ENGINES.length)
  })
})

describe('classification drives the bank, and the taxonomy is honoured', () => {
  it('scans the category the domain classified into, not a default', async () => {
    const cases: [string, string][] = [
      ['pipedrive.com', 'crm-software'],
      ['asana.com', 'project-management-software'],
      ['bitwarden.com', 'password-managers'],
      ['shopify.com', 'ecommerce-platforms'],
    ]
    for (const [domain, slug] of cases) {
      const r = await runScan(req(domain, { maxPrompts: 1 }), deps(() => 'nothing in particular'))
      expect([domain, r.status === 'scanned' ? r.category : r.status]).toEqual([domain, slug])
    }
  })

  it('a classified slug with no bank refuses rather than scanning something else', async () => {
    const orphan = { ...DEMO_TAXONOMY[0]!, slug: 'orphan-category', domainKeywords: ['orphan'] }
    const d = deps(() => 'x')
    const r = await runScan(req('my-orphan.io'), { ...d, taxonomy: [orphan], banks: [] })
    expect(r.status).toBe('unclassified')
    expect(d.blob.size).toBe(0)
  })
})
