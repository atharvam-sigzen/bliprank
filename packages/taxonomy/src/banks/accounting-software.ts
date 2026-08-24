/**
 * DEMO-SCOPED prompt bank — Accounting software. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders, which
 * is exactly the case `/category-bank`'s do-not-invent rule covers.
 */

import type { PromptBank } from '../types.js'

export const ACCOUNTING_SOFTWARE: PromptBank = {
  category: 'accounting-software',
  displayName: 'Accounting software',
  description: 'Cloud accounting and bookkeeping tools that freelancers, small businesses and their accountants use to invoice, reconcile bank feeds, run payroll and file tax returns.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. QuickBooks is matched on quickbooks.intuit.com and quickbooks.com; apex intuit.com is deliberately excluded because it collides with Mailchimp (a leader in email-marketing-software).',
  leaders: [
    { id: 'quickbooks', name: 'QuickBooks', aliases: ['quickbooks', 'quickbooks online', 'quickbooks desktop', 'qbo', 'intuit quickbooks'], domains: ['quickbooks.intuit.com', 'quickbooks.com'] },
    { id: 'xero', name: 'Xero', aliases: ['xero', 'xero accounting'], domains: ['xero.com'] },
    { id: 'freshbooks', name: 'FreshBooks', aliases: ['freshbooks', 'fresh books'], domains: ['freshbooks.com'] },
    { id: 'zoho-books', name: 'Zoho Books', aliases: ['zoho books', 'zohobooks'], domains: ['books.zoho.com'], siteDomains: ['zoho.com'] },
    { id: 'wave', name: 'Wave', aliases: ['wave accounting', 'waveapps', 'wave apps', 'wave financial'], domains: ['waveapps.com'] },
    { id: 'sage', name: 'Sage', aliases: ['sage accounting', 'sage business cloud', 'sage 50', 'sage 50cloud'], domains: ['sage.com'] },
    { id: 'tallyprime', name: 'TallyPrime', aliases: ['tallyprime', 'tally prime', 'tally erp', 'tally erp 9', 'tally solutions'], domains: ['tallysolutions.com'] },
    { id: 'freeagent', name: 'FreeAgent', aliases: ['freeagent'], domains: ['freeagent.com'] },
  ],
  prompts: [
    // discovery
    { text: 'Best accounting software for a freelancer working on their own', intent: 'discovery' },
    { text: 'What accounting software should a 10 person agency use?', intent: 'discovery' },
    { text: 'Top bookkeeping software for a small UK limited company', intent: 'discovery' },
    { text: 'Best accounting software for a small business in India that needs GST filing', intent: 'discovery' },
    { text: 'Which accounting software handles inventory well for a small ecommerce store?', intent: 'discovery' },
    { text: 'Good accounting software for a building contractor who needs job costing', intent: 'discovery' },
    { text: 'What is the best free accounting software for a side business?', intent: 'discovery' },
    { text: 'Recommended cloud accounting platform for a mid market manufacturer', intent: 'discovery' },
    { text: 'Best accounting software for a small company in the UAE that files VAT returns', intent: 'discovery' },
    { text: 'What bookkeeping tool should a small nonprofit with two staff use?', intent: 'discovery' },
    // comparison
    { text: 'QuickBooks vs Xero for a small business', intent: 'comparison' },
    { text: 'Xero or Zoho Books for a growing startup?', intent: 'comparison' },
    { text: 'FreshBooks vs Wave Accounting for a freelance consultant', intent: 'comparison' },
    { text: 'Alternatives to QuickBooks for a small business that has outgrown it', intent: 'comparison' },
    { text: 'FreeAgent vs Sage Accounting for a UK limited company', intent: 'comparison' },
    { text: 'TallyPrime vs Zoho Books for a business in India', intent: 'comparison' },
    { text: 'Cloud accounting software vs desktop accounting software for a small firm', intent: 'comparison' },
    { text: 'Hiring a bookkeeper vs using accounting software for a small company', intent: 'comparison' },
    // problem-led
    { text: 'How do I move my bookkeeping off spreadsheets without losing my transaction history?', intent: 'problem-led' },
    { text: 'How do I capture receipts and expense claims without typing them all in at the end of the quarter?', intent: 'problem-led' },
    { text: 'How do I reconcile bank transactions automatically instead of importing CSV files every week?', intent: 'problem-led' },
    { text: 'My accountant uses a different system to mine and the numbers never match', intent: 'problem-led' },
    { text: 'How do I invoice clients in several currencies and still see one clean profit figure?', intent: 'problem-led' },
    { text: 'How do I stop chasing clients for late invoice payments every month?', intent: 'problem-led' },
    { text: 'How do I run payroll for five employees alongside my bookkeeping?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Xero any good for a small business without a bookkeeper?', intent: 'brand-verification' },
    { text: 'What are the downsides of QuickBooks Online for a UK limited company?', intent: 'brand-verification' },
    { text: 'Is Wave Accounting reliable for a freelancer?', intent: 'brand-verification' },
    { text: 'What do people dislike about FreshBooks?', intent: 'brand-verification' },
    { text: 'Is Zoho Books a good fit for a small business in India?', intent: 'brand-verification' },
  ],
}
