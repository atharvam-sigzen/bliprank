import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GOLDEN_SET_TARGET, SPOT_CHECK_SEED, SPOT_CHECK_SIZE, isProposed, labelFingerprint, runGoldenSet, spotCheckPopulation, spotCheckSample, type GoldenCase } from './golden.js'
import { SPOT_CHECK_SHEET, loadGoldenCases } from './golden-report-cli.js'
import { parseSpotCheckSheet, renderSpotCheckSheet } from './golden-spot-check.js'

/** A proposed case over a short answer. `n` makes each one distinct; every fourth has no mention, so the sheet shows both kinds. */
function proposed(n: number): GoldenCase {
  const mentioned = n % 4 !== 0
  const text = mentioned ? `Option ${n}: Salesforce is the big one, but HubSpot is easier and HubSpot is cheaper.\nSee https://hubspot.com/pricing for the tiers.` : `Option ${n}: Salesforce is the usual answer for a team this size.`
  const first = text.indexOf('HubSpot')
  return {
    id: `s${String(n).padStart(3, '0')}-sample`,
    covers: 'spot-check fixture',
    source: { engine: n % 2 ? 'chatgpt' : 'google-ai-overviews', prompt: `Which CRM suits a team of ${n}?`, note: 'test fixture' },
    brand: { id: 'hubspot', name: 'HubSpot', aliases: ['HubSpot'], domains: ['hubspot.com'] },
    competitors: [{ id: 'salesforce', name: 'Salesforce', aliases: ['Salesforce'], domains: ['salesforce.com'] }],
    answer: { text, citations: mentioned ? [{ url: 'https://hubspot.com/pricing', position: 0 }] : [] },
    label: {
      mentioned,
      mentionCount: mentioned ? 2 : 0,
      brandsDetected: mentioned ? 2 : 1,
      cited: mentioned,
      position: mentioned ? 2 : null,
      competitorsMentioned: ['Salesforce'],
      citationClasses: mentioned ? { '0': 'owned' } : {},
    },
    labelledBy: 'agent-proposed',
    verifiedBy: null,
    evidence: {
      mentions: [{ brand: 'salesforce', span: 'Salesforce', offset: text.indexOf('Salesforce') }, ...(mentioned ? [{ brand: 'hubspot', span: 'HubSpot', offset: first }, { brand: 'hubspot', span: 'HubSpot', offset: text.indexOf('HubSpot', first + 1) }] : [])],
      order: mentioned ? ['Salesforce', 'HubSpot'] : ['Salesforce'],
      citations: mentioned ? { '0': 'hubspot.com is the subject’s own domain' } : {},
    },
  }
}

const SET = Array.from({ length: GOLDEN_SET_TARGET }, (_, i) => proposed(i + 1))

/** What the owner does: a name, a date, and an x in one box per answer. `disagreeWith` ticks the other box and leaves a note. */
function fillIn(md: string, opts: { by?: string; disagreeWith?: readonly string[]; leaveBlank?: readonly string[]; agreeNote?: string } = {}): string {
  const signed = md.replace('**Checked by:** ', `**Checked by:** ${opts.by ?? 'Katy Owner'}`).replace('**Date:** ', '**Date:** 2026-09-20')
  return signed
    .split(/(?=<!-- case: )/)
    .map((block) => {
      const id = /<!-- case: (\S+) /.exec(block)?.[1]
      if (!id || opts.leaveBlank?.includes(id)) return block
      if (opts.disagreeWith?.includes(id)) return block.replace('- [ ] DISAGREE', '- [x] DISAGREE').replace('Note: ', 'Note: it is named three times, not two')
      return block.replace('- [ ] AGREE', '- [x] AGREE').replace('Note: ', `Note: ${opts.agreeNote ?? ''}`)
    })
    .join('')
}

const judge = (cases: readonly GoldenCase[], md: string) => runGoldenSet(cases, parseSpotCheckSheet(md))

