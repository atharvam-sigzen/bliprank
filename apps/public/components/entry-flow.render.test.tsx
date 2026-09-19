/**
 * THE ENTRY FLOW, RENDERED (MVP_PLAN C3, ADR-0016 Amendment 1): what the three
 * surfaces the owner's flow touches actually put on the page.
 *
 *   1. The preview offers the edit and, on the machine's own store, the days;
 *      with a set of the person's own in force it says so, with the version.
 *   2. The headline names whose questions produced the number: "your N prompts,
 *      version V", in the same sentence as the sample size, at both depths.
 *   3. The record lists the days one by one at SIMPLE depth, says which were the
 *      daily re-check's, and says in words where a change of questions breaks
 *      the comparison.
 *
 * The route-level half (enter, edit with a brand-naming prompt refused, three
 * days, first cycle, three fixture ticks, the fourth refused as expired) is
 * `app/api/entry-flow.test.ts`.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatBounds, wilson, type Metric } from '@bliprank/stats'
import { customBasisOf, formatBasis } from '@bliprank/contracts'
import { sentence, simpleView } from '../lib/simple-view'
import { promptSetOf, promptSetWords } from '../lib/prompt-set'
import { rememberScan, type ScanResultFile } from '../lib/scan-result'
import type { PreviewResponse } from '../lib/preview-contract'
import { Headline } from './headline'
import { ZeroMentions, isZeroFinding, zeroMentionsWords } from './zero-mentions'
import { PromptPreview, smallSampleWarning } from './prompt-preview'
import { WorkspaceRecord } from './workspace-record'

const ENGINES = ['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews']
const basis = (custom?: { count: number; version: number }) =>
  formatBasis({ format: 'grader', engines: ENGINES, locale: 'en-US', geo: 'US', bank: { slug: 'general-business-software', version: 1 }, unprompted: custom ? 0 : 17, runs: 1, ...(custom ? { custom } : {}) })

const metric = (k: number, n: number, comparison_basis: string): Metric => {
  const w = wilson(k, n)
  return { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-3', collection_path: 'third-party-grounded', comparison_basis }
}

const cycle = (day: string, k: number, n: number, b: string, source: 'hand' | 'loop', over: { algo?: string; rival?: boolean } = {}): ScanResultFile =>
  ({
    status: 'scanned',
    domain: 'acme-flow.test',
    // The category the app itself derives for this host (no record, no keyword: the general bank), so the registry's scan is the record's scan.
    category: 'general-business-software',
    categoryName: 'General business software',
    subjectSource: 'domain-label',
    comparisonBasis: b,
    algoVersion: over.algo ?? 'det-3',
    counts: { cellsRequested: n, cacheHits: 0, collected: n, failed: 0, answersScored: n, providerCalls: n },
    collectedAt: `${day}T10:00:00.000Z`,
    brands: [
      { id: 'domain:acme-flow.test', name: 'Acme Flow', isSubject: true, mentions: k, citations: 0, metric: { ...metric(k, n, b), algo_version: over.algo ?? 'det-3' } },
      ...(over.rival ? [{ id: 'hubspot', name: 'HubSpot', isSubject: false, mentions: n, citations: 0, metric: { ...metric(n, n, b), algo_version: over.algo ?? 'det-3' } }] : []),
    ],
    promptRows: [],
    run: { mode: 'fixture', plan: 'payg', day, engines: ENGINES, spentUsd: 0, capUsd: 10, at: `${day}T10:01:00.000Z`, source },
  }) as unknown as ScanResultFile

const PREVIEW: PreviewResponse = {
  domain: 'acme-flow.test',
  category: 'crm-software',
  categoryName: 'CRM software',
  categoryDescription: 'Tools that track customers and deals.',
  source: 'site-content',
  evidence: 'crm, pipeline',
  previouslyDecided: false,
  verified: true,
  generated: false,
  decidedAt: '2026-09-16T00:00:00.000Z',
  version: 1,
  prompts: [
    { text: 'What is the best CRM for a small team?', intent: 'discovery' },
    { text: 'which crm works offline on a phone', intent: 'own' },
  ],
  engines: ENGINES,
  competitors: [],
}

afterEach(() => vi.unstubAllGlobals())

describe('the preview: edit the questions, say for how many days', () => {
  const render = (p: PreviewResponse, trackable: boolean) => renderToStaticMarkup(<PromptPreview preview={p} trackable={trackable} onConfirm={() => {}} onCancel={() => {}} busy={false} />)

  it('offers the edit, and on the machine’s own store the days; without it the press is one scan and no re-check is promised', () => {
    const on = render(PREVIEW, true)
    expect(on).toContain('Edit these questions')
    expect(on).toContain('data-track-days')
    expect(on).toContain('For how many days')
    expect(on).toContain('re-checked with these 2 questions on every engine each day for 7 days, then stops')
    // A deployment, or a list that cannot be read: the days section is not rendered at all, so nothing is promised that cannot be honoured.
    const off = render(PREVIEW, false)
    expect(off).toContain('Edit these questions')
    expect(off).not.toContain('data-track-days')
    expect(off).not.toContain('re-checked')
  })

  it('a small set is called a small sample before it is bought, against the comparison floor and not a count of its own; a set that clears the floor is not warned about', () => {
    // Two questions on five engines is ten answers: under the floor, so nothing this cycle produces can ever be compared.
    const small = render(PREVIEW, true)
    expect(small).toContain('data-small-sample')
    expect(small).toContain('2 questions on 5 engines is 10 answers, and below 30 answers no two cycles and no competitor row can be compared')
    expect(smallSampleWarning(5, 5)).toContain('25 answers')
    // The first size that clears it at five engines is six questions; the rule is the floor, so it moves with the floor and with the engines.
    expect(smallSampleWarning(6, 5)).toBeNull()
    expect(smallSampleWarning(6, 4)).toContain('24 answers')
    expect(smallSampleWarning(1, 5)).toContain('1 question on 5 engines is 5 answers')
    const enough = render({ ...PREVIEW, prompts: Array.from({ length: 6 }, (_, i) => ({ text: `question number ${i} about crm tools`, intent: 'own' })) }, true)
    expect(enough).not.toContain('data-small-sample')
    // A warning, never a refusal: the edit and the run are still offered.
    expect(small).toContain('Edit these questions')
    expect(small).toContain('Run this scan')
  })

  it('says whose questions these are once a set of the person’s own is in force, with the version, and marks the person’s own prompts as theirs', () => {
    const bank = render(PREVIEW, true)
    expect(bank).toContain('The 2 questions we will ask')
    expect(bank).not.toContain('data-prompt-set')
    const own = render({ ...PREVIEW, promptSet: { version: 3, count: 2 } }, true)
    expect(own).toContain('Your 2 questions, version 3')
    expect(own).toContain('data-prompt-set')
    expect(own).toContain('your 2 prompts, version 3')
    expect(own).toContain('>yours<')
  })
})

describe('the headline names whose questions produced the number', () => {
  it('says "your N prompts, version V" in the sentence that carries the sample size, and nothing of the kind for the bank’s set', () => {
    const b = basis({ count: 3, version: 2 })
    const set = promptSetOf(b)
    expect(set).toEqual({ count: 3, version: 2 })
    expect(promptSetWords(set!)).toBe('your 3 prompts, version 2')
    const own = sentence(renderToStaticMarkup(<Headline subject="Acme" metric={metric(5, 15, b)} engines={5} promptSet={set} />))
    expect(own).toContain('From 15 answers to your 3 prompts, version 2, across 5 engines.')
    // R8 still holds in words: the estimate and both bounds are in the same lede.
    expect(own).toMatch(/Could be as few as|The range is|answers\./)
    const bank = sentence(renderToStaticMarkup(<Headline subject="Acme" metric={metric(5, 15, basis())} engines={5} promptSet={promptSetOf(basis())} />))
    expect(bank).toContain('From 15 answers across 5 engines.')
    // One answer is one answer.
    expect(sentence(renderToStaticMarkup(<Headline subject="Acme" metric={metric(1, 1, b)} engines={5} promptSet={{ count: 1, version: 2 }} />))).toContain('From 1 answer to your 1 prompt, version 2,')
    expect(bank).not.toContain('your')
    // Decision 4's second block carried `custom=` on its OWN basis with unprompted > 0 on the headline: that is not a headline set.
    expect(promptSetOf(basis().replace('unprompted=17', 'unprompted=17') + '|custom=2@1')).toBeNull()
  })
})

describe('the record lists the days, at simple depth', () => {
  it('one line per day, newest first: the rate with its interval and n, who started it, which version of the questions, and where a change of questions breaks the comparison', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
    const v1 = basis({ count: 3, version: 1 })
    const v2 = basis({ count: 4, version: 2 })
    rememberScan(cycle('2026-09-16', 5, 15, v1, 'hand'))
    rememberScan(cycle('2026-09-17', 6, 15, v1, 'loop'))
    rememberScan(cycle('2026-09-18', 9, 20, v2, 'loop'))

    const html = renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />)
    // AT SIMPLE DEPTH: the list survives the simple view, it is not a detail.
    const simple = simpleView(html)
    expect(simple).toContain('Day by day')
    expect(simple).toContain('3 days collected, newest first')
    const list = simple.slice(simple.indexOf('data-cycle-days'))
    // Newest first.
    expect(list.indexOf('2026-09-18')).toBeLessThan(list.indexOf('2026-09-17'))
    expect(list.indexOf('2026-09-17')).toBeLessThan(list.indexOf('2026-09-16'))
    // R8 in the list: value, interval and n, formatted by packages/stats.
    expect(sentence(list)).toContain('2026-09-17: mentioned in 40.0% (19.8–64.3%, n=15)')
    // Who started each day, and over which version of the questions.
    expect(sentence(list)).toContain('2026-09-16: mentioned in')
    expect(sentence(list)).toMatch(/2026-09-16:.*started by hand · your 3 prompts, version 1/)
    expect(sentence(list)).toMatch(/2026-09-17:.*daily re-check · your 3 prompts, version 1/)
    expect(sentence(list)).toMatch(/2026-09-18:.*daily re-check · your 4 prompts, version 2/)
    // The version change is a change of basis, said in words on the day it happened, and only there.
    // IN PLAIN WORDS (stats review, MAJOR 3): this line used to read "the custom prompt set (3@1 against 4@2)".
    expect(sentence(list)).toMatch(/2026-09-18:.*not comparable with the day before: the day before was asked your own 3 questions \(version 1\), and this day your own 4 questions \(version 2\)/)
    expect(sentence(list)).not.toMatch(/\d@\d/)
    expect(sentence(list)).not.toMatch(/2026-09-17:[^:]*not comparable/)
    // The headline above it names the latest set.
    expect(sentence(simple)).toContain('to your 4 prompts, version 2,')
    expect(simple).toContain('data-prompt-set')
  })
})

describe('what travels with a number measured over a person’s own set', () => {
  const stub = () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
  }

  it('the day list marks a SCORING-VERSION boundary too, not only a change of questions: every reason compare() refuses for (C3 stats review)', () => {
    stub()
    const v1 = basis({ count: 6, version: 1 })
    rememberScan(cycle('2026-09-16', 10, 30, v1, 'loop', { algo: 'det-2' }))
    rememberScan(cycle('2026-09-17', 11, 30, v1, 'loop', { algo: 'det-3' }))
    rememberScan(cycle('2026-09-18', 12, 30, v1, 'loop', { algo: 'det-3' }))
    const list = sentence(simpleView(renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />)).split('data-cycle-days')[1] ?? '')
    // Identical basis, different scoring version: a boundary, said in words on the day it happened.
    expect(list).toMatch(/2026-09-17:.*not comparable with the day before: the two days were scored by different versions of our scoring rules \(det-2, then det-3\), so they are not the same measurement/)
    // Same version, same basis: a like-for-like pair, and no marker.
    expect(list).not.toMatch(/2026-09-18:[^:]*not comparable/)
    // The rule is stated whole: questions, engines, scoring version, and enough answers.
    expect(list).toContain('scored by the same version, and each holds enough answers to compare')
  })

  it('at zero mentions the lede yields, THE RECORD SAYS THE ZERO IN WORDS WITH ITS RANGE, and the set is still named beside the number (C3 stats review; C3r item 3)', () => {
    stub()
    const v2 = basis({ count: 3, version: 2 })
    rememberScan(cycle('2026-09-18', 0, 15, v2, 'loop'))
    const html = simpleView(renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />))
    // No lede at zero: the surface's own zero treatment speaks instead...
    expect(html).not.toContain('headline__claim')
    // ...and until C3r item 3 NOTHING did on the record: this test asserted the lede's absence and stopped, over a bare 0.0% rail.
    // At SIMPLE depth, the finding, whose questions, and the range spoken as a range with the figure packages/stats computed.
    expect(html).toContain('data-zero-mentions')
    const zero = sentence(html)
    expect(zero).toContain('Not named in any of the 15 answers to your 3 prompts, version 2.')
    const m = metric(0, 15, v2)
    // ONE number for the one bound, the figure the rail beside it shows (stats review, MAJOR 1). The first draft printed the
    // outward-rounded frequency and the percentage together: "1 in 4 answers (20.4%)", 25% beside 20.4% for a single limit.
    expect(formatBounds(m).high).toBe('20.4%')
    expect(zero).toContain('the true rate could be anywhere from none at all up to 20.4% of answers')
    expect(zero).not.toMatch(/1 in \d+/)
    expect(zero).toContain('a real result with an upper limit, not an error and not proof of zero')
    // The brand came from the domain label here, and the caveat travels with the zero as it does on the Grader.
    expect(zero).toContain('a trading name that differs from the domain would be undercounted')
    // The basis note names whose questions produced the zero, at simple depth, and the scope sentence travels with it.
    expect(html).toContain('data-prompt-set')
    expect(sentence(html)).toContain('your 3 prompts, version 2')
    expect(html).toContain('data-prompt-set-scope')
    // "No other domain" used to stand above a chart of rival domains; what may not be compared is another domain's OWN number (C3r item 4).
    // ...and it does not promise a comparison the floor on n forbids on this very page (stats review, MINOR 5).
    expect(sentence(html)).toContain('it compares with your own earlier cycles that asked the same questions and hold enough answers to compare, and with no other measurement: not with another domain\u2019s own number')
    expect(sentence(html)).toContain('Any rivals shown on this page were scored on these same questions in this same scan')
  })

  it('the head-to-head says it ranks rivals on the person’s own questions, under a heading that does not claim the category', () => {
    stub()
    const v2 = basis({ count: 6, version: 2 })
    rememberScan(cycle('2026-09-18', 12, 30, v2, 'loop', { rival: true }))
    const html = renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />)
    expect(html).toContain('How that compares on your questions')
    expect(html).not.toContain('How that compares in general business software')
    expect(html).toContain('data-h2h-own-set')
    expect(sentence(html)).toContain('These rivals are measured on your own questions (your 6 prompts, version 2), so this ranks them on what you asked')
    // The margin states the brands' OWN sample, the subject metric's n, in the words the rail's margin uses (C3r item 9).
    expect(sentence(html)).toContain('the same 30 answers')
    // Over the bank, the category heading stands and nothing is said about a set.
    stub()
    rememberScan(cycle('2026-09-18', 12, 30, basis(), 'hand', { rival: true }))
    const bank = renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />)
    expect(bank).toContain('How that compares in general business software')
    expect(bank).not.toContain('data-h2h-own-set')
    expect(bank).not.toContain('data-prompt-set-scope')
  })
})

describe('the zero-mention sentence, on its own', () => {
  it('speaks only at zero, never above it, and never over nothing measured', () => {
    expect(zeroMentionsWords(metric(1, 15, basis()))).toBeNull()
    expect(zeroMentionsWords({ ...metric(0, 15, basis()), n: 0 })).toBeNull()
    expect(renderToStaticMarkup(<ZeroMentions metric={metric(4, 15, basis())} />)).toBe('')
    // The lede and the zero sentence are exclusive at every n: one of them always speaks, never both.
    for (const n of [1, 2, 3, 5, 15, 150]) {
      const lede = renderToStaticMarkup(<Headline subject="Acme" metric={metric(0, n, basis())} engines={5} />)
      const zero = renderToStaticMarkup(<ZeroMentions metric={metric(0, n, basis())} />)
      expect(lede, `n=${n}`).toBe('')
      expect(zero, `n=${n}`).toContain('data-zero-mentions')
    }
    // BOTH halves, in the two states no real record reaches (stats review, NOTE 1): nothing measured, and a value that is not a
    // number. One predicate decides for both components, so exactly one of them speaks, whatever it then has to say.
    for (const odd of [{ ...metric(0, 15, basis()), n: 0 }, { ...metric(0, 15, basis()), value: Number.NaN }]) {
      expect(isZeroFinding(odd)).toBe(false)
      expect(renderToStaticMarkup(<ZeroMentions metric={odd} />)).toBe('')
      expect(renderToStaticMarkup(<Headline subject="Acme" metric={odd} engines={5} />)).not.toBe('')
    }
  })

  it('the upper limit is the figure packages/stats prints, at every n, and one answer is one answer', () => {
    for (const n of [1, 3, 7, 15, 150, 750]) {
      const m = metric(0, n, basis())
      expect(zeroMentionsWords(m)?.range, `n=${n}`).toContain(`from none at all up to ${formatBounds(m).high} of answers`)
      expect(zeroMentionsWords(m)?.range, `n=${n}`).not.toMatch(/1 in \d+/)
    }
    expect(zeroMentionsWords(metric(0, 1, basis()))?.found).toBe('Not named in the one answer collected.')
    // Over the bank's questions nothing is said about a set.
    expect(zeroMentionsWords(metric(0, 150, basis()))?.found).toBe('Not named in any of the 150 answers.')
  })
})

describe('the day list is marked by compare() itself, for every reason it refuses (MVP_PLAN C3r item 2)', () => {
  const stub = () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
  }
  const days = () => sentence(simpleView(renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />)).split('data-cycle-days')[1] ?? '')

  it('TOO FEW ANSWERS is marked in plain words: it is routine for a short set, and the list used to pass it over in silence', () => {
    stub()
    const v1 = basis({ count: 3, version: 1 })
    // Three questions on five engines: fifteen answers a day, under the floor of 30, on an identical basis and scoring version.
    rememberScan(cycle('2026-09-16', 5, 15, v1, 'loop'))
    rememberScan(cycle('2026-09-17', 6, 15, v1, 'loop'))
    const list = days()
    expect(list).toMatch(/2026-09-17:.*too few answers to compare with the day before: the smaller of the two days holds 15 answers, and a comparison needs at least 30 on each/)
    // Not called "not comparable": nothing about the two days differs, there is only too little of each.
    expect(list).not.toMatch(/2026-09-17:[^:]*not comparable/)
    // The first day has no day before it, and says nothing.
    expect(list).not.toMatch(/2026-09-16:[^·]*·[^·]*·[^·]*too few/)
  })

  it('a like-for-like pair with enough answers carries no mark at all', () => {
    stub()
    const v1 = basis({ count: 6, version: 1 })
    rememberScan(cycle('2026-09-16', 10, 30, v1, 'loop'))
    rememberScan(cycle('2026-09-17', 11, 30, v1, 'loop'))
    expect(simpleView(renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />))).not.toContain('data-day-marker')
  })

  it('A REVERT IS SAID, NOT LEFT TO BE INFERRED: version 3 holding version 1\u2019s questions is compared, and the line says why the version moved and the trend did not (stats review, MINOR 6)', () => {
    stub()
    const A = ['which crm suits a small team', 'which crm has the best mobile app', 'which crm is cheapest to start', 'which crm do accountants use', 'which crm works offline', 'which crm imports from a spreadsheet']
    const on = (version: number) => formatBasis({ format: 'grader', engines: ENGINES, locale: 'en-US', geo: 'US', bank: { slug: 'general-business-software', version: 1 }, unprompted: 0, runs: 1, custom: customBasisOf(A, version) })
    rememberScan(cycle('2026-09-16', 10, 30, on(1), 'loop'))
    rememberScan(cycle('2026-09-17', 11, 30, on(3), 'loop'))
    const html = simpleView(renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />))
    const list = sentence(html.split('data-cycle-days')[1] ?? '')
    expect(list).toMatch(/2026-09-17:.*your 6 prompts, version 3 · the same questions as the day before, saved again as version 3, so the two days are compared/)
    expect(html).toContain('data-day-marker="note"')
    expect(list).not.toContain('not comparable')
  })
})

describe('the head-to-head says which of three facts it is (MVP_PLAN C3r item 4; stats review MINOR 7)', () => {
  const stub = () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
  }

  it('A THIN SCAN IS ONE FACT ABOUT THE SCAN, SAID ONCE: not "no brand can be told apart from you", and not a fault listed against each rival', () => {
    stub()
    // Three of the person's own questions on five engines: fifteen answers, under the floor for every row.
    rememberScan(cycle('2026-09-18', 4, 15, basis({ count: 3, version: 1 }), 'loop', { rival: true }))
    const html = sentence(renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />))
    expect(html).toContain('This scan holds 15 answers, and ranking one brand against another needs at least 30, so no brand could be compared with Acme Flow and nothing is said about who is ahead. That is not the same as comparing them and finding no difference.')
    expect(html).not.toContain('can be told apart from Acme Flow')
    expect(html).not.toContain('Not ranked against you')
    expect(html).not.toContain('in the category')
  })

  it('compared and no difference found is still said as that, without "in the category" under an own-set heading', () => {
    stub()
    const b = basis({ count: 6, version: 1 })
    const scan = cycle('2026-09-18', 12, 30, b, 'loop', { rival: true })
    // A rival whose range overlaps the subject's: compared, indistinguishable.
    const rival = { id: 'hubspot', name: 'HubSpot', isSubject: false, mentions: 13, citations: 0, metric: metric(13, 30, b) }
    rememberScan({ ...scan, brands: [scan.brands[0]!, rival] } as unknown as ScanResultFile)
    const html = sentence(renderToStaticMarkup(<WorkspaceRecord domain="acme-flow.test" context="brand" />))
    expect(html).toContain('On this scan, not one of these brands can be told apart from Acme Flow. That is a fact about the sample size, not about the brands.')
    expect(html).not.toContain('brand in the category')
  })
})
