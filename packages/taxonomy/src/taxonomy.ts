/**
 * The demo-scoped taxonomy — ADR-0008.
 *
 * ⚠️ DEMO-SCOPED / PROVISIONAL. Fourteen hand-authored categories plus a
 * keyword-free fallback, existing so the application can be demonstrated end to
 * end on one machine. **This is not the
 * production taxonomy decision**, which is still open: where the vocabulary
 * comes from, what granularity 200 banks implies, and what G3's ≥95% criterion
 * is measured against are all unanswered. Adopting the real answer invalidates
 * everything here, which is why it all lives in one deletable package.
 *
 * THE SLUG CARRIES NO GEO — ADR-0008 §2. `prompt_banks` is
 * `UNIQUE(category, locale, geo, version)` and R6's cache key already carries
 * geo as its own field, so a geo-bearing slug would fragment one vertical into N
 * banks whose prompts normalise identically: the same text collected once per
 * variant, into a different cell each time, with no cache hit between them. That
 * is the margin lever spending itself on a naming convention.
 */

import type { CategoryDef } from './types.js'

/**
 * Keywords are matched as WHOLE TOKENS of the host, split on `.` and `-`, never
 * as substrings. Substring matching is how `compass.com` becomes a password
 * manager and `chronos.io` becomes an HR product.
 *
 * Deliberately omitted for being too generic to carry a category on their own:
 * `mail` (mail hosting is not email marketing), `books` (a bookshop),
 * `server`, `cloud`, `people`, `app`, `pay`. A keyword that fires on the wrong
 * site is worse than one that never fires, because the wrong category silently
 * changes what every downstream number is a measurement of.
 *
 * No keyword may appear in two categories — asserted in the tests, because a
 * duplicate would make every domain carrying it permanently ambiguous.
 */
