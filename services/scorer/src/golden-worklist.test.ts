import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PUBLISHER_REGISTRY } from '../../../packages/taxonomy/src/publishers.js'
import { DEMO_BANKS } from '../../../packages/taxonomy/src/index.js'
import { r2KeyFor } from '../../collector/src/cache-index.js'
import { writeCycle } from '../../grader/src/cycles.js'
import { FileBlobStore } from '../../grader/src/local-store.js'
import { cellsFor, subjectFor } from '../../grader/src/scan.js'
import { validateGoldenCase } from './golden.js'
import { SCORING_ALGO_VERSION } from './score.js'
import { REGISTRY_SNAPSHOT, readCorpus, scanPublishers, withLabel } from './golden-worklist-cli.js'
import { WORKLIST_SEED, assignIds, caseKey, caseSlug, selectWorklist, sensitiveFindings, structuralCovers, toWorklistCase, type CorpusAnswer } from './golden-worklist.js'

const here = dirname(fileURLToPath(import.meta.url))

/** One synthetic corpus answer. Distinct per (engine, category, n). */
function answer(engine: string, category: string, n: number, over: Partial<CorpusAnswer> = {}): CorpusAnswer {
  return {
    domain: `${category}.example`,
    category,
    day: '2026-09-01',
    engine,
    prompt: `Best ${category} tool number ${n} for a small team`,
    comparisonBasis: `grader|engines=${engine}|en-US|US|${category}@1|unprompted=1|runs=1`,
    // The trailing hyphen keeps n = 1 and n = 10 apart once padded.
    cell: { key: `${engine}-${category}-${n}-`.padEnd(64, 'x'), adapter: `openwebninja:${engine}`, run: 0 },
    collectedAt: '2026-09-01T10:00:00.000Z',
    answer: { text: `Answer ${n} about ${category}.`, citations: [{ url: `https://example.org/${n}`, position: 0 }] },
    brand: { id: 'acme', name: 'Acme', aliases: ['Acme'], domains: ['acme.example'] },
    competitors: [],
    publishers: {},
    ...over,
  }
}

const corpus = (sizes: Readonly<Record<string, number>>): CorpusAnswer[] =>
  Object.entries(sizes).flatMap(([stratum, size]) => {
    const [engine, category] = stratum.split('|') as [string, string]
    return Array.from({ length: size }, (_, i) => answer(engine, category, i))
  })

