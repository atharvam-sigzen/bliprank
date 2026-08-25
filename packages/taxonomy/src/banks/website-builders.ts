/**
 * DEMO-SCOPED prompt bank — website builders. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders.
 */

import type { PromptBank } from '../types.js'

export const WEBSITE_BUILDERS: PromptBank = {
  category: 'website-builders',
  displayName: 'Website builders',
  description: 'Platforms for building and publishing a website or landing page without writing code.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. WordPress is the hardest attribution in this bank and is tracked as WordPress.com (the hosted product) only: wordpress.org is self-hosted software whose citations belong to web-hosting, and host-level matching cannot tell a .com marketing page from a .org docs page when an answer links both. GoDaddy leads web hosting as well as site building; it is tracked in web-hosting and excluded here so godaddy.com does not become ambiguous. Squarespace and Wix both sell domains and hosting, so some citations here are really hosting citations. wix.com is deliberately left AMBIGUOUS between this bank and ecommerce-platforms and is not resolved to either: Wix genuinely leads both, and picking one would be inventing a fact about what the visitor sells. It therefore falls back to the general bank, which names both candidates. Hostinger Website Builder is EXCLUDED for the same reason as GoDaddy: hostinger.com already leads web-hosting, and claiming the apex here would make that domain ambiguous across two categories rather than resolving cleanly to the one it is better known for.',
  leaders: [
    { id: 'wix', name: 'Wix', aliases: ['wix', 'wix website builder', 'wix.com'], domains: ['wix.com'] },
    { id: 'squarespace', name: 'Squarespace', aliases: ['squarespace'], domains: ['squarespace.com'] },
    { id: 'webflow', name: 'Webflow', aliases: ['webflow'], domains: ['webflow.com'] },
    { id: 'wordpress-com', name: 'WordPress.com', aliases: ['wordpress.com', 'wordpress com'], domains: ['wordpress.com'] },
    { id: 'framer', name: 'Framer', aliases: ['framer'], domains: ['framer.com'] },
    { id: 'weebly', name: 'Weebly', aliases: ['weebly'], domains: ['weebly.com'] },
    { id: 'carrd', name: 'Carrd', aliases: ['carrd'], domains: ['carrd.co'] },
    { id: 'durable', name: 'Durable', aliases: ['durable ai', 'durable.co'], domains: ['durable.co'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best website builder for a small business with no developer?', intent: 'discovery' },
    { text: 'Which website builder is best for a photographer showing a portfolio?', intent: 'discovery' },
    { text: 'Best no-code platform for building a marketing site a designer can control', intent: 'discovery' },
    { text: 'Which site builder is best for a restaurant that needs online bookings?', intent: 'discovery' },
    { text: 'Best way to build a one-page site for a personal brand', intent: 'discovery' },
    { text: 'Which website builders let you export the code if you outgrow them?', intent: 'discovery' },
    { text: 'Best website builder for a consultant in the UK on a small budget', intent: 'discovery' },
    { text: 'Which platform should a charity use to build a site volunteers can update?', intent: 'discovery' },
    { text: 'Best site builder for a startup that needs to ship a landing page this week', intent: 'discovery' },
    { text: 'Which website builders are genuinely good for search engine visibility?', intent: 'discovery' },
    // comparison
    { text: 'Wix vs Squarespace for a small business site', intent: 'comparison' },
    { text: 'Webflow vs WordPress.com for a marketing team that wants design control', intent: 'comparison' },
    { text: 'Squarespace or Framer for a design studio portfolio', intent: 'comparison' },
    { text: 'What are the best alternatives to Wix for someone who wants more control?', intent: 'comparison' },
    { text: 'Carrd vs Webflow for a simple one-page product site', intent: 'comparison' },
    { text: 'Weebly vs Wix for a very small shop just getting online', intent: 'comparison' },
    { text: 'Is a hosted site builder or self-hosted WordPress better for a growing business?', intent: 'comparison' },
    { text: 'Hiring a web designer versus using a site builder: which costs less over three years?', intent: 'comparison' },
    // problem-led
    { text: 'Our website takes eight seconds to load, how do we fix that without a rebuild?', intent: 'problem-led' },
    { text: 'How do I move a site to a new platform without losing search rankings?', intent: 'problem-led' },
    { text: 'Our agency built our site and now nobody can edit it, what are the options?', intent: 'problem-led' },
    { text: 'How do I make a site accessible enough to pass an accessibility audit?', intent: 'problem-led' },
    { text: 'Our site looks broken on phones, what is the cheapest way to fix it?', intent: 'problem-led' },
    { text: 'How do we add a blog to a site that was built as brochure pages?', intent: 'problem-led' },
    { text: 'How do I connect a domain I already own to a new site without downtime?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Wix good enough for a serious business website in 2026?', intent: 'brand-verification' },
    { text: 'Is Squarespace worth the monthly cost compared with cheaper builders?', intent: 'brand-verification' },
    { text: 'Is Webflow too hard to learn for someone who is not a designer?', intent: 'brand-verification' },
    { text: 'Is Framer a real alternative for a production marketing site?', intent: 'brand-verification' },
    { text: 'Is Carrd enough for a landing page that needs to collect emails?', intent: 'brand-verification' },
  ],
}
