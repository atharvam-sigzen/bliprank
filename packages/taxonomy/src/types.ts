/**
 * Shapes for the demo-scoped taxonomy and its prompt banks (ADR-0008).
 *
 * DEMO-SCOPED / PROVISIONAL. None of this is the production taxonomy decision,
 * which is still open — see the PHASES 3.1 scoping report in `docs/PROGRESS.md`.
 */

/** The four buyer intents a bank spans. `/category-bank` step 1. */
export const INTENTS = ['discovery', 'comparison', 'problem-led', 'brand-verification'] as const
export type Intent = (typeof INTENTS)[number]

export interface Prompt {
  /** Sent to the engine verbatim. Never the normalised form — that is keying only. */
  readonly text: string
  readonly intent: Intent
}

/**
 * A brand that leads a category.
 *
 * Same shape as the scorer's `BrandSpec` on purpose: these feed straight into
 * `ScoreInput.competitors` with no adapter layer. Aliases are matched
 * case-insensitively on WHOLE TOKENS, so an alias must be a form a human would
 * write — `monday.com`, never a bare `monday`, which collides with the weekday.
 */
export interface Leader {
  readonly id: string
  readonly name: string
  readonly aliases: readonly string[]
  /**
   * Domains for CITATION ATTRIBUTION. Subdomains match by suffix, so these are
   * deliberately narrow: `crm.zoho.com`, not `zoho.com`, because the apex is
   * shared with Zoho Books and Zoho People — leaders in other banks — and an
   * apex claim would credit every sibling product's citation to this one.
   */
  readonly domains: readonly string[]
  /**
   * Domains for CLASSIFICATION only, where the organisation's site is broader
   * than the product's attribution domain.
   *
   * These two jobs were one field and should not have been. A visitor types
   * `zoho.com`, and the honest answer is that Zoho leads three of these
   * categories at once — which is the ambiguous result the classifier exists to
   * return. Narrowing `domains` for attribution correctness made that visitor
   * unclassifiable, so the classification signal gets its own field rather than
   * the attribution list being widened back and quietly re-breaking the scorer.
   */
  readonly siteDomains?: readonly string[]
}

export interface PromptBank {
  /** The category slug. Carries NO geo — ADR-0008 §2. */
  readonly category: string
  readonly displayName: string
  readonly description: string
  /** BCP-47. */
  readonly locale: string
  /** ISO 3166-1 alpha-2. Separate from the slug, matching `prompt_banks`. */
  readonly geo: string
  readonly version: number
  /**
   * Always false here. `/category-bank`: "Do not invent competitor names. Derive
   * them from actual collected answers or from a verifiable source, and mark any
   * that are unverified." These were hand-authored with no collected answer
   * behind them, which is precisely the case that rule covers.
   */
  readonly verified: false
  readonly note: string
  readonly leaders: readonly Leader[]
  readonly prompts: readonly Prompt[]
}

/**
 * A category as the classifier sees it.
 *
 * `domainKeywords` are matched as WHOLE TOKENS of the host, split on `.` and
 * `-`. They are never matched as substrings: substring matching is how
 * `compass.com` becomes a password manager and `chronos.io` becomes an HR
 * product, and the scorer's alias matching already refuses it for the same
 * reason.
 */
export interface CategoryDef {
  readonly slug: string
  readonly displayName: string
  readonly description: string
  readonly domainKeywords: readonly string[]
  /**
   * Phrases matched against the site's own PAGE TEXT, not its host.
   *
   * A different signal with different rules, which is why it is a different
   * field rather than `domainKeywords` reused. A host has five tokens and a
   * homepage has two thousand words, so a single hit means almost nothing here
   * and a multi-word phrase is affordable: `domainKeywords` cannot carry
   * `customer relationship management` because no host contains it, and page
   * text carries it constantly.
   *
   * Matched as WHOLE-TOKEN SEQUENCES after the text is normalised to lowercase
   * `[a-z0-9]` tokens — so `crm` matches "our CRM" and never "microm", the same
   * substring refusal `domainKeywords` makes for the same reason.
   *
   * As with `domainKeywords`, no phrase may appear in two categories; the tests
   * assert it. A shared phrase makes every site carrying it permanently
   * ambiguous, which is the one outcome worse than not classifying at all.
   */
  readonly contentKeywords: readonly string[]
}