describe('spot-check sample — seeded, so nobody chooses what the person sees', () => {
  it('is thirty proposed cases, the same thirty whatever order the set arrives in', () => {
    const sample = spotCheckSample(SET)
    expect(sample).toHaveLength(SPOT_CHECK_SIZE)
    expect(new Set(sample.map((c) => c.id)).size).toBe(SPOT_CHECK_SIZE)
    expect(spotCheckSample([...SET].reverse()).map((c) => c.id)).toEqual(sample.map((c) => c.id))
    // Not the first thirty, and not any run of neighbours: a hash order, not a file order.
    expect(sample.map((c) => c.id)).not.toEqual(SET.slice(0, SPOT_CHECK_SIZE).map((c) => c.id))
  })

  it('a different seed is a different sample, and the recorded seed is the one in use', () => {
    expect(spotCheckSample(SET, 'another-seed').map((c) => c.id)).not.toEqual(spotCheckSample(SET).map((c) => c.id))
    expect(spotCheckSample(SET, SPOT_CHECK_SEED).map((c) => c.id)).toEqual(spotCheckSample(SET).map((c) => c.id))
  })

  it('draws from every agent-proposed label, verified since or not, never from a hand-built case, and takes them all when there are fewer than thirty', () => {
    const verified: GoldenCase = { ...SET[5]!, verifiedBy: 'A. Person', verifiedFingerprint: labelFingerprint(SET[5]!) }
    const mixed: GoldenCase[] = [...SET.slice(0, 5), verified, { ...SET[6]!, labelledBy: 'human' }]
    expect(isProposed(verified)).toBe(false)
    // Verifying a label must not redraw the sample: that would throw away the check of whoever disputed it.
    expect(spotCheckSample(mixed).map((c) => c.id).sort()).toEqual(SET.slice(0, 6).map((c) => c.id).sort())
    expect(spotCheckPopulation(mixed)).toEqual({ count: 6, fingerprint: spotCheckPopulation(SET.slice(0, 6)).fingerprint })
  })
})

describe('label fingerprint — what was checked is what is on file', () => {
  const c = SET[0]!
  it('changes with the label, the answer and the competitor set, and not with the labeller’s notes', () => {
    const fp = labelFingerprint(c)
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
    expect(labelFingerprint({ ...c, label: { ...c.label, mentionCount: 3 } })).not.toBe(fp)
    expect(labelFingerprint({ ...c, label: { ...c.label, citationClasses: { '0': 'other' } } })).not.toBe(fp)
    expect(labelFingerprint({ ...c, answer: { ...c.answer, text: c.answer.text + ' ' } })).not.toBe(fp)
    expect(labelFingerprint({ ...c, competitors: [] })).not.toBe(fp)
    expect(labelFingerprint({ ...c, evidence: { ...c.evidence!, notes: 'tidied' } })).toBe(fp)
  })
})

