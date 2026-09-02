/**
 * WHAT THESE TESTS DEFEND, in order of how expensive it is to get wrong.
 *
 *   1. Nothing is invented. Every promoted name is a string that appeared in a
 *      stored answer, and it carries the answers it appeared in. This is the
 *      rule ADR-0009 spent three refusals protecting; promotion is the one path
 *      that adds a rival, so it is the one path where "where did this come
 *      from" must have a filed answer.
 *
 *   2. ADR-0009's three refusals still hold. `readGeneratedBanks` still DROPS a
 *      generated bank file that has acquired leaders. Promotion did not buy its
 *      capability by weakening the check that was in the way.
 *
 *   3. The bank version moves when the competitor set does. Adding competitors
 *      changes `position`, so a scan from before and one from after are not
 *      measurements of the same thing and `compare()` has to refuse them.
 *
 *   4. The heuristic prefers a NAME over a SENTENCE, and where it cannot tell,
 *      the evidence bar and the human gate are what stand between it and a
 *      chart. Several cases below are real strings from the real corpus.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEMO_BANKS } from '@bliprank/taxonomy'
import {
  DEFAULT_THRESHOLDS,
  buildPromotion,
  excludedKeys,
  extractCandidates,
  looksLikeName,
  promotable,
  readCorpus,
  readPromoted,
  tallyCompetitors,
  writePromotion,
  type AnswerSample,
} from './promote-competitors.js'
import { allBanks, readGeneratedBanks, trackedBrands } from './resolve-category.js'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'promote-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Verbatim from a collected chatgpt answer, 2026-09-01, jewellery ERP prompt. */
const REAL_ANSWER = `If you're looking for an **ERP specifically for a jewellery business with a strong retail POS**, I would avoid generic ERP/POS systems.

### Strong options to evaluate

| ERP | Best for | Retail POS |
| --- | --- | --- |
| **Ornexa** | Modern retail + wholesale | OK |
| **Gehna ERP** | Retail + broad jewellery operations | OK |

These platforms advertise **gold/purity/weight inventory, barcode tagging, making charges, old-gold exchange, GST billing** rather than adding a category to a generic POS.

**1. Ornexa** — particularly interesting if your priority is **fast showroom POS + inventory + GST/HUID + multi-branch**.`

describe('extraction — a name, never a sentence', () => {
  it('lifts the products out of a real answer and leaves its prose behind', () => {
    const got = extractCandidates(REAL_ANSWER)
    expect(got).toContain('Ornexa')
    expect(got).toContain('Gehna ERP')
    // Every one of these is bold in the same answer, and none is a product.
    expect(got).not.toContain('ERP specifically for a jewellery business with a strong retail POS')
    expect(got.some((c) => c.includes('gold/purity'))).toBe(false)
    expect(got.some((c) => c.includes('fast showroom POS'))).toBe(false)
  })

  it('counts a numbered shortlist entry as the same candidate as the table row', () => {
    // "**1. Ornexa**" and "| **Ornexa** |" are one product, and one piece of
    // evidence. Two would let a single answer clear a two-answer bar.
    expect(extractCandidates(REAL_ANSWER).filter((c) => c.toLowerCase().startsWith('ornexa'))).toHaveLength(1)
  })

  it('refuses category vocabulary in caps, which is what an ERP answer is full of', () => {
    for (const acronym of ['ERP', 'POS', 'GST', 'HUID', 'RFID', 'CRM']) expect(looksLikeName(acronym)).toBe(false)
  })

  it('refuses a measurement, and keeps the digit-initial brands that look like one', () => {
    // Straight from the gaming-peripherals corpus. Every left-hand string is a
    // bold span in a real answer; the right-hand ones are real products.
    for (const spec of ['37g', '54 g', '50–60g', '99g', '3°C to 7°C', '800×300 vs 900×400', '75% keyboard']) {
      expect(looksLikeName(spec), spec).toBe(false)
    }
    for (const brand of ['24KaratSolutions', '8BitDo Pro 2', 'Odoo', 'SAP Business One']) {
      expect(looksLikeName(brand), brand).toBe(true)
    }
  })

  it('refuses a clause, however title-cased, on its punctuation and its length', () => {
    expect(looksLikeName('Best for retail, wholesale and manufacturing')).toBe(false)
    expect(looksLikeName('If you tell me your country I can narrow this')).toBe(false)
    expect(looksLikeName('Ok')).toBe(false)
  })
})

