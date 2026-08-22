/**
 * Types packages/stats needs without depending on @bliprank/contracts.
 * `packages/stats` is pure and dependency-free by design (CLAUDE.md §4/§8) —
 * it is verified against reference implementations, and a dependency edge into
 * the contracts package would make that harness drag the whole workspace in.
 */

/** Mirrors `CollectionPath` in @bliprank/contracts. Kept in sync by the type test. */
export type CollectionPath = 'official-api' | 'third-party-grounded'
