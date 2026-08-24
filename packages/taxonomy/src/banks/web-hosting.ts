/**
 * DEMO-SCOPED prompt bank — Web hosting. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders, which
 * is exactly the case `/category-bank`'s do-not-invent rule covers.
 */

import type { PromptBank } from '../types.js'

export const WEB_HOSTING: PromptBank = {
  category: 'web-hosting',
  displayName: 'Web hosting',
  description: 'Providers that host websites and WordPress sites, from cheap shared plans through managed WordPress and cloud hosting for agencies and ecommerce.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected.',
  leaders: [
    { id: 'hostinger', name: 'Hostinger', aliases: ['hostinger'], domains: ['hostinger.com'] },
    { id: 'siteground', name: 'SiteGround', aliases: ['siteground', 'site ground'], domains: ['siteground.com'] },
    { id: 'bluehost', name: 'Bluehost', aliases: ['bluehost', 'blue host'], domains: ['bluehost.com'] },
    { id: 'wp-engine', name: 'WP Engine', aliases: ['wp engine', 'wpengine'], domains: ['wpengine.com'] },
    { id: 'kinsta', name: 'Kinsta', aliases: ['kinsta'], domains: ['kinsta.com'] },
    { id: 'cloudways', name: 'Cloudways', aliases: ['cloudways'], domains: ['cloudways.com'] },
    { id: 'dreamhost', name: 'DreamHost', aliases: ['dreamhost', 'dream host'], domains: ['dreamhost.com'] },
    { id: 'a2-hosting', name: 'A2 Hosting', aliases: ['a2 hosting', 'a2hosting'], domains: ['a2hosting.com'] },
    { id: 'godaddy', name: 'GoDaddy', aliases: ['godaddy', 'go daddy'], domains: ['godaddy.com'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best web hosting for a small business website?', intent: 'discovery' },
    { text: 'Best WordPress hosting for a high traffic ecommerce store', intent: 'discovery' },
    { text: 'Which hosting provider should a solo founder use for a portfolio site?', intent: 'discovery' },
    { text: 'Recommended managed WordPress hosting for a marketing site getting around 100,000 visits a month', intent: 'discovery' },
    { text: 'What hosting do agencies use to manage lots of client WordPress sites?', intent: 'discovery' },
    { text: 'Best web hosting in India for a WooCommerce store', intent: 'discovery' },
    { text: 'Good UK web hosting with servers in London for a local business', intent: 'discovery' },
    { text: 'What should I use to host a WordPress membership site?', intent: 'discovery' },
    { text: 'Enterprise WordPress hosting with an uptime SLA and dedicated support', intent: 'discovery' },
    { text: 'Cheapest reliable web hosting for a personal website', intent: 'discovery' },
    // comparison
    { text: 'Hostinger vs SiteGround for a WordPress site', intent: 'comparison' },
    { text: 'WP Engine vs Kinsta for managed WordPress hosting', intent: 'comparison' },
    { text: 'What are the best alternatives to Bluehost?', intent: 'comparison' },
    { text: 'Cloudways vs Kinsta for an agency hosting client sites', intent: 'comparison' },
    { text: 'DreamHost vs A2 Hosting for a developer running several small sites', intent: 'comparison' },
    { text: 'Shared hosting or managed WordPress hosting for a growing ecommerce brand', intent: 'comparison' },
    { text: 'Cheaper alternatives to WP Engine for a small agency', intent: 'comparison' },
    { text: 'GoDaddy hosting alternatives for a WooCommerce store', intent: 'comparison' },
    // problem-led
    { text: 'My WordPress site takes ages to load, is my hosting the problem?', intent: 'problem-led' },
    { text: 'How do I move a WordPress site to a new host without downtime?', intent: 'problem-led' },
    { text: 'My hosting renewal price has tripled, what are my options?', intent: 'problem-led' },
    { text: 'Should I move my hosting to a server in the UAE or just put a CDN in front of it?', intent: 'problem-led' },
    { text: 'How do I keep WordPress core and plugins updated across twenty client sites without breaking one?', intent: 'problem-led' },
    { text: 'My site was hacked through an out of date plugin, does managed hosting actually prevent that?', intent: 'problem-led' },
    { text: 'I keep hitting CPU limits on shared hosting, what should I upgrade to?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Hostinger any good for a small business website?', intent: 'brand-verification' },
    { text: 'What are the downsides of Bluehost for a site that is starting to get real traffic?', intent: 'brand-verification' },
    { text: 'Is WP Engine worth the price for a single WordPress site?', intent: 'brand-verification' },
    { text: 'How reliable is SiteGround for uptime and support?', intent: 'brand-verification' },
    { text: 'Is Cloudways a good fit for someone who is not a developer?', intent: 'brand-verification' },
  ],
}
