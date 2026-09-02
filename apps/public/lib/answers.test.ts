/**
 * WHAT THESE TESTS DEFEND.
 *
 *   1. THE RIGHT TEXT UNDER THE RIGHT NUMBER, or no text. Evidence whose basis
 *      does not match the result is refused — a reader checking our arithmetic
 *      against the wrong input is worse off than one who cannot check it at all.
 *
 *   2. AN ABSENT ANSWER IS NOT A SILENT ONE. Every empty answer in the real
 *      corpus is a `google-ai-overviews` cell where Google showed no overview,
 *      and the scorer counts it as an answer that did not name the brand. The
 *      flag that keeps those two facts apart is derived here, not trusted.
 *
 *   3. NOTHING IS EXCERPTED. Whatever the store holds is what a reader sees.
 */

import { describe, expect, it } from 'vitest'
import { answerKey, belongsTo, evidenceUrl, indexAnswers, loadAnswers, parseAnswers } from './answers'
import type { ScanResultFile } from './scan-result'

const BASIS = 'grader|engines=chatgpt,gemini|en-US|US|crm-software@1|unprompted=2|runs=1'

const scan = (over: Partial<ScanResultFile> = {}): ScanResultFile =>
  ({ domain: 'pipedrive.com', comparisonBasis: BASIS, status: 'scanned', brands: [], ...over }) as ScanResultFile

const file = (over: Record<string, unknown> = {}) => ({
  domain: 'pipedrive.com',
  category: 'crm-software',
  day: '2026-08-25',
  comparisonBasis: BASIS,
  answers: [
    { prompt: 'best crm', engine: 'chatgpt', text: 'Pipedrive is good.', empty: false, collectedAt: '' },
    { prompt: 'best crm', engine: 'gemini', text: '', empty: true, collectedAt: '' },
  ],
  ...over,
})

describe('the shape guard', () => {
  it('drops an entry that could not be rendered', () => {
    const got = parseAnswers(file({ answers: [{ prompt: 'q', engine: 'chatgpt', text: 'x' }, {}, null, { prompt: 'q' }] }))!
    expect(got.answers).toHaveLength(1)
  })

  it('refuses something that is not an evidence file at all', () => {
    expect(parseAnswers(null)).toBeNull()
    expect(parseAnswers({ domain: 'x.com' })).toBeNull()
    expect(parseAnswers([])).toBeNull()
  })

  it('⚠️ derives `empty` rather than trusting it', () => {
    // A file written before the flag existed, or one where the flag disagrees
    // with the text, must still tell an absent answer from a silent one.
    const got = parseAnswers(file({ answers: [{ prompt: 'q', engine: 'chatgpt', text: '   ', empty: false }] }))!
    expect(got.answers[0]!.empty).toBe(true)
  })

  it('does not touch the text — no trimming, no excerpting', () => {
    const text = '  ## Heading\n\n**Pipedrive** is good.\n\n  trailing  '
    const got = parseAnswers(file({ answers: [{ prompt: 'q', engine: 'chatgpt', text }] }))!
    expect(got.answers[0]!.text).toBe(text)
  })
})

describe('⚠️ the basis check — the right text under the right number', () => {
  it('accepts evidence from the same measurement', () => {
    expect(belongsTo(parseAnswers(file())!, scan())).toBeNull()
  })

  it('refuses evidence from a scan of a different scope', () => {
    // unprompted=2 against unprompted=17: a different sample, so these are not
    // the answers the numbers were counted from.
    const other = BASIS.replace('unprompted=2', 'unprompted=17')
    expect(belongsTo(parseAnswers(file({ comparisonBasis: other }))!, scan())).toMatch(/different basis/)
  })

  it('refuses evidence from a category whose competitor set has since moved', () => {
    // `erp-software@1` -> `@2` is exactly what promoting a competitor does, and
    // it changes `position` on every row. Same answers, different measurement.
    const other = BASIS.replace('crm-software@1', 'crm-software@2')
    expect(belongsTo(parseAnswers(file({ comparisonBasis: other }))!, scan())).toMatch(/different basis/)
  })

  it('refuses evidence for another domain', () => {
    expect(belongsTo(parseAnswers(file({ domain: 'sigzen.com' }))!, scan())).toMatch(/collected for sigzen\.com/)
  })

  it('⚠️ refuses a file that records no basis at all', () => {
    // Absence is the honest state for a missing cost. It is NOT the honest state
    // here: the whole claim is that these answers produced these numbers, and an
    // unverifiable claim is the thing this feature exists to replace.
    expect(belongsTo(parseAnswers(file({ comparisonBasis: '' }))!, scan())).toMatch(/does not record which measurement/)
  })
})

describe('indexing', () => {
  it('keys by prompt and engine, and keeps every run of a cell', () => {
    const got = indexAnswers(
      parseAnswers(
        file({
          answers: [
            { prompt: 'q', engine: 'chatgpt', text: 'one' },
            { prompt: 'q', engine: 'chatgpt', text: 'two' },
            { prompt: 'q', engine: 'gemini', text: 'three' },
          ],
        }),
      )!,
    )
    expect(got.get(answerKey('q', 'chatgpt'))?.map((a) => a.text)).toEqual(['one', 'two'])
    expect(got.get(answerKey('q', 'gemini'))).toHaveLength(1)
  })
})