export const DEMO_TAXONOMY: readonly CategoryDef[] = [
  {
    slug: 'crm-software',
    displayName: 'CRM software',
    description: 'Tools that track leads, contacts and deals for a sales team.',
    domainKeywords: ['crm', 'crms'],
    contentKeywords: ['crm', 'customer relationship management', 'sales pipeline', 'deal pipeline', 'lead management', 'contact management', 'sales crm', 'close more deals', 'sales team', 'deals won'],
  },
  {
    slug: 'project-management-software',
    displayName: 'Project management software',
    description: 'Tools that plan and track a team’s projects, tasks and deadlines.',
    domainKeywords: ['project', 'projects', 'task', 'tasks', 'kanban', 'sprint', 'scrum', 'roadmap'],
    contentKeywords: ['project management', 'task management', 'kanban board', 'gantt chart', 'sprint planning', 'manage projects', 'project tracking', 'team collaboration', 'work management', 'task tracking'],
  },
  {
    slug: 'email-marketing-software',
    displayName: 'Email marketing software',
    description: 'Platforms that send marketing and lifecycle email to a subscriber list.',
    domainKeywords: ['email', 'emails', 'mailer', 'mailing', 'newsletter', 'newsletters', 'campaign', 'campaigns'],
    contentKeywords: ['email marketing', 'email campaigns', 'newsletter', 'subscriber list', 'drip campaign', 'marketing automation', 'email automation', 'open rates', 'click through rate', 'mailing list'],
  },
  {
    slug: 'accounting-software',
    displayName: 'Accounting software',
    description: 'Bookkeeping, invoicing and tax filing for a small business.',
    domainKeywords: ['accounting', 'accounts', 'bookkeeping', 'ledger', 'invoice', 'invoices', 'invoicing', 'tax', 'taxes', 'gst'],
    contentKeywords: ['accounting software', 'bookkeeping', 'invoicing', 'invoices', 'profit and loss', 'balance sheet', 'tax filing', 'vat returns', 'gst returns', 'expense tracking', 'chart of accounts'],
  },
  {
    slug: 'web-hosting',
    displayName: 'Web hosting',
    description: 'Companies that host a website or a WordPress install.',
    domainKeywords: ['hosting', 'host', 'hosts', 'webhost', 'webhosting', 'vps', 'servers'],
    contentKeywords: ['web hosting', 'shared hosting', 'vps hosting', 'dedicated server', 'cpanel', 'uptime guarantee', 'wordpress hosting', 'managed hosting', 'domain registration', 'data centre'],
  },
  {
    slug: 'password-managers',
    displayName: 'Password managers',
    description: 'Apps that store and fill passwords and shared team credentials.',
    domainKeywords: ['password', 'passwords', 'passwd', 'vault', 'vaults', 'credentials', 'secrets'],
    contentKeywords: ['password manager', 'password vault', 'autofill passwords', 'zero knowledge encryption', 'master password', 'shared credentials', 'passkeys', 'two factor authentication', 'secrets management', 'end to end encrypted vault'],
  },
  {
    slug: 'hr-payroll-software',
    displayName: 'HR and payroll software',
    description: 'Platforms that run payroll, onboarding and employee records.',
    domainKeywords: ['hr', 'payroll', 'hrms', 'hris', 'employees', 'recruiting', 'recruitment', 'staffing', 'workforce'],
    contentKeywords: ['payroll', 'human resources', 'hr software', 'employee onboarding', 'applicant tracking', 'leave management', 'attendance tracking', 'performance reviews', 'employee records', 'payslips'],
  },
  {
    slug: 'ecommerce-platforms',
    displayName: 'Ecommerce platforms',
    description: 'Platforms for building and running an online store.',
    domainKeywords: ['ecommerce', 'commerce', 'shop', 'shopping', 'store', 'storefront', 'cart', 'checkout'],
    contentKeywords: ['online store', 'ecommerce platform', 'shopping cart', 'product catalogue', 'checkout experience', 'sell online', 'abandoned cart', 'storefront', 'order management', 'payment gateway'],
  },
  {
    slug: 'help-desk-software',
    displayName: 'Help desk software',
    description: 'Tools that run a support inbox, a ticket queue or a live chat widget.',
    domainKeywords: ['helpdesk', 'servicedesk', 'ticketing', 'tickets', 'livechat', 'support'],
    contentKeywords: ['help desk', 'service desk', 'support tickets', 'ticketing system', 'live chat', 'customer support software', 'shared inbox', 'knowledge base', 'sla management', 'first response time'],
  },
  {
    slug: 'website-builders',
    displayName: 'Website builders',
    description: 'Platforms for building a site or a landing page without writing code.',
    domainKeywords: ['website', 'websites', 'sitebuilder', 'webdesign', 'landingpage', 'builder'],
    contentKeywords: ['website builder', 'drag and drop builder', 'landing page builder', 'build a website', 'no code website', 'site templates', 'page builder', 'publish your site', 'web design templates'],
  },
  {
    slug: 'analytics-software',
    displayName: 'Product and web analytics',
    description: 'Tools that measure site and product usage — visitors, events and funnels.',
    domainKeywords: ['analytics', 'analytic', 'metrics', 'telemetry', 'insights', 'dashboards'],
    contentKeywords: ['product analytics', 'web analytics', 'funnel analysis', 'event tracking', 'user behaviour', 'session replay', 'cohort analysis', 'conversion tracking', 'retention analysis', 'dashboards and reports'],
  },
  {
    slug: 'seo-tools',
    displayName: 'SEO tools',
    description: 'Tools for keyword research, backlink analysis and rank tracking.',
    domainKeywords: ['seo', 'serp', 'serps', 'backlink', 'backlinks', 'keywords', 'rank', 'ranking', 'rankings'],
    contentKeywords: ['keyword research', 'backlink analysis', 'rank tracking', 'search engine optimisation', 'serp tracking', 'site audit', 'organic traffic', 'domain authority', 'competitor keywords', 'technical seo'],
  },
  {
    slug: 'video-conferencing',
    displayName: 'Video conferencing',
    description: 'Software for running video meetings, webinars and remote calls.',
    domainKeywords: ['meet', 'meeting', 'meetings', 'webinar', 'webinars', 'conferencing', 'videocall'],
    contentKeywords: ['video conferencing', 'video meetings', 'online meetings', 'screen sharing', 'webinars', 'virtual meeting rooms', 'meeting recordings', 'breakout rooms', 'video calls'],
  },
  {
    slug: 'esignature-software',
    displayName: 'E-signature software',
    description: 'Tools for sending documents to be signed electronically.',
    domainKeywords: ['esign', 'esignature', 'esignatures', 'signature', 'signatures', 'signing'],
    contentKeywords: ['electronic signature', 'esignature', 'sign documents online', 'digitally sign', 'signature workflow', 'legally binding signature', 'audit trail for signatures', 'send for signature'],
  },
  /*
   * THE FALLBACK. Deliberately last, and deliberately keyword-free.
   *
   * An empty `domainKeywords` AND an empty `contentKeywords` mean neither the
   * token pass nor the content pass can ever SELECT this category — nothing
   * matches nothing. It is reachable only by `scan.ts`
   * choosing it after both signals have already missed, which keeps the
   * classifier's own answer honest: it still says "unclassified" or "ambiguous",
   * and the decision to scan anyway is taken one layer up where it is visible.
   *
   * It has no leaders, and that is the point rather than an omission. We do not
   * know this domain's category, so we do not know its competitors, and
   * inventing a set to fill the chart is exactly what `/category-bank`'s
   * do-not-invent rule forbids. The scan measures the domain's own mention rate
   * against general software prompts and says the comparison is unavailable.
   */
  {
    slug: 'general-business-software',
    displayName: 'General business software',
    description: 'The fallback used when a domain does not resolve to a known category.',
    domainKeywords: [],
    contentKeywords: [],
  },
]

/** The category `scan.ts` falls back to. Never reachable by any keyword pass. */
export const FALLBACK_SLUG = 'general-business-software'

export const DEMO_SLUGS: readonly string[] = DEMO_TAXONOMY.map((c) => c.slug)

export const categoryBySlug = (slug: string): CategoryDef | undefined => DEMO_TAXONOMY.find((c) => c.slug === slug)