describe('selectWorklist — stratified by engine × category, deterministic', () => {
  it('gives every stratum an equal share, takes a small stratum whole and re-divides what it could not use', () => {
    const s = selectWorklist(corpus({ 'chatgpt|crm': 2, 'gemini|crm': 50, 'chatgpt|erp': 50 }), { target: 30 })
    expect(s.strata).toEqual([
      { stratum: 'chatgpt|crm', available: 2, selected: 2 },
      { stratum: 'chatgpt|erp', available: 50, selected: 14 },
      { stratum: 'gemini|crm', available: 50, selected: 14 },
    ])
    expect(s.selected).toHaveLength(30)
  })

  it('hands out what flooring left over, so the target is met exactly whenever the corpus can meet it', () => {
    const s = selectWorklist(corpus({ 'a|x': 40, 'b|x': 40, 'c|x': 40 }), { target: 100 })
    expect(s.strata.map((x) => x.selected).sort()).toEqual([33, 33, 34])
    expect(s.selected).toHaveLength(100)
  })

  it('one pass is enough: for any strata and any target it selects min(target, corpus), never more than a stratum holds, and as evenly as the sizes allow', () => {
    // The first build had a second pass to hand out what flooring left over. It could never run (E4 review, N4): this is the property that made it unnecessary.
    let seed = 20260919
    const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    for (let trial = 0; trial < 120; trial++) {
      const sizes: Record<string, number> = {}
      for (let k = 0, strata = 1 + next(7); k < strata; k++) sizes[`e${k}|c`] = 1 + next(40)
      const total = Object.values(sizes).reduce((a, b) => a + b, 0)
      const target = 1 + next(total + 20)
      const s = selectWorklist(corpus(sizes), { target })
      expect(s.selected, JSON.stringify({ sizes, target })).toHaveLength(Math.min(target, total))
      for (const st of s.strata) expect(st.selected).toBeLessThanOrEqual(st.available)
      // Water-filled: a stratum that was not taken whole never trails another by more than one.
      const notWhole = s.strata.filter((st) => st.selected < st.available).map((st) => st.selected)
      if (notWhole.length) expect(Math.max(...s.strata.map((st) => st.selected)) - Math.min(...notWhole), JSON.stringify({ sizes, target })).toBeLessThanOrEqual(1)
    }
  })

  it('takes everything when the corpus is smaller than the target, and says how much there was', () => {
    const s = selectWorklist(corpus({ 'chatgpt|crm': 3, 'gemini|erp': 4 }), { target: 300 })
    expect(s.selected).toHaveLength(7)
    expect(s.strata.every((x) => x.selected === x.available)).toBe(true)
  })

  it('does not depend on the order the corpus was read in, and the seed is what decides', () => {
    const all = corpus({ 'chatgpt|crm': 40, 'gemini|crm': 40 })
    const a = selectWorklist(all, { target: 20 })
    const b = selectWorklist([...all].reverse(), { target: 20 })
    expect(b.selected.map(caseKey)).toEqual(a.selected.map(caseKey))
    expect(a.seed).toBe(WORKLIST_SEED)
    const other = selectWorklist(all, { target: 20, seed: 'another-seed' })
    expect(other.selected.map(caseKey)).not.toEqual(a.selected.map(caseKey))
    // Not the first ten of each stratum: a hash order, not a file order.
    expect(a.selected.map(caseKey)).not.toEqual([...all.slice(0, 10), ...all.slice(40, 50)].map(caseKey))
  })

  it('leaves out a fixture adapter’s text, names it, and never counts it towards a stratum', () => {
    const fake = answer('chatgpt', 'crm', 99, { cell: { key: 'f'.repeat(64), adapter: 'fixture:chatgpt', run: 0 } })
    const s = selectWorklist([...corpus({ 'chatgpt|crm': 3 }), fake], { target: 10 })
    expect(s.selected.map(caseKey)).not.toContain(caseKey(fake))
    expect(s.excluded).toEqual([expect.objectContaining({ key: caseKey(fake), reason: expect.stringContaining('fixture adapter') })])
    expect(s.strata).toEqual([{ stratum: 'chatgpt|crm', available: 3, selected: 3 }])
  })

  it('leaves out an answer that would put an email, a phone number or a credential in a public repository, and says which', () => {
    const email = answer('chatgpt', 'crm', 1, { answer: { text: 'Write to jane.doe@gmail.com for a quote.', citations: [] } })
    const phone = answer('chatgpt', 'crm', 2, { answer: { text: 'Call +91 98765 43210 to book a demo.', citations: [] } })
    const inMeta = answer('chatgpt', 'crm', 3, { answer: { text: 'Clean.', citations: [{ url: 'https://example.org/x', position: 0, meta: { snippet: 'api_key = "sk_live_abcdefghijklmnop1234"' } }] } })
    const clean = answer('chatgpt', 'crm', 4, { answer: { text: 'Under ₹2,000 to 3,500 in 2025-2026; polling rate 1000 Hz; model G502 X; 1,00,000 clicks; call quality is fine.', citations: [] } })
    const s = selectWorklist([email, phone, inMeta, clean], { target: 10 })
    expect(s.selected.map(caseKey)).toEqual([caseKey(clean)])
    expect(s.excluded.map((e) => e.reason)).toEqual(expect.arrayContaining([expect.stringContaining('email address'), expect.stringContaining('phone number'), expect.stringContaining('credential')]))
    expect(sensitiveFindings(clean.answer.text)).toEqual([])
  })

  it('keeps an empty answer: the scan counted it in its denominator, so the set has to hold it', () => {
    const empty = answer('google-ai-overviews', 'crm', 1, { answer: { text: '', citations: [] } })
    const s = selectWorklist([empty], { target: 10 })
    expect(s.selected).toHaveLength(1)
    expect(structuralCovers(empty)).toContain('empty answer')
  })

  it('one answer scored for two subjects is two cases; the same case twice is one', () => {
    const a = answer('chatgpt', 'crm', 1)
    const s = selectWorklist([a, { ...a }, { ...a, domain: 'rival.example' }], { target: 10 })
    expect(s.selected.map((x) => x.domain).sort()).toEqual(['crm.example', 'rival.example'])
  })

  it('refuses a target that is not a positive whole number', () => {
    expect(() => selectWorklist([], { target: 0 })).toThrow(RangeError)
    expect(() => selectWorklist([], { target: 2.5 })).toThrow(RangeError)
  })
})