const sample = (text: string, prompt: string, engine: string): AnswerSample => ({ text, prompt, engine })

describe('the evidence bar — what a heuristic is allowed to promote', () => {
  const tracked = trackedBrands(DEMO_BANKS)

  it('records the answers, prompts and engines behind every candidate', () => {
    const corpus = [
      sample('**Odoo** is a strong all-rounder.', 'q1', 'chatgpt'),
      sample('**Odoo** again, plus **Katana**.', 'q2', 'gemini'),
      sample('I would look at **Odoo**.', 'q3', 'copilot'),
    ]
    const odoo = tallyCompetitors(corpus, { tracked, exclude: [] }).find((c) => c.name === 'Odoo')!
    expect(odoo.evidence).toMatchObject({ source: 'extracted', answers: 3, prompts: 3, engines: 3 })
    expect(odoo.evidence.engineIds).toEqual(['chatgpt', 'copilot', 'gemini'])
    expect(odoo.evidence.excerpt).toContain('Odoo')
  })

  it('⚠️ one engine is never enough, however often it says the name', () => {
    // The failure mode that matters: an engine is fluent and repeatable, so a
    // name it invented clears an answer count and a prompt count on its own.
    // Two independent systems saying it is a much harder thing to fake.
    const oneEngine = Array.from({ length: 9 }, (_, i) => sample('**Ornexa** is the pick.', `q${i}`, 'chatgpt'))
    expect(promotable(tallyCompetitors(oneEngine, { tracked, exclude: [] }))).toEqual([])
  })

  it('a heading an engine writes every time still does not clear it', () => {
    // "Model", "My picks" and "Best overall" are all real bold/heading spans
    // from the corpus, and they recur — within one engine's house style.
    const corpus = Array.from({ length: 8 }, (_, i) => sample('### Model\n**Best overall**', `q${i}`, 'chatgpt'))
    expect(promotable(tallyCompetitors(corpus, { tracked, exclude: [] }))).toEqual([])
  })

  it('the subject is never proposed as its own competitor', () => {
    const corpus = [
      sample('**Sigzen** is an ERPNext partner.', 'q1', 'chatgpt'),
      sample('**Sigzen** implements ERPNext.', 'q2', 'gemini'),
      sample('Try **Sigzen**.', 'q3', 'copilot'),
    ]
    const names = tallyCompetitors(corpus, { tracked, exclude: ['sigzen.com', 'Sigzen'] }).map((c) => c.name)
    expect(names).not.toContain('Sigzen')
  })

  it('a tracked brand is recorded under its curated name, not the surface form', () => {
    // "quickbooks" matched; the candidate is "QuickBooks", the reviewed name.
    const corpus = [
      sample('Pair it with quickbooks for the books.', 'q1', 'chatgpt'),
      sample('QUICKBOOKS handles the accounting side.', 'q2', 'gemini'),
    ]
    const got = tallyCompetitors(corpus, { tracked, exclude: [] }).find((c) => c.evidence.source === 'tracked')!
    expect(got.name).toBe('QuickBooks')
    expect(got.evidence.answers).toBe(2)
  })

  it('a tracked brand found by shape as well is one candidate, not two', () => {
    // Otherwise a single answer bolding a tracked name would contribute two
    // pieces of evidence for one fact, and one answer could clear a two-answer
    // bar on its own.
    const corpus = [sample('**QuickBooks** is the obvious one.', 'q1', 'chatgpt')]
    const got = tallyCompetitors(corpus, { tracked, exclude: [] }).filter((c) => c.name.toLowerCase() === 'quickbooks')
    expect(got).toHaveLength(1)
    expect(got[0]!.evidence.answers).toBe(1)
  })

  it('the defaults are the documented ones, so a drift in them fails here', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ minAnswers: 3, minPrompts: 2, minEngines: 2 })
  })
})

