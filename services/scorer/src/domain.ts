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
  // "Private" suffixes: each site under these is a distinct publisher, and
  // grouping them under one registrable domain would merge every Blogspot or
  // GitHub Pages author into a single row of the source mix.
  'blogspot.com',
  'github.io',
  'gitlab.io',
  'wordpress.com',
  'substack.com',
  'medium.com',
  'wixsite.com',
  'webflow.io',
  'notion.site',
  'pages.dev',
  'vercel.app',
  'netlify.app',
])

/**
 * Lowercased host, leading `www.` and the root-zone trailing dot removed.
 * Empty string if unparseable.
 *
 * The trailing dot matters: some canonicalisers emit `hubspot.com.`, which is
 * DNS-identical to `hubspot.com` but a different string. Left in, it made an
 * owned citation classify as `other` (undercounting the customer's own domain)
 * and made registrableDomain return the nonsense `com.`.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
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

/**
 * True when `url` is on `domain` or any subdomain of it.
 *
 * Both sides must be non-empty. An empty `domain` — a trailing comma in an
 * imported domain list is enough — previously matched every unparseable URL,
 * because `hostOf` returns '' for those and '' === ''. That made `cited` true
 * for arbitrary third-party URLs: the ADR-0005 failure mode (inflating the
 * customer's own number) reached through the citation path instead of the
 * classifier.
 */
export function isOnDomain(url: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  if (!d) return false
  const host = hostOf(url)
  if (!host) return false
  return host === d || host.endsWith(`.${d}`)
}
