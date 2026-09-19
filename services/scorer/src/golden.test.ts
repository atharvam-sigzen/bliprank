import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DETERMINISTIC_FIELDS,
  GOLDEN_SET_TARGET,
  SPOT_CHECK_SEED,
  SPOT_CHECK_SIZE,
  isProposed,
  labelFingerprint,
  runGoldenSet,
  spotCheckMinAgree,
  spotCheckPopulation,
  spotCheckSample,
  validateEvidence,
  validateGoldenCase,
  type GoldenCase,
  type SpotCheckSheet,
} from './golden.js'
import { DISAGREEMENTS_FILE, disagreementsOf, type RecordedDisagreement } from './golden-report-cli.js'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'answers')

function loadGolden(): GoldenCase[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) as GoldenCase)
}

/** The hand-built fixtures a person wrote together with their text: every case that is not an agent's proposal. */
const seedsOf = (cases: readonly GoldenCase[]): GoldenCase[] => cases.filter((c) => c.labelledBy !== 'agent-proposed')

// Read ONCE. As a default parameter this re-read the whole set (191 files) for every one of the
// 300 cases of every padded set below: a million synchronous reads that held the worker past
// vitest's 60 s acknowledgement (the "onTaskUpdate" timeout), with every test green.
const G001 = loadGolden().find((c) => c.id === 'g001-plain-mention')!

/**
 * g001 as an agent would have proposed it: the same answer and the same label,
 * with the evidence an agent's label must carry. Offsets are looked up, not
 * typed, so the fixture cannot rot if the seed's text is ever edited.
 */
function proposedCase(id: string, base: GoldenCase = G001): GoldenCase {
  const text = base.answer.text
  return {
    ...base,
    id,
    labelledBy: 'agent-proposed',
    verifiedBy: null,
    evidence: {
      mentions: [
        { brand: 'hubspot', span: 'HubSpot', offset: text.indexOf('HubSpot') },
        { brand: 'salesforce', span: 'Salesforce', offset: text.indexOf('Salesforce') },
      ],
      order: ['HubSpot', 'Salesforce'],
      citations: { '0': 'hubspot.com is the subject’s own domain', '1': 'g2.com: review platform' },
    },
  }
}

/** A set at the target size whose labels are ALL agent-proposed and all agree with the scorer. */
const proposedSet = (n: number = GOLDEN_SET_TARGET): GoldenCase[] => Array.from({ length: n }, (_, i) => proposedCase(`p-${String(i).padStart(3, '0')}`))

/**
 * The sheet as a person would leave it: the seeded sample of THESE cases, each
 * entry carrying the fingerprint of the label on file, signed, every box ticked.
 * `agree` of them agree and the rest disagree; `answered` leaves the tail blank.
 */
function sheetFor(cases: readonly GoldenCase[], opts: { agree?: number; by?: string; answered?: number; note?: string } = {}): SpotCheckSheet {
  const sample = spotCheckSample(cases)
  const answered = opts.answered ?? sample.length
  const agree = opts.agree ?? answered
  return {
    checkedBy: opts.by ?? 'A. Person',
    checkedOn: '2026-09-20',
    seed: SPOT_CHECK_SEED,
    population: spotCheckPopulation(cases).fingerprint,
    entries: sample.map((c, i) => ({
      id: c.id,
      fingerprint: labelFingerprint(c),
      verdict: i >= answered ? ('unanswered' as const) : i < agree ? ('agree' as const) : ('disagree' as const),
      note: i >= answered ? '' : i < agree ? (opts.note ?? '') : 'the count is wrong',
    })),
  }
}

