/**
 * DEMO-SCOPED prompt bank — CRM software. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders, which
 * is exactly the case `/category-bank`'s do-not-invent rule covers.
 */

import type { PromptBank } from '../types.js'

export const CRM_SOFTWARE: PromptBank = {
  category: 'crm-software',
  displayName: 'CRM software',
  description: 'Software that sales teams and small businesses use to track leads, deals and customer relationships in one place.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. Host-level citation attribution cannot separate monday CRM from monday work management (project-management-software); both sit on monday.com. Freshdesk/Freshservice/Freshchat citations on freshworks.com are credited to Freshsales; not separable host-side. Zoho marketing pages are zoho.com/crm/... (a path); host-only matching cannot attribute them, so Zoho CRM citations are a lower bound.',
  leaders: [
    { id: 'hubspot', name: 'HubSpot', aliases: ['hubspot', 'hub spot', 'hubspot crm', 'hubspot sales hub', 'hubspot marketing hub'], domains: ['hubspot.com'] },
    { id: 'salesforce', name: 'Salesforce', aliases: ['salesforce', 'salesforce crm', 'sales cloud', 'sfdc'], domains: ['salesforce.com'] },
    { id: 'zoho-crm', name: 'Zoho CRM', aliases: ['zoho crm', 'zoho crm plus'], domains: ['crm.zoho.com'], siteDomains: ['zoho.com'] },
    { id: 'pipedrive', name: 'Pipedrive', aliases: ['pipedrive'], domains: ['pipedrive.com'] },
    { id: 'freshsales', name: 'Freshsales', aliases: ['freshsales', 'freshsales suite'], domains: ['freshworks.com', 'freshsales.io'] },
    { id: 'monday-crm', name: 'monday CRM', aliases: ['monday crm', 'monday sales crm'], domains: ['monday.com'] },
    { id: 'dynamics-365-sales', name: 'Microsoft Dynamics 365 Sales', aliases: ['dynamics 365 sales', 'microsoft dynamics 365 sales', 'dynamics crm'], domains: ['dynamics.microsoft.com'] },
    { id: 'close', name: 'Close', aliases: ['close crm', 'close.com'], domains: ['close.com'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best CRM for a solo founder just starting out?', intent: 'discovery' },
    { text: 'Which CRM works best for a 10-person B2B sales team?', intent: 'discovery' },
    { text: 'Best CRM for a mid-market company that has outgrown spreadsheets', intent: 'discovery' },
    { text: 'What CRM should a marketing agency use to manage client pipelines?', intent: 'discovery' },
    { text: 'Which CRM is best for a small business in the UK?', intent: 'discovery' },
    { text: 'Best CRM for a startup in India with a small sales team', intent: 'discovery' },
    { text: 'Which CRM do large enterprise sales organisations typically use?', intent: 'discovery' },
    { text: 'Which CRMs have a free plan, and what are the limits on it?', intent: 'discovery' },
    { text: 'Which CRM is easiest for a non-technical team to set up on their own?', intent: 'discovery' },
    { text: 'Best CRM for a field sales team in the UAE', intent: 'discovery' },
    // comparison
    { text: 'HubSpot vs Salesforce for a 20-person sales team', intent: 'comparison' },
    { text: 'Pipedrive vs HubSpot: which is better for outbound sales?', intent: 'comparison' },
    { text: 'Zoho CRM or Freshsales for a small business on a tight budget', intent: 'comparison' },
    { text: 'What are the best alternatives to Salesforce for a mid-market company?', intent: 'comparison' },
    { text: 'monday CRM vs Pipedrive for a small agency', intent: 'comparison' },
    { text: 'Alternatives to HubSpot for a team whose contact list is growing quickly', intent: 'comparison' },
    { text: 'Microsoft Dynamics 365 Sales vs Salesforce for a company already on Microsoft 365', intent: 'comparison' },
    { text: 'Close CRM vs Pipedrive for a high-volume inside sales team', intent: 'comparison' },
    // problem-led
    { text: 'How do I move customer data out of spreadsheets into a CRM without losing history?', intent: 'problem-led' },
    { text: 'Our CRM bill has doubled as we added seats, what are the options?', intent: 'problem-led' },
    { text: 'How do I get a sales team to actually log their calls and emails in the CRM?', intent: 'problem-led' },
    { text: 'Our CRM is full of duplicate contacts, how do we clean it up and stop it recurring?', intent: 'problem-led' },
    { text: 'How do I connect a CRM to Gmail and calendar so nothing has to be entered twice?', intent: 'problem-led' },
    { text: 'Our sales forecast in the CRM is never close to what actually closes, how do we fix it?', intent: 'problem-led' },
    { text: 'How do I track leads that come in through WhatsApp in a CRM?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is HubSpot CRM any good for a small team, and where does it fall short?', intent: 'brand-verification' },
    { text: 'What are the downsides of Salesforce for a company under 50 people?', intent: 'brand-verification' },
    { text: 'Is Zoho CRM reliable enough to run a whole sales team on?', intent: 'brand-verification' },
    { text: 'What do users complain about most with Pipedrive?', intent: 'brand-verification' },
    { text: 'What are the strengths and weaknesses of monday CRM for a sales team?', intent: 'brand-verification' },
  ],
}
