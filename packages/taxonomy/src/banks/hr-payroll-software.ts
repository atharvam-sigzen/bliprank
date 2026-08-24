/**
 * DEMO-SCOPED prompt bank — HR and payroll software. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders, which
 * is exactly the case `/category-bank`'s do-not-invent rule covers.
 */

import type { PromptBank } from '../types.js'

export const HR_PAYROLL_SOFTWARE: PromptBank = {
  category: 'hr-payroll-software',
  displayName: 'HR and payroll software',
  description: 'Platforms that run payroll and handle core HR — onboarding, employee records, benefits, leave and statutory compliance — for small businesses through mid-market and multi-country teams.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. Known false-positive class: bare "gusto" matches "with gusto" and bare "rippling" matches "a rippling effect". Mention rates for those two are UPPER BOUNDS until the scorer supports case-sensitive aliases. Zoho Payroll (payroll.zoho.com) is a separate product and is not tracked here; India statutory prompts are often answered with it rather than Zoho People.',
  leaders: [
    { id: 'gusto', name: 'Gusto', aliases: ['gusto', 'gusto.com', 'gusto payroll', 'gusto hr'], domains: ['gusto.com'] },
    { id: 'rippling', name: 'Rippling', aliases: ['rippling', 'rippling.com', 'rippling hr', 'rippling payroll'], domains: ['rippling.com'] },
    { id: 'deel', name: 'Deel', aliases: ['deel', 'deel.com', 'deel hr', 'deel payroll'], domains: ['deel.com'] },
    { id: 'bamboohr', name: 'BambooHR', aliases: ['bamboohr', 'bamboo hr', 'bamboohr.com'], domains: ['bamboohr.com'] },
    { id: 'justworks', name: 'Justworks', aliases: ['justworks', 'justworks.com', 'justworks payroll'], domains: ['justworks.com'] },
    { id: 'keka', name: 'Keka', aliases: ['keka', 'keka hr', 'keka.com', 'keka hrms'], domains: ['keka.com'] },
    { id: 'greythr', name: 'greytHR', aliases: ['greythr', 'greyt hr', 'greythr.com', 'greytip'], domains: ['greythr.com', 'greytip.com'] },
    { id: 'zoho-people', name: 'Zoho People', aliases: ['zoho people', 'zoho people plus'], domains: ['people.zoho.com'], siteDomains: ['zoho.com'] },
    { id: 'adp', name: 'ADP', aliases: ['adp', 'adp.com', 'adp workforce now', 'adp run', 'adp totalsource'], domains: ['adp.com'] },
  ],
  prompts: [
    // discovery
    { text: 'Best HR and payroll software for a 10-person startup', intent: 'discovery' },
    { text: 'What payroll software should I use when hiring my first employee', intent: 'discovery' },
    { text: 'Best HRMS for a mid-market company with around 400 employees', intent: 'discovery' },
    { text: 'Which HR and payroll system suits an enterprise with 2,000 employees across multiple states', intent: 'discovery' },
    { text: 'Best HR software for a small business in the UK', intent: 'discovery' },
    { text: 'Top payroll software for Indian startups that handles PF, ESI and TDS', intent: 'discovery' },
    { text: 'What HR platform works best for an agency managing both contractors and full-time staff', intent: 'discovery' },
    { text: 'Best HR and onboarding software for a remote-first team spread across time zones', intent: 'discovery' },
    { text: 'Best HR and payroll software for a retail chain with hourly staff and shift rosters', intent: 'discovery' },
    { text: 'Best HR and payroll platform for a company based in the UAE', intent: 'discovery' },
    // comparison
    { text: 'Gusto vs Rippling for a 30-person startup', intent: 'comparison' },
    { text: 'Deel vs Rippling for hiring contractors in other countries', intent: 'comparison' },
    { text: 'BambooHR vs Zoho People for a distributed team', intent: 'comparison' },
    { text: 'Justworks or Gusto for a small business that wants a PEO', intent: 'comparison' },
    { text: 'Keka vs greytHR for an Indian company with 200 employees', intent: 'comparison' },
    { text: 'What are the main alternatives to ADP for mid-sized payroll', intent: 'comparison' },
    { text: 'BambooHR vs Justworks for a US small business', intent: 'comparison' },
    { text: 'Zoho People vs Keka for a growing company in India', intent: 'comparison' },
    // problem-led
    { text: 'How do I run payroll for employees in three different countries without opening entities', intent: 'problem-led' },
    { text: 'My payroll software bills per employee per month and it is getting expensive as we grow', intent: 'problem-led' },
    { text: 'How do I move HR and payroll off spreadsheets without a long implementation', intent: 'problem-led' },
    { text: 'We keep missing statutory PF and TDS filing deadlines, how do we automate that', intent: 'problem-led' },
    { text: 'How do I handle offer letters, onboarding paperwork and e-signatures for remote new hires', intent: 'problem-led' },
    { text: 'Our HR system and our payroll system do not talk to each other and employee data keeps drifting', intent: 'problem-led' },
    { text: 'How do I pay a contractor in India from a UK company', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Gusto any good for a small business', intent: 'brand-verification' },
    { text: 'What are the downsides of Rippling for a company under 50 employees', intent: 'brand-verification' },
    { text: 'Is Deel a good choice for hiring contractors overseas', intent: 'brand-verification' },
    { text: 'What are the main complaints about BambooHR', intent: 'brand-verification' },
    { text: 'Is Keka any good for a company in India', intent: 'brand-verification' },
  ],
}
