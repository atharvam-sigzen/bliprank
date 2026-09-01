import { describe, expect, it } from 'vitest'
import {
  MAX_BODY_CHARS,
  MIN_DISTINCT,
  MIN_SCORE,
  classifyContent,
  countPhrase,
  extractSiteText,
  normaliseText,
  scoreCategories,
} from './classify-content.js'
import { DEMO_TAXONOMY } from './taxonomy.js'
import type { CategoryDef } from './types.js'

const page = (over: Partial<{ title: string; description: string; headings: string; body: string }> = {}) => ({
  title: '',
  description: '',
  headings: '',
  body: '',
  ...over,
})

describe('normalisation is whole-token, and that is the point', () => {
  it('brackets the text so a phrase never matches inside a longer word', () => {
    // The substring bug, in the form the taxonomy's own docblocks describe:
    // `crm` inside `microm` is how compass.com becomes a password manager.
    expect(countPhrase(normaliseText('our microm platform'), 'crm')).toBe(0)
    expect(countPhrase(normaliseText('our CRM platform'), 'crm')).toBe(1)
  })

  it('matches at the very start and the very end of the text', () => {
    expect(countPhrase(normaliseText('crm'), 'crm')).toBe(1)
    expect(countPhrase(normaliseText('a great crm'), 'crm')).toBe(1)
    expect(countPhrase(normaliseText('crm software here'), 'crm')).toBe(1)
  })

  it('matches multi-word phrases across punctuation and casing', () => {
    expect(countPhrase(normaliseText('Customer-Relationship  MANAGEMENT, done right'), 'customer relationship management')).toBe(1)
  })

  it('counts every occurrence, not just the first', () => {
    expect(countPhrase(normaliseText('crm and crm and crm'), 'crm')).toBe(3)
  })

  it('a punctuation-only phrase matches nothing rather than everything', () => {
    // An empty needle in an indexOf loop matches at every position and never
    // terminates usefully. Guarded, because a hand-edited keyword list can
    // contain anything.
    expect(countPhrase(normaliseText('anything at all'), '---')).toBe(0)
  })
})

describe('scoring rewards breadth, not repetition', () => {
  const taxonomy: readonly CategoryDef[] = [
    { slug: 'alpha', displayName: 'Alpha', description: '', domainKeywords: [], contentKeywords: ['alpha one', 'alpha two', 'alpha three'] },
    { slug: 'beta', displayName: 'Beta', description: '', domainKeywords: [], contentKeywords: ['beta one', 'beta two'] },
  ]

  it('caps what one repeated phrase can contribute', () => {
    const spammed = scoreCategories(page({ body: Array(50).fill('alpha one').join(' ') }), taxonomy)
    // 50 occurrences, capped at 3, at body weight 1.
    expect(spammed[0]).toMatchObject({ slug: 'alpha', score: 3, distinct: 1 })
  })

  it('weights the title above the body', () => {
    const inTitle = scoreCategories(page({ title: 'alpha one' }), taxonomy)
    const inBody = scoreCategories(page({ body: 'alpha one' }), taxonomy)
    expect(inTitle[0]!.score).toBeGreaterThan(inBody[0]!.score)
  })

  it('omits a category with an empty vocabulary entirely — the fallback can never be selected', () => {
    const withFallback = [...taxonomy, { slug: 'general', displayName: 'General', description: '', domainKeywords: [], contentKeywords: [] }]
    const scores = scoreCategories(page({ body: 'nothing relevant here' }), withFallback)
    expect(scores.map((s) => s.slug)).not.toContain('general')
  })

  it('is stable for a given input — ties break on the slug, not on array order', () => {
    const a = scoreCategories(page({ body: 'alpha one beta one' }), taxonomy)
    const b = scoreCategories(page({ body: 'alpha one beta one' }), [...taxonomy].reverse())
    expect(a).toEqual(b)
  })
})

