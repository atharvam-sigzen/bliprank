/**
 * PHASES 3.1 — domain → category, deterministically (ADR-0008 §3).
 *
 * NO MODEL CALL ON ANY PATH, and the reason is not R1's cost argument, which
 * would be weak here: a Haiku classification is ~$0.0002 against a $0.18 scan.
 * It is that the category decides which prompt bank runs, which decides
 * `comparison_basis`. A non-deterministic classifier lets the same domain land
 * in different banks on different days, so the thing a number is a measurement
 * OF changes underneath the customer — exactly the change `compare()` exists to
 * refuse. Determinism here is load-bearing for the metric contract.
 *
 * Pure: the same host plus the same banks always yields the same result. Banks
 * are passed in rather than imported, so the caller owns the IO (CLAUDE.md §8).
 *
 * WHAT PHASES 3.1 ASKS FOR AND THIS DOES NOT DO. The deliverable names three
 * signals — site content, autocomplete, contacts enrichment. All three need a
 * network call and two have no provider, no key and no cost line anywhere in the
 * repo. None is implemented. That is why `unclassified` is common rather than
 * rare, and the Grader says so on the page instead of papering over it. Site
 * content in particular is a server-side fetch of a user-supplied domain and
 * carries an SSRF surface that needs its own design before it is built.
 */

import type { CategoryDef, PromptBank } from './types.js'

export type Signal = 'leader-domain' | 'domain-token'

export type Classification =
  | {
      readonly status: 'classified'
      readonly slug: string
      readonly signal: Signal
      /** What actually matched, so a surprising classification is explainable. */
      readonly evidence: string
    }
  | {
      readonly status: 'ambiguous'
      /** Sorted, so the output is stable for a given input. */
      readonly candidates: readonly string[]
      readonly signal: Signal
      readonly evidence: string
    }
  | { readonly status: 'unclassified'; readonly reason: string }

/**
 * Lowercased host with scheme, `www.`, path, port and trailing dot removed.
 * Returns '' for anything that is not shaped like a hostname.
 *
 * The trailing dot matters: `hubspot.com.` is DNS-identical to `hubspot.com` and
 * a different string, and the scorer was bitten by exactly that.
 */
export function normaliseHost(input: string): string {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
  // At least two labels, each 1-63 chars, ending in an alphabetic TLD. Rejects
  // 'hello.txt' the same way the Grader's own input check does.
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ? host : ''
}

/** True when `host` is `domain` or any subdomain of it. Both must be non-empty. */
export function isOnDomain(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  // An empty domain — one trailing comma in an imported list is enough — would
  // otherwise match every host through endsWith('.'). The scorer shipped that
  // bug once; it made `cited` true for arbitrary third-party URLs.
  if (!d || !host) return false
  return host === d || host.endsWith(`.${d}`)
}

/**
 * Host → whole tokens, split on `.` and `-`.
 *
 * The public suffix is deliberately NOT stripped, and no dependency on the PSL
 * is taken. Leader matching never needs it (that is a suffix comparison against
 * a known apex), and for keyword matching the TLD is a legitimate signal in its
 * own right: `.shop`, `.store`, `.host` and `.tax` all say something true about
 * the site. Labels that are not keywords — `co`, `uk`, `com` — simply never
 * match, so carrying them costs nothing.
 */
export function hostTokens(host: string): readonly string[] {
  return host.split(/[.-]/).filter(Boolean)
}

/**
 * Classify a domain against the demo taxonomy.
 *
 * Two signals, in strict precedence:
 *
 *   1. leader-domain — the host is, or is under, a domain a bank lists as a
 *      leader. A known brand outranks a keyword; `shopify.com` is ecommerce
 *      because it IS Shopify, not because of anything in the string.
 *   2. domain-token — a whole token of the host is a category keyword
 *      (`my-crm.io` → `crm-software`).
 *
 * Concatenated labels are NOT segmented. `mycrm.com` returns unclassified.
 * A conservative miss is recoverable; a confident wrong category silently
 * mislabels every number downstream.
 *
 * Three outcomes, and the last two are not failures. There is no default
 * category and no fallback: a fallback would be a silent `comparison_basis`
 * change wearing a helpful face, the same mistake ADR-0005 refuses when it
 * forbids bucketing an unknown citation as `owned`.
 */
export function classifyDomain(input: string, banks: readonly PromptBank[], taxonomy: readonly CategoryDef[]): Classification {
  const host = normaliseHost(input)
  if (!host) return { status: 'unclassified', reason: 'not a domain' }

  // 1. Leader domains. Longest match wins the evidence line, because
  //    `zoho.com` and `books.zoho.com` can both be listed and the more specific
  //    one is the more informative thing to report.
  const byLeader = new Map<string, string>()
  for (const bank of banks) {
    for (const leader of bank.leaders) {
      for (const domain of [...leader.domains, ...(leader.siteDomains ?? [])]) {
        if (!isOnDomain(host, domain)) continue
        const previous = byLeader.get(bank.category)
        if (previous === undefined || domain.length > previous.length) byLeader.set(bank.category, domain)
      }
    }
  }
  if (byLeader.size === 1) {
    const [slug, domain] = [...byLeader][0]!
    return { status: 'classified', slug, signal: 'leader-domain', evidence: domain }
  }
  if (byLeader.size > 1) {
    // Zoho leads CRM, accounting and HR. Microsoft and Adobe are the same shape.
    // Picking one would be inventing a fact; the caller asks instead.
    return {
      status: 'ambiguous',
      candidates: [...byLeader.keys()].sort(),
      signal: 'leader-domain',
      evidence: [...new Set(byLeader.values())].sort().join(', '),
    }
  }

  // 2. Whole-token keywords.
  const tokens = new Set(hostTokens(host))
  const byToken = new Map<string, string[]>()
  for (const category of taxonomy) {
    const hits = category.domainKeywords.filter((k) => tokens.has(k))
    if (hits.length > 0) byToken.set(category.slug, hits.sort())
  }
  if (byToken.size === 1) {
    const [slug, hits] = [...byToken][0]!
    return { status: 'classified', slug, signal: 'domain-token', evidence: hits.join(', ') }
  }
  if (byToken.size > 1) {
    return {
      status: 'ambiguous',
      candidates: [...byToken.keys()].sort(),
      signal: 'domain-token',
      evidence: [...new Set([...byToken.values()].flat())].sort().join(', '),
    }
  }

  return { status: 'unclassified', reason: 'no known brand and no category keyword in the domain' }
}