describe('golden set — structure', () => {
  const cases = loadGolden()

  it('is non-empty and every case is structurally valid', () => {
    expect(cases.length).toBeGreaterThan(0)
    const errs = cases.flatMap(validateGoldenCase)
    expect(errs).toEqual([])
  })

  it('every case declares what edge it covers, so the set does not silently duplicate itself', () => {
    for (const c of cases) expect(c.covers, `${c.id} has no "covers" note`).toBeTruthy()
  })

  it('ids are unique', () => {
    const ids = cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the validator actually rejects a bad label', () => {
    const base = cases[0]!
    expect(validateGoldenCase({ ...base, label: { ...base.label, mentioned: false, position: 3 } })).toContainEqual(expect.stringContaining('position is not null'))
    expect(validateGoldenCase({ ...base, brand: { ...base.brand, aliases: [] } })).toContainEqual(expect.stringContaining('no aliases'))
    expect(validateGoldenCase({ ...base, label: { ...base.label, citationClasses: { '99': 'owned' } } })).toContainEqual(
      expect.stringContaining('does not exist'),
    )
  })

  it('a real stored answer says whose label it carries, and an agent’s label is never presented as verified by default', () => {
    const real = cases.filter((c) => c.source.cell)
    for (const c of real) expect(c.labelledBy, `${c.id} names a stored cell and no labeller`).toBeDefined()
    // MVP_PLAN E4: every label proposed in this row waits for a person. A case a person has verified names that person.
    for (const c of cases.filter((x) => x.labelledBy === 'agent-proposed')) expect(c.verifiedBy === null || (typeof c.verifiedBy === 'string' && c.verifiedBy.trim() !== ''), `${c.id}: verifiedBy`).toBe(true)
  })

  it('every real case is traceable: engine, domain, day, the question and the cache cell', () => {
    for (const c of cases.filter((x) => x.source.cell)) {
      expect(c.source.domain, c.id).toBeTruthy()
      expect(c.source.day, c.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(c.source.prompt, c.id).toBeTruthy()
      expect(c.source.cell!.key, c.id).toMatch(/^[0-9a-f]{64}$/)
      expect(c.source.cell!.adapter, c.id).not.toMatch(/^fixture/)
    }
  })
})

describe('golden set — whose label, and the evidence behind an agent’s', () => {
  const good = proposedCase('p-good')

  it('a well-formed proposed case is valid', () => {
    expect(validateGoldenCase(good)).toEqual([])
  })

  it('an agent-proposed label without its evidence is refused', () => {
    const { evidence: _dropped, ...bare } = good
    void _dropped
    expect(validateGoldenCase(bare)).toContainEqual(expect.stringContaining('must carry its evidence'))
  })

  it('an agent-proposed label must say nobody has verified it yet, rather than say nothing', () => {
    const { verifiedBy: _dropped, ...silent } = good
    void _dropped
    expect(validateGoldenCase(silent)).toContainEqual(expect.stringContaining('verifiedBy'))
    expect(validateGoldenCase({ ...good, verifiedBy: '  ' })).toContainEqual(expect.stringContaining("person's name"))
    // A name alone is not a verification: it names the label it verified, by fingerprint.
    expect(validateGoldenCase({ ...good, verifiedBy: 'A. Person' })).toContainEqual(expect.stringContaining('needs verifiedFingerprint'))
    expect(validateGoldenCase({ ...good, verifiedBy: 'A. Person', verifiedFingerprint: labelFingerprint(good) })).toEqual([])
  })

  it('a case from a stored cell with no labeller is refused, and so is a labeller nobody defined', () => {
    const { labelledBy: _dropped, verifiedBy: _v, evidence: _e, ...anonymous } = good
    void _dropped, _v, _e
    expect(validateGoldenCase({ ...anonymous, source: { ...good.source, cell: { key: 'k', adapter: 'openwebninja:chatgpt', run: 0 } } })).toContainEqual(expect.stringContaining('must say who labelled it'))
    expect(validateGoldenCase({ ...good, labelledBy: 'the-scorer' as unknown as 'human' })).toContainEqual(expect.stringContaining("'human' or 'agent-proposed'"))
  })

  it('an invented span is caught: the quoted text must stand at its offset', () => {
    const ev = good.evidence!
    const moved = { ...good, evidence: { ...ev, mentions: [{ ...ev.mentions[0]!, offset: ev.mentions[0]!.offset + 1 }, ev.mentions[1]!] } }
    expect(validateEvidence(moved)).toContainEqual(expect.stringContaining('is not at offset'))
  })

  it('the evidence must quote every counted occurrence, in an order that matches the offsets and the label', () => {
    const ev = good.evidence!
    expect(validateEvidence({ ...good, label: { ...good.label, mentionCount: 2 } })).toContainEqual(expect.stringContaining('quotes 1 occurrence'))
    expect(validateEvidence({ ...good, evidence: { ...ev, order: ['Salesforce', 'HubSpot'] } })).toEqual(expect.arrayContaining([expect.stringContaining('first appears later'), expect.stringContaining('evidence order gives 2')]))
    expect(validateEvidence({ ...good, label: { ...good.label, brandsDetected: 3 } })).toContainEqual(expect.stringContaining('brandsDetected is 3'))
    expect(validateEvidence({ ...good, label: { ...good.label, competitorsMentioned: [] } })).toContainEqual(expect.stringContaining('competitorsMentioned'))
    expect(validateEvidence({ ...good, evidence: { ...ev, mentions: [...ev.mentions, { brand: 'oracle', span: 'x', offset: 0 }] } })).toContainEqual(expect.stringContaining('neither the subject nor in the competitor set'))
  })

  it('every citation needs a reason, and a reason needs a citation', () => {
    const ev = good.evidence!
    expect(validateEvidence({ ...good, evidence: { ...ev, citations: { '0': 'owned domain' } } })).toContainEqual(expect.stringContaining('citation 1 has a class and no reason'))
    expect(validateEvidence({ ...good, evidence: { ...ev, citations: { ...ev.citations, '7': 'nothing there' } } })).toContainEqual(expect.stringContaining('citation 7, which does not exist'))
  })
})

describe('golden set — agreement harness', () => {
  const cases = loadGolden()
  const report = runGoldenSet(cases)

  it('the hand-built seed cases agree with the scorer on every labelled field', () => {
    const seeds = runGoldenSet(seedsOf(cases))
    expect(seeds.cases).toBe(7)
    expect(seeds.deterministic.flatMap((f) => f.disagreements)).toEqual([])
    expect(seeds.citationClass.disagreements).toEqual([])
  })

  it('ADR-0005: in the seed cases nothing a person labelled otherwise came back as `owned`', () => {
    expect(runGoldenSet(seedsOf(cases)).silentOwned).toEqual([])
  })

  /*
   * THE PROPOSED CASES DISAGREE WITH THE SCORER IN PLACES, AND THAT IS THE ROW'S
   * OUTPUT, NOT A RED SUITE. What may not happen is a disagreement nobody has
   * seen: a rule edit that moves agreement, or a label edited until it matches.
   * So every disagreement is recorded in golden/disagreements.json, and the
   * live report must equal the record in both directions. Changing either side
   * shows up as a diff of that file in review
   * (`pnpm scorer:golden-report -- --write-disagreements`).
   *
   * Taken WITHOUT the spot-check on purpose: a person ticking a box must never
   * turn the suite red, and a disputed case stays on this list until its label
   * is corrected by a person.
   */
  it('every disagreement between a label and the scorer is on the record, and the record holds nothing that has gone away', () => {
    const recorded = JSON.parse(readFileSync(DISAGREEMENTS_FILE, 'utf8')) as { disagreements: RecordedDisagreement[]; silentOwned: unknown[] }
    expect(disagreementsOf(report)).toEqual(recorded.disagreements)
    expect(report.silentOwned).toEqual(recorded.silentOwned)
  })

  it('does NOT claim G2: below the target it is NOT_RUN, and the note says how many labels are only proposed', () => {
    if (report.cases < GOLDEN_SET_TARGET) {
      expect(report.gateStatus).toBe('NOT_RUN')
      expect(report.gateNote).toMatch(/NOT RUN/)
      if (report.labels.proposed > 0) expect(report.gateNote).toContain(`${report.labels.proposed} of them agent-proposed and unverified`)
    } else if (report.labels.proposed > 0) {
      expect(report.gateStatus).toBe('PROPOSED')
    }
    expect(report.labels.human + report.labels.proposed + report.labels.verified).toBe(report.cases)
  })

  it('the harness reports FAIL rather than throwing when a label disagrees', () => {
    const broken = { ...cases[0]!, id: 'broken', label: { ...cases[0]!.label, mentioned: !cases[0]!.label.mentioned } }
    const r = runGoldenSet([broken])
    expect(r.deterministicRate).toBeLessThan(1)
    expect(r.deterministic.find((f) => f.field === 'mentioned')?.disagreements).toHaveLength(1)
  })

  it('a padded set of hand-built cases at target size would be judged, not skipped', () => {
    // Same seven cases repeated to reach the target: proves the gate arithmetic
    // wires up. It is NOT evidence about accuracy — the same cases repeated
    // carry no more information than one pass of them.
    const seeds = seedsOf(cases)
    const padded = Array.from({ length: GOLDEN_SET_TARGET }, (_, i) => ({ ...seeds[i % seeds.length]!, id: `pad-${i}` }))
    const r = runGoldenSet(padded)
    expect(r.gateStatus).toBe('PASS')
    expect(r.spotCheck.status).toBe('not-needed')
    expect(r.gateNote).toMatch(/deterministic 100\.0% \(1800\/1800 checks, need 95\)/)
  })

  it('the six checks the headline pools are pinned: adding or dropping one moves G2, so it is a decision', () => {
    expect([...DETERMINISTIC_FIELDS]).toEqual(['mentioned', 'mentionCount', 'brandsDetected', 'cited', 'position', 'competitorsMentioned'])
    expect(report.deterministic.map((f) => f.field)).toEqual([...DETERMINISTIC_FIELDS])
    expect(report.deterministic.every((f) => f.total === report.cases)).toBe(true)
  })

  it('the case-level reading stands beside the pooled one, with the interval only it can honestly carry', () => {
    // One wrong `cited` label in ten cases: 59 of 60 checks agree (98.3%), and 9 of 10 cases do (90%).
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...cases[0]!, id: `c-${i}`, label: i === 0 ? { ...cases[0]!.label, cited: !cases[0]!.label.cited } : cases[0]!.label }))
    const r = runGoldenSet(ten)
    expect(r.deterministicRate).toBeCloseTo(59 / 60, 10)
    expect(r.casesFullyAgreed).toMatchObject({ agreed: 9, total: 10 })
    expect(r.casesFullyAgreed.interval!.low).toBeCloseTo(0.596, 3)
    expect(r.casesFullyAgreed.interval!.high).toBeCloseTo(0.982, 3)
  })

  it('nothing measured is not zero agreement, and zero silently owned is not proof of zero', () => {
    const none = runGoldenSet([])
    expect(none.measured).toEqual({ deterministic: false, citations: false })
    expect(none.casesFullyAgreed.interval).toBeNull()
    expect(none.silentOwnedUpper).toBeNull()
    // A set with answers and no citations: the citation figures are unmeasured, not clean.
    const uncited = runGoldenSet(cases.filter((c) => c.answer.citations.length === 0))
    expect(uncited.measured).toEqual({ deterministic: true, citations: false })
    expect(uncited.silentOwnedUpper).toBeNull()
    // 0 seen of N labelled citations still leaves room, and the report says how much: z²/(n + z²), so 0.64% at 600 and wide at a handful.
    expect(report.measured.citations).toBe(true)
    expect(report.silentOwnedUpper!).toBeGreaterThan(0)
    const sixHundred = runGoldenSet(Array.from({ length: GOLDEN_SET_TARGET }, (_, i) => ({ ...G001, id: `z-${i}` })))
    expect(sixHundred.citationClass.total).toBe(600)
    expect(sixHundred.silentOwnedUpper!).toBeCloseTo(0.00636, 4)
    expect(runGoldenSet([G001]).silentOwnedUpper!).toBeGreaterThan(0.5)
  })
})