describe('the store — evidence is the price of admission', () => {
  const candidate = (name: string, answers = 4) => ({
    name,
    evidence: { source: 'extracted' as const, answers, prompts: 3, engines: 2, engineIds: ['chatgpt', 'gemini'], matchedAs: name, excerpt: '…' },
  })

  it('writes a leader with NO domains, so no citation is ever credited to it', () => {
    // A promoted name was learned from prose, and prose cites nothing. Guessing
    // `ornexa.com` from "Ornexa" is the invention this module exists to refuse.
    const dir = tmp()
    writePromotion(dir, buildPromotion('erp-software', [candidate('Ornexa')], { bankVersion: 1, now: '2026-09-02T00:00:00.000Z' }))
    const back = readPromoted(dir, 'erp-software')!
    expect(back.leaders[0]!.domains).toEqual([])
    expect(back.leaders[0]!.id).toBe('promoted:ornexa')
    expect(back.leaders[0]!.evidence.answers).toBe(4)
  })

  it('⚠️ drops an entry that carries no evidence, even hand-written into the file', () => {
    // The file is on disk and a person can type into it. An entry with no
    // evidence is precisely what an invented competitor looks like from here.
    const dir = tmp()
    mkdirSync(join(dir, 'promoted-competitors'), { recursive: true })
    writeFileSync(
      join(dir, 'promoted-competitors', 'erp-software.json'),
      JSON.stringify({
        category: 'erp-software',
        bankVersion: 2,
        leaders: [
          { id: 'promoted:ornexa', name: 'Ornexa', aliases: ['Ornexa'], domains: [], evidence: { source: 'extracted', answers: 4, engines: 2 } },
          { id: 'promoted:invented', name: 'Invented Rival', aliases: ['Invented Rival'], domains: ['invented.com'] },
        ],
      }),
    )
    const back = readPromoted(dir, 'erp-software')!
    expect(back.leaders.map((l) => l.name)).toEqual(['Ornexa'])
  })

  it('forces domains empty on READ too, so a hand-edited attribution cannot land', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'promoted-competitors'), { recursive: true })
    writeFileSync(
      join(dir, 'promoted-competitors', 'erp-software.json'),
      JSON.stringify({
        category: 'erp-software',
        bankVersion: 2,
        leaders: [
          {
            id: 'promoted:ornexa',
            name: 'Ornexa',
            aliases: ['Ornexa'],
            domains: ['ornexa.com'],
            evidence: { source: 'extracted', answers: 4, engines: 2 },
          },
        ],
      }),
    )
    expect(readPromoted(dir, 'erp-software')!.leaders[0]!.domains).toEqual([])
  })

  it('a second round is additive and bumps the version again', () => {
    const dir = tmp()
    const first = buildPromotion('erp-software', [candidate('Ornexa')], { bankVersion: 1, now: 'a' })
    const second = buildPromotion('erp-software', [candidate('Gehna ERP')], { bankVersion: 1, now: 'b', existing: first })
    expect(first.bankVersion).toBe(2)
    expect(second.bankVersion).toBe(3)
    expect(second.leaders.map((l) => l.name)).toEqual(['Ornexa', 'Gehna ERP'])
    writePromotion(dir, second)
    expect(readPromoted(dir, 'erp-software')!.leaders).toHaveLength(2)
  })
})

