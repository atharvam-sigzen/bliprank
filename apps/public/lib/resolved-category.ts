/**
 * The server's category decision, mirrored into this browser.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A CONVENIENCE.
 *
 * Classification now has two halves. The free half — leader domains and host
 * tokens — is pure, lives in `@bliprank/taxonomy`, and runs identically in a
 * browser and on a server, which is why `workspaceFor` could compute it inline.
 * The other half reads the site's homepage and, for a domain in no known
 * category, authors a bank; neither can happen in a page.
 *
 * So the server decides, and every screen in this app must agree with that
 * decision or the product tells the visitor two different things about
 * themselves. That is not hypothetical: without this, the Grader would report
 * "Gaming peripherals — 17 prompts, authored for you" and the Tracked Prompts
 * page one click later would say "General business software" and list a
 * completely different seventeen, because it re-derived the category from the
 * domain string alone.
 *
 * Two stores, mirroring the server's two files exactly:
 *
 *   host  -> slug        the decision, which is permanent server-side
 *   slug  -> bank        the prompts, shared by every domain in that category
 *
 * Keyed separately for the same reason the server keys them separately: two
 * domains in one authored category share one bank, and a per-domain copy of the
 * prompts would let the two drift and stop being comparable.
 *
 * ⚠️ THIS IS A CACHE, NOT THE RECORD. The record is the server's
 * `domain-categories.json`, and it is what makes a category permanent. Clearing
 * site data here loses nothing: the next preview reads the same decision back
 * off the server. Nothing may WRITE a category here that the server did not
 * decide.
 *
 * Storage discipline follows lib/workspace.ts exactly: every access inside
 * try/catch, every read validated, a failed write never a failed render.
 */

export const CATEGORY_KEY_PREFIX = 'bliprank-domain-category:'
export const BANK_KEY_PREFIX = 'bliprank-bank:'

export interface CachedBank {
  readonly slug: string
  readonly displayName: string
  readonly description: string
  readonly prompts: readonly { readonly text: string; readonly intent: string }[]
  /** False for an authored bank. Surfaces say so rather than presenting it as reviewed. */
  readonly verified: boolean
  readonly generated: boolean
  readonly competitors: readonly string[]
}

export interface CachedDecision {
  readonly slug: string
  /** `leader-domain` | `domain-token` | `site-content` | `generated` | `fallback`. */
  readonly source: string
  readonly evidence: string
  readonly decidedAt: string
  readonly fallback?: { readonly reason: 'unclassified' | 'ambiguous'; readonly detail: string; readonly candidates: readonly string[] }
}

/*
 * localStorage, matching `readActiveDomain` and the scan registry — changed
 * 2026-09-01, and it reverses what this comment used to argue.
 *
 * The old reasoning: "a decision cached in March that the server has since had
 * reason to revisit is worse than no cache". That premise is false in this
 * codebase. `recordCategory` REFUSES TO OVERWRITE an existing record — that
 * refusal is the stability guarantee R5 requires, and it means the server
 * cannot revisit a decision. Asking again in March returns the same slug it
 * returned today. A cache of an answer that cannot change is not a staleness
 * risk; it is just the answer.
 *
 * What the session scoping cost instead was real. The prompts live under the
 * BANK key, and a generated bank exists ONLY here on the client — there is no
 * `gaming-peripherals-india` in DEMO_BANKS. So on the next visit
 * `preflightPrompts` found no cached bank, fell through to the demo banks,
 * matched nothing, and Manage Prompts rendered an EMPTY list for a domain whose
 * seventeen prompts had already been authored and paid for. The visitor's own
 * scan looked like it had no prompts at all.
 *
 * Still a CACHE, not the record. The record is the server's
 * `domain-categories.json`; clearing site data loses nothing, because the next
 * preview reads the same decision back. Nothing may WRITE a category here that
 * the server did not decide.
 */
function read(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // Private window, exhausted quota, or SSR. The caller already holds the
    // value for this render; the only loss is agreement after a reload, and the
    // next preview restores it.
  }
}

/** The category decided for this host, or null when this browser has not seen one. */
export function readDecision(host: string): CachedDecision | null {
  const v = read(CATEGORY_KEY_PREFIX + host) as Partial<CachedDecision> | null
  if (!v || typeof v.slug !== 'string' || !v.slug) return null
  return {
    slug: v.slug,
    source: typeof v.source === 'string' ? v.source : '',
    evidence: typeof v.evidence === 'string' ? v.evidence : '',
    decidedAt: typeof v.decidedAt === 'string' ? v.decidedAt : '',
    ...(v.fallback && typeof v.fallback === 'object' ? { fallback: v.fallback } : {}),
  }
}

/** The bank for this slug, or null. Present for any category this BROWSER has previewed, including past visits. */
export function readBank(slug: string): CachedBank | null {
  const v = read(BANK_KEY_PREFIX + slug) as Partial<CachedBank> | null
  if (!v || typeof v.slug !== 'string' || !Array.isArray(v.prompts)) return null
  const prompts = v.prompts.filter(
    (p): p is { text: string; intent: string } =>
      typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' && typeof (p as { intent?: unknown }).intent === 'string',
  )
  if (prompts.length === 0) return null
  return {
    slug: v.slug,
    displayName: typeof v.displayName === 'string' ? v.displayName : v.slug,
    description: typeof v.description === 'string' ? v.description : '',
    prompts,
    verified: v.verified === true,
    generated: v.generated === true,
    competitors: Array.isArray(v.competitors) ? v.competitors.filter((c): c is string => typeof c === 'string') : [],
  }
}

/**
 * Record what the server decided. The ONLY writer, and it takes the whole
 * preview response rather than loose fields so no caller can save half of one.
 */
export function rememberDecision(preview: {
  domain: string
  category: string
  categoryName: string
  categoryDescription: string
  source: string
  evidence: string
  verified: boolean
  generated: boolean
  decidedAt: string
  previouslyDecided: boolean
  fallback?: { reason: 'unclassified' | 'ambiguous'; detail: string; candidates: readonly string[] }
  prompts: readonly { text: string; intent: string }[]
  competitors: readonly string[]
}): void {
  if (!preview.domain || !preview.category) return
  write(CATEGORY_KEY_PREFIX + preview.domain, {
    slug: preview.category,
    source: preview.source,
    evidence: preview.evidence,
    decidedAt: preview.decidedAt,
    ...(preview.fallback ? { fallback: preview.fallback } : {}),
  } satisfies CachedDecision)
  write(BANK_KEY_PREFIX + preview.category, {
    slug: preview.category,
    displayName: preview.categoryName,
    description: preview.categoryDescription,
    prompts: preview.prompts.map((p) => ({ text: p.text, intent: p.intent })),
    verified: preview.verified,
    generated: preview.generated,
    competitors: [...preview.competitors],
  } satisfies CachedBank)
}
