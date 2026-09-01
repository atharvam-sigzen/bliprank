import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEMO_BANKS, FALLBACK_SLUG } from '@bliprank/taxonomy'
import {
  GENERATED_DISCOVERY,
  GENERATED_PROBLEM_LED,
  allBanks,
  readCategoryRecord,
  readGeneratedBanks,
  recordCategory,
  namesTrackedBrand,
  rejectionReason,
  resolveCategory,
  trackedBrands,
  slugify,
  type GeneratedBank,
} from './resolve-category.js'
import type { FetchSiteResult } from './fetch-site.js'
import { authorBank, type GenerateInput } from './bank-author.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-resolve-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const page = (title: string, description = '', headings = '', body = ''): FetchSiteResult => ({
  ok: true,
  html: `<title>${title}</title><meta name="description" content="${description}"><h1>${headings}</h1><body>${body}</body>`,
  finalUrl: 'https://example.com/',
  bytes: 100,
  truncated: false,
})

const unreachable: FetchSiteResult = { ok: false, reason: 'unreachable', message: 'timed out' }

const AUTHOR = {
  provider: 'openai-compatible',
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  timeoutMs: 1_000,
} as const

const goodBank = (name = 'Gaming peripherals'): GeneratedBank => ({
  model: AUTHOR.model,
  displayName: name,
  description: 'Keyboards, mice and headsets built for gaming.',
  prompts: [
    ...Array.from({ length: GENERATED_DISCOVERY }, (_, i) => ({ text: `Best gaming keyboard for a small desk, option ${i}`, intent: 'discovery' as const })),
    ...Array.from({ length: GENERATED_PROBLEM_LED }, (_, i) => ({ text: `My wrists ache after long sessions, what helps, case ${i}`, intent: 'problem-led' as const })),
  ],
})

const neverFetch = async (): Promise<FetchSiteResult> => {
  throw new Error('the homepage must not be fetched on this path')
}
const neverGenerate = async (): Promise<GeneratedBank | null> => {
  throw new Error('a bank must not be authored on this path')
}

describe('the free signals still come first, and cost nothing', () => {
  it('a tracked leader domain resolves without touching the network', async () => {
    const r = await resolveCategory('pipedrive.com', { dataDir: dir, fetchSite: neverFetch, generate: neverGenerate })
    expect(r.record.source).toBe('leader-domain')
    expect(r.bank.category).toBe('crm-software')
    expect(r.fallback).toBeUndefined()
  })

  it('a category keyword in the host resolves without touching the network', async () => {
    const r = await resolveCategory('my-crm.io', { dataDir: dir, fetchSite: neverFetch, generate: neverGenerate })
    expect(r.record.source).toBe('domain-token')
    expect(r.bank.category).toBe('crm-software')
  })

  it('an ambiguous domain stays ambiguous — the homepage does not get to break the tie', async () => {
    // zoho.com genuinely leads three of these categories. That is information,
    // and page content would resolve it by whichever product the homepage
    // happens to feature this quarter.
    const r = await resolveCategory('zoho.com', { dataDir: dir, fetchSite: neverFetch, generate: neverGenerate })
    expect(r.bank.category).toBe(FALLBACK_SLUG)
    expect(r.fallback?.reason).toBe('ambiguous')
    expect(r.fallback!.candidates.length).toBeGreaterThan(1)
  })
})

describe('the site-content signal places domains the host string cannot', () => {
  it('classifies from the homepage', async () => {
    const r = await resolveCategory('acme-labs.com', {
      dataDir: dir,
      generate: neverGenerate,
      fetchSite: async () =>
        page(
          'Acme — a simple CRM',
          'Track every deal in one sales pipeline',
          'Lead management for small teams',
          'Our customer relationship management tool keeps your sales team in one place.',
        ),
    })
    expect(r.record.source).toBe('site-content')
    expect(r.bank.category).toBe('crm-software')
    // It is a REAL bank with real competitors, so the head-to-head works.
    expect(r.bank.leaders.length).toBeGreaterThan(0)
  })

  it('falls back honestly, and says why, when the homepage cannot be read', async () => {
    const r = await resolveCategory('acme-labs.com', { dataDir: dir, generate: neverGenerate, fetchSite: async () => unreachable })
    expect(r.bank.category).toBe(FALLBACK_SLUG)
    expect(r.fallback?.detail).toContain('timed out')
  })

  it('falls back rather than authoring when no key is configured', async () => {
    // The behaviour that shipped before authoring existed. Absent key must
    // degrade, never break.
    const r = await resolveCategory('acme-labs.com', {
      dataDir: dir,
      fetchSite: async () => page('Acme', 'We do things', 'Things', 'Welcome to our website.'),
    })
    expect(r.bank.category).toBe(FALLBACK_SLUG)
    expect(r.record.generated).toBe(false)
  })
})

