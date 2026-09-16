/**
 * What a visitor is told when a spending route throws. The cause goes to the
 * server log only: a provider body, a ledger path or a stack detail is not the
 * visitor's to read (2026-09-09 audit, defect 6). Kept out of the route
 * modules because Next.js allows a route file to export handlers and config
 * and nothing else.
 */
export const SCAN_FAILED = 'The scan stopped because of an error on our side. Nothing was substituted for the missing answers; the cause has been logged. Please try again later.'
export const PREVIEW_FAILED = 'The preview could not be built because of an error on our side. No category was invented; the cause has been logged. Please try again later.'
