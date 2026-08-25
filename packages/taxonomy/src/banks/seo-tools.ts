/**
 * DEMO-SCOPED prompt bank — SEO tools. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders.
 */

import type { PromptBank } from '../types.js'

export const SEO_TOOLS: PromptBank = {
  category: 'seo-tools',
  displayName: 'SEO tools',
  description: 'Tools for keyword research, backlink analysis, technical audits and rank tracking.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. This is the category BlipRank itself is adjacent to, and the bias runs the other way from the usual one: Semrush and Ahrefs publish enormous content libraries, so they are cited in answers about subjects far outside their products and their rates here are an UPPER BOUND on genuine recommendation. Moz is tracked through two-word aliases only because a bare "moz" appears inside Mozilla and Mozscape in prose the scorer would otherwise count.',
  leaders: [
    { id: 'semrush', name: 'Semrush', aliases: ['semrush', 'sem rush'], domains: ['semrush.com'] },
    { id: 'ahrefs', name: 'Ahrefs', aliases: ['ahrefs'], domains: ['ahrefs.com'] },
    { id: 'moz', name: 'Moz', aliases: ['moz pro', 'moz.com'], domains: ['moz.com'] },
    { id: 'screaming-frog', name: 'Screaming Frog', aliases: ['screaming frog'], domains: ['screamingfrog.co.uk'] },
    { id: 'sitebulb', name: 'Sitebulb', aliases: ['sitebulb'], domains: ['sitebulb.com'] },
    { id: 'ubersuggest', name: 'Ubersuggest', aliases: ['ubersuggest'], domains: ['neilpatel.com'] },
    { id: 'serpstat', name: 'Serpstat', aliases: ['serpstat'], domains: ['serpstat.com'] },
    { id: 'se-ranking', name: 'SE Ranking', aliases: ['se ranking', 'seranking'], domains: ['seranking.com'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best SEO tool for a small business doing its own marketing?', intent: 'discovery' },
    { text: 'Which SEO platform is best for an agency managing 20 client sites?', intent: 'discovery' },
    { text: 'Best keyword research tool for someone starting a blog', intent: 'discovery' },
    { text: 'Which tool is best for finding technical problems on a large site?', intent: 'discovery' },
    { text: 'Best backlink analysis tool for a competitive niche', intent: 'discovery' },
    { text: 'Which SEO tools offer a free plan worth using?', intent: 'discovery' },
    { text: 'Best rank tracking tool for a company selling in several countries', intent: 'discovery' },
    { text: 'Which SEO tool should an ecommerce store use to find product page issues?', intent: 'discovery' },
    { text: 'Best tool for tracking whether a site appears in AI generated answers', intent: 'discovery' },
    { text: 'Which SEO software is easiest for a marketer with no technical background?', intent: 'discovery' },
    // comparison
    { text: 'Semrush vs Ahrefs for a small in-house marketing team', intent: 'comparison' },
    { text: 'Ahrefs or Moz Pro for backlink research', intent: 'comparison' },
    { text: 'Screaming Frog vs Sitebulb for a technical site audit', intent: 'comparison' },
    { text: 'What are the best cheaper alternatives to Semrush?', intent: 'comparison' },
    { text: 'Ubersuggest vs Serpstat for a solo founder on a budget', intent: 'comparison' },
    { text: 'SE Ranking vs Semrush for an agency reporting to clients', intent: 'comparison' },
    { text: 'Is a crawler or an all-in-one suite more useful for a 500-page site?', intent: 'comparison' },
    { text: 'Paying an SEO consultant versus buying an SEO tool: which for a small company?', intent: 'comparison' },
    // problem-led
    { text: 'Our organic traffic dropped 40% after a core update, how do we diagnose it?', intent: 'problem-led' },
    { text: 'How do we find out why our pages are indexed but not ranking?', intent: 'problem-led' },
    { text: 'Our site has thousands of duplicate URLs from filters, how do we fix that?', intent: 'problem-led' },
    { text: 'How do I audit a competitor to work out why they outrank us?', intent: 'problem-led' },
    { text: 'We are cited in AI answers but get no clicks, what should we measure instead?', intent: 'problem-led' },
    { text: 'How do we clean up a toxic backlink profile inherited from an old agency?', intent: 'problem-led' },
    { text: 'Our SEO tool subscription costs more than our ad budget, what are the options?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Semrush worth the subscription for a small business?', intent: 'brand-verification' },
    { text: 'Is Ahrefs still the best for backlink data?', intent: 'brand-verification' },
    { text: 'Is Screaming Frog difficult to use without technical SEO experience?', intent: 'brand-verification' },
    { text: 'Is Ubersuggest accurate enough to base decisions on?', intent: 'brand-verification' },
    { text: 'Is Moz Pro still competitive with the newer SEO suites?', intent: 'brand-verification' },
  ],
}