describe('the human override — a judgement the bar cannot make', () => {
  const candidate = (name: string) => ({
    name,
    evidence: { source: 'extracted' as const, answers: 4, prompts: 3, engines: 2, engineIds: ['chatgpt', 'gemini'], matchedAs: name, excerpt: '…' },
  })

  it('keeps the batch and drops the named ones — never all-or-nothing', () => {
    // The real shape of this report: six good names and two that clear the
    // arithmetic while being wrong about the market. Refusing the batch over
    // the two would mean taking the wrong ones or taking none.
    const p = buildPromotion('erp-software', [candidate('Odoo'), candidate('Shopify'), candidate('Xero')], {
      bankVersion: 1,
      now: 'now',
      exclude: ['Shopify'],
    })
    expect(p.leaders.map((l) => l.name)).toEqual(['Odoo', 'Xero'])
    expect(p.excluded).toEqual([{ name: 'Shopify', at: 'now' }])
  })

  it('⚠️ the refusal PERSISTS, so the next run does not re-propose it', () => {
    // Without this the override lives in somebody's shell history. The bar is
    // deterministic, so the same corpus reaches the same wrong candidate every
    // single time it is run.
    const first = buildPromotion('erp-software', [candidate('Odoo')], { bankVersion: 1, now: 't1', exclude: ['Shopify'] })
    const second = buildPromotion('erp-software', [candidate('Shopify'), candidate('Xero')], { bankVersion: 1, now: 't2', existing: first })
    expect(second.leaders.map((l) => l.name)).toEqual(['Odoo', 'Xero'])
    expect(second.excluded).toEqual([{ name: 'Shopify', at: 't1' }])
  })

  it('⚠️ is retroactive: refusing a name already promoted removes it', () => {
    // A gate-only refusal would leave a mistake on a chart for ever, and the
    // only undo would be hand-editing the store — the thing every refusal in
    // this module exists to make unnecessary.
    const first = buildPromotion('erp-software', [candidate('Odoo'), candidate('Shopify')], { bankVersion: 1, now: 't1' })
    expect(first.leaders).toHaveLength(2)
    const second = buildPromotion('erp-software', [], { bankVersion: 1, now: 't2', existing: first, exclude: ['Shopify'] })
    expect(second.leaders.map((l) => l.name)).toEqual(['Odoo'])
    // And the version moves, so the removal is a declared change of basis
    // rather than a silent rebase of what the old number meant.
    expect(second.bankVersion).toBeGreaterThan(first.bankVersion)
  })

  it('matches a refusal however it was typed', () => {
    const p = buildPromotion('x', [candidate('SAP Business One')], { bankVersion: 1, now: 'now', exclude: ['sap business one'] })
    expect(p.leaders).toEqual([])
    expect(excludedKeys(p).has('sapbusinessone')).toBe(true)
  })

  it('survives the round trip through the store', () => {
    const dir = tmp()
    writePromotion(dir, buildPromotion('erp-software', [candidate('Odoo')], { bankVersion: 1, now: 'now', exclude: ['Shopify'] }))
    const back = readPromoted(dir, 'erp-software')!
    expect(back.excluded).toEqual([{ name: 'Shopify', at: 'now' }])
    expect(excludedKeys(back).has('shopify')).toBe(true)
  })

  it('⚠️ a file of pure refusals is still remembered', () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE, AND THE REASONING WAS WRONG.
     *
     * It said `readPromoted` should return null for a file with no leaders,
     * because "an operator who refuses everything has changed nothing". They
     * have: they read the excerpts and decided. Dropping the file meant the next
     * run over the same corpus — deterministic, so the same corpus reaches the
     * same candidates — re-proposed every refused name with no memory of the
     * refusal. The persistence feature failed in precisely the case where every
     * candidate was wrong.
     */
    const dir = tmp()
    writePromotion(dir, buildPromotion('erp-software', [], { bankVersion: 1, now: 'now', exclude: ['Shopify', 'ERPNext'] }))
    const back = readPromoted(dir, 'erp-software')
    expect(back?.excluded?.map((e) => e.name)).toEqual(['Shopify', 'ERPNext'])
    expect(excludedKeys(back).has('shopify')).toBe(true)
    // It remembers and nothing else: no leaders, so no bank and no version move.
    expect(back?.leaders).toEqual([])
  })

  it('a file with neither leaders nor refusals is nothing at all', () => {
    const dir = tmp()
    writePromotion(dir, buildPromotion('erp-software', [], { bankVersion: 1, now: 'now' }))
    expect(readPromoted(dir, 'erp-software')).toBeNull()
  })

  it('the refusal survives a round trip that promotes nothing, then blocks the candidate', () => {
    // The full loop the fix exists for: refuse everything, come back later, and
    // find the wrong candidate still refused rather than freshly proposed.
    const dir = tmp()
    writePromotion(dir, buildPromotion('erp-software', [], { bankVersion: 1, now: 't1', exclude: ['Shopify'] }))
    const held = readPromoted(dir, 'erp-software')
    const next = buildPromotion('erp-software', [candidate('Shopify'), candidate('Odoo')], {
      bankVersion: 1,
      now: 't2',
      ...(held ? { existing: held } : {}),
    })
    expect(next.leaders.map((l) => l.name)).toEqual(['Odoo'])
  })
})

