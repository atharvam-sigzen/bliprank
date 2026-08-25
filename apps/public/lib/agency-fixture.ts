import { wilson, type Metric } from '@bliprank/stats'
import { previewScore, type PreviewScore } from './preview-score'
import type { ScanBrand } from './scan-result'

/**
 * ⚠️ ILLUSTRATIVE DATA FOR A CONCEPT SCREEN. NOT A PRODUCT.
 *
 * There are no agency accounts, no tenancy, no second workspace and no
 * cross-client query anywhere in this codebase. This module invents a portfolio
 * so the shape of an agency view can be shown and discussed; every row is made
 * up and the page it feeds says so at the top, in the margin and in the table
 * caption.
 *
 * THE ARITHMETIC IS REAL EVEN THOUGH THE INPUTS ARE INVENTED. Each row's
 * interval comes from `wilson()` on its invented counts, and each row's score
 * comes from the same `previewScore` the Grader uses. Hand-writing plausible
 * intervals would have produced a screen that could not exist — a row whose
 * interval did not match its n, or a score that did not follow from its inputs
 * — and the first person to check the arithmetic would find the demo lying
 * about something it did not need to lie about. Invented inputs, honest maths.
 *
 * ⚠️ TENANCY IS HUMAN-OWNED (CLAUDE.md §4). Nothing here is a step toward a
 * real agency workspace: an actual portfolio view crosses a workspace boundary
 * on every row and needs the RLS model and `tenancy-auditor` before a line of
 * it is written. This is a picture of a screen.
 */

const BASIS = 'grader|engines=chatgpt,gemini,copilot,ai-mode,aio|en-GB|GB|auto-bank|1cycle'

const metric = (k: number, n: number): Metric => {
  const w = wilson(k, n)
  return { value: w.value, ci_low: w.ci_low, ci_high: w.ci_high, n: w.n, algo_version: 'det-1', collection_path: 'third-party-grounded', comparison_basis: BASIS }
}

const brand = (name: string, k: number, n: number, isSubject = false): ScanBrand => ({
  id: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  isSubject,
  mentions: k,
  citations: 0,
  metric: metric(k, n),
})

export interface PortfolioRow {
  readonly client: string
  readonly categoryName: string
  readonly metric: Metric
  readonly preview: PreviewScore
  /** Named so the row can say what it could not rank against. */
  readonly rivals: number
}

/**
 * Six invented clients across the demo taxonomy, chosen to put every honest
 * state on one screen rather than six flattering ones:
 *
 *   - a strong performer and a weak one, so the range of scores is visible;
 *   - one on a SMALL sample, so a wide interval appears next to narrow ones and
 *     the reader can see the portfolio does not hide uncertainty;
 *   - one measured at zero, which is a finding and not a gap.
 *
 * A portfolio screen that shows six comfortable rows teaches an agency nothing
 * about what the product does when a number is bad.
 */
const CLIENTS: readonly { client: string; categoryName: string; k: number; n: number; rivals: readonly [number, number][] }[] = [
  { client: 'northwind.io', categoryName: 'CRM software', k: 71, n: 85, rivals: [[40, 85], [33, 85], [18, 85]] },
  { client: 'ledgerwise.com', categoryName: 'Accounting software', k: 44, n: 85, rivals: [[52, 85], [39, 85], [21, 85]] },
  { client: 'shiptide.co', categoryName: 'Ecommerce platforms', k: 30, n: 85, rivals: [[61, 85], [48, 85], [35, 85]] },
  { client: 'harborhr.com', categoryName: 'HR and payroll software', k: 12, n: 85, rivals: [[55, 85], [41, 85], [29, 85]] },
  // Deliberately thin: 31 answers is just over the comparison floor, so this row
  // carries a visibly wider interval than the others.
  { client: 'quillbase.app', categoryName: 'Project management software', k: 11, n: 31, rivals: [[14, 31], [9, 31]] },
  // Zero is a real result with a real upper bound, not a missing value.
  { client: 'vaultline.dev', categoryName: 'Password managers', k: 0, n: 85, rivals: [[47, 85], [38, 85], [26, 85]] },
]

export const PORTFOLIO: readonly PortfolioRow[] = CLIENTS.map((c) => {
  const subject = brand(c.client, c.k, c.n, true)
  const rivals = c.rivals.map(([k, n], i) => brand(`rival-${i}`, k, n))
  return {
    client: c.client,
    categoryName: c.categoryName,
    metric: subject.metric,
    preview: previewScore(subject, rivals),
    rivals: rivals.length,
  }
})

/** One wording for the disclosure, used by every element on the concept page. */
export const CONCEPT_NOTICE =
  'Concept preview — illustrative clients, invented figures. There are no agency accounts in this build and nothing here reads real data.'