describe('the sheet — written for a person, read back by the harness', () => {
  const md = renderSpotCheckSheet(SET)

  it('lists the thirty sampled answers with the question, the engine, the label in words and an excerpt round every mention', () => {
    const parsed = parseSpotCheckSheet(md)
    expect(parsed.entries.map((e) => e.id)).toEqual(spotCheckSample(SET).map((c) => c.id))
    expect(parsed.seed).toBe(SPOT_CHECK_SEED)
    expect(parsed.population).toBe(spotCheckPopulation(SET).fingerprint)
    const one = spotCheckSample(SET).find((c) => c.label.mentioned)!
    expect(md).toContain(`**Question asked:** ${one.source.prompt}`)
    expect(md).toMatch(/\*\*Answered by:\*\* (ChatGPT|Google AI Overviews)/)
    expect(md).toContain('**Mentioned:** yes, 2 times.')
    expect(md).toContain('>>>HubSpot<<< is easier')
    expect(md).toContain('So HubSpot is in **position 2 of 2**')
    expect(md).toContain("`hubspot.com/pricing` is the brand's own website.")
    expect(md).toContain('**Mentioned:** no.')
    // Every entry has its two boxes and its note line, and nothing is pre-ticked.
    expect(md.match(/^- \[ \] AGREE/gm)).toHaveLength(SPOT_CHECK_SIZE)
    expect(md.match(/^- \[ \] DISAGREE/gm)).toHaveLength(SPOT_CHECK_SIZE)
    expect(md.match(/^Note: $/gm)).toHaveLength(SPOT_CHECK_SIZE)
  })

  it('is deterministic: the same set renders the same file, byte for byte', () => {
    expect(renderSpotCheckSheet([...SET].reverse())).toBe(md)
  })

  it('promises the owner only what the harness will do at this set size', () => {
    // E4 review, S8: at 191 cases the first sheet said "the gate can give a verdict". It cannot: below 300 it is NOT_RUN whatever is ticked.
    expect(md).toContain('The accuracy gate (G2) can then give its verdict.')
    expect(judge(SET, fillIn(md)).gateStatus).toBe('PASS')

    const small = SET.slice(0, 191)
    const smallMd = renderSpotCheckSheet(small)
    expect(smallMd).not.toContain('can then give its verdict')
    expect(smallMd).toContain(`the accuracy gate (G2) needs ${GOLDEN_SET_TARGET} answers and the set holds 191`)
    const r = judge(small, fillIn(smallMd))
    expect(r.spotCheck.status).toBe('accepted')
    expect(r.gateStatus).toBe('NOT_RUN')
  })

  it('an untouched sheet is nobody’s check: unsigned, thirty unanswered, and the verdict stays PROPOSED', () => {
    const parsed = parseSpotCheckSheet(md)
    expect(parsed.checkedBy).toBe('')
    expect(parsed.checkedOn).toBe('')
    expect(parsed.entries.every((e) => e.verdict === 'unanswered' && e.note === '')).toBe(true)
    const r = judge(SET, md)
    expect(r.gateStatus).toBe('PROPOSED')
    expect(r.spotCheck.status).toBe('unusable')
    expect(r.spotCheck.problems).toEqual([expect.stringContaining('nobody has signed'), expect.stringContaining('30 of 30 case(s) have no answer yet')])
  })

  it('a sheet the owner filled in, agreeing with all thirty, is accepted and the verdict becomes reachable', () => {
    const r = judge(SET, fillIn(md))
    expect(r.spotCheck).toMatchObject({ status: 'accepted', checkedBy: 'Katy Owner', agreed: SPOT_CHECK_SIZE, checked: SPOT_CHECK_SIZE, problems: [], disputed: [] })
    expect(r.gateStatus).toBe('PASS')
  })

  it('a disagreement carries the owner’s note; one is tolerated, two reject the labels', () => {
    const ids = spotCheckSample(SET).map((c) => c.id)
    const one = judge(SET, fillIn(md, { disagreeWith: [ids[3]!] }))
    expect(one.spotCheck.disputed).toEqual([{ id: ids[3], note: 'it is named three times, not two' }])
    expect(one.spotCheck.status).toBe('accepted')
    const two = judge(SET, fillIn(md, { disagreeWith: [ids[3]!, ids[7]!] }))
    expect(two.spotCheck.status).toBe('below-threshold')
    expect(two.gateStatus).toBe('PROPOSED')
  })

  it('an objection written beside an AGREE reaches the report: the sheet asks for exactly that', () => {
    const r = judge(SET, fillIn(md, { agreeNote: 'right as the rule stands; I would class a redirect by its card' }))
    expect(r.spotCheck.status).toBe('accepted')
    expect(r.spotCheck.notes).toHaveLength(SPOT_CHECK_SIZE)
    expect(r.spotCheck.notes.every((n) => n.verdict === 'agree' && n.note === 'right as the rule stands; I would class a redirect by its card')).toBe(true)
  })

  it('a half-finished sheet is not finished, whatever it says so far', () => {
    const ids = spotCheckSample(SET).map((c) => c.id)
    const r = judge(SET, fillIn(md, { leaveBlank: ids.slice(10) }))
    expect(r.gateStatus).toBe('PROPOSED')
    expect(r.spotCheck.problems).toContainEqual(expect.stringContaining('20 of 30 case(s) have no answer yet'))
  })

  it('reads a box, a name and a note the way people type them, and refuses two ticks', () => {
    const ids = spotCheckSample(SET).map((c) => c.id)
    const typed = fillIn(md, { by: 'Dr. K: owner', leaveBlank: ids.slice(0, 5) })
      .split(/(?=<!-- case: )/)
      .map((block) => {
        const id = /<!-- case: (\S+) /.exec(block)?.[1]
        if (id === ids[0]) return block.replace('- [ ] AGREE', '- [X] AGREE')
        if (id === ids[1]) return block.replace('- [ ] AGREE', '-   [ x ]   **AGREE**')
        if (id === ids[2]) return block.replace('- [ ] AGREE', '* [✓] AGREE')
        if (id === ids[3]) return block.replace('- [ ] AGREE', '- [x] AGREE').replace('- [ ] DISAGREE', '- [x] DISAGREE')
        if (id === ids[4]) return block.replace('- [ ] DISAGREE', '- [x] DISAGREE').replace('Note: ', 'Note:\nthe second one is a link,\nnot a mention')
        return block
      })
      .join('')
      .replace(/\n/g, '\r\n') // saved from a Windows editor
    const parsed = parseSpotCheckSheet(typed)
    expect(parsed.entries.slice(0, 5).map((e) => e.verdict)).toEqual(['agree', 'agree', 'agree', 'both', 'disagree'])
    expect(parsed.entries[4]!.note).toBe('the second one is a link, not a mention')
    expect(parsed.checkedBy).toBe('Dr. K: owner')
    expect(parsed.checkedOn).toBe('2026-09-20')
    expect(runGoldenSet(SET, parsed).spotCheck.problems).toContainEqual(expect.stringContaining('both boxes ticked'))
  })

  it('an answer that happens to contain a ticked box cannot vote: only a list line of the sheet is a box', () => {
    const lead = '- [x] AGREE: a checklist the engine wrote\n'
    const tricky: GoldenCase = { ...SET[0]!, answer: { ...SET[0]!.answer, text: lead + SET[0]!.answer.text }, evidence: { ...SET[0]!.evidence!, mentions: SET[0]!.evidence!.mentions.map((m) => ({ ...m, offset: m.offset + lead.length })) } }
    const parsed = parseSpotCheckSheet(renderSpotCheckSheet([tricky]))
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]!.verdict).toBe('unanswered')
  })

  it('a label edited after the check, a sheet for a set that has since grown, and a sample drawn with another seed are each refused by name', () => {
    const filled = fillIn(md)
    const editedId = parseSpotCheckSheet(filled).entries[0]!.id
    const edited = SET.map((c) => (c.id === editedId ? { ...c, label: { ...c.label, cited: !c.label.cited } } : c))
    expect(judge(edited, filled).spotCheck.problems).toContainEqual(expect.stringContaining('changed after the sheet was written'))

    const grown = [...SET, ...Array.from({ length: 200 }, (_, i) => proposed(1000 + i))]
    expect(judge(grown, filled).spotCheck.problems).toEqual(expect.arrayContaining([expect.stringContaining('drawn from a different set of agent-proposed labels'), expect.stringContaining('is not the seeded sample of this set')]))

    const otherSeed = judge(SET, fillIn(renderSpotCheckSheet(SET, 'picked-by-hand')))
    expect(otherSeed.spotCheck.problems).toContainEqual(expect.stringContaining('a chosen one'))
    expect(otherSeed.gateStatus).toBe('PROPOSED')
  })

  it('a sheet goes on vouching only for the set it was drawn from: cases removed outside the sample void it', () => {
    // A hash-rank draw does not move when cases OUTSIDE it are deleted, so nothing about the entries gives the deletion away.
    const filled = fillIn(md)
    const sampled = new Set(spotCheckSample(SET).map((c) => c.id))
    const pruned = SET.filter((c, i) => sampled.has(c.id) || i % 2 === 0)
    expect(spotCheckSample(pruned).map((c) => c.id)).toEqual(spotCheckSample(SET).map((c) => c.id))
    const r = judge(pruned, filled)
    expect(r.spotCheck.status).toBe('unusable')
    expect(r.spotCheck.problems).toEqual([expect.stringContaining('drawn from a different set of agent-proposed labels')])
  })
})

describe('the sheet on disk — docs/runbooks/golden-spot-check.md', () => {
  const cases = loadGoldenCases()
  const anyProposed = cases.some(isProposed)

  it.runIf(anyProposed && existsSync(SPOT_CHECK_SHEET))('is the sheet for the labels on file: the current seeded sample, every fingerprint current', () => {
    const sheet = parseSpotCheckSheet(readFileSync(SPOT_CHECK_SHEET, 'utf8'))
    // Whatever the owner has or has not ticked is theirs. What the suite holds is that the sheet is about THESE labels.
    const structural = runGoldenSet(cases, sheet).spotCheck.problems.filter((p) => /seeded sample|changed after|sample seed|listed? a case twice/.test(p))
    expect(structural).toEqual([])
    expect(sheet.entries.map((e) => e.id)).toEqual(spotCheckSample(cases).map((c) => c.id))
    // And it says the truth about what ticking it will do at this set size.
    if (cases.length < GOLDEN_SET_TARGET) expect(readFileSync(SPOT_CHECK_SHEET, 'utf8')).toContain(`the set holds ${cases.length}`)
  })
})