describe('the merge — ADR-0009’s refusals are untouched', () => {
  const writeBank = (dir: string, leaders: unknown[]) => {
    mkdirSync(join(dir, 'generated-banks'), { recursive: true })
    writeFileSync(
      join(dir, 'generated-banks', 'made-up.json'),
      JSON.stringify({
        category: { slug: 'made-up', displayName: 'Made Up', description: 'x', domainKeywords: [], contentKeywords: [] },
        bank: {
          category: 'made-up',
          displayName: 'Made Up',
          description: 'x',
          locale: 'en-US',
          geo: 'US',
          version: 1,
          verified: false,
          leaders,
          prompts: [{ text: 'best made up thing', intent: 'discovery' }],
        },
      }),
    )
  }

  it('⚠️ STILL DROPS a generated bank file that has acquired leaders', () => {
    // The third refusal, unweakened. Promotion did not buy its capability by
    // switching off the check that stood in its way; it took a different door.
    const dir = tmp()
    writeBank(dir, [{ id: 'x', name: 'Invented', aliases: ['Invented'], domains: [] }])
    expect(readGeneratedBanks(dir)).toEqual([])
  })

  it('attaches promoted leaders, and moves the bank version with them', () => {
    const dir = tmp()
    writeBank(dir, [])
    writePromotion(
      dir,
      buildPromotion(
        'made-up',
        [
          {
            name: 'Ornexa',
            evidence: { source: 'extracted', answers: 4, prompts: 3, engines: 2, engineIds: ['chatgpt', 'gemini'], matchedAs: 'Ornexa', excerpt: '…' },
          },
        ],
        { bankVersion: 1, now: '2026-09-02T00:00:00.000Z' },
      ),
    )
    const bank = allBanks(dir).find((b) => b.category === 'made-up')!
    expect(bank.leaders.map((l) => l.name)).toEqual(['Ornexa'])
    // ⚠️ The version MUST move: the competitor set decides `position`, so a scan
    // from before and one from after measure different things and `compare()`
    // has to refuse them rather than call the difference movement.
    expect(bank.version).toBe(2)
    // And no evidence blob leaks into the bank — the store is where it lives.
    expect(Object.keys(bank.leaders[0]!)).toEqual(['id', 'name', 'aliases', 'domains'])
  })

  it('⚠️ enforces the version bump on read, so a hand-edited file cannot defeat it', () => {
    /*
     * The bump is the whole guarantee: `comparisonBasisFor` stamps `slug@version`
     * into every metric, and attaching competitors changes `position`. A file
     * edited back to the bank's own version used to attach six rivals while
     * claiming an unchanged basis — so `compare()` would have put a number
     * scored against them beside one scored against none and called the
     * difference movement.
     */
    const dir = tmp()
    writeBank(dir, [])
    mkdirSync(join(dir, 'promoted-competitors'), { recursive: true })
    writeFileSync(
      join(dir, 'promoted-competitors', 'made-up.json'),
      JSON.stringify({
        category: 'made-up',
        bankVersion: 1, // hand-set back to the bank's own version
        leaders: [{ id: 'promoted:x', name: 'Rival X', aliases: ['Rival X'], domains: [], evidence: { source: 'extracted', answers: 4, engines: 2 } }],
      }),
    )
    const bank = allBanks(dir).find((b) => b.category === 'made-up')!
    expect(bank.leaders.map((l) => l.name)).toEqual(['Rival X'])
    expect(bank.version).toBeGreaterThan(1)
  })

  it('a category with nothing promoted is byte-for-byte what it was', () => {
    const dir = tmp()
    writeBank(dir, [])
    const bank = allBanks(dir).find((b) => b.category === 'made-up')!
    expect(bank.leaders).toEqual([])
    expect(bank.version).toBe(1)
  })
})

describe('the corpus reader', () => {
  it('finds a bank prompt’s answers wherever the store put them, and ignores the rest', () => {
    const dir = tmp()
    const cell = join(dir, 'answers', '2026-09-01', 'chatgpt')
    mkdirSync(cell, { recursive: true })
    const write = (name: string, prompt: string, normalised: string, engine: string, text: string) =>
      writeFileSync(
        join(cell, name),
        JSON.stringify({
          cell: { normalisedPrompt: normalised, engine },
          runs: [{ prompt, text, cell: { normalisedPrompt: normalised, engine } }],
        }),
      )

    // Matched on the NORMALISED prompt, so trailing punctuation and casing
    // drift between the bank and the collection still finds its own answers.
    write('a.json', 'Best ERP for jewellery?', 'best erp for jewellery', 'chatgpt', '**Ornexa** is one.')
    write('b.json', 'Something else entirely', 'something else entirely', 'gemini', '**Irrelevant** answer.')

    const got = readCorpus(join(dir, 'answers'), ['Best ERP for jewellery?'])
    expect(got).toHaveLength(1)
    expect(got[0]!.text).toContain('Ornexa')
  })

  it('a corrupt object degrades the evidence rather than stopping the report', () => {
    const dir = tmp()
    const cell = join(dir, 'answers', '2026-09-01', 'chatgpt')
    mkdirSync(cell, { recursive: true })
    writeFileSync(join(cell, 'bad.json'), '{ not json')
    writeFileSync(
      join(cell, 'good.json'),
      JSON.stringify({ cell: { normalisedPrompt: 'q', engine: 'chatgpt' }, runs: [{ prompt: 'q', text: '**Odoo**', cell: { normalisedPrompt: 'q', engine: 'chatgpt' } }] }),
    )
    expect(readCorpus(join(dir, 'answers'), ['q'])).toHaveLength(1)
  })

  it('an empty store promotes nothing, which is the only honest answer', () => {
    expect(readCorpus(join(tmp(), 'answers'), ['q'])).toEqual([])
  })
})

