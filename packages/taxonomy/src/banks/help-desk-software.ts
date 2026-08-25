/**
 * DEMO-SCOPED prompt bank — help desk software. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders.
 */

import type { PromptBank } from '../types.js'

export const HELP_DESK_SOFTWARE: PromptBank = {
  category: 'help-desk-software',
  displayName: 'Help desk software',
  description: 'Software that runs a support inbox, a ticket queue or a live chat widget for a customer-facing team.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. HubSpot Service Hub and Zoho Desk are deliberately EXCLUDED despite leading this category: both sit on apexes already claimed by other banks (hubspot.com, zoho.com), and adding them would make those two domains ambiguous across three categories rather than the two and three they already carry — which changes an existing demo case for no measurement gain. Freshdesk citations land on freshworks.com, an apex shared with Freshsales in crm-software; host-level attribution cannot separate them, so both are lower bounds.',
  leaders: [
    { id: 'zendesk', name: 'Zendesk', aliases: ['zendesk', 'zendesk support', 'zendesk suite'], domains: ['zendesk.com'] },
    { id: 'intercom', name: 'Intercom', aliases: ['intercom'], domains: ['intercom.com'] },
    { id: 'freshdesk', name: 'Freshdesk', aliases: ['freshdesk'], domains: ['freshdesk.com'] },
    { id: 'help-scout', name: 'Help Scout', aliases: ['help scout', 'helpscout'], domains: ['helpscout.com'] },
    { id: 'gorgias', name: 'Gorgias', aliases: ['gorgias'], domains: ['gorgias.com'] },
    { id: 'livechat', name: 'LiveChat', aliases: ['livechat', 'live chat inc'], domains: ['livechat.com'] },
    { id: 'tidio', name: 'Tidio', aliases: ['tidio'], domains: ['tidio.com'] },
    { id: 'crisp', name: 'Crisp', aliases: ['crisp chat', 'crisp.chat'], domains: ['crisp.chat'] },
  ],
  prompts: [
    // discovery — names no tracked brand
    { text: 'What is the best help desk software for a small support team?', intent: 'discovery' },
    { text: 'Which help desk tool works best for an online store handling returns?', intent: 'discovery' },
    { text: 'Best shared inbox software for a team answering customer email', intent: 'discovery' },
    { text: 'Which support tool should a SaaS company use for in-app messaging?', intent: 'discovery' },
    { text: 'Best live chat widget for a small business website', intent: 'discovery' },
    { text: 'Which help desk platforms have a genuinely usable free plan?', intent: 'discovery' },
    { text: 'Best customer support software for a team of three in the UK', intent: 'discovery' },
    { text: 'Which ticketing system is easiest to set up without an IT department?', intent: 'discovery' },
    { text: 'Best help desk software for a company selling into India', intent: 'discovery' },
    { text: 'Which support platform handles WhatsApp and Instagram messages as tickets?', intent: 'discovery' },
    // comparison — may name brands
    { text: 'Zendesk vs Freshdesk for a 10-person support team', intent: 'comparison' },
    { text: 'Intercom vs Zendesk: which is better for a product-led SaaS?', intent: 'comparison' },
    { text: 'Help Scout or Freshdesk for a small team on a tight budget', intent: 'comparison' },
    { text: 'What are the best alternatives to Zendesk for a mid-market company?', intent: 'comparison' },
    { text: 'Gorgias vs Zendesk for an ecommerce brand on Shopify', intent: 'comparison' },
    { text: 'LiveChat vs Tidio for a small retail site', intent: 'comparison' },
    { text: 'Shared inbox versus a full ticketing system: which does a small team need?', intent: 'comparison' },
    { text: 'Is a chatbot or a live agent better for first-line customer questions?', intent: 'comparison' },
    // problem-led — names no tracked brand
    { text: 'Our support inbox is a shared Gmail account and things get missed, what should we move to?', intent: 'problem-led' },
    { text: 'How do we cut first response time without hiring more support staff?', intent: 'problem-led' },
    { text: 'Customers ask the same five questions every day, how do we deflect them?', intent: 'problem-led' },
    { text: 'How do I move years of support history into a new help desk without losing threads?', intent: 'problem-led' },
    { text: 'Our help desk bill jumped when we added agents, what are the cheaper options?', intent: 'problem-led' },
    { text: 'How do we measure whether our customer support is actually getting better?', intent: 'problem-led' },
    { text: 'How do we handle support across three time zones without a night shift?', intent: 'problem-led' },
    // brand-verification — must name a matchable alias
    { text: 'Is Zendesk worth the price for a company with under 1,000 tickets a month?', intent: 'brand-verification' },
    { text: 'Is Intercom too expensive for an early-stage startup?', intent: 'brand-verification' },
    { text: 'Is Help Scout a good fit for a team that only answers email?', intent: 'brand-verification' },
    { text: 'Is Freshdesk reliable enough for a business that depends on support?', intent: 'brand-verification' },
    { text: 'Is Gorgias only useful if you sell on Shopify?', intent: 'brand-verification' },
  ],
}
