import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FALLBACK_SLUG } from '@bliprank/taxonomy'
import {
  GENERATED_DISCOVERY,
  GENERATED_PROBLEM_LED,
  allBanks,
  readCategoryRecord,
  readGeneratedBanks,
  recordCategory,
  rejectionReason,
  resolveCategory,
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
