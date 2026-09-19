/**
 * The cache key — CLAUDE.md rule R6, ADR-0003.
 *
 *   key = sha256( JSON [normalised_prompt, engine, locale, geo, date_bucket] )
 *
 * Primary key of the answer store, Redis lookup key, R2 object identity and
 * the unit of the benchmark corpus. Its shape does not change without an ADR.
 */

import { createHash } from 'node:crypto'
import { ENGINES, type EngineId } from './engines.js'
import { canonicalGeo } from './geo.js'
import { NORMALISATION_VERSION, normalisePrompt } from './normalise.js'

// The normaliser lives in `normalise.ts` (no Node-only import, so the basis can
// share it in a browser bundle) and is re-exported here, where every caller
// already finds it. Same function, same version, same keys.
export { NORMALISATION_VERSION, normalisePrompt }

export interface CacheKeyInput {
  /** Raw prompt as authored; normalised here for keying only. */
  readonly prompt: string
  readonly engine: EngineId
  /** BCP-47 language tag, any casing, e.g. 'en-in'. */
  readonly locale: string
  /** ISO 3166-1 alpha-2 country, any casing; aliases resolved (UK → GB), e.g. 'in'. */
  readonly geo: string
  /**
   * The collection *cycle's* date (UTC), assigned by the scheduler — not the
   * wall-clock time of the call, so a cycle spanning midnight stays one cell.
   */
  readonly dateBucket: Date | string
}

/** A fully canonicalised cell plus its key. Everything needed to reproduce `key`. */
export interface CacheCell {
  readonly key: string
  readonly normalisedPrompt: string
  readonly engine: EngineId
  /** Canonical BCP-47, e.g. 'en-IN'. */
  readonly locale: string
  /** Upper-case alpha-2, e.g. 'IN'. */
  readonly geo: string
  /** 'YYYY-MM-DD', UTC. */
  readonly dateBucket: string
  readonly normalisationVersion: number
}

const DATE_BUCKET = /^\d{4}-\d{2}-\d{2}$/

export function cacheCell(input: CacheKeyInput): CacheCell {
  if (!(ENGINES as readonly string[]).includes(input.engine)) {
    throw new RangeError(`unknown engine: ${input.engine}`)
  }
  // Intl.getCanonicalLocales throws RangeError on a malformed tag — that is the validation.
  const locale = Intl.getCanonicalLocales(input.locale)[0]
  if (!locale) throw new RangeError(`invalid locale: ${input.locale}`)
  const geo = canonicalGeo(input.geo)
  const dateBucket =
    input.dateBucket instanceof Date ? input.dateBucket.toISOString().slice(0, 10) : input.dateBucket
  if (!DATE_BUCKET.test(dateBucket) || Number.isNaN(Date.parse(`${dateBucket}T00:00:00Z`))) {
    throw new RangeError(`dateBucket must be YYYY-MM-DD: ${String(input.dateBucket)}`)
  }
  const normalisedPrompt = normalisePrompt(input.prompt)
  if (normalisedPrompt === '') throw new RangeError('prompt is empty after normalisation')

  // JSON array = canonical, delimiter-safe serialisation. Field order is the schema.
  const key = createHash('sha256')
    .update(JSON.stringify([normalisedPrompt, input.engine, locale, geo, dateBucket]))
    .digest('hex')

  return {
    key,
    normalisedPrompt,
    engine: input.engine,
    locale,
    geo,
    dateBucket,
    normalisationVersion: NORMALISATION_VERSION,
  }
}

/** Convenience: just the key. */
export const cacheKey = (input: CacheKeyInput): string => cacheCell(input).key