describe('golden set — the verdict between NOT_RUN and PASS/FAIL (MVP_PLAN E4)', () => {
  it('NOT_RUN: below the target size nothing else is looked at, not even a perfect spot-check', () => {
    const few = proposedSet(GOLDEN_SET_TARGET - 1)
    expect(runGoldenSet(few).gateStatus).toBe('NOT_RUN')
    expect(runGoldenSet(few, sheetFor(few)).gateStatus).toBe('NOT_RUN')
  })

  it('PROPOSED: at full size with agent labels and no spot-check, it reports the three figures with what each is a rate of, and cannot read PASS', () => {
    const set = proposedSet()
    const r = runGoldenSet(set)
    // The scorer agrees with every one of these labels. It is still not a pass: nobody has checked the labels.
    expect(r.deterministicRate).toBe(1)
    expect(r.citationClass.rate).toBe(1)
    expect(r.silentOwned).toEqual([])
    expect(r.gateStatus).toBe('PROPOSED')
    expect(r.spotCheck.status).toBe('missing')
    expect(r.gateNote).toMatch(/PROPOSED, not a verdict/)
    expect(r.gateNote).toContain('deterministic 100.0% (1800/1800 checks, need 95), citation class 100.0% (600/600, need 97), silent owned 0 of 600 (need 0)')
    expect(r.labels).toEqual({ human: 0, proposed: GOLDEN_SET_TARGET, verified: 0 })
  })

  it('PROPOSED: one agent-proposed label among 299 hand-built ones is enough to withhold the verdict', () => {
    const seeds = seedsOf(loadGolden())
    const mixed = [...Array.from({ length: GOLDEN_SET_TARGET - 1 }, (_, i) => ({ ...seeds[i % seeds.length]!, id: `pad-${i}` })), proposedCase('p-one')]
    const r = runGoldenSet(mixed)
    expect(r.gateStatus).toBe('PROPOSED')
    expect(r.spotCheck.required).toBe(1)
  })

  it('agent labels alone can NEVER produce PASS: every sheet that is not a complete, signed check of the seeded sample leaves it PROPOSED', () => {
    const set = proposedSet()
    const full = sheetFor(set)
    const outsiders = set.filter((c) => !full.entries.some((e) => e.id === c.id))
    const entryOf = (c: GoldenCase) => ({ id: c.id, fingerprint: labelFingerprint(c), verdict: 'agree' as const, note: '' })
    const unusable: [string, SpotCheckSheet | undefined][] = [
      ['nothing recorded', undefined],
      ['nobody signed it', { ...full, checkedBy: '   ' }],
      ['half answered', sheetFor(set, { answered: 15 })],
      ['one box still empty', sheetFor(set, { answered: SPOT_CHECK_SIZE - 1 })],
      ['a smaller sample than the seed drew', { ...full, entries: full.entries.slice(0, 10) }],
      // E4 review, B1: thirty REAL proposed cases of this very set, all agreed, signed, and not the thirty the seed drew.
      ['thirty cases somebody picked', { ...full, entries: outsiders.slice(0, SPOT_CHECK_SIZE).map(entryOf) }],
      ['the right thirty with one swapped for a picked one', { ...full, entries: [...full.entries.slice(1), entryOf(outsiders[0]!)] }],
      ['drawn under another seed', { ...full, seed: 'picked-by-hand' }],
      ['no seed recorded', { ...full, seed: null }],
      ['written for another set of labels', { ...full, population: '000000000000' }],
      ['no population recorded', { ...full, population: null }],
      ['it names cases that are in no set', { ...full, entries: full.entries.map((e) => ({ ...e, id: `other-${e.id}` })) }],
      ['a case is listed twice', { ...full, entries: [...full.entries, full.entries[0]!] }],
      ['both boxes ticked on one answer', { ...full, entries: full.entries.map((e, i) => (i === 0 ? { ...e, verdict: 'both' as const } : e)) }],
      ['a label was edited after the sheet was written', { ...full, entries: full.entries.map((e, i) => (i === 0 ? { ...e, fingerprint: '000000000000' } : e)) }],
      // E4 review, B2: 29 agreed is not "29 of 30" when 81 were answered. 29 of 81 is 36%.
      ['the seeded thirty plus fifty-one more, 29 agreed and 52 disagreed', { ...full, entries: [...full.entries.map((e, i) => ({ ...e, verdict: i < 29 ? ('agree' as const) : ('disagree' as const) })), ...outsiders.slice(0, 51).map((c) => ({ ...entryOf(c), verdict: 'disagree' as const }))] }],
      ['the person disagreed with two of thirty', sheetFor(set, { agree: SPOT_CHECK_SIZE - 2 })],
      ['the person disagreed with all of them', sheetFor(set, { agree: 0 })],
    ]
    for (const [why, sheet] of unusable) {
      const r = runGoldenSet(set, sheet)
      expect(r.gateStatus, why).toBe('PROPOSED')
      expect(r.gateNote, why).not.toMatch(/\bPASS\b/)
      expect(['missing', 'unusable', 'below-threshold'], why).toContain(r.spotCheck.status)
    }
  })

  it('the harness draws the sample itself: a caller cannot hand it a conclusion', () => {
    // The first build took `{ sampleIds, agreed, problems: [] }` from its caller. There is nothing like that to pass now:
    // the only input is the sheet, and an extra field claiming it is fine changes nothing.
    const set = proposedSet()
    const drawn = new Set(spotCheckSample(set).map((c) => c.id))
    const picked = set.filter((c) => !drawn.has(c.id)).slice(0, SPOT_CHECK_SIZE)
    const forged = { ...sheetFor(set), entries: picked.map((c) => ({ id: c.id, fingerprint: labelFingerprint(c), verdict: 'agree' as const, note: '' })), problems: [], status: 'accepted' } as SpotCheckSheet
    const r = runGoldenSet(set, forged)
    expect(r.spotCheck.status).toBe('unusable')
    expect(r.spotCheck.problems).toContainEqual(expect.stringContaining('is not the seeded sample of this set (30 sampled case(s) missing, 30 case(s) the seed did not draw'))
    expect(r.spotCheck.agreed).toBe(0)
  })

  it('below the threshold the labels are rejected, and the count is said with its interval', () => {
    const set = proposedSet()
    const r = runGoldenSet(set, sheetFor(set, { agree: 28 }))
    expect(r.spotCheck.status).toBe('below-threshold')
    expect(r.spotCheck).toMatchObject({ agreed: 28, checked: 30, minAgree: 29 })
    expect(r.spotCheck.interval!.low).toBeCloseTo(0.787, 3)
    expect(r.gateNote).toMatch(/agreed with 28 of 30, below the 29 required/)
  })

  it('the threshold is 29 of 30, and every one of a smaller sample', () => {
    expect(spotCheckMinAgree(30)).toBe(29)
    expect(spotCheckMinAgree(29)).toBe(29)
    for (let n = 1; n < SPOT_CHECK_SIZE; n++) expect(spotCheckMinAgree(n), `n = ${n}`).toBe(n)
    expect(spotCheckMinAgree(0)).toBe(0)
  })

  it('PASS: reachable once a signed spot-check of exactly the seeded sample agrees with at least 29 of 30', () => {
    const set = proposedSet()
    for (const agree of [30, 29]) {
      const r = runGoldenSet(set, sheetFor(set, { agree }))
      expect(r.gateStatus, `${agree}/30`).toBe('PASS')
      expect(r.spotCheck.status).toBe('accepted')
      expect(r.gateNote).toMatch(new RegExp(`A\\. Person's spot-check, ${agree} of 30 agreed \\(95% interval `))
    }
    // The order the person's file lists them in is theirs.
    expect(runGoldenSet(set, { ...sheetFor(set), entries: [...sheetFor(set).entries].reverse() }).gateStatus).toBe('PASS')
  })

  it('FAIL: an accepted spot-check lets the labels judge the scorer, and they can judge it wrong', () => {
    const set = proposedSet()
    // 40 of 300 labels say "not cited" where the scorer says cited: 40 of 1800 field checks, 97.8%, still a pass on that figure…
    const wrongCited = set.map((c, i) => (i >= 260 ? { ...c, label: { ...c.label, cited: !c.label.cited } } : c))
    const a = runGoldenSet(wrongCited, sheetFor(wrongCited))
    expect(a.gateStatus).toBe('PASS')
    // …which is why the case-level reading is always beside it: 40 of 300 answers scored wrong is 86.7% of cases.
    expect(a.casesFullyAgreed).toMatchObject({ agreed: 260, total: 300 })
    // A citation class the scorer gets "wrong" on 40 of 600 citations is 93.3%, below the 97 required.
    const wrongClass = set.map((c, i) => (i >= 260 ? { ...c, label: { ...c.label, citationClasses: { ...c.label.citationClasses, '1': 'other' as const } } } : c))
    const r = runGoldenSet(wrongClass, sheetFor(wrongClass))
    expect(r.gateStatus).toBe('FAIL')
    expect(r.citationClass.disagreements).toHaveLength(40)
    // The same set with no spot-check is not a FAIL either: unverified labels do not get to fail the scorer.
    expect(runGoldenSet(wrongClass).gateStatus).toBe('PROPOSED')
  })

  it('a label the person disputed STAYS in the figures and is named: disputing a case is not a way to remove it', () => {
    const set = proposedSet()
    // The one label the person disputes is also one the scorer disagrees with.
    const disputedId = spotCheckSample(set)[SPOT_CHECK_SIZE - 1]!.id
    const withBad = set.map((c) => (c.id === disputedId ? { ...c, label: { ...c.label, cited: false } } : c))
    const r = runGoldenSet(withBad, sheetFor(withBad, { agree: SPOT_CHECK_SIZE - 1 }))
    expect(r.spotCheck.status).toBe('accepted')
    expect(r.spotCheck.disputed).toEqual([{ id: disputedId, note: 'the count is wrong' }])
    // Counted exactly as it is with no sheet at all (E4 review, S5).
    expect(r.deterministic.find((f) => f.field === 'cited')).toMatchObject({ total: GOLDEN_SET_TARGET, disagreements: [{ caseId: disputedId, expected: false, actual: true }] })
    expect(r.deterministicRate).toBe(runGoldenSet(withBad).deterministicRate)
    expect(r.gateNote).toContain(`1 label(s) the person disputed are still counted until corrected: ${disputedId}`)
  })

  it('deleting awkward cases OUTSIDE the sample does not slip past a signed sheet', () => {
    // E4 review, c. A hash-rank draw does not move when cases outside it are deleted, so the sheet's own entries stay
    // valid; the review removed 17 disagreeing cases that way and the signed sheet still judged clean. The population does move.
    const big = proposedSet(GOLDEN_SET_TARGET + 100).map((c, i) => (i % 5 === 0 ? { ...c, label: { ...c.label, cited: !c.label.cited } } : c))
    const signed = sheetFor(big)
    const sampled = new Set(signed.entries.map((e) => e.id))
    const pruned = big.filter((c) => sampled.has(c.id) || c.label.cited === G001.label.cited)
    expect(pruned.length).toBeGreaterThanOrEqual(GOLDEN_SET_TARGET)
    expect(spotCheckSample(pruned).map((c) => c.id)).toEqual(spotCheckSample(big).map((c) => c.id))
    const r = runGoldenSet(pruned, signed)
    expect(r.spotCheck.status).toBe('unusable')
    expect(r.spotCheck.problems).toContainEqual(expect.stringContaining('drawn from a different set of agent-proposed labels'))
    expect(r.gateStatus).toBe('PROPOSED')
  })

  it('correcting a disputed label and having the person verify it does not throw their check away', () => {
    const set = proposedSet()
    const signed = sheetFor(set, { agree: SPOT_CHECK_SIZE - 1 })
    const disputedId = signed.entries[SPOT_CHECK_SIZE - 1]!.id
    // Corrected by re-reading, then verified by the person, fingerprint and all.
    const corrected = set.map((c) => {
      if (c.id !== disputedId) return c
      const fixed = { ...c, label: { ...c.label, cited: !c.label.cited } }
      return { ...fixed, verifiedBy: 'A. Person', verifiedFingerprint: labelFingerprint(fixed) }
    })
    expect(labelFingerprint(corrected.find((c) => c.id === disputedId)!)).not.toBe(signed.entries[SPOT_CHECK_SIZE - 1]!.fingerprint)
    const r = runGoldenSet(corrected, signed)
    // Still the same sample (it is drawn from every agent-proposed label, verified or not) and still the same population.
    expect(r.spotCheck.status).toBe('accepted')
    expect(r.labels).toEqual({ human: 0, proposed: GOLDEN_SET_TARGET - 1, verified: 1 })
    // A label the person AGREED with may not change under them, though.
    const agreedId = signed.entries[0]!.id
    const tampered = set.map((c) => (c.id === agreedId ? { ...c, label: { ...c.label, cited: !c.label.cited } } : c))
    expect(runGoldenSet(tampered, signed).spotCheck.problems).toContainEqual(expect.stringContaining('changed after the sheet was written'))
  })

  it('what the person wrote arrives, beside an AGREE as much as a DISAGREE', () => {
    // The sheet invites "I would rather have a different rule" in any note. The first build kept notes only on a disagreement (E4 review, S9).
    const set = proposedSet()
    const r = runGoldenSet(set, sheetFor(set, { note: 'agree as the rule stands, but I would count a redirect by its card' }))
    expect(r.spotCheck.status).toBe('accepted')
    expect(r.spotCheck.notes).toHaveLength(SPOT_CHECK_SIZE)
    expect(r.spotCheck.notes[0]).toMatchObject({ verdict: 'agree', note: 'agree as the rule stands, but I would count a redirect by its card' })
  })

  it('a label a person has verified is a person’s label only while it is still the label they verified', () => {
    const verified = proposedSet().map((c) => ({ ...c, verifiedBy: 'A. Person', verifiedFingerprint: labelFingerprint(c) }))
    const r = runGoldenSet(verified)
    expect(r.labels).toEqual({ human: 0, proposed: 0, verified: GOLDEN_SET_TARGET })
    expect(r.spotCheck.status).toBe('not-needed')
    expect(r.gateStatus).toBe('PASS')

    // A name with no fingerprint verifies nothing (E4 review, S6)…
    const named = proposedSet().map((c) => ({ ...c, verifiedBy: 'A. Person' }))
    expect(runGoldenSet(named).labels.proposed).toBe(GOLDEN_SET_TARGET)
    expect(runGoldenSet(named).gateStatus).toBe('PROPOSED')
    // …and a label edited after it was verified is a proposal again, which the validator says by name.
    const edited = verified.map((c, i) => (i === 0 ? { ...c, label: { ...c.label, mentionCount: 2 } } : c))
    expect(isProposed(edited[0]!)).toBe(true)
    expect(runGoldenSet(edited).gateStatus).toBe('PROPOSED')
    expect(validateGoldenCase(edited[0]!)).toContainEqual(expect.stringContaining('the label changed after A. Person verified it'))
  })
})