describe('case ids — stable forever', () => {
  const picked = corpus({ 'chatgpt|crm': 2, 'gemini|crm': 1 })

  it('numbers new cases after the highest existing id, in a reader’s order, with a slug that says what the case is', () => {
    const ids = assignIds(picked, [{ id: 'g001-plain-mention' }, { id: 'g007-token-boundaries' }])
    expect([...ids.values()].sort()).toEqual(['g008-gpt-crm-best-crm-tool-number', 'g009-gem-crm-best-crm-tool-number', 'g010-gpt-crm-best-crm-tool-number'])
    expect(caseSlug({ engine: 'google-ai-overviews', domain: 'www.TheCosmicByte.com', prompt: 'What is the best RGB mousepad in India under ₹1500?' })).toBe('aio-thecosmicbyte-best-rgb-mousepad-india')
  })

  it('an answer that already has a case keeps that case’s id when the tool is run again over a grown corpus', () => {
    const first = assignIds(picked, [{ id: 'g007-x' }])
    const existing = [{ id: 'g007-x' }, ...picked.map((a) => ({ id: first.get(caseKey(a))!, key: caseKey(a) }))]
    const grown = [...picked, answer('copilot', 'crm', 7)]
    const second = assignIds(grown, existing)
    for (const a of picked) expect(second.get(caseKey(a))).toBe(first.get(caseKey(a)))
    expect(second.get(caseKey(grown[3]!))).toMatch(/^g011-cop-/)
  })
})

