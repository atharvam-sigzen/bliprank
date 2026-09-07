/**
 * WHAT THESE TESTS DEFEND.
 *
 *   1. THE TOOL NEVER LABELS. A blank verdict is refused, not defaulted to
 *      agreement. A harness that scored a classifier against labels the
 *      classifier supplied would read 100% and mean nothing.
 *
 *   2. A PARTLY-REVIEWED FILE IS REFUSED, not scored on what it has. Silently
 *      dropping unreviewed rows shrinks the denominator of a criterion that is
 *      a proportion of a stated 100.
 *
 *   3. `unsure` IS A REAL OUTCOME and leaves the denominator. Forcing a
 *      labeller to choose on a domain they cannot judge produces a number that
 *      looks decisive and is not.
 *
 *   4. THE CSV SURVIVES A REAL META DESCRIPTION — commas, quotes, newlines.
 */

import { describe, expect, it } from 'vitest'
import {
  CORRECTION_CHOICES,
  G3_SAMPLE_SIZE,
  importLabels,
  parseCsv,
  readDomainList,
  scoreLabels,
  splitCsvLine,
  toCsv,
  type WorklistRow,
} from './label.js'

const row = (over: Partial<WorklistRow> = {}): WorklistRow => ({
  domain: 'acme.com',
  title: 'Acme',
  description: 'We do things',
  fetched: true,
  proposed: 'crm-software',
  signal: 'site-content',
  evidence: 'matched crm, pipeline',
  verdict: '?',
  correct: '',
  notes: '',
  ...over,
})

const csvOf = (rows: readonly WorklistRow[]) => toCsv(rows)

describe('the CSV survives what a real homepage puts in a description', () => {
  it('round-trips commas, quotes and newlines', () => {
    const nasty = 'CRM, "the best", for teams\nand a second line'
    const back = parseCsv(csvOf([row({ description: nasty })]))
    expect(back.errors).toEqual([])
    expect(back.rows[0]!['description']).toBe(nasty)
  })

  it('refuses a file that ends inside a quoted field rather than guessing', () => {
    expect(parseCsv('domain,verdict\n"acme.com,ok\n').errors[0]).toMatch(/unterminated/)
  })

  it('reports a row with the wrong column count instead of shifting the values', () => {
    // A shifted row would put a title in the verdict column and be refused for
    // the wrong reason three steps later.
    expect(parseCsv('domain,verdict,correct\nacme.com,ok\n').errors[0]).toMatch(/2 columns, header has 3/)
  })

  it('splits an empty trailing field', () => {
    expect(splitCsvLine('a,b,')).toEqual(['a', 'b', ''])
    expect(splitCsvLine('"a,b",c')).toEqual(['a,b', 'c'])
    expect(splitCsvLine('"say ""hi""",c')).toEqual(['say "hi"', 'c'])
  })
})

describe('the domain list', () => {
  it('strips scheme, www, path and comments, and deduplicates', () => {
    const got = readDomainList('https://www.Acme.com/pricing\n# a comment\nacme.com\n\n  beta.io  # trailing note\n')
    expect(got).toEqual(['acme.com', 'beta.io'])
  })
})

describe('⚠️ the import refuses rather than assumes', () => {
  const withVerdict = (v: string, correct = '') => csvOf([row({ verdict: v as WorklistRow['verdict'], correct })])

  it('refuses an unreviewed row', () => {
    const got = importLabels(csvOf([row()]), 'test')
    expect('refuse' in got && got.refuse[0]).toMatch(/not reviewed yet/)
  })

  it('refuses a blank verdict — it is NOT agreement', () => {
    const got = importLabels(withVerdict(''), 'test')
    expect('refuse' in got).toBe(true)
  })

  it('refuses a verdict it does not recognise', () => {
    expect('refuse' in importLabels(withVerdict('probably'), 'test')).toBe(true)
  })

  it('refuses "wrong" with no correction — which category IS right?', () => {
    const got = importLabels(withVerdict('wrong'), 'test')
    expect('refuse' in got && got.refuse[0]).toMatch(/which category IS right/)
  })

  it('refuses a correction that is not a category', () => {
    const got = importLabels(withVerdict('wrong', 'crm-softwear'), 'test')
    expect('refuse' in got && got.refuse[0]).toMatch(/is not a category/)
  })

  it('refuses a correction identical to the proposal', () => {
    // Marked wrong and corrected to the same thing is a labelling slip, and
    // scoring it as a disagreement would understate the classifier.
    const got = importLabels(withVerdict('wrong', 'crm-software'), 'test')
    expect('refuse' in got && got.refuse[0]).toMatch(/the correction is the proposal/)
  })

  it('refuses a duplicated domain', () => {
    const got = importLabels(csvOf([row({ verdict: 'ok' }), row({ verdict: 'ok' })]), 'test')
    expect('refuse' in got && got.refuse[0]).toMatch(/appears more than once/)
  })

  it('names EVERY problem, not just the first', () => {
    const got = importLabels(csvOf([row({ domain: 'a.com' }), row({ domain: 'b.com', verdict: 'wrong' })]), 'test')
    expect('refuse' in got && got.refuse.length).toBe(2)
  })

  it('accepts a fully reviewed file and records what "ok" meant', () => {
    const got = importLabels(csvOf([row({ verdict: 'ok' }), row({ domain: 'b.com', verdict: 'wrong', correct: 'seo-tools' })]), 'top-1000 sample')
    if ('refuse' in got) throw new Error(got.refuse.join('; '))
    expect(got.sample).toBe('top-1000 sample')
    // `ok` is stored as the slug it agreed with, so the file stays readable
    // when the classifier's proposal for that domain later changes.
    expect(got.cases[0]).toMatchObject({ domain: 'acme.com', correct: 'crm-software', agreed: true })
    expect(got.cases[1]).toMatchObject({ domain: 'b.com', correct: 'seo-tools', agreed: false })
  })

  it('⚠️ "ok" on a fallback proposal records `none`, not the fallback slug', () => {
    // "No category we hold fits this" is a correct answer. Storing the fallback
    // slug would later read as "this domain is general business software",
    // which is a different and weaker claim.
    const got = importLabels(csvOf([row({ proposed: 'general-business-software', verdict: 'ok' })]), 'test')
    if ('refuse' in got) throw new Error(got.refuse.join('; '))
    expect(got.cases[0]!.correct).toBe('none')
  })

  it('offers "none" as a correction, because it is an answer', () => {
    expect(CORRECTION_CHOICES).toContain('none')
    const got = importLabels(csvOf([row({ verdict: 'wrong', correct: 'none' })]), 'test')
    expect('refuse' in got).toBe(false)
  })
})