describe('⚠️ THE STABILITY GUARANTEE: a category is decided once and never silently changes', () => {
  it('the second resolve reads the record and does not fetch anything', async () => {
    let fetches = 0
    const deps = {
      dataDir: dir,
      generate: neverGenerate,
      fetchSite: async () => {
        fetches += 1
        return page('A simple CRM', 'sales pipeline', 'lead management', 'crm for teams')
      },
    }
    const first = await resolveCategory('acme-labs.com', deps)
    expect(fetches).toBe(1)
    expect(first.record.source).toBe('site-content')

    const second = await resolveCategory('acme-labs.com', deps)
    expect(fetches).toBe(1)
    expect(second.record.source).toBe('site-content')
    expect(second.bank.category).toBe(first.bank.category)
  })

  it('a site that relaunches into a different market keeps its original category', async () => {
    // The whole point. A homepage rewritten on Tuesday must not turn every
    // number collected before Tuesday into a measurement of something else.
    const crm = page('A simple CRM', 'sales pipeline', 'lead management', 'crm')
    const helpdesk = page('Help desk software', 'support tickets', 'shared inbox', 'help desk')

    const before = await resolveCategory('acme-labs.com', { dataDir: dir, generate: neverGenerate, fetchSite: async () => crm })
    expect(before.bank.category).toBe('crm-software')

    const after = await resolveCategory('acme-labs.com', { dataDir: dir, generate: neverGenerate, fetchSite: async () => helpdesk })
    expect(after.bank.category).toBe('crm-software')
  })

  it('recordCategory refuses to overwrite — the refusal IS the guarantee', () => {
    const first = recordCategory(dir, { host: 'x.com', slug: 'crm-software', source: 'site-content', evidence: 'a', decidedAt: '2026-01-01', generated: false })
    const second = recordCategory(dir, { host: 'x.com', slug: 'seo-tools', source: 'site-content', evidence: 'b', decidedAt: '2026-06-01', generated: false })
    expect(second).toEqual(first)
    expect(readCategoryRecord(dir, 'x.com')!.slug).toBe('crm-software')
  })

  it('a corrupt record store re-derives rather than trusting it or throwing', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'domain-categories.json'), '{ not json')
    const r = await resolveCategory('pipedrive.com', { dataDir: dir, fetchSite: neverFetch, generate: neverGenerate })
    expect(r.bank.category).toBe('crm-software')
  })

  it('a record whose category has no bank falls back for the scan WITHOUT rewriting the record', async () => {
    recordCategory(dir, { host: 'x.com', slug: 'gone-category', source: 'generated', evidence: '', decidedAt: '2026-01-01', generated: true })
    const r = await resolveCategory('x.com', { dataDir: dir, fetchSite: neverFetch, generate: neverGenerate })
    expect(r.bank.category).toBe(FALLBACK_SLUG)
    // Still on record as gone-category: a domain with history does not quietly
    // acquire a different one because a file went missing.
    expect(readCategoryRecord(dir, 'x.com')!.slug).toBe('gone-category')
  })
})

