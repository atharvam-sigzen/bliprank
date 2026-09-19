/**
 * THE ONE PROMPT NORMALISER — what makes two spellings of a question the same
 * question. The cache key (R6, ADR-0003) hashes its output, and the comparison
 * basis fingerprints a person's prompt set with it (ADR-0016 Amendment 1), so
 * "the same cell" and "the same sample" can never disagree about a prompt.
 *
 * ⚠️ WHY IT HAS ITS OWN FILE. It lived in `cache-key.ts`, which imports
 * `node:crypto`. `basis.ts` is read by browser-side code through the
 * `@bliprank/contracts/basis` subpath, and a browser bundle refuses the `node:`
 * scheme at resolution (the C3 build break, fixed in b1ea791). The function
 * moved here unchanged, `cache-key.ts` re-exports it, and the key's shape and
 * every stored key are exactly what they were: `cache-key.test.ts` pins the
 * behaviour, and nothing in this file may import a Node-only module.
 */

/**
 * Bump whenever `normalisePrompt` changes behaviour. Stored next to every row
 * so a key can be reproduced from its raw prompt later; deliberately NOT part
 * of the hash (see ADR-0003, "what is excluded").
 */
export const NORMALISATION_VERSION = 1

/**
 * v1: NFKC → lowercase → collapse whitespace → strip terminal punctuation.
 * NFKC folds full-width and compatibility forms and also symbol-to-letter
 * forms (™ → "tm"), so "Acme™" and "AcmeTM" share a cell — accepted.
 * Alias resolution to canonical brand names arrives with the alias table
 * (P2.2) as v2. Deterministic across machines: no locale-aware casing.
 */
export function normalisePrompt(prompt: string): string {
  return prompt
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\s.!?…,;:]+$/u, '')
}
