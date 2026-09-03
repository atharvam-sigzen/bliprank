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
import { SCORING_ALGO_VERSION, findMentions, normaliseForMatch } from '@bliprank/scorer'
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

describe('PROPERTY 1 — what may spend, and what still may not', () => {
  /*
   * ⚠️ THIS PROPERTY WAS DELIBERATELY NARROWED, 2026-08-25.
   *
   * It used to read "a domain that does not classify never spends", and that was
   * a real spend guard: no category meant no bank meant no cell. It was traded
   * away on an explicit instruction, so that a demo visitor typing any real
   * domain gets a measurement instead of a dead end. An uncategorised domain now
   * scans against the fallback bank and COSTS A FULL SCAN.
   *
   * What survives is the half that was protecting against accidents rather than
   * against ignorance: a string that is not a domain still buys nothing. That is
   * the line, and these tests are what hold it.
   */
  it('an uncategorised but REAL domain now scans, against the fallback bank', async () => {
    const d = deps(() => 'nothing')
    const r = await runScan(req('acme.com'), d)
    expect(r.status).toBe('scanned')
    if (r.status !== 'scanned') return
    expect(r.category).toBe('general-business-software')
    expect(r.fallback).toEqual({ reason: 'unclassified', detail: expect.any(String), candidates: [] })
    // No leaders in that bank, so the subject is the only brand and there is
    // nothing to rank it against. An empty competitor set is the honest output
    // when the category is unknown — not an empty chart with invented rivals.
    expect(r.brands.filter((b) => !b.isSubject)).toEqual([])
    expect(r.subjectSource).toBe('domain-label')
    // It really did buy something. Stated plainly rather than left implied.
    expect(d.blob.size).toBeGreaterThan(0)
  })

  it('an ambiguous domain scans too, and carries the candidates rather than flattening them', async () => {
    const d = deps(() => 'nothing')
    const r = await runScan(req('zoho.com'), d)
    expect(r.status).toBe('scanned')
    if (r.status !== 'scanned') return
    expect(r.category).toBe('general-business-software')
    // "You lead three of these at once" is information. It is carried, not
    // collapsed into "we could not place you", because those are different facts.
    expect(r.fallback?.reason).toBe('ambiguous')
    expect(r.fallback?.candidates).toEqual(['accounting-software', 'crm-software', 'hr-payroll-software'])
  })

  it('THE LINE THAT HELD: a filename pasted into the box still costs nothing', async () => {
    const d = deps(() => 'nothing')
    expect((await runScan(req('report.pdf'), d)).status).toBe('unclassified')
    expect(d.blob.size).toBe(0)
  })

  it('and neither does a half-typed address', async () => {
    // The failure this guards is a live one: a public box, no confirmation step,
    // and one scan of quota left. A typo must not be able to spend it.
    for (const junk of ['hello.txt', 'acme', 'http://', 'a.b', '  ']) {
      const d = deps(() => 'nothing')
      expect([junk, (await runScan(req(junk), d)).status]).toEqual([junk, 'unclassified'])
      expect([junk, d.blob.size]).toEqual([junk, 0])
    }
  })

  it('a fallback scan is NOT comparable with a category scan', async () => {
    // The structural half of the honesty claim. Nobody has to remember this:
    // comparisonBasisFor stamps the bank slug, so compare() refuses the pairing.
    const a = await runScan(req('acme.com'), deps(() => 'nothing'))
    const b = await runScan(req('pipedrive.com'), deps(() => 'nothing'))
    expect(a.status).toBe('scanned')
    expect(b.status).toBe('scanned')
    if (a.status !== 'scanned' || b.status !== 'scanned') return
    expect(a.comparisonBasis).not.toBe(b.comparisonBasis)
    expect(a.comparisonBasis).toContain('general-business-software@1')
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
      expect([b.id, b.metric.algo_version]).toEqual([b.id, SCORING_ALGO_VERSION])
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

/**
 * THE FALSE ZERO — thecosmicbyte.com, 2026-09-01, algo det-1 → det-2.
 *
 * The subject's only alias was the domain label `thecosmicbyte`. All five
 * engines write "Cosmic Byte". A brand named 139 times across 31 of 50 collected
 * answers was published as mentioned in NONE of them, at 0.0%, beside a
 * confidence grade. The instrument read zero; the world did not.
 */
describe('a brand whose domain runs its words together is still found', () => {
  const bank = DEMO_BANKS.find((b) => b.category === 'general-business-software')!

  it('derives the spaced trading name from the domain alone, with no site title', () => {
    const { spec, source } = subjectFor('thecosmicbyte.com', bank)
    expect(source).toBe('domain-label')
    // The prefix-stripped form is what "Cosmic Byte" squashes to.
    expect(spec.squashedAliases).toContain('cosmicbyte')
    expect(spec.squashedAliases).toContain('thecosmicbyte')
  })

  it('MATCHES the form the engines actually wrote — the exact defect', () => {
    const { spec } = subjectFor('thecosmicbyte.com', bank)
    const real = 'For budget gaming in India, Cosmic Byte and a few others dominate the shelf.'
    expect(findMentions(normaliseForMatch(real), spec)).not.toBeNull()

    // And the old behaviour, to show what changed: label-only found nothing.
    const before = { id: 'x', name: 'thecosmicbyte', aliases: ['thecosmicbyte'], domains: ['thecosmicbyte.com'] }
    expect(findMentions(normaliseForMatch(real), before)).toBeNull()
  })

  it('a corroborated site title sharpens the NAME, and a wrong one cannot invent it', () => {
    // The title names the brand: it squashes to the prefix-stripped label, so
    // it is accepted and becomes the display name.
    const good = subjectFor('thecosmicbyte.com', bank, 'Cosmic Byte - Gaming Peripherals India')
    expect(good.spec.name).toBe('Cosmic Byte')
    expect(good.spec.aliases).toContain('Cosmic Byte')

    // A title that names something else contributes NOTHING. This is the
    // safety property: the title corroborates a name the domain implies, it is
    // never trusted to supply one.
    const bad = subjectFor('thecosmicbyte.com', bank, 'Best Gaming Gear and Accessories in India')
    expect(bad.spec.name).toBe('thecosmicbyte')
    expect(bad.spec.aliases).not.toContain('Best Gaming Gear')
  })

  it('a leader domain is untouched — its reviewed alias table still wins', () => {
    const crm = DEMO_BANKS.find((b) => b.category === 'crm-software')!
    const { spec, source } = subjectFor('pipedrive.com', crm)
    expect(source).toBe('leader')
    expect(spec.squashedAliases).toBeUndefined()
  })
})

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * PER-ANSWER ROWS — the split the record used to say was "not in this cycle's
 * stored payload".
 *
 * The claim these tests pin is a RECONCILIATION claim, not a feature claim: the
 * rows must be the same evidence the headline rate is made of, one row per
 * scored answer, or a surface that renders both is showing two measurements
 * under one heading. `promptBreakdown` in the public app refuses to draw when
 * they disagree; these are what stop them disagreeing at the source.
 */
describe('promptRows — the per-prompt, per-engine evidence behind the rate', () => {
  const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
  const unprompted = bank.prompts.filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent))

  it('emits exactly one row per scored answer, and they reconcile with the metric', async () => {
    // Pipedrive is named by chatgpt only, so the two engines genuinely differ —
    // a split that a divide-the-total table could not have produced.
    const d = deps((_prompt, engine) => (engine === 'chatgpt' ? 'Pipedrive is a good pick.' : 'Try something else entirely.'))
    const r = await runScan(req('pipedrive.com', { maxPrompts: 3 }), d)
    expect(r.status).toBe('scanned')
    if (r.status !== 'scanned') return

    const subject = r.brands.find((b) => b.isSubject)!
    expect(r.promptRows).toHaveLength(subject.metric.n)
    expect(r.promptRows).toHaveLength(r.counts.answersScored)
    expect(r.promptRows.filter((row) => row.mentioned)).toHaveLength(subject.mentions)

    // The split itself: every chatgpt answer names it, no gemini answer does.
    const chatgpt = r.promptRows.filter((row) => row.engine === 'chatgpt')
    const gemini = r.promptRows.filter((row) => row.engine === 'gemini')
    expect(chatgpt).toHaveLength(3)
    expect(gemini).toHaveLength(3)
    expect(chatgpt.every((row) => row.mentioned)).toBe(true)
    expect(gemini.every((row) => row.mentioned)).toBe(false)
  })

  it('carries the prompt AS SENT, not the normalised cache-key form', async () => {
    const d = deps(() => 'nothing here')
    const r = await runScan(req('pipedrive.com', { maxPrompts: 2 }), d)
    if (r.status !== 'scanned') throw new Error(r.status)

    const sent = unprompted.slice(0, 2).map((p) => p.text)
    expect([...new Set(r.promptRows.map((row) => row.prompt))].sort()).toEqual([...sent].sort())
    // The cache key lowercases; a sheet showing that would show a question we
    // did not ask. At least one demo prompt has a capital in it.
    expect(sent.some((t) => t !== t.toLowerCase())).toBe(true)
  })

  it('records position, mention count and the competitors named in the same answer', async () => {
    // HubSpot first, Pipedrive second: position is by first appearance, so the
    // row must say 2 of 2 rather than merely "mentioned".
    const d = deps(() => 'HubSpot leads here, though Pipedrive is the better value. Pipedrive again.')
    const r = await runScan(req('pipedrive.com', { maxPrompts: 1 }), d)
    if (r.status !== 'scanned') throw new Error(r.status)

    const row = r.promptRows[0]!
    expect(row.mentioned).toBe(true)
    expect(row.position).toBe(2)
    expect(row.brandsDetected).toBeGreaterThanOrEqual(2)
    expect(row.mentionCount).toBe(2)
    expect(row.competitorsMentioned).toContain('HubSpot')
  })

  it('an unmentioned answer is a row, not a missing row — that is the whole point', async () => {
    const d = deps(() => 'No CRM is named in this answer at all.')
    const r = await runScan(req('pipedrive.com', { maxPrompts: 2 }), d)
    if (r.status !== 'scanned') throw new Error(r.status)

    expect(r.promptRows).toHaveLength(4)
    expect(r.promptRows.every((row) => row.mentioned === false)).toBe(true)
    expect(r.promptRows.every((row) => row.position === null)).toBe(true)
    // A zero rate with four rows behind it is a finding. Four missing rows
    // would be indistinguishable from a scan that never ran.
    expect(r.brands.find((b) => b.isSubject)!.metric.value).toBe(0)
  })

  it('rows describe the SUBJECT only — a competitor does not get its own rows', async () => {
    const d = deps(() => 'HubSpot is the only one worth naming.')
    const r = await runScan(req('pipedrive.com', { maxPrompts: 2 }), d)
    if (r.status !== 'scanned') throw new Error(r.status)

    // Two prompts x two engines = four answers, and four rows — not eight, not
    // one set per brand scored.
    expect(r.promptRows).toHaveLength(4)
    expect(r.brands.length).toBeGreaterThan(1)
    expect(r.promptRows.every((row) => row.mentioned === false)).toBe(true)
    expect(r.promptRows.every((row) => row.competitorsMentioned.includes('HubSpot'))).toBe(true)
  })
})

describe('a per-domain competitor override reaches the scan through the resolver (ADR-0016)', () => {
  it('the excluded rival is not scored, the included one is, and the basis carries set=<version>; without an override nothing changes', async () => {
    const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
    const hubspot = bank.leaders.find((l) => l.id === 'hubspot')!
    const semrush = DEMO_BANKS.find((b) => b.category === 'seo-tools')!.leaders.find((l) => l.id === 'semrush')!
    const text = () => 'HubSpot and Semrush and Acme all get a mention.'
    const resolver = (competitorSet?: { version: number; competitors: { id: string; name: string; aliases: string[]; domains: string[] }[] }) => async () => ({
      slug: 'crm-software',
      bank,
      signal: 'site-content',
      evidence: 'x',
      ...(competitorSet ? { competitorSet } : {}),
    })
    const plain = await runScan(req('acme.example'), { ...deps(text), resolveCategory: resolver() })
    const overridden = await runScan(req('acme.example'), {
      ...deps(text),
      resolveCategory: resolver({
        version: 3,
        competitors: [...bank.leaders.filter((l) => l.id !== 'hubspot'), semrush].map((l) => ({ id: l.id, name: l.name, aliases: [...l.aliases], domains: [...l.domains] })),
      }),
    })
    expect(plain.status).toBe('scanned')
    expect(overridden.status).toBe('scanned')
    if (plain.status !== 'scanned' || overridden.status !== 'scanned') return
    expect(plain.comparisonBasis).not.toContain('set=')
    expect(plain.brands.map((b) => b.id)).toContain(hubspot.id)
    expect(overridden.comparisonBasis).toBe(`${plain.comparisonBasis}|set=3`)
    expect(overridden.brands.map((b) => b.id)).not.toContain(hubspot.id)
    expect(overridden.brands.map((b) => b.id)).toContain(semrush.id)
    expect(overridden.brands.find((b) => b.id === semrush.id)!.mentions).toBe(overridden.counts.answersScored)
  })
})

describe('the customer’s own prompts are a second measurement, never the headline (ADR-0016)', () => {
  it('custom cells are collected in the same loop, scored into their own block on their own basis, and the headline is byte-identical to a scan without them', async () => {
    const text = (prompt: string) => (prompt.startsWith('custom:') ? 'Only Pipedrive here.' : 'HubSpot and Pipedrive both.')
    const plain = await runScan(req('pipedrive.com'), deps(text))
    const withCustom = await runScan(req('pipedrive.com', { customPrompts: { version: 2, prompts: ['custom: which crm works offline', 'custom: best crm for a two-person studio'] } }), deps(text))
    expect(plain.status).toBe('scanned')
    expect(withCustom.status).toBe('scanned')
    if (plain.status !== 'scanned' || withCustom.status !== 'scanned') return
    // The headline sample, its basis, its brands and its rows: unchanged.
    expect(withCustom.comparisonBasis).toBe(plain.comparisonBasis)
    expect(withCustom.brands).toEqual(plain.brands)
    expect(withCustom.promptRows).toEqual(plain.promptRows)
    expect(plain).not.toHaveProperty('customPrompts')
    // The custom block: its own basis, its own answers, its own rows.
    const c = withCustom.customPrompts!
    expect(c.version).toBe(2)
    expect(c.comparisonBasis).toBe(`${plain.comparisonBasis.replace(/unprompted=\d+/, 'unprompted=0')}|custom=2@2`)
    expect(c.counts).toEqual({ cellsRequested: 2 * ENGINES.length, answersScored: 2 * ENGINES.length })
    expect(c.promptRows.every((r) => r.prompt.startsWith('custom:'))).toBe(true)
    expect(c.brands.find((b) => b.isSubject)!.mentions).toBe(2 * ENGINES.length)
    expect(c.brands.find((b) => b.id === 'hubspot')!.mentions).toBe(0)
    // The cycle's counts are the whole cycle; the block's are its share.
    expect(withCustom.counts.cellsRequested).toBe(plain.counts.cellsRequested + c.counts.cellsRequested)
    expect(withCustom.counts.answersScored).toBe(plain.counts.answersScored + c.counts.answersScored)
  })
})