describe('⚠️ AN AUTHORED CATEGORY NEVER HAS COMPETITORS', () => {
  const authoring = (bank: GeneratedBank = goodBank()) => ({
    dataDir: dir,
    author: AUTHOR,
    fetchSite: async () => page('Acme Gaming', 'Keyboards and mice', 'Built for play', 'We make gaming keyboards.'),
    generate: async () => bank,
  })

  it('grows the taxonomy, with an empty leader set', async () => {
    const r = await resolveCategory('acmegear.com', authoring())
    expect(r.record.source).toBe('generated')
    expect(r.record.generated).toBe(true)
    expect(r.bank.category).toBe('gaming-peripherals')
    expect(r.bank.leaders).toEqual([])
    expect(r.bank.verified).toBe(false)
    expect(r.bank.prompts).toHaveLength(GENERATED_DISCOVERY + GENERATED_PROBLEM_LED)
  })

  it('persists the bank so a second domain in that market joins it rather than authoring a duplicate', async () => {
    await resolveCategory('acmegear.com', authoring())
    let authored = 0
    const r = await resolveCategory('othergear.com', {
      dataDir: dir,
      author: AUTHOR,
      fetchSite: async () => page('Other Gear', 'Keyboards and mice', 'Built for play', 'We make gaming keyboards.'),
      generate: async () => {
        authored += 1
        return goodBank()
      },
    })
    // It authored again — the content classifier cannot select a generated
    // category, which carries no content vocabulary — but the SLUG collides, so
    // the existing bank is reused and nothing is overwritten.
    expect(readGeneratedBanks(dir)).toHaveLength(1)
    expect(r.bank.category).toBe('gaming-peripherals')
    expect(authored).toBe(1)
  })

  it('a bank file hand-edited to add leaders is refused on READ, not merely on write', async () => {
    await resolveCategory('acmegear.com', authoring())
    const path = join(dir, 'generated-banks', 'gaming-peripherals.json')
    expect(existsSync(path)).toBe(true)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.bank.leaders = [{ id: 'razer', name: 'Razer', aliases: ['Razer'], domains: ['razer.com'] }]
    writeFileSync(path, JSON.stringify(file))
    // Dropped entirely rather than loaded-and-stripped: a file someone edited to
    // put invented rivals on a chart is not a file to partially trust.
    expect(readGeneratedBanks(dir)).toHaveLength(0)
    expect(allBanks(dir).some((b) => b.category === 'gaming-peripherals')).toBe(false)
  })

  it('END TO END through the real author: a model naming rivals still yields a bank with none', async () => {
    /*
     * The other tests here inject `generate`, so they prove the resolver's half.
     * This one runs the SHIPPING author against a mocked HTTP response, so the
     * whole chain is under test: a free model volunteering `competitors`, the
     * parser that reads three keys, the `leaders: []` the resolver constructs,
     * and the file that is written and read back.
     */
    const reply = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              display_name: 'Gaming peripherals',
              description: 'Keyboards, mice and headsets built for gaming.',
              competitors: ['Razer', 'Logitech'],
              leaders: [{ id: 'razer', name: 'Razer', aliases: ['Razer'], domains: ['razer.com'] }],
              prompts: [
                ...Array.from({ length: GENERATED_DISCOVERY }, (_, i) => ({ text: `Best gaming keyboard, option ${i}`, intent: 'discovery' })),
                ...Array.from({ length: GENERATED_PROBLEM_LED }, (_, i) => ({ text: `My wrists ache, case ${i}`, intent: 'problem-led' })),
              ],
            }),
          },
        },
      ],
    })

    const r = await resolveCategory('acmegear.com', {
      dataDir: dir,
      author: AUTHOR,
      fetchSite: async () => page('Acme Gaming', 'Keyboards and mice', 'Built for play', 'We make gaming keyboards.'),
      // The real author, with only its transport replaced.
      generate: (i: GenerateInput) =>
        authorBank({ ...i, fetchImpl: async () => new Response(reply, { status: 200, headers: { 'content-type': 'application/json' } }) }),
    })

    expect(r.record.source).toBe('generated')
    expect(r.bank.leaders).toEqual([])
    // Nowhere on the stored artefact, not in the bank, not in the note.
    const stored = readFileSync(join(dir, 'generated-banks', 'gaming-peripherals.json'), 'utf8')
    expect(stored).not.toContain('Razer')
    expect(stored).not.toContain('Logitech')
    // And the model that answered is on the record, so a surprising bank is
    // attributable years later.
    expect(r.record.evidence).toContain(AUTHOR.model)
  })

  it('an authoring failure degrades to the fallback, never to a broken scan', async () => {
    const r = await resolveCategory('acmegear.com', {
      ...authoring(),
      generate: async () => {
        throw new Error('429 rate limited')
      },
    })
    expect(r.bank.category).toBe(FALLBACK_SLUG)
    expect(r.fallback?.detail).toContain('429 rate limited')
    expect(r.record.generated).toBe(false)
  })

  it('reuses an existing category when authoring names one, rather than duplicating it', async () => {
    const r = await resolveCategory('acmegear.com', {
      ...authoring({ ...goodBank('CRM software'), displayName: 'CRM software' }),
    })
    expect(r.bank.category).toBe('crm-software')
    expect(readGeneratedBanks(dir)).toHaveLength(0)
    // And it is the reviewed bank, with its real competitors.
    expect(r.bank.leaders.length).toBeGreaterThan(0)
  })
})