describe('the three outcomes', () => {
  const taxonomy: readonly CategoryDef[] = [
    { slug: 'crm-software', displayName: 'CRM software', description: '', domainKeywords: [], contentKeywords: ['crm', 'sales pipeline', 'deal pipeline', 'lead management'] },
    { slug: 'help-desk-software', displayName: 'Help desk', description: '', domainKeywords: [], contentKeywords: ['help desk', 'support tickets', 'shared inbox'] },
  ]

  it('classifies a page that says what it is, several different ways', () => {
    const result = classifyContent(
      page({ title: 'A simple CRM', description: 'Manage your sales pipeline', headings: 'Lead management that works' }),
      taxonomy,
    )
    expect(result.status).toBe('classified')
    if (result.status !== 'classified') return
    expect(result.slug).toBe('crm-software')
    expect(result.signal).toBe('site-content')
    // The evidence names what matched, so a surprising category is explainable.
    expect(result.evidence).toContain('sales pipeline')
  })

  it('refuses one phrase repeated — a mention is not a subject', () => {
    const result = classifyContent(page({ title: 'CRM', description: 'CRM', headings: 'CRM', body: 'crm crm crm' }), taxonomy)
    expect(result.status).toBe('weak')
    if (result.status !== 'weak') return
    expect(result.reason).toContain(`${MIN_DISTINCT} are needed`)
  })

  it('refuses a page that mentions the vocabulary in passing, even with breadth', () => {
    // Two DIFFERENT phrases, so the distinct rule is satisfied — and it is still
    // refused, because both are one buried mention in the body. Breadth is
    // necessary and not sufficient; the floor is the second half of the rule.
    const result = classifyContent(page({ body: 'we integrate with your crm and with your sales pipeline tool' }), taxonomy)
    expect(result.status).toBe('weak')
    if (result.status !== 'weak') return
    expect(result.reason).toContain(`under the floor of ${MIN_SCORE}`)
  })

  it('refuses a page that mentions one category word once', () => {
    const result = classifyContent(page({ body: 'we integrate with your crm' }), taxonomy)
    expect(result.status).toBe('weak')
    if (result.status !== 'weak') return
    expect(result.reason).toContain(`${MIN_DISTINCT} are needed`)
  })

  it('calls it ambiguous when two categories fit almost equally', () => {
    const result = classifyContent(
      page({ title: 'CRM and help desk', description: 'sales pipeline and support tickets', headings: 'lead management shared inbox' }),
      taxonomy,
    )
    expect(result.status).toBe('ambiguous')
    if (result.status !== 'ambiguous') return
    // Sorted and both named. Picking one would be inventing a fact.
    expect(result.candidates).toEqual(['crm-software', 'help-desk-software'])
  })

  it('REGRESSION (sigzen.com): body evidence alone never selects a category', () => {
    /*
     * The real wrong answer this rule exists for. sigzen.com is an ERPNext
     * implementation consultancy; its title and description say exactly that,
     * and its body — a list of the ERP modules it implements — says `crm`
     * twenty-one times. On totals alone it scored 18 against a floor of 8, with
     * five distinct phrases and a clear margin: confident, well-evidenced, and
     * about a market it works with rather than the one it is in.
     */
    const result = classifyContent(
      page({
        title: 'Certified ERPNext & Frappe Partner - Implementation & Support',
        description: 'Partner with us for expert ERPNext implementation, customisation and support.',
        headings: 'Our industry specific solutions: CRM, and lead management',
        body: `${'crm '.repeat(21)} ${'customer relationship management '.repeat(3)} ${'lead management '.repeat(3)} ${'sales pipeline '.repeat(3)}`,
      }),
      taxonomy,
    )
    expect(result.status).toBe('weak')
    if (result.status !== 'weak') return
    expect(result.reason).toContain('title and description do not')
    // The evidence was genuinely strong by volume. That is the point: the rule
    // is not a threshold, it is about WHICH zone the evidence came from.
    expect(result.scores[0]!.score).toBeGreaterThan(MIN_SCORE)
    expect(result.scores[0]!.inSelfDescription).toBe(0)
  })

  it('one phrase in the title is enough to unlock the body evidence behind it', () => {
    const result = classifyContent(
      page({ title: 'Sales CRM and pipeline software', body: 'lead management sales pipeline deal pipeline' }),
      taxonomy,
    )
    expect(result.status).toBe('classified')
  })

  it('says weak, not classified, when the page says nothing', () => {
    const result = classifyContent(page({ title: 'Acme', body: 'Welcome to our website' }), taxonomy)
    expect(result.status).toBe('weak')
  })
})