describe('the G3 number', () => {
  const set = (cases: { domain: string; signal: string; agreed: boolean; correct?: string }[]) => ({
    labelledAt: '', sample: 'test',
    cases: cases.map((c) => ({ domain: c.domain, proposed: 'x', signal: c.signal, correct: c.correct ?? 'y', agreed: c.agreed, notes: '' })),
  })

  it('⚠️ excludes `unsure` from the denominator rather than guessing it', () => {
    const s = scoreLabels(set([
      { domain: 'a', signal: 'site-content', agreed: true },
      { domain: 'b', signal: 'site-content', agreed: false },
      { domain: 'c', signal: 'site-content', agreed: false, correct: 'unsure' },
    ]))
    expect(s.total).toBe(3)
    expect(s.judged).toBe(2)
    expect(s.unsure).toBe(1)
    expect(s.rate).toBe(0.5)
  })

  it('⚠️ does not meet the gate on rate alone — the criterion is a proportion of 100', () => {
    // Ten domains all correct is 100% and is not the criterion. A gate that
    // passed here would close G3 on a tenth of the evidence it asks for.
    const s = scoreLabels(set(Array.from({ length: 10 }, (_, i) => ({ domain: `d${i}`, signal: 'site-content', agreed: true }))))
    expect(s.rate).toBe(1)
    expect(s.meetsGate).toBe(false)
  })

  it('meets the gate at the sample size and the threshold', () => {
    const cases = Array.from({ length: G3_SAMPLE_SIZE }, (_, i) => ({ domain: `d${i}`, signal: 'site-content', agreed: i >= 5 }))
    expect(scoreLabels(set(cases)).meetsGate).toBe(true) // 95/100
    const worse = cases.map((c, i) => (i === 6 ? { ...c, agreed: false } : c))
    expect(scoreLabels(set(worse)).meetsGate).toBe(false) // 94/100
  })

  it('breaks the rate down by which rung decided, which is where a threshold lives', () => {
    const s = scoreLabels(set([
      { domain: 'a', signal: 'leader-domain', agreed: true },
      { domain: 'b', signal: 'site-content', agreed: false },
      { domain: 'c', signal: 'site-content', agreed: true },
    ]))
    expect(s.bySignal).toEqual([
      { signal: 'leader-domain', judged: 1, correct: 1 },
      { signal: 'site-content', judged: 2, correct: 1 },
    ])
  })

  it('an empty set is 0%, never a vacuous pass', () => {
    const s = scoreLabels(set([]))
    expect(s.rate).toBe(0)
    expect(s.meetsGate).toBe(false)
  })
})

describe('⚠️ "not read" is not "read and empty"', () => {
  it('carries the fetched flag into the CSV so the two cannot be confused', () => {
    // Rungs 1 and 2 decide from the hostname, so a tracked brand's homepage is
    // never fetched. Rendering that as "(no title)" would tell the labeller the
    // page has no title, which is false.
    const csv = toCsv([row({ domain: 'pipedrive.com', title: '', description: '', fetched: false, signal: 'leader-domain' })])
    const back = parseCsv(csv)
    expect(back.rows[0]!['fetched']).toBe('no')
    const fetched = parseCsv(toCsv([row({ fetched: true })]))
    expect(fetched.rows[0]!['fetched']).toBe('yes')
  })
})