describe('⚠️ A GENERATED PROMPT MAY NOT NAME A BRAND WE ALREADY TRACK', () => {
  /*
   * The gap the first live run exposed. `rejectionReason` checked the subject
   * naming ITSELF and nothing else, so a bank authored for one domain could
   * name somebody else's tracked brand and pass every refusal - through the
   * prompt TEXT, which is not where the three `leaders` refusals look.
   */
  const withPrompt = (text: string): GeneratedBank => {
    const base = goodBank()
    return { ...base, prompts: [{ text, intent: 'discovery' as const }, ...base.prompts.slice(1)] }
  }

  it('refuses a deliberately injected competitor name', () => {
    // HubSpot is a leader of crm-software. A prompt naming it guarantees it a
    // mention, and its mention rate is a number this product publishes.
    const refused = rejectionReason(withPrompt('Best gaming keyboard, or should I just use HubSpot?'), 'acmegear.com', DEMO_BANKS)
    expect(refused).toContain('HubSpot')
    expect(refused).toContain('already tracks')
  })

  it('refuses the comparison phrasing a model is most likely to produce', () => {
    const refused = rejectionReason(withPrompt('How does this compare to Salesforce for a small sales team?'), 'acmegear.com', DEMO_BANKS)
    expect(refused).not.toBeNull()
    expect(refused).toContain('Salesforce')
  })

  it('catches a brand tracked in a category unrelated to the one being authored', () => {
    // The point of checking the WHOLE taxonomy rather than the subject's own
    // bank: an authored gaming-peripherals bank has no neighbours, so a
    // per-bank check would have found nothing to compare against.
    const refused = rejectionReason(withPrompt('Which help desk do gaming brands use, is Zendesk any good?'), 'acmegear.com', DEMO_BANKS)
    expect(refused).toContain('Zendesk')
  })

  it('refuses on an ALIAS, not only on the display name', () => {
    // A bank may list `HubSpot` as the name and `HubSpot CRM` as an alias. The
    // matcher takes both, and the refusal says which one it saw.
    const brands = trackedBrands(DEMO_BANKS)
    const withAlias = brands.find((b) => b.aliases.some((a) => a !== b.name))!
    const alias = withAlias.aliases.find((a) => a !== withAlias.name)!
    const hit = namesTrackedBrand(`Is ${alias} worth paying for in 2026?`, brands)
    expect(hit).not.toBeNull()
    expect(hit!.name).toBe(withAlias.name)
  })

  it('PERMITS a market-defining platform that is in no leader table', () => {
    /*
     * The distinction the whole check rests on. ERPNext and Frappe are the
     * platform an ERP-implementation market is defined BY - the way "WordPress
     * hosting" is a real category - and naming one is not naming a rival. They
     * are in no leader table, so nothing refuses them.
     *
     * This is the real bank Nemotron authored for sigzen.com on 2026-09-01.
     */
    const erp: GeneratedBank = {
      model: AUTHOR.model,
      displayName: 'ERP Implementation Services',
      description: 'Consultancies that implement and support ERP systems.',
      prompts: [
        ...Array.from({ length: GENERATED_DISCOVERY }, (_, i) => ({
          text: `Best ERPNext implementation partner for small manufacturing firms, option ${i}`,
          intent: 'discovery' as const,
        })),
        ...Array.from({ length: GENERATED_PROBLEM_LED }, (_, i) => ({
          text: `Our Frappe based records are scattered across paper and Excel, how do we centralise them, case ${i}`,
          intent: 'problem-led' as const,
        })),
      ],
    }
    expect(rejectionReason(erp, 'sigzen.com', DEMO_BANKS)).toBeNull()
  })

  it('uses the scorer\'s whole-token rule, so a longer word is not a mention', () => {
    // `Zoho1` is not `Zoho`, and `#HubSpot_CRM` is a handle. Reusing
    // `findMentions` means the refusal and the measurement share one definition
    // of "this text names that brand" rather than drifting apart.
    const brands = trackedBrands(DEMO_BANKS)
    expect(namesTrackedBrand('Is Xero any good for a small team?', brands)).not.toBeNull()
    expect(namesTrackedBrand('Is Xeroish any good for a small team?', brands)).toBeNull()
    // `Zoho` alone is deliberately NOT an alias anywhere - the taxonomy's own
    // rule is that an alias must be a form a human would write and must not
    // collide, so the banks carry `Zoho Books`, `Zoho CRM` and so on. Pinned
    // here because a later edit adding a bare `Zoho` would silently widen every
    // refusal AND every mention count.
    expect(namesTrackedBrand('Zoho makes several products', brands)).toBeNull()
  })

  it('⚠️ INHERITS FIVE ALIAS COLLISIONS FROM THE TAXONOMY, and this test exists to make them visible', () => {
    /*
     * NOT AN ASSERTION THAT THIS IS CORRECT. It is a pin on behaviour that is
     * wrong upstream, so the wrongness is countable and cannot be rediscovered
     * as a surprise.
     *
     * Five leaders carry a bare single-word alias that is also ordinary English:
     * Wave, Sage, Notion, Asana and Close. `Close` is the worst of them - "our
     * monthly close" is ACCOUNTING vocabulary, in a taxonomy that has an
     * accounting-software category.
     *
     * The taxonomy's own docblock warns about exactly this and names the case it
     * caught: "an alias must be a form a human would write - `monday.com`, never
     * a bare `monday`, which collides with the weekday." These five were missed.
     *
     * ⚠️ THE COST IS NOT PRIMARILY HERE. `findMentions` is what decides
     * `mentioned` in `scoreAnswer`, so a COLLECTED ANSWER containing "a wave of
     * interest" already counts as a mention of Wave, inflating a published
     * mention rate and its interval. This refusal merely inherits the same
     * table. Fixing it means editing leader aliases, which is scoring rule set
     * and human-owned (CLAUDE.md §4) - so it is reported, not quietly changed.
     *
     * The consequence for THIS check is a false refusal, which degrades to the
     * general bucket. Safe direction, real cost.
     */
    const brands = trackedBrands(DEMO_BANKS)
    const collisions = [
      ['we saw a wave of interest from buyers', 'Wave'],
      ['sage advice from an accountant', 'Sage'],
      ['the notion that this is simple', 'Notion'],
      ['an asana pose between meetings', 'Asana'],
      ['how do we speed up our monthly close', 'Close'],
    ] as const
    for (const [prose, brand] of collisions) {
      expect([prose, namesTrackedBrand(prose, brands)?.name]).toEqual([prose, brand])
    }
    // And ordinary prose that does NOT collide stays clean, so the check is not
    // simply matching everything.
    for (const clean of ['how do we keep our team in sync across two offices', 'which tool helps a small business file its taxes']) {
      expect([clean, namesTrackedBrand(clean, brands)]).toEqual([clean, null])
    }
  })

  it('ignores a URL, because the scorer masks them before matching', () => {
    // A prompt is prose; a link inside one is not the brand being asked about,
    // and `normaliseForMatch` blanks URLs so the citation signal is not
    // double-counted. The refusal inherits that for free.
    const brands = trackedBrands(DEMO_BANKS)
    expect(namesTrackedBrand('See https://hubspot.com/crm for context', brands)).toBeNull()
  })

  it('collects every leader once, across every bank', () => {
    const brands = trackedBrands(DEMO_BANKS)
    expect(brands.length).toBeGreaterThan(20)
    expect(new Set(brands.map((b) => b.id)).size).toBe(brands.length)
    // No domains: this matches prose, and `Leader.domains` is narrowed for
    // citation attribution, which a prompt cannot do.
    expect(brands.every((b) => b.domains.length === 0)).toBe(true)
  })

  it('is a no-op when no banks are passed, so the old two-argument call still means something', () => {
    expect(rejectionReason(withPrompt('Best keyboard, or should I use HubSpot?'), 'acmegear.com')).toBeNull()
  })

  it('END TO END: an authored bank naming a tracked brand degrades to the bucket', async () => {
    // Not a unit check of the predicate - the whole rung 4, refusing and falling
    // back exactly as it does when the model is unreachable.
    const r = await resolveCategory('acmegear.com', {
      dataDir: dir,
      author: AUTHOR,
      fetchSite: async () => page('Acme Gaming', 'Keyboards and mice', 'Built for play', 'We make gaming keyboards.'),
      generate: async () => withPrompt('Best gaming keyboard, or is HubSpot better?'),
    })
    expect(r.bank.category).toBe(FALLBACK_SLUG)
    expect(r.record.generated).toBe(false)
    expect(r.fallback?.detail).toContain('HubSpot')
    // And nothing was written: a refused bank must not exist on disk.
    expect(readGeneratedBanks(dir)).toHaveLength(0)
  })
})

