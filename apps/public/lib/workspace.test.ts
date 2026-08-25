import { afterEach, describe, expect, it } from 'vitest'
import { FALLBACK_SLUG } from '@bliprank/taxonomy'
import {
  ACTIVE_STORAGE_KEY,
  AGENCY_STORAGE_KEY,
  PROMPTS_PER_CYCLE,
  ROLE_STORAGE_KEY,
  addAgencyDomain,
  collectionLine,
  collectionStatus,
  preflightPrompts,
  readActiveDomain,
  readAgencyDomains,
  readRole,
  removeAgencyDomain,
  workspaceFor,
  writeActiveDomain,
  writeRole,
} from './workspace'

/**
 * The whole reason this file exists is R8's negative half: a workspace object is
 * shown BEFORE anything has been measured, so the tests that matter most are the
 * ones asserting `hasData: false` and `lastRunDay: null` for the many domains
 * that have never been collected. pipedrive.com is the single exception in this
 * build and it is pinned here so that a future scan artefact cannot quietly move
 * it without a test turning red.
 */

const ORIGINAL = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function stubStorage(impl: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true, writable: true })
}

/** A localStorage that throws on every access, as a private window does. */
const THROWING = {
  getItem() {
    throw new Error('The operation is insecure.')
  },
  setItem() {
    throw new Error('The operation is insecure.')
  },
}

/** Enough of the Storage surface for these helpers. */
function memoryStorage(seed: Record<string, string> = {}): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

