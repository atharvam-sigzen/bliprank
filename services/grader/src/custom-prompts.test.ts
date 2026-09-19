import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_CUSTOM_PROMPTS,
  allPendingPromptRequests,
  applyCustomPrompts,
  checkCustomPrompts,
  customPromptsAt,
  filePromptRequest,
  pendingPromptRequest,
  readCustomPromptSet,
  resolvePromptRequest,
} from './custom-prompts.js'
import { recordCategory } from './resolve-category.js'

/**
 * The customer's own prompts (ADR-0016, decision 4): stored, versioned, and
 * held to PROPERTY 2 with the scorer's own matcher. Synthetic store; nothing
 * fetches, nothing spends.
 */

let dir: string
const REASON = 'these are the questions our buyers actually ask'
const GOOD = ['best invoicing tool for a two-person studio', 'which crm works offline on a phone']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-custom-prompts-'))
  recordCategory(dir, { host: 'acme.test', slug: 'crm-software', source: 'site-content', evidence: 'x', decidedAt: '2026-08-01', generated: false, brandName: 'Acme Labs' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PROPERTY 2 holds for the customer’s prompts, with the scorer’s own matcher', () => {
  it('a prompt naming the subject, by domain form or by recorded brand name, is refused and the refusal says why', () => {
    expect(checkCustomPrompts(dir, 'acme.test', ['is acme any good for a small team'], REASON)).toMatchObject({ kind: 'names-brand', refuse: expect.stringContaining('your own brand') })
    expect(checkCustomPrompts(dir, 'acme.test', ['does Acme Labs integrate with slack'], REASON)).toMatchObject({ kind: 'names-brand' })
  })

  it('a prompt naming a tracked brand is refused, naming the brand and the alias that matched', () => {
    const r = checkCustomPrompts(dir, 'acme.test', ['how does this compare to HubSpot'], REASON)
    expect(r).toMatchObject({ kind: 'names-brand', refuse: expect.stringContaining('HubSpot') })
  })

  it('a link, the subject written without its space, and a zero-width-joined brand are all refused', () => {
    expect(checkCustomPrompts(dir, 'acme.test', ['compare against https://hubspot.com/crm for a small team'], REASON)).toMatchObject({ kind: 'names-brand', refuse: expect.stringContaining('link') })
    expect(checkCustomPrompts(dir, 'acme.test', ['see www.hubspot.com before deciding on a crm'], REASON)).toMatchObject({ kind: 'names-brand' })
    expect(checkCustomPrompts(dir, 'acme.test', ['is acmelabs good for a small team'], REASON)).toMatchObject({ kind: 'names-brand' })
    expect(checkCustomPrompts(dir, 'acme.test', ['how does this compare to hub\u200bspot for a team'], REASON)).toMatchObject({ kind: 'names-brand' })
  })

  it('a prompt the curated bank already asks is KEPT (the set replaces the bank, ADR-0016 Amendment 1), and two spellings the cache key calls one question are one prompt', () => {
    expect(checkCustomPrompts(dir, 'acme.test', ['What is the best CRM for a solo founder just starting out?'], REASON)).toMatchObject({ prompts: ['What is the best CRM for a solo founder just starting out?'] })
    expect(checkCustomPrompts(dir, 'acme.test', ['which crm works offline on a phone?', 'which crm works offline on a phone'], REASON)).toMatchObject({ prompts: ['which crm works offline on a phone?'] })
    expect(checkCustomPrompts(dir, 'acme.test', Array.from({ length: 100 }, (_, i) => `question number ${i} about crm tools`), REASON)).toMatchObject({ kind: 'too-many' })
  })

  it('a bare English word that a brand deliberately does not list as an alias is not a brand', () => {
    // `close` (the CRM) lists no bare alias; "close deals" is a sentence about deals.
    expect(checkCustomPrompts(dir, 'acme.test', ['which tool helps a small team close deals faster'], REASON)).toMatchObject({ prompts: ['which tool helps a small team close deals faster'] })
  })
})