describe('what an authored bank must satisfy before it exists', () => {
  it('refuses a bank whose prompt names the subject brand', () => {
    // scan.ts PROPERTY 2, enforced at authoring time: a prompt naming the brand
    // guarantees a mention and reports our own phrasing as visibility.
    const bank = goodBank()
    const named = { ...bank, prompts: [{ text: 'Is acmegear any good for FPS players?', intent: 'discovery' as const }, ...bank.prompts.slice(1)] }
    expect(rejectionReason(named, 'acmegear.com')).toContain('names the subject brand')
  })

  it('refuses a short bank rather than running a smaller sample than every other bank', () => {
    const short = { ...goodBank(), prompts: goodBank().prompts.slice(0, 5) }
    expect(rejectionReason(short, 'acmegear.com')).toContain('discovery prompts')
  })

  it('refuses duplicates, empty prompts and over-length prompts', () => {
    const base = goodBank()
    expect(rejectionReason({ ...base, prompts: [base.prompts[0]!, ...base.prompts] }, 'x.com')).toContain('duplicate')
    expect(rejectionReason({ ...base, prompts: [{ text: 'x'.repeat(250), intent: 'discovery' }, ...base.prompts.slice(1)] }, 'x.com')).toContain('over 200')
  })

  it('refuses a bank with no usable category name', () => {
    expect(rejectionReason({ ...goodBank(), displayName: '   ' }, 'x.com')).toContain('no usable category name')
    expect(rejectionReason({ ...goodBank(), displayName: '!!!' }, 'x.com')).toContain('no usable category name')
  })

  it('accepts a well-formed one', () => {
    expect(rejectionReason(goodBank(), 'acmegear.com')).toBeNull()
  })

  it('derives the slug here, never from the model', () => {
    expect(slugify('Gaming Peripherals')).toBe('gaming-peripherals')
    expect(slugify('  Cybersecurity  consulting! ')).toBe('cybersecurity-consulting')
  })
})