describe('loading, and every way it can honestly fail', () => {
  const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch

  /**
   * The committed artefact, served exactly as the browser gets it. Reading it
   * off disk and handing it back through `fetch` keeps the test on the same code
   * path as production: `loadAnswers` does not know or care that the bytes came
   * from a file rather than a socket.
   */
  const served = (async (url: RequestInfo | URL) => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    if (String(url) !== '/scan-answers.json') return new Response('{}', { status: 404 })
    const p = fileURLToPath(new URL('../public/scan-answers.json', import.meta.url))
    return new Response(readFileSync(p, 'utf8'), { status: 200 })
  }) as unknown as typeof fetch

  it('a build with no route says so as a fact about the deployment', async () => {
    // A static export has no route handlers at all. That is not a statement
    // about the scan, and the message must not imply one.
    const got = await loadAnswers(scan({ domain: 'nowhere.example' }), notFound)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.message).toMatch(/not available in this build/)
  })

  it('a server fault reports its status rather than a blank failure', async () => {
    const boom = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    const got = await loadAnswers(scan({ domain: 'nowhere.example' }), boom)
    if (got.ok) throw new Error('expected a refusal')
    expect(got.message).toContain('500')
  })

  it('an unreachable store names what went wrong', async () => {
    const dead = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const got = await loadAnswers(scan({ domain: 'nowhere.example' }), dead)
    if (got.ok) throw new Error('expected a refusal')
    expect(got.message).toMatch(/Could not reach the answer store: offline/)
  })

  it('⚠️ the committed evidence is the reference scan’s, and it belongs to it', async () => {
    // The real artefact, against the real committed result — the end-to-end
    // claim this whole feature rests on.
    const { SCAN } = await import('./scan-result')
    const got = await loadAnswers(SCAN, served)
    if (!got.ok) throw new Error(got.message)
    expect(got.answers.domain).toBe('pipedrive.com')
    expect(got.answers.answers.length).toBe((SCAN.promptRows ?? []).length)
    expect(belongsTo(got.answers, SCAN)).toBeNull()
  })

  it('⚠️ every row in the reference scan has its answer, matched on prompt AND engine', async () => {
    // Position alone would be enough while the writer and the reader agree, and
    // would put one prompt's answer under another prompt's heading the moment
    // they stopped. Matched on identity instead.
    const { SCAN } = await import('./scan-result')
    const got = await loadAnswers(SCAN, served)
    if (!got.ok) throw new Error(got.message)
    const index = indexAnswers(got.answers)
    const rows = (SCAN.promptRows ?? []) as { prompt: string; engine: string }[]
    const missing = rows.filter((r) => !index.has(answerKey(r.prompt, r.engine)))
    expect(missing).toEqual([])
  })

  it('⚠️ the reference scan carries the two absent Google overviews, flagged', async () => {
    // Measured on the real corpus: two google-ai-overviews cells returned no
    // text. They are counted in the published 38/85 as answers that did not name
    // Pipedrive (44.71%, against 45.78% without them). The flag is what stops a
    // blank box saying the wrong one of those.
    const { SCAN } = await import('./scan-result')
    const got = await loadAnswers(SCAN, served)
    if (!got.ok) throw new Error(got.message)
    const empties = got.answers.answers.filter((a) => a.empty)
    expect(empties).toHaveLength(2)
    expect(empties.every((a) => a.engine === 'google-ai-overviews')).toBe(true)
  })
})

describe('⚠️ where the evidence is fetched from', () => {
  it('the reference scan reads a static asset, which needs no server', async () => {
    // The path that has to work on Cloudflare Pages, where `/api/answers` does
    // not exist. A file under `public/` is served for free and, unlike a
    // dynamic import, no bundler gets to decide where it ends up.
    const { SCAN } = await import('./scan-result')
    expect(evidenceUrl(SCAN)).toBe('/scan-answers.json')
  })

  it('a scan this browser collected reads the route instead', () => {
    expect(evidenceUrl(scan({ domain: 'acme.example' }))).toBe('/api/answers?domain=acme.example')
  })

  it('⚠️ decides which before fetching either, so neither pays for the other', async () => {
    // A session scan must not download the reference scan's 191 KB to discover
    // it is the wrong file.
    const asked: string[] = []
    const spy = (async (u: RequestInfo | URL) => {
      asked.push(String(u))
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    await loadAnswers(scan({ domain: 'acme.example' }), spy)
    expect(asked).toEqual(['/api/answers?domain=acme.example'])
  })
})

describe('⚠️ the rule-set check — the classes on screen are the classes behind the number (R5)', () => {
  it('refuses evidence classified under a different scorer version than the result was scored with', () => {
    const evidence = parseAnswers(file({ algoVersion: 'det-3' }))!
    const why = belongsTo(evidence, scan({ algoVersion: 'det-2' }))
    expect(why).toContain('det-3')
    expect(why).toContain('det-2')
  })

  it('accepts the same version, and a file too old to name one', () => {
    expect(belongsTo(parseAnswers(file({ algoVersion: 'det-2' }))!, scan({ algoVersion: 'det-2' }))).toBeNull()
    expect(belongsTo(parseAnswers(file({}))!, scan({ algoVersion: 'det-2' }))).toBeNull()
    expect(parseAnswers(file({}))!.algoVersion).toBe('')
  })

  it('a static host answering the route with its own HTML page is the deployment, not the store', async () => {
    const html = (async () => new Response('<!doctype html><h1>Not found</h1>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const got = await loadAnswers(scan({ domain: 'acme.example' }), html)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.message).toContain('not available in this build')
  })
})