describe('end to end, on the real committed corpus', () => {
  /*
   * ⚠️ THIS RUNS AGAINST `data-live`, AND IT IS READ-ONLY.
   *
   * It is the only test here that touches real collected answers, and it is
   * worth the coupling: the extractor's job is to survive what engines actually
   * write, and a synthetic fixture is a sample of what I imagined they write.
   * It asserts a floor, not an exact set, so a later collection cycle adding
   * answers cannot fail it.
   */
  const DATA = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', 'data-live')

  it('promotes real ERP products from the real answers, and no prose', () => {
    const bank = allBanks(DATA).find((b) => b.category === 'erp-software')
    if (!bank) return // the committed corpus is not present in this checkout
    const corpus = readCorpus(join(DATA, 'answers'), bank.prompts.map((p) => p.text))
    expect(corpus.length).toBeGreaterThan(20)

    const cleared = promotable(tallyCompetitors(corpus, { tracked: trackedBrands(DEMO_BANKS), exclude: ['sigzen.com', 'Sigzen'] })).map((c) => c.name)
    // Real products the engines actually named, across at least two engines.
    expect(cleared).toContain('Odoo')
    expect(cleared).toContain('ERPNext')
    // And none of the prose that recurs just as often inside one engine.
    for (const prose of ['My recommendation', 'My shortlist', 'Best overall', 'Strong options to evaluate', 'Software']) {
      expect(cleared, prose).not.toContain(prose)
    }
  })

  it('promotes nothing where the engines named SKUs rather than brands', () => {
    // Gaming peripherals: every answer names specific models, each once. The
    // honest output is an empty set, and an empty set is a finding — it is what
    // "no competitor was measured often enough" looks like.
    const bank = allBanks(DATA).find((b) => b.category === 'gaming-peripherals-india')
    if (!bank) return
    const corpus = readCorpus(join(DATA, 'answers'), bank.prompts.map((p) => p.text))
    if (corpus.length === 0) return
    expect(promotable(tallyCompetitors(corpus, { tracked: trackedBrands(DEMO_BANKS), exclude: ['thecosmicbyte.com', 'Cosmic Byte'] }))).toEqual([])
  })

  it('records the reviewed decision for erp-software, and nothing for the category nobody reviewed', () => {
    /*
     * ⚠️ THIS ASSERTION IS THE HUMAN REVIEW, WRITTEN DOWN.
     *
     * The mechanism shipped dry. On 2026-09-02 an operator read the dry run and
     * approved six of the eight names it proposed, refusing `Shopify` (named as
     * an integration: "Connect online platforms like Shopify or WooCommerce")
     * and `ERPNext` (the platform sigzen.com implements, not a rival of it).
     *
     * Pinned so that a later change to the extractor, the bar or the corpus
     * cannot quietly add a seventh competitor to a customer's chart without
     * somebody editing this list and re-reading the excerpts.
     */
    const erp = readPromoted(DATA, 'erp-software')
    if (erp) {
      expect(erp.leaders.map((l) => l.name).sort()).toEqual([
        'Microsoft Dynamics 365',
        'Odoo',
        'QuickBooks',
        'SAP Business One',
        'Salesforce',
        'Xero',
      ])
      expect(erp.excluded?.map((e) => e.name).sort()).toEqual(['ERPNext', 'Shopify'])
      // Every promoted leader is silent on citations. See the header.
      for (const l of erp.leaders) expect(l.domains, l.name).toEqual([])
      expect(erp.bankVersion).toBe(2)
    }
    // Nothing clears the bar there, so nothing was ever written for it.
    expect(readPromoted(DATA, 'gaming-peripherals-india')).toBeNull()
  })
})