/**
 * THE SUBJECT'S OWN NAME, SPACED — the other half of the false zero.
 *
 * `rejectionReason` tested `\bthecosmicbyte\b`, the literal concatenated label.
 * A model reading thecosmicbyte.com's homepage writes "Cosmic Byte", because
 * that is what the homepage says, and a spaced form never matches a
 * concatenated regex. So the guard that exists to stop a prompt naming its own
 * subject would have passed it — guaranteeing the brand a mention inside its
 * own measurement, which is exactly what PROPERTY 2 refuses.
 *
 * One root cause with two victims: `subjectFor` could not FIND the brand and
 * this could not REFUSE it. Both now share `domainBrandForms`.
 */
describe('⚠️ A GENERATED PROMPT MAY NOT NAME THE SUBJECT, HOWEVER IT IS SPACED', () => {
  const withPrompt = (text: string): GeneratedBank => {
    const base = goodBank()
    return { ...base, prompts: [{ text, intent: 'discovery' as const }, ...base.prompts.slice(1)] }
  }

  it('catches the spaced trading name the domain only implies', () => {
    // THE EXACT MISS. 'thecosmicbyte' does not appear; 'Cosmic Byte' does.
    const refused = rejectionReason(withPrompt('best Cosmic Byte gaming headset under 3000'), 'thecosmicbyte.com', DEMO_BANKS)
    expect(refused).toContain('names the subject brand')
  })

  it('catches every spacing of it, because separators are not evidence', () => {
    for (const naming of ['CosmicByte keyboards worth buying', 'is Cosmic-Byte any good for fps', 'thecosmicbyte mouse review']) {
      expect(rejectionReason(withPrompt(naming), 'thecosmicbyte.com', DEMO_BANKS), naming).toContain('names the subject brand')
    }
  })

  it('does NOT refuse a clean prompt that merely shares a word', () => {
    // The bank must not be thrown away for saying "byte" or "cosmic" alone. A
    // refusal costs the visitor their whole category; it has to be earned.
    for (const clean of [
      'best budget mechanical keyboard under 3000 rupees',
      'how many bytes of storage does a gaming keyboard need',
      'cosmic themed rgb lighting for a desk setup',
    ]) {
      expect(rejectionReason(withPrompt(clean), 'thecosmicbyte.com', DEMO_BANKS), clean).toBeNull()
    }
  })
})
