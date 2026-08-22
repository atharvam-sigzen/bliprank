/**
 * URL → registrable domain. Shared by the source classifier and by owned/
 * competitor domain matching, so both agree on what "the same site" means.
 *
 * ponytail: a hand-cut multi-label suffix list rather than the full Public
 * Suffix List. The PSL is ~10k entries and a live-updating dependency; the
 * suffixes below cover the markets in scope (India, GCC, UK/EU, US). The
 * ceiling: a site on an unlisted multi-label suffix resolves one label too
 * short — `example.co.za` would read as `co.za`. Upgrade path is a PSL
 * dependency behind this same function if a customer turns up on one.
 */

/** Multi-label public suffixes we may plausibly see. Longest match wins. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.in',
  'net.in',
  'org.in',
  'gov.in',
  'ac.in',
  'co.jp',
  'co.nz',
  'co.za',
  'com.au',
  'net.au',
  'org.au',
  'gov.au',
  'com.br',
  'com.sg',
  'com.my',
  'com.tr',
  'com.mx',
  'com.ar',
  'ae.org',
  'com.sa',
  'com.eg',
  'com.pk',
  'com.bd',
  'com.ph',
  'com.hk',
  'com.tw',
  'com.cn',
  'com.vn',
])

/** Lowercased host with a leading `www.` removed. Empty string if unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The registrable domain: `docs.hubspot.com` → `hubspot.com`,
 * `x.example.co.uk` → `example.co.uk`. Returns '' for an unparseable URL.
 */
export function registrableDomain(url: string): string {
  const host = hostOf(url)
  if (!host || host.includes(':')) return host
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

/** True when `url` is on `domain` or any subdomain of it. */
export function isOnDomain(url: string, domain: string): boolean {
  const host = hostOf(url)
  const d = domain.toLowerCase().replace(/^www\./, '')
  return host === d || host.endsWith(`.${d}`)
}
