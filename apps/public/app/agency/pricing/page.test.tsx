import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The identity strip is stubbed out. It is a stateful client component tested in
// full by `components/chrome.test.tsx`, and nothing asserted below is about it -
// rendering it here would only couple this file's result to a component this
// page does not own.
vi.mock('@/components/chrome', () => ({ ProductBar: () => null }))

import AgencyPricing from './page'
import { AGENCY_TIERS, FEATURED_ID, agencyMaths, tierById } from '@/lib/agency-pricing'
import { NO_SCHEDULER_NOTE } from '@/lib/planned'

/**
 * THE AGENCY PRICING PAGE, RENDERED.
 *
 * `agency-pricing.test.ts` guards the arithmetic. This file guards the three
 * things the arithmetic cannot see: that the page states no quantity it has no
 * population for, that it discloses the gap its monthly price implies, and that
 * the three-tier comparison is actually addressable by a screen reader.
 *
 * Rendered rather than source-scanned, for the same reason `chrome.test.tsx`
 * is: the assertion is about what reaches the page, and a regex over JSX cannot
 * tell a rendered string from one inside a comment explaining why it was
 * removed - which is exactly the shape of the first case below.
 */
const html = renderToStaticMarkup(<AgencyPricing />)

describe('the page states no number it cannot support', () => {
  /**
   * "Most chosen" was a popularity claim on plans nobody has ever been able to
   * choose. There is no checkout, no agency account and no billing anywhere in
   * apps/public, so the count behind it is zero for every tier, and the page
   * says so itself three sections later. It was the one invented figure on an
   * otherwise fully derived page, and it sat in the largest badge on it.
   */
  it('makes no claim about what buyers have chosen', () => {
    expect(html).not.toMatch(/most chosen/i)
    expect(html).not.toMatch(/most popular/i)
    expect(html).not.toMatch(/\bbest[- ]sell/i)
  })

  it('flags the featured tier with a fact about this page instead', () => {
    expect(html).toContain('<span class="tier__flag">Worked below</span>')
    // ...and the thing it points at exists: the featured tier is the one the
    // pool section is worked through with, by name.
    expect(html).toContain(`${tierById(FEATURED_ID).name}, worked`)
  })

  it('flags exactly one tier, and it is the featured one', () => {
    expect(html.match(/tier__flag/g)).toHaveLength(1)
    const featured = html.indexOf('tier--featured')
    expect(featured).toBeGreaterThan(-1)
    // The flag is inside the featured panel: after its opening tag, and before
    // the next panel starts.
    const flag = html.indexOf('tier__flag')
    expect(flag).toBeGreaterThan(featured)
    expect(html.slice(featured, flag)).not.toContain('class="card tier')
  })
})

describe('a monthly price discloses that nothing recurs yet', () => {
  /**
   * A price per month is the strongest implication of recurring collection a
   * page can make, and it was the only implication on this page left out of
   * "What is not on this page", which enumerated checkout, payment provider,
   * agency accounts and every cap.
   */
  it('says the scheduler does not exist', () => {
    expect(html).toContain('no scheduler exists')
    expect(html).toMatch(/[Rr]ecurring collection is not built/)
    expect(html).toContain('a cycle runs only when a person starts one')
  })

  /**
   * The wording is the page's own, because NO_SCHEDULER_NOTE is written for
   * surfaces that DISPLAY cycles ("these cycles were not collected on a
   * schedule", "the interval maths shown here") and this page displays neither.
   * Rendering it verbatim would have stated two things that are not true of
   * this page in order to keep one sentence identical. The load-bearing clause
   * is pinned against the constant instead, so the two surfaces cannot drift on
   * the part that carries the disclosure.
   */
  it('uses the same load-bearing clause as the shared note', () => {
    for (const clause of ['no scheduler exists', 'not built']) {
      expect(NO_SCHEDULER_NOTE.toLowerCase()).toContain(clause)
      expect(html.toLowerCase()).toContain(clause)
    }
  })

  it('still says the cadence is bought, not running', () => {
    expect(html).toContain('not something running now')
  })
})

describe('the three, actually side by side', () => {
  /**
   * This was ten middle-dot-joined strings in a two-column `dl`. NVDA and JAWS
   * at default punctuation level announce U+00B7 as nothing, so "$199 · $499 ·
   * $999" was read as one run of three figures with nothing binding any of them
   * to a tier except a sentence emitted ten rows earlier.
   */
  it('joins no row of figures into one unattributed string', () => {
    expect(html).not.toContain('·')
    expect(html).not.toContain('&#xB7;')
    // The order sentence the middle dots needed goes with them.
    expect(html).not.toMatch(/Order in every row/)
  })

  it('gives every tier a column header and every metric a row header', () => {
    expect(html).toContain('<div class="table-wrap">')
    for (const t of AGENCY_TIERS) {
      expect(html).toContain(`<th scope="col">${t.name.replace('Agency ', '')}</th>`)
    }
    for (const label of ['Price a month', 'Domain ceiling', 'Pooled prompts', 'Cost per pooled prompt']) {
      expect(html).toContain(`<th scope="row">${label}</th>`)
    }
  })

  it('puts each tier figure in its own cell, in the mono the figures use', () => {
    for (const t of AGENCY_TIERS) {
      const m = agencyMaths(t)
      for (const cell of [`$${t.usdPerMonth}`, `${t.domains}`, `${t.pooledPrompts}`, m.promptsPerDomainLabel, `$${m.usdPerPrompt}`]) {
        expect(html).toContain(`<td class="num">${cell}</td>`)
      }
    }
  })
})
