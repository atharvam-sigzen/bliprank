/**
 * A SYNTHETIC scan file, hand-built, for the two shapes that have no other
 * specimen in this build:
 *
 *   1. a result carrying NO `run` block — what `/api/scan` cached before the
 *      runner stamped one, and the shape that crashed every surface reading
 *      `scan.run.day` through a type that declared `run` required;
 *   2. a ZERO-COMPETITOR record — what the fallback bank produces, where the
 *      head-to-head must render honest prose instead of an empty chart.
 *
 * ⚠️ WHY THIS IS INVENTED RATHER THAN A REAL SCAN. It replaces
 * `scan-sigzen.json`, which was deleted on 2026-09-01. That file was a real
 * collected artefact, but it had been run against manually substituted prompts
 * rather than through the generated pipeline, so the numbers in it were not
 * produced by the code that claims to produce them. A fixture that looks like
 * evidence and is not is worse than an obvious fake: this one is labelled,
 * carries a reserved example domain, and nothing about it can be mistaken for a
 * measurement of a real business.
 *
 * The FIGURES are deliberately self-consistent — 85 answers, 0 mentions, an
 * interval a real Wilson call would return for (0, 85) — so the surfaces under
 * test do arithmetic on plausible inputs rather than on placeholders.
 */

import type { ScanResultFile } from '../scan-result'

/** RFC 2606 reserves example.com for exactly this. It can never be a customer. */
export const NO_RUN_BLOCK_SCAN = {
  status: 'scanned',
  domain: 'example.com',
  category: 'general-business-software',
  categoryName: 'General business software',
  fallback: { reason: 'unclassified', detail: 'no known brand or category keyword in the domain', candidates: [] },
  subjectSource: 'domain-label',
  // The engine list survives here even with no run block — `runInfoOf` recovers
  // it from this string, which is the whole reason the field is parsed.
  comparisonBasis:
    'bank=general-business-software|v1|locale=en-US|geo=US|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|prompts=17|runs=1',
  algoVersion: 'det-1',
  counts: { cellsRequested: 85, cacheHits: 0, collected: 85, failed: 0, answersScored: 85, providerCalls: 85 },
  collectedAt: '2026-08-25T12:00:00.000Z',
  brands: [
    {
      id: 'domain:example.com',
      name: 'example',
      isSubject: true,
      mentions: 0,
      citations: 0,
      metric: {
        value: 0,
        ci_low: 0,
        ci_high: 0.04341,
        n: 85,
        algo_version: 'det-1',
        collection_path: 'third-party-grounded',
        comparison_basis:
          'bank=general-business-software|v1|locale=en-US|geo=US|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|prompts=17|runs=1',
      },
    },
  ],
  // NO `run` KEY. Its absence is the point of the fixture; adding one, even an
  // empty one, would silently stop testing the branch it exists for.
} as unknown as ScanResultFile
