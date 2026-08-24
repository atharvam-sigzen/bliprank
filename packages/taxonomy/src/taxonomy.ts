/**
 * The demo-scoped taxonomy — ADR-0008.
 *
 * ⚠️ DEMO-SCOPED / PROVISIONAL. Eight hand-authored categories that exist so the
 * application can be demonstrated end to end on one machine. **This is not the
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
  },
  {
    slug: 'project-management-software',
    displayName: 'Project management software',
    description: 'Tools that plan and track a team’s projects, tasks and deadlines.',
    domainKeywords: ['project', 'projects', 'task', 'tasks', 'kanban', 'sprint', 'scrum', 'roadmap'],
  },
  {
    slug: 'email-marketing-software',
    displayName: 'Email marketing software',
    description: 'Platforms that send marketing and lifecycle email to a subscriber list.',
    domainKeywords: ['email', 'emails', 'mailer', 'mailing', 'newsletter', 'newsletters', 'campaign', 'campaigns'],
  },
  {
    slug: 'accounting-software',
    displayName: 'Accounting software',
    description: 'Bookkeeping, invoicing and tax filing for a small business.',
    domainKeywords: ['accounting', 'accounts', 'bookkeeping', 'ledger', 'invoice', 'invoices', 'invoicing', 'tax', 'taxes', 'gst'],
  },
  {
    slug: 'web-hosting',
    displayName: 'Web hosting',
    description: 'Companies that host a website or a WordPress install.',
    domainKeywords: ['hosting', 'host', 'hosts', 'webhost', 'webhosting', 'vps', 'servers'],
  },
  {
    slug: 'password-managers',
    displayName: 'Password managers',
    description: 'Apps that store and fill passwords and shared team credentials.',
    domainKeywords: ['password', 'passwords', 'passwd', 'vault', 'vaults', 'credentials', 'secrets'],
  },
  {
    slug: 'hr-payroll-software',
    displayName: 'HR and payroll software',
    description: 'Platforms that run payroll, onboarding and employee records.',
    domainKeywords: ['hr', 'payroll', 'hrms', 'hris', 'employees', 'recruiting', 'recruitment', 'staffing', 'workforce'],
  },
  {
    slug: 'ecommerce-platforms',
    displayName: 'Ecommerce platforms',
    description: 'Platforms for building and running an online store.',
    domainKeywords: ['ecommerce', 'commerce', 'shop', 'shopping', 'store', 'storefront', 'cart', 'checkout'],
  },
]

export const DEMO_SLUGS: readonly string[] = DEMO_TAXONOMY.map((c) => c.slug)

export const categoryBySlug = (slug: string): CategoryDef | undefined => DEMO_TAXONOMY.find((c) => c.slug === slug)
