/**
 * WHAT THESE TESTS DEFEND.
 *
 *   1. NO FALSE GAP. The worst thing this report can produce is a line telling a
 *      customer to write copy their page already has. Two real ways that
 *      happened are pinned here — a plural, and a page longer than the reader.
 *
 *   2. NO CAUSAL CLAIM. Every `why` is hedged, because none of these has been
 *      run through a holdout. A test asserts the hedge, because it is the sort
 *      of sentence that gets "tightened" in a later edit.
 *
 *   3. NOTHING IS PUBLISHED. The draft path reaches exactly one host, the
 *      configured model endpoint, and returns a string. There is no write.
 */

import { describe, expect, it } from 'vitest'
import {
  auditSite,
  coverageFor,
  draftGapContent,
  jsonLdTypes,
  promptTerms,
  questionHeadings,
  widestGap,
  wholeDocumentText,
} from './aeo-audit.js'
import type { BankAuthorConfig } from './bank-author.js'

const page = (body: string, head = ''): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

describe('structured data — parsed, never pattern-matched', () => {
  it('reads @type out of a @graph and out of nested entities', () => {
    const html = page(
      '',
      `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [{ '@type': 'Organization', name: 'Acme' }, { '@type': ['WebSite', 'WebPage'], publisher: { '@type': 'Brand' } }],
      })}</script>`,
    )
    const got = jsonLdTypes(html)
    expect(got.types).toEqual(['Brand', 'Organization', 'WebPage', 'WebSite'])
    expect(got.blocks).toBe(1)
    expect(got.invalid).toBe(0)
  })

  it('does not find structured data in prose that happens to say "@type"', () => {
    // A documentation site explaining schema.org has no schema.org markup, and
    // a substring match would report that it does.
    const html = page('<p>Set the "@type" property to Organization in your JSON-LD.</p>')
    expect(jsonLdTypes(html)).toEqual({ types: [], blocks: 0, invalid: 0 })
  })

  it('counts a block it cannot parse instead of ignoring it', () => {
    // "There is markup here and it is broken" is a different, more useful
    // finding than "there is no markup here".
    const html = page('', '<script type="application/ld+json">{ oops, }</script>')
    const got = jsonLdTypes(html)
    expect(got).toMatchObject({ blocks: 1, invalid: 1 })
    expect(auditSite(html, { domain: 'x.com', prompts: [] }).findings.find((f) => f.id === 'json-ld')!.status).toBe('weak')
  })

  it('finds questions in headings, summaries and definition terms', () => {
    const html = page('<h2>How much does it cost?</h2><summary>What is included</summary><h3>Our team</h3><dt>Can I cancel</dt>')
    expect(questionHeadings(html)).toEqual(['How much does it cost?', 'What is included', 'Can I cancel'])
  })
})

describe('coverage — a word check, and it must not manufacture a gap', () => {
  it('drops stopwords and short tokens, keeps the topic', () => {
    expect(promptTerms('best ERP for a travel agency with booking and accounting')).toEqual(['erp', 'travel', 'agency', 'booking', 'accounting'])
  })

  it('⚠️ counts a plural as the word — the false gap found on a real site', () => {
    // sigzen.com says "Bookings" throughout and was told `booking` was never on
    // its page. A gap that is not a gap is advice to write copy that exists.
    expect(coverageFor('We handle Bookings every day.', ['booking for an agency'])[0]!.missing).toEqual(['agency'])
    // And the other direction: the prompt plural, the page singular.
    // `agency`/`agencies` above is the documented ceiling: two suffixes, no
    // irregulars. A y-to-ies rule is a stemmer by instalments, and a term that
    // matches something the page did not say is the same defect reversed.
    expect(coverageFor('One employee, one seat.', ['pricing for employees'])[0]!.missing).toEqual(['pricing'])
  })

  it('does NOT stem, because a loose match is the same defect pointing the other way', () => {
    // `book` must not be satisfied by `booking`. Two suffixes is the whole rule.
    expect(coverageFor('Our booking engine is fast.', ['book a demo'])[0]!.missing).toContain('book')
  })

  it('reads the page’s text, not its markup', () => {
    // A term appearing only in a class name or a tracking script is not the
    // page addressing it, and counting it would hide a real gap.
    const html = page('<div class="jewellery-hero">Welcome</div><script>var topic="jewellery"</script>')
    expect(coverageFor(wholeDocumentText(html), ['jewellery retail'])[0]!.missing).toContain('jewellery')
  })

  it('⚠️ reads the WHOLE document, not the classifier’s 20k body cap', () => {
    // The second false gap found on a real site: sigzen.com strips to 173,000
    // characters, so a cap at 20,000 judged coverage on the first 12% of the
    // page and reported everything past it as absent.
    const filler = 'lorem ipsum dolor sit amet '.repeat(2_000) // ~54k chars
    const html = page(`<p>${filler}</p><p>We serve jewellery retailers.</p>`)
    const report = auditSite(html, { domain: 'x.com', prompts: ['jewellery retailers'] })
    expect(report.coverage[0]!.missing).toEqual([])
    expect(report.words).toBeGreaterThan(9_000)
  })
})

