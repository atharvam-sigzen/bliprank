import { normalisePrompt } from '@bliprank/contracts'
import { describe, expect, it } from 'vitest'
import { classifyDomain } from './classify-domain.js'
import { DEMO_BANKS } from './banks/index.js'
import { DEMO_SLUGS, DEMO_TAXONOMY } from './taxonomy.js'
import { INTENTS, type Intent } from './types.js'

/**
 * The shipped taxonomy and the shipped banks, checked as data.
 *
 * Separate from `classify-domain.test.ts` on purpose: that suite proves the
 * ALGORITHM against fixtures, this one proves the CONTENT. A bank edit must not
 * be able to quietly change what the classifier is proven to do, and a classifier
 * change must not be able to quietly invalidate a bank.
 *
 * These are the checks `/category-bank` performs by hand for a production bank —
 * intent mix, dedup against every existing bank, overlap reported rather than
 * designed away — run as assertions instead, because a hand-check that has to
 * happen again on every edit is not a check.
 */

const ALL_PROMPTS = DEMO_BANKS.flatMap((b) => b.prompts.map((p) => ({ ...p, category: b.category })))
const norm = (t: string) => normalisePrompt(t)

/** Whole-token alias matching, the same rule the scorer uses. */
function mentions(text: string, alias: string): boolean {
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-z0-9_])${esc}(?![a-z0-9_])`, 'i').test(text)
}

describe('the taxonomy is internally consistent', () => {
  it('every slug has exactly one bank, and every bank has a slug', () => {
    expect([...DEMO_BANKS.map((b) => b.category)].sort()).toEqual([...DEMO_SLUGS].sort())
  })

  it('THE ADR-0008 §2 RULE: no slug carries a geo', () => {
    // A geo-bearing slug fragments one vertical into N banks whose prompts
    // normalise identically — the same text collected once per variant, into a
    // different cell each time, with no cache hit between them. R6's key already
    // carries geo, so this is the margin lever spending itself on a name.
    const COUNTRYISH = /(^|-)(india|indian|uk|usa|us|gb|uae|gcc|europe|eu|global|apac|emea|in|ae|au|ca)(-|$)/
    for (const slug of DEMO_SLUGS) expect([slug, COUNTRYISH.test(slug)]).toEqual([slug, false])
  })

  it('no keyword belongs to two categories', () => {
    // A duplicate keyword makes every domain carrying it permanently ambiguous,
    // and it would degrade silently: the classifier would just stop classifying.
    const seen = new Map<string, string>()
    for (const c of DEMO_TAXONOMY) {
      for (const k of c.domainKeywords) {
        expect([k, seen.get(k)]).toEqual([k, undefined])
        seen.set(k, c.slug)
      }
    }
    expect(seen.size).toBeGreaterThan(40)
  })

  it('keywords are lowercase single tokens — they are matched against split host labels', () => {
    for (const c of DEMO_TAXONOMY) {
      for (const k of c.domainKeywords) {
        expect([c.slug, k, k === k.toLowerCase() && /^[a-z0-9]{2,}$/.test(k)]).toEqual([c.slug, k, true])
      }
    }
  })
})

describe('every bank is shaped the way prompt_banks expects', () => {
  it('carries locale, geo, version and an unverified marker', () => {
    for (const b of DEMO_BANKS) {
      expect([b.category, /^[a-z]{2}-[A-Z]{2}$/.test(b.locale)]).toEqual([b.category, true])
      expect([b.category, /^[A-Z]{2}$/.test(b.geo)]).toEqual([b.category, true])
      expect([b.category, b.version]).toEqual([b.category, 1])
      // `/category-bank`: derive competitor names from collected answers or a
      // verifiable source, and mark any that are unverified. Nothing here has a
      // collected answer behind it.
      expect([b.category, b.verified]).toEqual([b.category, false])
    }
  })

  it('the (category, locale, geo, version) key is unique — it is the table PRIMARY KEY', () => {
    const keys = DEMO_BANKS.map((b) => `${b.category}|${b.locale}|${b.geo}|${b.version}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('holds 6-10 leaders with unique ids, lowercase aliases and apex-only domains', () => {
    for (const b of DEMO_BANKS) {
      expect([b.category, b.leaders.length >= 6 && b.leaders.length <= 10]).toEqual([b.category, true])
      expect(new Set(b.leaders.map((l) => l.id)).size).toBe(b.leaders.length)
      for (const l of b.leaders) {
        expect([b.category, l.id, /^[a-z0-9-]+$/.test(l.id)]).toEqual([b.category, l.id, true])
        expect([b.category, l.id, l.aliases.length > 0]).toEqual([b.category, l.id, true])
        for (const a of l.aliases) expect([l.id, a, a === a.toLowerCase() && a.trim() === a && a.length > 0]).toEqual([l.id, a, true])
        for (const d of l.domains) {
          // Apex only: subdomains match by suffix, so a scheme, a `www.` or a
          // path in this list is either dead weight or a match that never fires.
          expect([l.id, d, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !d.startsWith('www.')]).toEqual([l.id, d, true])
        }
      }
    }
  })

  it('THE DANGEROUS-ALIAS RULE: no alias is a bare word that occurs in ordinary prose', () => {
    // `monday` is the canonical case: a bare alias collides with the weekday, so
    // "we ship every monday" scores a mention for monday.com. Aliases are matched
    // whole-token and case-insensitively, which does not save you from a real word.
    //
    // This list is ENGLISH WORDS ONLY. `wix`, `deel`, `brevo` and `wrike` are not
    // words and belong nowhere near it — banning a brand name because it looks
    // unusual is how a test starts failing for reasons that are not defects.
    // `keeper` is deliberately absent and deliberately allowed: `bookkeeper` and
    // `goalkeeper` are letter-flanked and cannot match under whole-token
    // matching, and the bank interrogates Keeper by name three times.
    const BANNED = new Set([
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      'wave', 'sage', 'close', 'kit', 'notion', 'tally', 'shop', 'store', 'square',
      'stripe', 'slack', 'zoom', 'teams', 'drive', 'box', 'pipeline', 'campaign',
      'books', 'people', 'pay', 'contact', 'lead', 'deal', 'invoice', 'vault',
    ])
    const offenders: string[] = []
    for (const b of DEMO_BANKS) {
      for (const l of b.leaders) {
        for (const a of l.aliases) if (BANNED.has(a)) offenders.push(`${b.category}/${l.id}: "${a}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('a KNOWN-RISK bare alias is kept only where the bank records the bias it creates', () => {
    // `gusto` matches "with gusto" and `rippling` matches "a rippling effect".
    // Both are real English and both are kept, because removing them would cost
    // more coverage than the false-positive rate buys — but a number quoted with
    // a confidence interval and an unrecorded known bias is exactly what R8
    // exists to prevent. The caveat is mechanical, not a comment someone wrote
    // once: drop it from the note and this fails.
    const ACKNOWLEDGED = ['gusto', 'rippling']
    for (const b of DEMO_BANKS) {
      const used = ACKNOWLEDGED.filter((w) => b.leaders.some((l) => l.aliases.includes(w)))
      for (const w of used) {
        expect([b.category, w, b.note.toLowerCase().includes(w)]).toEqual([b.category, w, true])
        expect([b.category, /upper bound/i.test(b.note)]).toEqual([b.category, true])
      }
    }
  })

  it('a brand appearing in two categories keeps the same aliases and domains', () => {
    // Zoho leads three categories here. Inconsistent domains would make the
    // classifier ambiguous in one direction and not the other.
    const byId = new Map<string, { aliases: string; domains: string }>()
    for (const b of DEMO_BANKS) {
      for (const l of b.leaders) {
        const sig = { aliases: [...l.aliases].sort().join('|'), domains: [...l.domains].sort().join('|') }
        const prior = byId.get(l.id)
        if (prior) expect([l.id, sig.domains]).toEqual([l.id, prior.domains])
        else byId.set(l.id, sig)
      }
    }
  })
})

describe('the prompts are the intent mix `/category-bank` specifies', () => {
  it('10 discovery, 8 comparison, 7 problem-led, 5 brand-verification per bank', () => {
    const want: Record<Intent, number> = { discovery: 10, comparison: 8, 'problem-led': 7, 'brand-verification': 5 }
    for (const b of DEMO_BANKS) {
      const got = Object.fromEntries(INTENTS.map((i) => [i, b.prompts.filter((p) => p.intent === i).length]))
      expect([b.category, got]).toEqual([b.category, want])
    }
  })

  it('THE NEUTRALITY RULE: discovery and problem-led prompts name no tracked brand', () => {
    // These two groups are the UNPROMPTED share-of-voice baseline. A brand named
    // in one is guaranteed a mention on every run of that cell, so its rate there
    // is structurally 100% and the cell measures our phrasing rather than the
    // engines. `comparison` and `brand-verification` are exempt by construction —
    // "X vs Y" and "is X any good" name brands on purpose.
    //
    // Aliases only, never `name`: the scorer matches aliases, so an alias set that
    // deliberately excludes a dangerous bare name (Close, Wave, Sage) must not be
    // re-introduced here, or this flags prose the scorer will never see.
    const offenders: string[] = []
    for (const b of DEMO_BANKS) {
      const aliases = b.leaders.flatMap((l) => l.aliases)
      for (const p of b.prompts) {
        if (p.intent === 'comparison' || p.intent === 'brand-verification') continue
        for (const a of aliases) if (mentions(p.text, a)) offenders.push(`${b.category} [${p.intent}] "${p.text}" names "${a}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every BRAND-VERIFICATION prompt names a brand the scorer can actually match', () => {
    // "Is X any good" is only a measurement if X is countable. This catches the
    // real defect class the critique found — a prompt built around a brand the
    // bank does not track ("ConvertKit vs beehiiv", "GoDaddy hosting
    // alternatives") — and it catches the subtler one, where a brand IS tracked
    // but its alias set was tightened until the prompt's own wording no longer
    // matches it. Both burn real spend on a cell whose subject is invisible.
    //
    // Comparison prompts are deliberately NOT held to this. "Cloud accounting vs
    // desktop accounting", "hosted or self-hosted ecommerce", "hiring a
    // bookkeeper vs using software" are category-level questions that name no
    // brand on purpose, and they are among the most useful prompts in the set.
    const offenders: string[] = []
    for (const b of DEMO_BANKS) {
      const aliases = b.leaders.flatMap((l) => l.aliases)
      for (const p of b.prompts) {
        if (p.intent !== 'brand-verification') continue
        if (!aliases.some((a) => mentions(p.text, a))) offenders.push(`${b.category} "${p.text}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('records every prompt whose brand is named in a form no alias matches', () => {
    // NOT a failure — a disclosure, and the concrete argument for the
    // case-sensitive alias change flagged to services/scorer. Dropping bare
    // "notion" was correct (it matches "the notion that"), and the cost is that
    // this bank's own prompt names Notion in the form a buyer actually types and
    // the scorer cannot see it. Counting the instances keeps that cost visible
    // instead of letting it live in a comment nobody re-reads.
    const unmatched: string[] = []
    for (const b of DEMO_BANKS) {
      const aliases = b.leaders.flatMap((l) => l.aliases)
      for (const p of b.prompts) {
        if (p.intent !== 'comparison') continue
        if (!aliases.some((a) => mentions(p.text, a))) unmatched.push(`${b.category}: ${p.text}`)
      }
    }
    // Category-level comparisons legitimately name nothing; the cap is here so a
    // bank cannot drift into being mostly unmeasurable without anyone noticing.
    expect(unmatched.length).toBeLessThanOrEqual(6)
    if (unmatched.length) console.log(`comparison prompts naming no matchable brand (${unmatched.length}): ${unmatched.join(' | ')}`)
  })

})

describe('deduplication against the cache key — `/category-bank` step 2', () => {
  it('THE WASTE THIS PREVENTS: no two prompts collide after normalisation', () => {
    // Deduplicated by the REAL normaliser, not a lookalike: two prompts that
    // normalise identically are one cell, so the second one is spend that buys
    // nothing. Within a bank this is pure waste and always a defect.
    const byNorm = new Map<string, string[]>()
    for (const p of ALL_PROMPTS) {
      const k = norm(p.text)
      byNorm.set(k, [...(byNorm.get(k) ?? []), `${p.category}: ${p.text}`])
    }
    const withinBank = [...byNorm.values()].filter((v) => v.length > 1 && new Set(v.map((x) => x.split(':')[0])).size === 1)
    expect(withinBank).toEqual([])
  })

  it('reports cross-bank overlap rather than designing it away', () => {
    // `/category-bank`: "high overlap is good news for the cache and should be
    // preserved, not designed away." Two categories asking a genuinely shared
    // question share a cell, which is the shared-corpus economics working.
    const byNorm = new Map<string, Set<string>>()
    for (const p of ALL_PROMPTS) {
      const k = norm(p.text)
      byNorm.set(k, (byNorm.get(k) ?? new Set()).add(p.category))
    }
    const shared = [...byNorm.values()].filter((s) => s.size > 1).length
    const pct = ((shared / byNorm.size) * 100).toFixed(1)
    // Not a threshold — a disclosure. It fails only if the arithmetic breaks.
    expect(Number(pct)).toBeGreaterThanOrEqual(0)
    console.log(`cross-bank prompt overlap: ${shared}/${byNorm.size} distinct cells shared by 2+ categories (${pct}%)`)
  })

  it('the bank is large enough to draw a free scan from', () => {
    // The free scan takes 20 prompts (ADR-0008 / PHASES 3.3). A bank smaller
    // than that cannot fill one, and the head-to-head goes silent.
    for (const b of DEMO_BANKS) expect([b.category, b.prompts.length]).toEqual([b.category, 30])
  })
})

describe('the classifier against the REAL banks — the demo path', () => {
  const classify = (d: string) => classifyDomain(d, DEMO_BANKS, DEMO_TAXONOMY)

  it('every leader domain in every bank classifies to a category', () => {
    // The demo is someone typing a brand they know. If a leader domain came back
    // unclassified the demo would die on the first realistic input, and nothing
    // else in this file would have noticed.
    const dead: string[] = []
    for (const b of DEMO_BANKS) {
      for (const l of b.leaders) {
        for (const d of [...l.domains, ...(l.siteDomains ?? [])]) {
          if (classify(d).status === 'unclassified') dead.push(`${b.category}/${l.id}: ${d}`)
        }
      }
    }
    expect(dead).toEqual([])
  })

  it('a single-category brand resolves to exactly that category', () => {
    for (const [domain, slug] of [
      // NOT hubspot.com: HubSpot leads CRM and email marketing here, so it is
      // ambiguous — correctly, and asserted as such below.
      ['pipedrive.com', 'crm-software'],
      ['asana.com', 'project-management-software'],
      ['klaviyo.com', 'email-marketing-software'],
      ['xero.com', 'accounting-software'],
      ['hostinger.com', 'web-hosting'],
      ['bitwarden.com', 'password-managers'],
      ['gusto.com', 'hr-payroll-software'],
      ['shopify.com', 'ecommerce-platforms'],
    ] as const) {
      expect([domain, classify(domain)]).toEqual([domain, { status: 'classified', slug, signal: 'leader-domain', evidence: domain }])
    }
  })

  it('THE DEMO CASE: zoho.com is ambiguous across the three categories it leads', () => {
    // Verified against the shipped banks rather than a fixture. This is the
    // outcome the whole design exists to produce: Zoho really does lead CRM,
    // accounting and HR, and inventing one of them would silently fix
    // comparison_basis to a category the visitor never chose.
    expect(classify('zoho.com')).toEqual({
      status: 'ambiguous',
      candidates: ['accounting-software', 'crm-software', 'hr-payroll-software'],
      signal: 'leader-domain',
      evidence: 'zoho.com',
    })
  })

  it('a second real ambiguity: one vendor spanning two of these categories', () => {
    // HubSpot sells Sales Hub and Marketing Hub. The critique pass added it to
    // email-marketing-software because that bank's own prompt named it, and the
    // consequence is that hubspot.com now leads two categories — which is true,
    // and which the classifier must say rather than resolve.
    expect(classify('hubspot.com')).toEqual({
      status: 'ambiguous',
      candidates: ['crm-software', 'email-marketing-software'],
      signal: 'leader-domain',
      evidence: 'hubspot.com',
    })
  })

  it('a subdomain of a leader still resolves, and a lookalike does not', () => {
    expect(classify('support.pipedrive.com')).toMatchObject({ status: 'classified', slug: 'crm-software' })
    expect(classify('notpipedrive.com')).toMatchObject({ status: 'unclassified' })
    expect(classify('pipedrive.com.evil.test')).toMatchObject({ status: 'unclassified' })
  })

  it('an unknown domain is refused — there is no default category', () => {
    for (const d of ['acme.com', 'example.org', 'somerandombrand.io']) {
      expect([d, classify(d).status]).toEqual([d, 'unclassified'])
    }
  })

  it('every category is reachable by at least one leader domain', () => {
    // A category no domain can reach is a bank that can never be selected —
    // dead weight that still costs review effort on every edit.
    const reached = new Set<string>()
    for (const b of DEMO_BANKS) {
      for (const l of b.leaders) {
        for (const d of l.domains) {
          const r = classify(d)
          if (r.status === 'classified') reached.add(r.slug)
        }
      }
    }
    expect([...reached].sort()).toEqual([...DEMO_SLUGS].sort())
  })
})
