/**
 * DEMO-SCOPED prompt bank — Email marketing software. ADR-0008.
 *
 * ⚠️ Hand-authored, reviewed, and NOT collected. `verified: false` is not a
 * placeholder: no answer has ever been collected against these leaders, which
 * is exactly the case `/category-bank`'s do-not-invent rule covers.
 */

import type { PromptBank } from '../types.js'

export const EMAIL_MARKETING_SOFTWARE: PromptBank = {
  category: 'email-marketing-software',
  displayName: 'Email marketing software',
  description: 'Platforms for sending marketing, newsletter and lifecycle email (and often SMS) to a subscriber or customer list, with automation, segmentation and campaign reporting.',
  locale: 'en-US',
  geo: 'US',
  version: 1,
  verified: false,
  note:
    'Demo-scoped (ADR-0008). Hand-authored, never collected. Bare "Kit" mentions are not counted; Kit is matched only through ConvertKit-era forms and kit.com, so its mention rate is a LOWER BOUND until case-sensitive aliases land.',
  leaders: [
    { id: 'mailchimp', name: 'Mailchimp', aliases: ['mailchimp', 'mail chimp', 'intuit mailchimp'], domains: ['mailchimp.com'] },
    { id: 'klaviyo', name: 'Klaviyo', aliases: ['klaviyo'], domains: ['klaviyo.com'] },
    { id: 'brevo', name: 'Brevo', aliases: ['brevo', 'sendinblue'], domains: ['brevo.com', 'sendinblue.com'] },
    { id: 'kit', name: 'Kit', aliases: ['convertkit', 'convert kit', 'kit.com', 'kit (formerly convertkit)', 'kit, formerly convertkit', 'convertkit (now kit)'], domains: ['kit.com', 'convertkit.com'] },
    { id: 'activecampaign', name: 'ActiveCampaign', aliases: ['activecampaign'], domains: ['activecampaign.com'] },
    { id: 'omnisend', name: 'Omnisend', aliases: ['omnisend'], domains: ['omnisend.com'] },
    { id: 'mailerlite', name: 'MailerLite', aliases: ['mailerlite', 'mailer lite'], domains: ['mailerlite.com'] },
    { id: 'constant-contact', name: 'Constant Contact', aliases: ['constant contact', 'constantcontact'], domains: ['constantcontact.com'] },
    { id: 'getresponse', name: 'GetResponse', aliases: ['getresponse'], domains: ['getresponse.com'] },
    { id: 'hubspot', name: 'HubSpot', aliases: ['hubspot', 'hub spot', 'hubspot crm', 'hubspot sales hub', 'hubspot marketing hub'], domains: ['hubspot.com'] },
  ],
  prompts: [
    // discovery
    { text: 'What is the best email marketing platform for a solo founder sending their first newsletter', intent: 'discovery' },
    { text: 'Which email marketing tool should an ecommerce brand with a 20,000 subscriber list use', intent: 'discovery' },
    { text: 'Best email marketing software for a Shopify store selling in the UK', intent: 'discovery' },
    { text: 'What email platform do marketing agencies use to run campaigns for several clients at once', intent: 'discovery' },
    { text: 'Which email marketing service is best for a B2B SaaS company building lifecycle onboarding flows', intent: 'discovery' },
    { text: 'Best newsletter platform for a writer who wants to charge for paid subscriptions', intent: 'discovery' },
    { text: 'What is the most affordable email marketing software for an early stage startup in India', intent: 'discovery' },
    { text: 'Which email tool works best for a nonprofit run mostly by volunteers', intent: 'discovery' },
    { text: 'Recommend an email marketing platform for an enterprise that needs EU data residency', intent: 'discovery' },
    { text: 'What is the best combined email and SMS marketing platform for a D2C retail brand in the GCC', intent: 'discovery' },
    // comparison
    { text: 'Mailchimp vs Klaviyo for an ecommerce store', intent: 'comparison' },
    { text: 'Klaviyo or Omnisend for a Shopify brand', intent: 'comparison' },
    { text: 'What are the best alternatives to Mailchimp for a small team', intent: 'comparison' },
    { text: 'Brevo vs MailerLite for a small business on a tight budget', intent: 'comparison' },
    { text: 'ActiveCampaign vs GetResponse for marketing automation', intent: 'comparison' },
    { text: 'Kit vs MailerLite for a writer running a paid newsletter', intent: 'comparison' },
    { text: 'What are the cheaper alternatives to Klaviyo for ecommerce automation', intent: 'comparison' },
    { text: 'ActiveCampaign or Brevo for a UK agency running campaigns for multiple clients', intent: 'comparison' },
    // problem-led
    { text: 'How do I segment my list so customers stop getting offers for products they have already bought', intent: 'problem-led' },
    { text: 'How do I stop my marketing emails from landing in the spam folder', intent: 'problem-led' },
    { text: 'How do I set up an abandoned cart email sequence for my online store', intent: 'problem-led' },
    { text: 'My email open rates have dropped sharply, how do I work out what changed', intent: 'problem-led' },
    { text: 'How do I move my subscriber list to a new email platform without losing my automations', intent: 'problem-led' },
    { text: 'How do I keep my email marketing GDPR compliant when most of my subscribers are in Europe', intent: 'problem-led' },
    { text: 'I am paying for contacts who never open anything, how do I clean up my list', intent: 'problem-led' },
    // brand-verification
    { text: 'Is Klaviyo worth the price for a store doing under a thousand orders a month', intent: 'brand-verification' },
    { text: 'What are the downsides of using Mailchimp once a list passes 10,000 subscribers', intent: 'brand-verification' },
    { text: 'Is Brevo any good for a small team sending both marketing and transactional email', intent: 'brand-verification' },
    { text: 'What do people complain about with ActiveCampaign', intent: 'brand-verification' },
    { text: 'Is MailerLite reliable enough for a business that emails every day', intent: 'brand-verification' },
  ],
}