describe('bounds and normalisation', () => {
  it('refuses a missing record, a short reason, a short or long prompt, too many prompts; folds whitespace and drops case-insensitive duplicates', () => {
    expect(checkCustomPrompts(dir, 'nobody.test', GOOD, REASON)).toMatchObject({ kind: 'no-record' })
    expect(checkCustomPrompts(dir, 'acme.test', GOOD, 'meh')).toMatchObject({ kind: 'input' })
    expect(checkCustomPrompts(dir, 'acme.test', ['too short'], REASON)).toMatchObject({ kind: 'input' })
    expect(checkCustomPrompts(dir, 'acme.test', ['x'.repeat(201)], REASON)).toMatchObject({ kind: 'input' })
    expect(checkCustomPrompts(dir, 'acme.test', Array.from({ length: MAX_CUSTOM_PROMPTS + 1 }, (_, i) => `a perfectly ordinary question number ${i}`), REASON)).toMatchObject({ kind: 'too-many' })
    expect(checkCustomPrompts(dir, 'acme.test', ['  best   invoicing\ttool for a two-person studio ', 'BEST invoicing tool for a two-person studio'], REASON)).toMatchObject({ prompts: ['best invoicing tool for a two-person studio'] })
    expect(checkCustomPrompts(dir, 'acme.test', 'not a list' as unknown as string[], REASON)).toMatchObject({ kind: 'input' })
  })
})

describe('the set is versioned, and read back at a version', () => {
  it('a first set is version 1, a change is version 2 with the first kept, an identical list is refused, clearing is a version', () => {
    const first = applyCustomPrompts(dir, { host: 'acme.test', prompts: GOOD, reason: REASON, by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    expect(first).toEqual({ host: 'acme.test', version: 1, prompts: GOOD, reason: REASON, by: 'operator', at: '2026-09-03T10:00:00.000Z' })
    expect(applyCustomPrompts(dir, { host: 'acme.test', prompts: [...GOOD], reason: 'same again', by: 'operator' })).toMatchObject({ kind: 'no-change' })
    const second = applyCustomPrompts(dir, { host: 'acme.test', prompts: [GOOD[0]!], reason: 'dropped the second one', by: 'operator' })
    if ('refuse' in second) throw new Error(second.refuse)
    expect(second.version).toBe(2)
    expect(second.superseded).toEqual([first])
    expect(customPromptsAt(dir, 'acme.test', 1)?.prompts).toEqual(GOOD)
    expect(customPromptsAt(dir, 'acme.test', 2)?.prompts).toEqual([GOOD[0]])
    expect(customPromptsAt(dir, 'acme.test', 3)).toBeNull()
    const cleared = applyCustomPrompts(dir, { host: 'acme.test', prompts: [], reason: 'no custom prompts for now', by: 'operator' })
    expect(cleared).toMatchObject({ version: 3, prompts: [] })
    expect(readCustomPromptSet(dir, 'acme.test')?.version).toBe(3)
    expect(applyCustomPrompts(dir, { host: 'nobody-else.test', prompts: [], reason: 'nothing at all', by: 'operator' })).toMatchObject({ kind: 'no-record' })
  })
})

describe('requests', () => {
  it('a request passes the same checks, writes no set, replaces a pending one, and resolves by the request it read', () => {
    expect(filePromptRequest(dir, { host: 'acme.test', prompts: ['how does this compare to HubSpot'], reason: REASON })).toMatchObject({ kind: 'names-brand' })
    expect(filePromptRequest(dir, { host: 'acme.test', prompts: [], reason: 'nothing to ask, really' })).toMatchObject({ kind: 'no-change' })
    const r = filePromptRequest(dir, { host: 'https://www.acme.test/', prompts: GOOD, reason: REASON, at: '2026-09-03T09:00:00.000Z' })
    expect(r).toEqual({ host: 'acme.test', prompts: GOOD, reason: REASON, requestedAt: '2026-09-03T09:00:00.000Z', status: 'pending' })
    expect(readCustomPromptSet(dir, 'acme.test')).toBeNull()
    filePromptRequest(dir, { host: 'acme.test', prompts: [GOOD[1]!], reason: 'changed my mind', at: '2026-09-03T09:05:00.000Z' })
    expect(pendingPromptRequest(dir, 'acme.test')?.prompts).toEqual([GOOD[1]])
    expect(allPendingPromptRequests(dir)).toHaveLength(1)
    expect(resolvePromptRequest(dir, 'acme.test', { status: 'applied', by: 'operator', expectRequestedAt: '2026-09-03T09:00:00.000Z' })).toMatchObject({ refuse: expect.stringContaining('changed since') })
    expect(resolvePromptRequest(dir, 'acme.test', { status: 'declined', by: 'operator', note: 'too vague', expectRequestedAt: '2026-09-03T09:05:00.000Z' })).toMatchObject({ status: 'declined', note: 'too vague' })
    expect(pendingPromptRequest(dir, 'acme.test')).toBeNull()
  })
})