describe('the worklist never meets the scorer', () => {
  it('a worklist case has no label, and says honestly what it covers', () => {
    const plain = answer('gemini', 'crm', 1, { answer: { text: 'Plain prose.', citations: [{ url: 'https://example.org/a', position: 0 }] } })
    const wl = toWorklistCase(plain, 'g008-x')
    expect(wl).not.toHaveProperty('label')
    expect(wl).not.toHaveProperty('labelledBy')
    expect(wl.covers).toContain('pins no particular edge')
    expect(wl.source).toMatchObject({ engine: 'gemini', domain: 'crm.example', day: '2026-09-01', prompt: plain.prompt, cell: plain.cell })
    const dialect = answer('copilot', 'crm', 2, { answer: { text: '| a | b |\n|---|---|', citations: [{ url: 'https://example.org/a', position: 0, meta: { publisher: 'X', icon_url: 'y' } }] } })
    expect(structuralCovers(dialect)).toContain("citation metadata in copilot's own dialect (icon_url, publisher)")
    expect(structuralCovers(dialect)).toContain('answer contains a table')
  })

  it('neither worklist file calls the scorer, the classifier, the harness or the scoring reader', () => {
    // The integrity line of MVP_PLAN E4, held mechanically: a label must be made without the scorer's opinion in reach.
    for (const file of ['golden-worklist.ts', 'golden-worklist-cli.ts']) {
      const src = readFileSync(join(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      for (const banned of ['scoreAnswer', 'scoreStoredCycle', 'readScanAnswers', 'runGoldenSet', 'classifyCitation', 'findMentions', 'promptRows']) expect(src, `${file} mentions ${banned}`).not.toContain(banned)
      // Types may cross; a function may not. Every import from the scorer's own rule modules is `import type`.
      const fromRules = src.split('\n').filter((l) => /from\s+['"]\.\/(score|classify-source)\.js['"]/.test(l))
      for (const line of fromRules) expect(line, `${file}: ${line}`).toMatch(/^import type /)
    }
  })
})

describe('the publisher registry the worklist copies into a case', () => {
  /*
   * The grader forbids a third production reader of the registry constant
   * (publisher-wiring.test.ts): a third reader is a third opinion. The worklist
   * therefore reads a snapshot, and THIS is what keeps the snapshot from
   * becoming an opinion: it equals the registry entry for entry, under the
   * scoring version it was taken at. A registry edit is a scoring rule change
   * (det-3's own note), so it fails here until the snapshot is retaken with it.
   */
  it('is the scan’s registry, entry for entry, under the current scoring version', () => {
    const snapshot = JSON.parse(readFileSync(REGISTRY_SNAPSHOT, 'utf8')) as { algoVersion: string; publishers: Record<string, string> }
    expect(snapshot.publishers).toEqual(PUBLISHER_REGISTRY)
    expect(Object.keys(snapshot.publishers)).toEqual(Object.keys(PUBLISHER_REGISTRY))
    expect(snapshot.algoVersion).toBe(SCORING_ALGO_VERSION)
    expect(scanPublishers()).toEqual(PUBLISHER_REGISTRY)
  })

  it('refuses a snapshot with no publishers rather than build cases the scan would have scored differently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bliprank-golden-registry-'))
    const empty = join(dir, 'registry.json')
    writeFileSync(empty, JSON.stringify({ algoVersion: 'det-3', publishers: {} }))
    expect(() => scanPublishers(empty)).toThrow(/holds no publishers/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('readCorpus — a stored cycle’s answers with the specs the scan used, over a fixture corpus', () => {
  const DOMAIN = 'pipedrive.com'
  const DAY = '2026-08-25'
  const bank = DEMO_BANKS.find((b) => b.category === 'crm-software')!
  const engines = ['chatgpt', 'copilot'] as const
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bliprank-golden-corpus-'))
    writeCycle(dir, {
      status: 'scanned',
      domain: DOMAIN,
      category: 'crm-software',
      comparisonBasis: `grader|engines=${engines.join(',')}|en-US|US|crm-software@${bank.version}|unprompted=2|runs=1`,
      collectedAt: `${DAY}T06:00:00.000Z`,
      run: { day: DAY },
      // A stored result carries score rows. The reader must not need them: these are deliberately absurd.
      promptRows: [{ prompt: 'x', engine: 'chatgpt', mentioned: 'NOT-A-BOOLEAN' }],
    } as Parameters<typeof writeCycle>[1])

    const blob = new FileBlobStore(join(dir, 'answers'))
    const cells = cellsFor(bank, engines, DAY, 2)
    expect(cells).toHaveLength(4)
    for (const [i, c] of cells.entries()) {
      if (i === 3) continue // one cell was never stored
      // Cells run question by question, engine by engine: 0 chatgpt, 1 copilot, 2 chatgpt (a fixture's), 3 copilot (never stored).
      const adapter = i === 2 ? `fixture:${c.engine}` : `openwebninja:${c.engine}`
      const run = {
        text: i === 0 ? 'Pipedrive is the usual pick; HubSpot is the free one.' : i === 1 ? '' : 'Synthetic fixture text.',
        citations: i === 0 ? [{ url: 'https://www.pipedrive.com/en/pricing', title: 'Pricing', position: 0, meta: { publisher: 'Pipedrive' } }, { title: 'no url, dropped' }] : [],
        collectedAt: `${DAY}T06:00:0${i}.000Z`,
        adapter,
      }
      // Stored where the evidence reader looks when the index has no entry: the provider-qualified key.
      await blob.put(r2KeyFor(c.cell, `openwebninja:${c.engine}`), JSON.stringify({ cell: c.cell, adapter, runs: [run] }))
    }
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads every stored answer of the cycle with the subject, competitors and publisher registry the scan scored with', async () => {
    const got = await readCorpus(dir)
    expect(got.cycles).toBe(1)
    expect(got.answers).toHaveLength(3)
    const first = got.answers[0]!
    expect(first).toMatchObject({ domain: DOMAIN, category: 'crm-software', day: DAY, engine: 'chatgpt', collectedAt: `${DAY}T06:00:00.000Z` })
    expect(first.cell).toMatchObject({ adapter: 'openwebninja:chatgpt', run: 0 })
    expect(first.cell.key).toMatch(/^[0-9a-f]{64}$/)
    expect(first.brand).toEqual(subjectFor(DOMAIN, bank).spec)
    expect(first.competitors.map((b) => b.id)).toEqual(bank.leaders.filter((l) => l.id !== first.brand.id).map((l) => l.id))
    expect(first.publishers).toEqual(PUBLISHER_REGISTRY)
    // Exactly as stored: the title and the provider's metadata survive; only a citation with no URL is dropped.
    expect(first.answer.citations).toEqual([{ url: 'https://www.pipedrive.com/en/pricing', title: 'Pricing', position: 0, meta: { publisher: 'Pipedrive' } }])
    expect(got.skipped).toEqual([expect.stringContaining('no stored object for the cell')])
  })

  it('writes nothing into the data directory it reads', async () => {
    const snapshot = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? snapshot(join(d, e.name)) : [`${join(d, e.name)}:${statSync(join(d, e.name)).mtimeMs}`]))
    const before = snapshot(dir)
    await readCorpus(dir)
    expect(snapshot(dir)).toEqual(before)
  })

  it('refuses a directory that is not a grader data directory instead of creating one', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'bliprank-golden-empty-'))
    await expect(readCorpus(empty)).rejects.toThrow(/not a grader data directory/)
    expect(readdirSync(empty)).toEqual([])
    rmSync(empty, { recursive: true, force: true })
  })

  it('from corpus to a valid golden case: selected, unlabelled, then labelled by a reader and accepted by the harness’s own validator', async () => {
    const got = await readCorpus(dir)
    const s = selectWorklist(got.answers, { target: 300 })
    expect(s.excluded).toEqual([expect.objectContaining({ engine: 'chatgpt', reason: expect.stringContaining('fixture adapter (fixture:chatgpt)') })])
    expect(s.selected).toHaveLength(2)
    const ids = assignIds(s.selected, [{ id: 'g007-token-boundaries' }])
    const wl = s.selected.map((a) => toWorklistCase(a, ids.get(caseKey(a))!))
    const mentioned = wl.find((c) => c.answer.text !== '')!
    const text = mentioned.answer.text
    const labelled = withLabel(mentioned, {
      id: mentioned.id,
      label: { mentioned: true, mentionCount: 1, brandsDetected: 2, cited: true, position: 1, competitorsMentioned: ['HubSpot'], citationClasses: { '0': 'owned' } },
      evidence: {
        mentions: [{ brand: 'pipedrive', span: 'Pipedrive', offset: text.indexOf('Pipedrive') }, { brand: 'hubspot', span: 'HubSpot', offset: text.indexOf('HubSpot') }],
        order: ['Pipedrive', 'HubSpot'],
        citations: { '0': 'www.pipedrive.com is on the subject’s own domain' },
      },
      edge: 'subject first,   competitor second',
    })
    expect(validateGoldenCase(labelled)).toEqual([])
    expect(labelled).toMatchObject({ labelledBy: 'agent-proposed', verifiedBy: null })
    expect(labelled.covers).toMatch(/seen on reading: subject first, competitor second$/)

    const empty = wl.find((c) => c.answer.text === '')!
    const none = withLabel(empty, { id: empty.id, label: { mentioned: false, mentionCount: 0, brandsDetected: 0, cited: false, position: null, competitorsMentioned: [], citationClasses: {} }, evidence: { mentions: [], order: [], citations: {} } })
    expect(validateGoldenCase(none)).toEqual([])
    // A label whose evidence is invented does not get in.
    expect(validateGoldenCase(withLabel(mentioned, { id: mentioned.id, label: labelled.label, evidence: { ...labelled.evidence!, mentions: [{ brand: 'pipedrive', span: 'Pipedrive', offset: 7 }, labelled.evidence!.mentions[1]!] } }))).toContainEqual(expect.stringContaining('is not at offset'))
  })
})
