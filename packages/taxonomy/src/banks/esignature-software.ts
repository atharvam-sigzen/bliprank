/**
 * DEMO-SCOPED prompt bank — e-signature software. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders.
 */

import type { PromptBank } from '../types.js'

export const ESIGNATURE_SOFTWARE: PromptBank = {
  category: 'esignature-software',
  displayName: 'E-signature software',
  description: 'Tools for sending documents to be signed electronically and keeping an audit trail.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. Zoho Sign is deliberately EXCLUDED despite leading this category: zoho.com is already ambiguous across three banks and a fourth changes an existing demo case for no measurement gain. Dropbox Sign and Adobe Acrobat Sign both sit under apexes whose parent products are far larger than the signing product, so both are claimed on their product subdomains only and both rates are lower bounds.',
  leaders: [
    { id: 'docusign', name: 'DocuSign', aliases: ['docusign', 'docu sign'], domains: ['docusign.com'] },
    { id: 'adobe-acrobat-sign', name: 'Adobe Acrobat Sign', aliases: ['adobe acrobat sign', 'adobe sign'], domains: ['acrobat.adobe.com'] },
    { id: 'dropbox-sign', name: 'Dropbox Sign', aliases: ['dropbox sign', 'hellosign'], domains: ['sign.dropbox.com'] },
    { id: 'pandadoc', name: 'PandaDoc', aliases: ['pandadoc', 'panda doc'], domains: ['pandadoc.com'] },
    { id: 'signnow', name: 'SignNow', aliases: ['signnow', 'sign now'], domains: ['signnow.com'] },
    { id: 'yousign', name: 'Yousign', aliases: ['yousign'], domains: ['yousign.com'] },
    { id: 'signaturely', name: 'Signaturely', aliases: ['signaturely'], domains: ['signaturely.com'] },
    { id: 'eversign', name: 'eversign', aliases: ['eversign'], domains: ['eversign.com'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best e-signature tool for a small business?', intent: 'discovery' },
    { text: 'Which electronic signature platform is best for a law firm?', intent: 'discovery' },
    { text: 'Best way to get contracts signed electronically without a monthly subscription', intent: 'discovery' },
    { text: 'Which e-signature service is best for a recruitment agency sending offer letters?', intent: 'discovery' },
    { text: 'Best electronic signature tool that is valid under EU eIDAS rules', intent: 'discovery' },
    { text: 'Which e-signature platforms have a usable free tier?', intent: 'discovery' },
    { text: 'Best signing tool for a company that sends fewer than ten documents a month', intent: 'discovery' },
    { text: 'Which electronic signature software integrates with a sales pipeline?', intent: 'discovery' },
    { text: 'Best e-signature option for a business operating in India', intent: 'discovery' },
    { text: 'Which signing platforms keep a proper audit trail for disputes?', intent: 'discovery' },
    // comparison
    { text: 'DocuSign vs Adobe Acrobat Sign for a mid-sized company', intent: 'comparison' },
    { text: 'PandaDoc or DocuSign for a sales team that also builds proposals', intent: 'comparison' },
    { text: 'Dropbox Sign vs SignNow for a small team on a budget', intent: 'comparison' },
    { text: 'What are the best cheaper alternatives to DocuSign?', intent: 'comparison' },
    { text: 'Yousign vs DocuSign for a company that needs EU data residency', intent: 'comparison' },
    { text: 'Signaturely vs eversign for a freelancer signing a few contracts a month', intent: 'comparison' },
    { text: 'Is a standalone signing tool or a built-in one in your CRM better for sales contracts?', intent: 'comparison' },
    { text: 'Simple electronic signatures versus qualified digital signatures: which does a business need?', intent: 'comparison' },
    // problem-led
    { text: 'Our contracts take two weeks to get signed, how do we speed that up?', intent: 'problem-led' },
    { text: 'How do we prove a signature was genuine if a client later disputes it?', intent: 'problem-led' },
    { text: 'Our signing tool charges per envelope and the bill has grown, what are the options?', intent: 'problem-led' },
    { text: 'How do we collect signatures from clients who only use a phone?', intent: 'problem-led' },
    { text: 'How do we store signed documents so they are findable three years later?', intent: 'problem-led' },
    { text: 'Are scanned signatures on a PDF legally enough, or do we need a proper platform?', intent: 'problem-led' },
    { text: 'How do we send the same contract to 200 people without doing it one at a time?', intent: 'problem-led' },
    // brand-verification
    { text: 'Is DocuSign worth the price for a company signing 20 contracts a month?', intent: 'brand-verification' },
    { text: 'Is PandaDoc better than a standalone signing tool for sales proposals?', intent: 'brand-verification' },
    { text: 'Is Dropbox Sign a genuine replacement for HelloSign?', intent: 'brand-verification' },
    { text: 'Is SignNow reliable enough for legally binding agreements?', intent: 'brand-verification' },
    { text: 'Is Adobe Acrobat Sign only worth it if you already pay for Acrobat?', intent: 'brand-verification' },
  ],
}