describe('extraction reads the page, not its framework', () => {
  it('drops script, style, noscript and comments before reading anything', () => {
    // The defect this exists to prevent: a Next.js page ships its whole props
    // tree inside a <script>, so without this every React site's "body text" is
    // a JSON blob — meaningless, and an injection path into the evidence line.
    const html = `
      <html><head><title>Real title</title>
      <script>window.__DATA__ = {"crm":"sales pipeline","x":"lead management"}</script>
      <style>.a{content:"help desk"}</style></head>
      <body><!-- support tickets --><noscript>shared inbox</noscript><p>Actual copy.</p></body></html>`
    const text = extractSiteText(html)
    expect(text.title).toBe('Real title')
    expect(text.body).toContain('Actual copy.')
    expect(text.body).not.toContain('sales pipeline')
    expect(text.body).not.toContain('help desk')
    expect(text.body).not.toContain('support tickets')
    expect(text.body).not.toContain('shared inbox')
  })

  it('reads both descriptions and the social title, single or double quoted', () => {
    const html = `
      <meta name="description" content="The SEO description">
      <meta property='og:description' content='The social description'>
      <meta property="og:title" content="The social title">
      <meta name="viewport" content="width=device-width">`
    const text = extractSiteText(html)
    expect(text.description).toContain('The SEO description')
    expect(text.description).toContain('The social description')
    expect(text.description).toContain('The social title')
    // Not every meta tag — viewport is not a description of the business.
    expect(text.description).not.toContain('width=device-width')
  })

  it('collects h1 through h3 and decodes entities', () => {
    const text = extractSiteText('<h1>Sales &amp; support</h1><h2>Tools&nbsp;for teams</h2><h4>Footer</h4>')
    expect(text.headings).toContain('Sales & support')
    expect(text.headings).toContain('Tools for teams')
    expect(text.headings).not.toContain('Footer')
  })

  it('caps the body so a long page cannot make the answer depend on its footer', () => {
    const text = extractSiteText(`<body>${'word '.repeat(20_000)}</body>`)
    expect(text.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS)
  })

  it('survives malformed HTML rather than throwing', () => {
    expect(() => extractSiteText('<title>unclosed <p>and <<>> nonsense')).not.toThrow()
    expect(() => extractSiteText('')).not.toThrow()
  })
})

describe('the shipped taxonomy holds the same invariants for content as for domains', () => {
  it('no content phrase belongs to two categories', () => {
    // Same reasoning as the domainKeywords rule: a shared phrase makes every
    // site carrying it permanently ambiguous, and it degrades silently.
    const seen = new Map<string, string>()
    for (const c of DEMO_TAXONOMY) {
      for (const k of c.contentKeywords) {
        expect([k, seen.get(k)]).toEqual([k, undefined])
        seen.set(k, c.slug)
      }
    }
    expect(seen.size).toBeGreaterThan(100)
  })

  it('every phrase is lowercase and normalises to itself', () => {
    for (const c of DEMO_TAXONOMY) {
      for (const k of c.contentKeywords) {
        expect([c.slug, k, k === k.toLowerCase()]).toEqual([c.slug, k, true])
        // A phrase whose normalised form differs from itself would still match,
        // but the evidence line would print something the page never said.
        expect([c.slug, k, normaliseText(k).trim()]).toEqual([c.slug, k, k])
      }
    }
  })

  it('the fallback carries no content vocabulary, so the content pass can never select it', () => {
    const fallback = DEMO_TAXONOMY.find((c) => c.slug === 'general-business-software')!
    expect(fallback.contentKeywords).toEqual([])
    expect(fallback.domainKeywords).toEqual([])
  })

  it('places a real homepage the domain string could never place', () => {
    // sigzen.com and nike.com are the cases the PHASES 3.1 gap produced: nothing
    // in the host says anything, so the domain pass returns unclassified and the
    // scan runs against a general bank. Given the page, it is not close.
    const result = classifyContent(
      page({
        title: 'Zoho-style CRM for growing teams',
        description: 'Track every deal in one sales pipeline. Lead management, contact management and forecasting.',
        headings: 'Close more deals Contact management',
        body: 'Our customer relationship management platform gives your sales team one place to work.',
      }),
      DEMO_TAXONOMY,
    )
    expect(result.status).toBe('classified')
    if (result.status !== 'classified') return
    expect(result.slug).toBe('crm-software')
  })
})
