/**
 * DEMO-SCOPED prompt bank — Project management software. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders, which
 * is exactly the case `/category-bank`'s do-not-invent rule covers.
 */

import type { PromptBank } from '../types.js'

export const PROJECT_MANAGEMENT_SOFTWARE: PromptBank = {
  category: 'project-management-software',
  displayName: 'Project management software',
  description: 'Tools teams use to plan projects, assign and track tasks, and see who is working on what across boards, timelines and workloads.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. atlassian.com marketing and support citations are unattributable at host level until path-prefix domain matching exists. Notion is matched only via notion.so / notion.com / "notion ai" / "notion workspace": bare "Notion" is a common English noun and cannot be matched safely until the scorer supports case-sensitive aliases. Notion mention rates are a LOWER BOUND -- including this bank\'s own comparison prompt "What are the best alternatives to Notion for managing team projects?", which names Notion in the form a buyer types and the matcher cannot see.',
  leaders: [
    { id: 'asana', name: 'Asana', aliases: ['asana'], domains: ['asana.com'] },
    { id: 'monday-com', name: 'monday.com', aliases: ['monday.com', 'monday work management', 'monday work os'], domains: ['monday.com'] },
    { id: 'clickup', name: 'ClickUp', aliases: ['clickup', 'clickup.com'], domains: ['clickup.com'] },
    { id: 'notion', name: 'Notion', aliases: ['notion.so', 'notion.com', 'notion ai', 'notion workspace'], domains: ['notion.com', 'notion.so'] },
    { id: 'trello', name: 'Trello', aliases: ['trello'], domains: ['trello.com'] },
    { id: 'jira', name: 'Jira', aliases: ['jira', 'jira software', 'atlassian jira'], domains: ['jira.atlassian.com'], siteDomains: ['atlassian.com'] },
    { id: 'basecamp', name: 'Basecamp', aliases: ['basecamp'], domains: ['basecamp.com'] },
    { id: 'wrike', name: 'Wrike', aliases: ['wrike'], domains: ['wrike.com'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best project management software for a small marketing agency?', intent: 'discovery' },
    { text: 'Which work management tool should a solo founder use to keep client projects on track?', intent: 'discovery' },
    { text: 'Best project management software for a remote team of ten people', intent: 'discovery' },
    { text: 'What project management tool works best for a construction company running several sites at once?', intent: 'discovery' },
    { text: 'Which project management platform suits a mid-market company rolling it out across multiple departments?', intent: 'discovery' },
    { text: 'Best free project management software for a non-profit run by a small volunteer team', intent: 'discovery' },
    { text: 'What project management tool do software engineering teams use for sprint planning?', intent: 'discovery' },
    { text: 'Which project management software suits a UK creative studio that bills clients by the hour?', intent: 'discovery' },
    { text: 'What is a good project management tool for a startup in India that needs affordable per-user pricing?', intent: 'discovery' },
    { text: 'Which project management software meets enterprise requirements like SSO, audit logs and data residency?', intent: 'discovery' },
    // comparison
    { text: 'Asana vs monday.com for a 30-person marketing team', intent: 'comparison' },
    { text: 'ClickUp vs Notion for keeping product docs and tasks in one place', intent: 'comparison' },
    { text: 'Trello vs Basecamp for a small team new to project management software', intent: 'comparison' },
    { text: 'Jira or ClickUp when engineering and marketing need to work in the same tool', intent: 'comparison' },
    { text: 'Wrike vs monday.com for planning resource capacity across client projects', intent: 'comparison' },
    { text: 'Basecamp vs Asana for an agency that wants clients inside the same workspace', intent: 'comparison' },
    { text: 'What are the best alternatives to Jira for a small software team?', intent: 'comparison' },
    { text: 'What are the best alternatives to Notion for managing team projects?', intent: 'comparison' },
    // problem-led
    { text: 'How do I stop tracking my team\'s work across spreadsheets and chat messages?', intent: 'problem-led' },
    { text: 'Our project management tool costs too much per seat once contractors are added, what are the options?', intent: 'problem-led' },
    { text: 'How do I get a project management tool adopted by a team that keeps going back to email?', intent: 'problem-led' },
    { text: 'How can I see which projects are at risk without asking every team lead for a status update?', intent: 'problem-led' },
    { text: 'How do I manage client approvals and feedback rounds without losing track of versions?', intent: 'problem-led' },
    { text: 'We run projects across offices in Dubai and London, how do we keep one view of who is working on what?', intent: 'problem-led' },
    { text: 'How do I plan capacity when the same five people are shared across every project?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Asana any good for a five-person team that only needs task tracking?', intent: 'brand-verification' },
    { text: 'What are the downsides of ClickUp for a team that only needs task tracking?', intent: 'brand-verification' },
    { text: 'Is monday.com worth the price for a 20-person company?', intent: 'brand-verification' },
    { text: 'What do teams dislike about Jira?', intent: 'brand-verification' },
    { text: 'What are the limitations of Trello as a team grows?', intent: 'brand-verification' },
  ],
}
