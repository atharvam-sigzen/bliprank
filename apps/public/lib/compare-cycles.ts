/**
 * `compare()` between two cycles of one domain, with the basis rule asked
 * first (MVP_PLAN C3r item 1).
 *
 * `compare()` (packages/stats) refuses whenever the two `comparison_basis`
 * strings differ at all, and it does not open them. That is the right default
 * and it stays. One difference is not a difference of sample: a person who
 * goes back to a list of questions they asked before is given a new version
 * number, so the tail reads `custom=3@3#…` where the earlier cycle reads
 * `custom=3@1#…`, over the same fingerprint, the same questions, the same
 * cells. `sameBasis` (packages/contracts, the one definition of the string)
 * says whether that is all that moved. When it is, `compare()` is handed the
 * pair under one string and reaches every other guard it has: the scoring
 * version, the collection path, the floor on n, the precision check.
 *
 * ⚠️ THIS IS THE ONLY PLACE A BASIS IS SET ASIDE, and only on `sameBasis`'s
 * word. A caller that compares across cycles without coming through here gets
 * a refusal, which is the safe way to be wrong.
 */

import { sameBasis } from '@bliprank/contracts/basis'
import { compare, type Comparison, type Metric } from '@bliprank/stats'

export function compareCycles(current: Metric, previous: Metric): Comparison {
  const oneSample = current.comparison_basis !== previous.comparison_basis && sameBasis(current.comparison_basis, previous.comparison_basis)
  return compare(current, oneSample ? { ...previous, comparison_basis: current.comparison_basis } : previous)
}

/** May two neighbouring points be joined by a line: the three things `compare()` refuses across, with the basis read by its own rule. */
export function continuousCycles(a: Metric, b: Metric): boolean {
  return a.algo_version === b.algo_version && a.collection_path === b.collection_path && sameBasis(a.comparison_basis, b.comparison_basis)
}
