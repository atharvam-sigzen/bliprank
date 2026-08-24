/**
 * The demo-scoped banks — ADR-0008. Deletable as a unit: adopting a production
 * taxonomy invalidates every one of these, which is the whole reason they live
 * here rather than in the production seed path.
 */

import type { PromptBank } from '../types.js'
import { ACCOUNTING_SOFTWARE } from './accounting-software.js'
import { CRM_SOFTWARE } from './crm-software.js'
import { ECOMMERCE_PLATFORMS } from './ecommerce-platforms.js'
import { EMAIL_MARKETING_SOFTWARE } from './email-marketing-software.js'
import { HR_PAYROLL_SOFTWARE } from './hr-payroll-software.js'
import { PASSWORD_MANAGERS } from './password-managers.js'
import { PROJECT_MANAGEMENT_SOFTWARE } from './project-management-software.js'
import { WEB_HOSTING } from './web-hosting.js'

export const DEMO_BANKS: readonly PromptBank[] = [
  ACCOUNTING_SOFTWARE,
  CRM_SOFTWARE,
  ECOMMERCE_PLATFORMS,
  EMAIL_MARKETING_SOFTWARE,
  HR_PAYROLL_SOFTWARE,
  PASSWORD_MANAGERS,
  PROJECT_MANAGEMENT_SOFTWARE,
  WEB_HOSTING,
]
