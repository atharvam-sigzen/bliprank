/**
 * DEMO-SCOPED prompt bank — product and web analytics. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders.
 */

import type { PromptBank } from '../types.js'

export const ANALYTICS_SOFTWARE: PromptBank = {
  category: 'analytics-software',
  displayName: 'Product and web analytics',
  description: 'Tools that measure how people use a website or product — visitors, events, funnels and retention.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. Google Analytics is the hardest case: its citations land on paths under google.com and marketingplatform.google.com, and a host-level claim on google.com would credit every unrelated Google citation to it, so attribution is deliberately restricted to marketingplatform.google.com and the rate is a LOWER BOUND. Several leaders here carry English-word names — Amplitude, Plausible, Heap, Fathom — and every one of them is tracked only through a two-word alias for that reason, which makes each of those rates a lower bound as well.',
  leaders: [
    { id: 'google-analytics', name: 'Google Analytics', aliases: ['google analytics', 'ga4'], domains: ['marketingplatform.google.com'] },
    { id: 'mixpanel', name: 'Mixpanel', aliases: ['mixpanel'], domains: ['mixpanel.com'] },
    { id: 'amplitude', name: 'Amplitude', aliases: ['amplitude analytics'], domains: ['amplitude.com'] },
    { id: 'posthog', name: 'PostHog', aliases: ['posthog'], domains: ['posthog.com'] },
    { id: 'plausible', name: 'Plausible', aliases: ['plausible analytics'], domains: ['plausible.io'] },
    { id: 'matomo', name: 'Matomo', aliases: ['matomo'], domains: ['matomo.org'] },
    { id: 'fathom-analytics', name: 'Fathom Analytics', aliases: ['fathom analytics'], domains: ['usefathom.com'] },
    { id: 'heap', name: 'Heap', aliases: ['heap analytics'], domains: ['heap.io'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best web analytics tool for a small business site?', intent: 'discovery' },
    { text: 'Which product analytics tool works best for an early-stage SaaS?', intent: 'discovery' },
    { text: 'Best privacy-friendly analytics that does not need a cookie banner', intent: 'discovery' },
    { text: 'Which analytics platform is best for tracking a signup funnel?', intent: 'discovery' },
    { text: 'Best self-hosted analytics for a company that cannot send data to the US', intent: 'discovery' },
    { text: 'Which analytics tools have a free tier that is actually usable?', intent: 'discovery' },
    { text: 'Best analytics setup for an ecommerce store measuring revenue per channel', intent: 'discovery' },
    { text: 'Which analytics tool should a marketing team pick if nobody writes SQL?', intent: 'discovery' },
    { text: 'Best way to measure retention for a mobile app', intent: 'discovery' },
    { text: 'Which analytics platforms are straightforward to make GDPR compliant?', intent: 'discovery' },
    // comparison
    { text: 'Google Analytics vs Mixpanel for a subscription product', intent: 'comparison' },
    { text: 'Plausible vs Fathom Analytics for a small privacy-conscious site', intent: 'comparison' },
    { text: 'Amplitude or Mixpanel for a product team tracking feature adoption', intent: 'comparison' },
    { text: 'What are the best alternatives to Google Analytics after GA4?', intent: 'comparison' },
    { text: 'PostHog vs Amplitude for a startup that wants session replay too', intent: 'comparison' },
    { text: 'Matomo vs Google Analytics for a company that must self-host', intent: 'comparison' },
    { text: 'Is server-side or client-side event tracking more reliable now?', intent: 'comparison' },
    { text: 'A warehouse-first analytics stack versus an off-the-shelf tool: which for a 20-person company?', intent: 'comparison' },
    // problem-led
    { text: 'Our analytics numbers disagree with our billing system, how do we reconcile them?', intent: 'problem-led' },
    { text: 'Ad blockers are hiding a third of our traffic, what can we do about it?', intent: 'problem-led' },
    { text: 'How do we track conversions properly now that third-party cookies are gone?', intent: 'problem-led' },
    { text: 'Our event names are a mess after two years, how do we clean them up safely?', intent: 'problem-led' },
    { text: 'How do I prove which marketing channel actually drove a signup?', intent: 'problem-led' },
    { text: 'Our analytics bill scales with events and it has got expensive, what are the options?', intent: 'problem-led' },
    { text: 'How do we set up analytics without sending personal data outside the EU?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Google Analytics still the right default for a small site?', intent: 'brand-verification' },
    { text: 'Is Mixpanel worth paying for compared with a free option?', intent: 'brand-verification' },
    { text: 'Is Plausible Analytics accurate enough to replace a full analytics suite?', intent: 'brand-verification' },
    { text: 'Is PostHog too complex for a team of five?', intent: 'brand-verification' },
    { text: 'Is Matomo realistic to self-host without a dedicated engineer?', intent: 'brand-verification' },
  ],
}