afterEach(() => {
  if (ORIGINAL) Object.defineProperty(globalThis, 'localStorage', ORIGINAL)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('workspaceFor', () => {
  it('pipedrive.com is the one domain with collected data, and it says so exactly', () => {
    const w = workspaceFor('pipedrive.com')
    expect(w).not.toBeNull()
    expect(w!.domain).toBe('pipedrive.com')
    expect(w!.hasData).toBe(true)
    expect(w!.lastRunDay).toBe('2026-08-25')
    expect(w!.confident).toBe(true)
    expect(w!.categorySlug).toBe('crm-software')
    expect(w!.categoryName).toBe('CRM software')
    expect(w!.fallbackReason).toBe('')
    expect(w!.promptCount).toBe(PROMPTS_PER_CYCLE)
    expect(w!.engines).toHaveLength(5)
    expect(w!.answersCollected).toBe(85)
  })

  /*
   * THE ZERO THAT WAS NOT THERE.
   *
   * /agency/add printed "0 answers collected" and "no answer has been collected
   * for it" for pipedrive.com, then /agency drew a rail at n=85 for the same row
   * one click later. A hand-written zero over a real sample is the same defect
   * as a placeholder percentage, inverted — so the count is nullable and every
   * screen has to branch on it. `?? 0` anywhere is the bug written back in.
   */
  it('a collected domain reports its real count, and every uncollected one reports null rather than 0', () => {
    expect(workspaceFor('pipedrive.com')!.answersCollected).toBe(85)

    for (const d of ['zendesk.com', 'zoho.com', 'nike.com', 'acme.com']) {
      const w = workspaceFor(d)!
      expect(w.hasData).toBe(false)
      expect(w.lastRunDay).toBeNull()
      // Not 0. A figure slot fed 0 asserts "we measured, and found nothing".
      expect(w.answersCollected).toBeNull()
      expect(w.answersCollected).not.toBe(0)
    }
  })

  it('the collection sentences agree across every screen that prints them', () => {
    const collected = workspaceFor('pipedrive.com')!
    const queued = workspaceFor('zendesk.com')!

    expect(collectionStatus(collected)).toBe('collected — cycle of 2026-08-25')
    expect(collectionLine(collected)).toBe('85 answers · day 2026-08-25')
    // The one thing neither line may ever contain for a collected domain.
    expect(collectionLine(collected)).not.toMatch(/0 answers/)
    expect(collectionStatus(collected)).not.toMatch(/not collected/)

    expect(collectionStatus(queued)).toBe('queued — first cycle not collected')
    expect(collectionLine(queued)).toBe('no cycle in this record')
    // No digit at all in the uncollected line: the absence is words, not a
    // number in a mono slot.
    expect(collectionLine(queued)).not.toMatch(/\d/)
  })

  it('normalises before matching, so a pasted URL still finds the scan', () => {
    const w = workspaceFor('  https://WWW.Pipedrive.com/pricing?utm=x  ')
    expect(w!.domain).toBe('pipedrive.com')
    expect(w!.hasData).toBe(true)
  })

  it('a real but uncategorised domain gets the fallback bank and NO data', () => {
    const w = workspaceFor('nike.com')
    expect(w).not.toBeNull()
    expect(w!.hasData).toBe(false)
    expect(w!.lastRunDay).toBeNull()
    expect(w!.confident).toBe(false)
    expect(w!.categorySlug).toBe(FALLBACK_SLUG)
    expect(w!.fallbackReason).toMatch(/^Unclassified:/)
    // The fallback bank is a real bank, so a cycle for it is still a full cycle.
    expect(w!.promptCount).toBe(PROMPTS_PER_CYCLE)
  })

  it('a subdomain of the scanned domain is a different workspace with no data of its own', () => {
    const w = workspaceFor('blog.pipedrive.com')
    // Classification still resolves through the leader domain suffix match...
    expect(w!.categorySlug).toBe('crm-software')
    // ...but nothing was ever collected for this host, and it must not inherit.
    expect(w!.hasData).toBe(false)
    expect(w!.lastRunDay).toBeNull()
  })

  it('zoho.com is ambiguous because it leads three categories at once', () => {
    const w = workspaceFor('zoho.com')
    expect(w!.confident).toBe(false)
    expect(w!.categorySlug).toBe(FALLBACK_SLUG)
    expect(w!.fallbackReason).toMatch(/^Ambiguous:/)
    // The competing categories are named, not merely counted: "we could not
    // choose" is only actionable if the reader can see the choices.
    expect(w!.fallbackReason).toContain('CRM software')
    expect(w!.fallbackReason).toContain('Accounting software')
    expect(w!.fallbackReason).toContain('HR and payroll software')
    expect(w!.hasData).toBe(false)
  })

  it('a keyword domain classifies on the token, not on a brand', () => {
    const w = workspaceFor('my-crm.io')
    expect(w!.confident).toBe(true)
    expect(w!.categorySlug).toBe('crm-software')
    expect(w!.hasData).toBe(false)
  })

  it.each(['report.pdf', 'acme', '', '   ', 'notes.txt', 'archive.zip', 'https://', 'a.b'])(
    'refuses %j as a workspace',
    (input) => {
      expect(workspaceFor(input)).toBeNull()
    },
  )

  it('no workspace ever carries a figure that could be read as a result', () => {
    const w = workspaceFor('nike.com')!
    // Every value on the object is either offline-derivable or an explicit
    // absence. A number appearing here later must be one a cycle WOULD run, not
    // one a cycle DID produce.
    expect(Object.values(w).filter((v) => typeof v === 'number')).toEqual([PROMPTS_PER_CYCLE])
  })
})

describe('preflightPrompts', () => {
  it('returns the real prompts from the bank, unprompted intents only', () => {
    const prompts = preflightPrompts('crm-software')
    expect(prompts).toHaveLength(PROMPTS_PER_CYCLE)
    expect(prompts.map((p) => p.intent).every((i) => i === 'discovery' || i === 'problem-led')).toBe(true)
    // A brand-naming prompt would make the mention rate a measurement of the
    // prompt rather than of the market. None may appear.
    expect(prompts.some((p) => /pipedrive|hubspot|salesforce/i.test(p.text))).toBe(false)
    expect(prompts[0]!.text).toBe('What is the best CRM for a solo founder just starting out?')
  })

  it('respects the limit', () => {
    expect(preflightPrompts('crm-software', 3)).toHaveLength(3)
    expect(preflightPrompts('crm-software', 3).map((p) => p.text)).toEqual(preflightPrompts('crm-software').slice(0, 3).map((p) => p.text))
    expect(preflightPrompts('crm-software', 0)).toHaveLength(0)
    expect(preflightPrompts('crm-software', -5)).toHaveLength(0)
    expect(preflightPrompts('crm-software', 999)).toHaveLength(PROMPTS_PER_CYCLE)
  })

  it('the fallback bank has real prompts too, so an unclassified domain gets a real preflight', () => {
    const prompts = preflightPrompts(FALLBACK_SLUG)
    expect(prompts).toHaveLength(PROMPTS_PER_CYCLE)
    expect(prompts.every((p) => p.text.length > 0)).toBe(true)
  })

  it('an unknown slug returns nothing rather than some other category’s prompts', () => {
    expect(preflightPrompts('not-a-category')).toEqual([])
  })
})

describe('storage helpers', () => {
  it('every reader returns its default when localStorage throws', () => {
    stubStorage(THROWING)
    expect(readRole()).toBe('brand')
    expect(readActiveDomain()).toBeNull()
    expect(readAgencyDomains()).toEqual([])
  })

  it('every writer swallows a throwing localStorage', () => {
    stubStorage(THROWING)
    expect(() => writeRole('agency')).not.toThrow()
    expect(() => writeActiveDomain('pipedrive.com')).not.toThrow()
    // The addition still comes back: it works for the session, it just does not
    // persist. A button that appears to do nothing is the worse failure.
    expect(addAgencyDomain('pipedrive.com')).toEqual(['pipedrive.com'])
    expect(removeAgencyDomain('pipedrive.com')).toEqual([])
  })

  it('every helper survives SSR, where there is no localStorage at all', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(readRole()).toBe('brand')
    expect(readActiveDomain()).toBeNull()
    expect(readAgencyDomains()).toEqual([])
    expect(() => writeRole('agency')).not.toThrow()
    expect(() => writeActiveDomain('pipedrive.com')).not.toThrow()
    expect(addAgencyDomain('pipedrive.com')).toEqual(['pipedrive.com'])
  })

  it('round-trips the role, and treats any unrecognised value as brand', () => {
    stubStorage(memoryStorage())
    expect(readRole()).toBe('brand')
    writeRole('agency')
    expect(readRole()).toBe('agency')
    writeRole('brand')
    expect(readRole()).toBe('brand')

    stubStorage(memoryStorage({ [ROLE_STORAGE_KEY]: 'superuser' }))
    expect(readRole()).toBe('brand')
  })

  it('normalises the active domain on both write and read', () => {
    stubStorage(memoryStorage())
    writeActiveDomain('https://WWW.Pipedrive.com/pricing')
    expect(readActiveDomain()).toBe('pipedrive.com')

    // Junk left by an older build or by hand must not become a lookup key.
    stubStorage(memoryStorage({ [ACTIVE_STORAGE_KEY]: 'acme' }))
    expect(readActiveDomain()).toBeNull()
  })

  it('adds, dedupes and removes agency domains', () => {
    stubStorage(memoryStorage())
    expect(addAgencyDomain('pipedrive.com')).toEqual(['pipedrive.com'])
    expect(addAgencyDomain('https://www.Zoho.com/')).toEqual(['pipedrive.com', 'zoho.com'])
    expect(addAgencyDomain('PIPEDRIVE.com')).toEqual(['pipedrive.com', 'zoho.com'])
    expect(addAgencyDomain('report.pdf')).toEqual(['pipedrive.com', 'zoho.com'])
    expect(addAgencyDomain('acme')).toEqual(['pipedrive.com', 'zoho.com'])
    expect(removeAgencyDomain('www.pipedrive.com')).toEqual(['zoho.com'])
    expect(readAgencyDomains()).toEqual(['zoho.com'])
  })

  it('a corrupt stored list reads as empty rather than throwing into a render', () => {
    stubStorage(memoryStorage({ [AGENCY_STORAGE_KEY]: 'not json' }))
    expect(readAgencyDomains()).toEqual([])

    stubStorage(memoryStorage({ [AGENCY_STORAGE_KEY]: '{"domains":[]}' }))
    expect(readAgencyDomains()).toEqual([])

    stubStorage(memoryStorage({ [AGENCY_STORAGE_KEY]: '["pipedrive.com", 42, null, "acme", "WWW.Zoho.com"]' }))
    expect(readAgencyDomains()).toEqual(['pipedrive.com', 'zoho.com'])
  })
})
