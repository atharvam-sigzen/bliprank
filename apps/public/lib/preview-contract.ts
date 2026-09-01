/**
 * The shape of a prompt preview, and the limit that governs asking for one.
 *
 * SEPARATE FROM THE ROUTE ON PURPOSE, and not for tidiness. A Next route module
 * may export only route handlers and a fixed set of config names; any other
 * value export fails `next build` with a type error about an index signature,
 * which is an obscure way of being told "put that somewhere else". The type
 * alone could have stayed — types are erased — but the constant and the type
 * describe one contract and splitting them across two files by which of them
 * the compiler tolerates is how they drift.
 *
 * Both sides import from here: the route builds this, the Grader reads it, and
 * `resolved-category.ts` mirrors it into the browser so every other screen
 * agrees with what the Grader showed.
 */

/** Previews per visitor per hour. Well above browsing, well below amplification. */
export const DEFAULT_MAX_PREVIEWS_PER_HOUR = 20

export interface PreviewResponse {
  readonly domain: string
  readonly category: string
  readonly categoryName: string
  readonly categoryDescription: string
  /** How the category was decided, and what matched. Shown, not logged. */
  readonly source: string
  readonly evidence: string
  /**
   * True when this decision was READ back rather than made now.
   *
   * Separate from `source`, which stays what it always was: reading a decision
   * does not change how it was made. Together they let a page say "matched a
   * tracked brand, on 12 March, and reused since" — which is the sentence that
   * makes the stability guarantee visible instead of merely true.
   */
  readonly previouslyDecided: boolean
  /** True when a human wrote this bank. Generated banks are `false`, and say so. */
  readonly verified: boolean
  /** True when the bank was authored for this domain rather than chosen for it. */
  readonly generated: boolean
  readonly decidedAt: string
  /** Set when the category could not be decided and the general bank applies. */
  readonly fallback?: { readonly reason: 'unclassified' | 'ambiguous'; readonly detail: string; readonly candidates: readonly string[] }
  /** THE ACTUAL PROMPTS, verbatim, in the order a cycle would send them. */
  readonly prompts: readonly { readonly text: string; readonly intent: string }[]
  readonly engines: readonly string[]
  /** Competitors the scan will rank against. Empty for a generated or fallback bank. */
  readonly competitors: readonly string[]
}
