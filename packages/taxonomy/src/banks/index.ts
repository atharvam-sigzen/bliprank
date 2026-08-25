/**
 * The demo-scoped banks — ADR-0008. Deletable as a unit: adopting a production
 * taxonomy invalidates every one of these, which is the whole reason they live
 * here rather than in the production seed path.
 */

import type { PromptBank } from '../types.js'
import { ACCOUNTING_SOFTWARE } from './accounting-software.js'
import { ANALYTICS_SOFTWARE } from './analytics-software.js'
import { CRM_SOFTWARE } from './crm-software.js'
import { ECOMMERCE_PLATFORMS } from './ecommerce-platforms.js'
import { ESIGNATURE_SOFTWARE } from './esignature-software.js'
import { GENERAL_BUSINESS_SOFTWARE } from './general-business-software.js'
import { HELP_DESK_SOFTWARE } from './help-desk-software.js'
import { SEO_TOOLS } from './seo-tools.js'
import { VIDEO_CONFERENCING } from './video-conferencing.js'
import { WEBSITE_BUILDERS } from './website-builders.js'
import { EMAIL_MARKETING_SOFTWARE } from './email-marketing-software.js'
import { HR_PAYROLL_SOFTWARE } from './hr-payroll-software.js'
import { PASSWORD_MANAGERS } from './password-managers.js'
import { PROJECT_MANAGEMENT_SOFTWARE } from './project-management-software.js'
import { WEB_HOSTING } from './web-hosting.js'

export const DEMO_BANKS: readonly PromptBank[] = [
  ACCOUNTING_SOFTWARE,
  ANALYTICS_SOFTWARE,
  CRM_SOFTWARE,
  ECOMMERCE_PLATFORMS,
  EMAIL_MARKETING_SOFTWARE,
  ESIGNATURE_SOFTWARE,
  GENERAL_BUSINESS_SOFTWARE,
  HELP_DESK_SOFTWARE,
  HR_PAYROLL_SOFTWARE,
  PASSWORD_MANAGERS,
  PROJECT_MANAGEMENT_SOFTWARE,
  SEO_TOOLS,
  VIDEO_CONFERENCING,
  WEBSITE_BUILDERS,
  WEB_HOSTING,
]

/**
 * The fallback bank, by name, so `scan.ts` never has to string-match for it.
 * It is in DEMO_BANKS as well because every slug must have exactly one bank —
 * being the fallback does not exempt it from the taxonomy's own invariants.
 */
export { GENERAL_BUSINESS_SOFTWARE }