describe('the findings — facts about a document, hedged about mechanism', () => {
  const bare = page('<p>Hello.</p>', '<title>Acme</title>')

  it('a page with nothing on it says so, item by item', () => {
    const byId = Object.fromEntries(auditSite(bare, { domain: 'acme.com', prompts: [] }).findings.map((f) => [f.id, f.status]))
    expect(byId).toMatchObject({
      'json-ld': 'missing',
      'entity-schema': 'missing',
      faq: 'missing',
      'meta-description': 'missing',
      title: 'weak',
      h1: 'missing',
      'content-depth': 'weak',
    })
  })

  it('separates "has questions but no markup" from "has no questions"', () => {
    // The first is a markup change over copy that exists; the second is a
    // writing job. Collapsing them into one finding makes the cheap fix
    // invisible.
    const withQuestions = page('<h2>How long does implementation take?</h2><p>About six weeks.</p>')
    expect(auditSite(withQuestions, { domain: 'x.com', prompts: [] }).findings.find((f) => f.id === 'faq')!.status).toBe('weak')
    expect(auditSite(bare, { domain: 'x.com', prompts: [] }).findings.find((f) => f.id === 'faq')!.status).toBe('missing')
  })

  it('treats a noindex/nosnippet directive as outranking everything else', () => {
    const blocked = page('<p>x</p>', '<meta name="robots" content="noindex, nofollow">')
    const f = auditSite(blocked, { domain: 'x.com', prompts: [] }).findings.find((r) => r.id === 'robots')!
    expect(f.status).toBe('missing')
    expect(f.what).toContain('noindex')
  })

  it('⚠️ never claims a finding causes anything', () => {
    // Every `why` is a plausibility statement. These are exactly the sentences
    // that get "tightened" into claims in a later edit, so the hedge is pinned.
    const all = auditSite(bare, { domain: 'x.com', prompts: [] }).findings
    for (const f of all) {
      expect(f.why, f.id).not.toMatch(/\b(will improve|increases?|boosts?|guarantees?|ranks? you)\b/i)
    }
    // And the one place the absence of evidence is stated outright.
    expect(all.find((f) => f.id === 'json-ld')!.why).toMatch(/not something we have measured/i)
  })

  it('carries the truncation flag through, because it changes what a gap means', () => {
    expect(auditSite(bare, { domain: 'x.com', prompts: [], truncated: true }).truncated).toBe(true)
    expect(auditSite(bare, { domain: 'x.com', prompts: [] }).truncated).toBe(false)
  })

  it('picks the least-covered prompt as the gap worth drafting for', () => {
    const html = page('<p>We sell ERP software for jewellery retailers in India.</p>')
    const report = auditSite(html, { domain: 'x.com', prompts: ['erp for jewellery retailers', 'payroll for construction crews'] })
    expect(widestGap(report)!.prompt).toBe('payroll for construction crews')
  })
})

describe('the draft — one host, one string, no write anywhere', () => {
  const CONFIG: BankAuthorConfig = {
    provider: 'openai-compatible',
    model: 'primary/model:free',
    fallbackModel: 'fallback/model:free',
    baseUrl: 'https://example.test/api/v1',
    apiKey: 'k',
    timeoutMs: 1_000,
  }
  const reply = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 })
  const input = (fetchImpl: typeof fetch, config = CONFIG, log?: (m: string) => void) => ({
    domain: 'acme.com',
    title: 'Acme',
    description: 'We do things',
    headings: 'Things',
    prompt: 'payroll for construction crews',
    missingTerms: ['payroll', 'construction'],
    config,
    fetchImpl,
    ...(log ? { log } : {}),
  })

  it('⚠️ reaches exactly one host, and it is the configured model endpoint', () => {
    // The property that matters most here: a report that diagnoses someone
    // else's site must not be able to touch it. Nothing in this path takes a
    // URL from the audited domain.
    const seen: string[] = []
    const doFetch = (async (url: unknown) => {
      seen.push(String(url))
      return reply('## Payroll\n\nWe run payroll.')
    }) as unknown as typeof fetch
    return draftGapContent(input(doFetch)).then((out) => {
      expect(seen).toEqual(['https://example.test/api/v1/chat/completions'])
      expect(out).toContain('## Payroll')
    })
  })

  it('puts the gap and its missing terms in front of the model', async () => {
    let body: { messages: { role: string; content: string }[] } = { messages: [] }
    const doFetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body
      return reply('## x')
    }) as unknown as typeof fetch
    await draftGapContent(input(doFetch))
    const user = body.messages.find((m) => m.role === 'user')!.content
    expect(user).toContain('payroll for construction crews')
    expect(user).toContain('payroll, construction')
    // And the system prompt forbids the two things a draft must never do.
    const system = body.messages.find((m) => m.role === 'system')!.content
    expect(system).toContain('Name no competitor')
    expect(system).toMatch(/do not write one|Claim no award/)
  })

  it('never throws: a dead model falls to the fallback, and two dead models yield null', async () => {
    const asked: string[] = []
    const failing = (async (_u: unknown, init?: RequestInit) => {
      asked.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return new Response('rate limited', { status: 429 })
    }) as unknown as typeof fetch
    const logs: string[] = []
    await expect(draftGapContent(input(failing, CONFIG, (m) => logs.push(m)))).resolves.toBeNull()
    expect(asked).toEqual(['primary/model:free', 'fallback/model:free'])
    expect(logs.join(' ')).toContain('429')
  })

  it('the anthropic provider gets null and a logged reason, not a wrong-shaped request', () => {
    // Documented ceiling: that transport is a forced tool call shaped for a
    // bank, and this needs prose. Silence would look like a dead model.
    const logs: string[] = []
    const never = (async () => {
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    return draftGapContent(input(never, { ...CONFIG, provider: 'anthropic' }, (m) => logs.push(m))).then((out) => {
      expect(out).toBeNull()
      expect(logs.join(' ')).toContain('no prose transport')
    })
  })
})
