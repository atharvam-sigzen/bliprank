/**
 * THE FALLBACK BANK — general business software. ADR-0008.
 *
 * ⚠️ THIS BANK HAS NO LEADERS, AND THAT IS THE DESIGN.
 *
 * It is used when a domain does not resolve to a known category. We therefore do
 * not know what the domain sells, which means we do not know who its competitors
 * are. Filling `leaders` with plausible-looking brands would put a competitor set
 * on screen that nobody measured against anything — precisely what
 * `/category-bank`'s do-not-invent rule forbids, and precisely the failure this
 * product is positioned against.
 *
 * So the scan still runs and still produces a real, interval-bearing mention
 * rate for the domain itself, and the head-to-head says the comparison is
 * unavailable because the category is unknown. A missing chart that explains
 * itself beats a full chart that is fiction.
 *
 * `comparisonBasisFor` embeds `general-business-software@1`, so `compare()` will
 * refuse to rank a number from this bank against one from a real category bank.
 * The refusal is structural rather than remembered — nobody has to police it.
 *
 * WHY THE PROMPT MIX DIFFERS. There are no brand-verification prompts, because
 * a brand-verification prompt has to name a brand the scorer can match and there
 * are no tracked brands here. The unprompted share (10 discovery + 7 problem-led
 * = 17) matches every other bank exactly, so a fallback scan draws the same
 * number of cells as a category scan and costs the same.
 */

import type { PromptBank } from '../types.js'

export const GENERAL_BUSINESS_SOFTWARE: PromptBank = {
  category: 'general-business-software',
  displayName: 'General business software',
  description: 'The fallback used when a domain does not resolve to one of the demo categories.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'THE FALLBACK BANK. No leaders by design: the category is unknown, so the competitor set is unknown, and inventing one would be the exact failure this product is positioned against. A rate from this bank is a real measurement of how often the domain is named in answers to general business-software questions, and it is NOT comparable with a rate from a category bank — comparisonBasisFor carries the slug, so compare() refuses that pairing structurally. No brand-verification prompts, because there is no tracked brand to verify.',
  leaders: [],
  prompts: [
    // discovery — deliberately category-agnostic, the questions a buyer asks
    // before they know what kind of tool they need.
    { text: 'What software should a small business buy first when it starts to grow?', intent: 'discovery' },
    { text: 'Which business tools are worth paying for rather than using a free version?', intent: 'discovery' },
    { text: 'Best software for a ten-person company that has outgrown spreadsheets', intent: 'discovery' },
    { text: 'What tools does a new online business actually need in the first year?', intent: 'discovery' },
    { text: 'Which business software has the best value for a startup in the UK?', intent: 'discovery' },
    { text: 'Best software stack for a small agency serving a handful of clients', intent: 'discovery' },
    { text: 'Which business tools are easiest to adopt for a non-technical team?', intent: 'discovery' },
    { text: 'What software should a business in India choose for GST compliant operations?', intent: 'discovery' },
    { text: 'Which SaaS tools offer meaningful discounts for non-profits?', intent: 'discovery' },
    { text: 'Best business software for a company that needs everything to work offline sometimes', intent: 'discovery' },
    // comparison — category-level, naming nothing, because there is nothing to name
    { text: 'Is an all-in-one business platform better than several specialist tools?', intent: 'comparison' },
    { text: 'Buying software versus building it in-house for a 20-person company', intent: 'comparison' },
    { text: 'Monthly subscription or annual licence: which works out cheaper for a small business?', intent: 'comparison' },
    { text: 'Open source business software versus commercial: what are the real trade-offs?', intent: 'comparison' },
    { text: 'Is it better to pick software your accountant knows or software your team prefers?', intent: 'comparison' },
    { text: 'Hosted SaaS versus self-hosted for a company with data residency requirements', intent: 'comparison' },
    { text: 'Per-seat pricing versus usage-based pricing for a growing team', intent: 'comparison' },
    { text: 'Is it worth paying for a premium support tier on business software?', intent: 'comparison' },
    // problem-led
    { text: 'We pay for eleven SaaS tools and use four properly, how do we cut that down?', intent: 'problem-led' },
    { text: 'How do we choose business software without getting locked in for years?', intent: 'problem-led' },
    { text: 'Our team refuses to use the software we bought, what do we do now?', intent: 'problem-led' },
    { text: 'How do we get our tools to talk to each other without hiring a developer?', intent: 'problem-led' },
    { text: 'Our software costs have doubled as we added people, how do we control that?', intent: 'problem-led' },
    { text: 'How do we move our data out of a tool we want to stop paying for?', intent: 'problem-led' },
    { text: 'How do we work out whether a piece of business software is actually paying for itself?', intent: 'problem-led' },
  ],
}
