/**
 * THE COMPARISON BASIS — everything that must match before two numbers may be
 * put side by side. One definition, shared by the writer (the grader stamps
 * it on every metric) and the reader (the public app explains, segment by
 * segment, why two cycles are not comparable). ADR-0016.
 *
 * ⚠️ WHY THIS FILE EXISTS. Until 2026-09-03 the writer lived in the grader and
 * the reader's labels lived in the public app, two hand-maintained lists in
 * two packages with no test between them. A segment added to one and not the
 * other would have printed "basis field 8" to a customer, or explained the
 * wrong segment. The parser also recovered two of the seven segments, so
 * locale, geography and bank version were unreadable by code.
 *
 * ⚠️ THE STRING IS PROVENANCE, NOT A CONVENIENCE. Every stored measurement
 * carries one, and `compare()` refuses across any difference. So:
 *
 *   - The first seven segments are POSITIONAL and NEVER REORDERED. Three stored
 *     scans and the bundled reference carry the seven-segment form, and
 *     `formatBasis` must reproduce those strings byte for byte (pinned in
 *     `basis.test.ts`).
 *   - Anything new is a KEYED TAIL segment, appended only when it applies. A
 *     measurement with no competitor override and no custom prompts formats
 *     exactly as it did before this file existed, so nothing already stored
 *     becomes "not comparable" with its own successor by an accident of shape.
 *   - A reader that meets a key it does not know reports it by key rather than
 *     by position, so a newer writer and an older reader still say something
 *     true.
 */

export interface Basis {
  /** The measurement family. Only 'grader' exists. */
  readonly format: string
  /** Engine ids, sorted, so argument order can never make two identical scans differ. */
  readonly engines: readonly string[]
  readonly locale: string
  readonly geo: string
  /** The prompt bank the curated prompts came from, at the version whose competitor set applied. */
  readonly bank: { readonly slug: string; readonly version: number }
  /** How many curated (unprompted) prompts this measurement covers. 0 on a measurement over custom prompts only. */
  readonly unprompted: number
  readonly runs: number
  /**
   * Per-domain competitor override version (ADR-0016). Absent means the
   * category's competitor set alone applied. Present on every measurement of a
   * domain from the moment its first override is applied.
   */
  readonly set?: number
  /**
   * A measurement over the customer's own prompts: how many, at which stored
   * version (ADR-0016). Absent on the curated measurement. The two are separate
   * measurements with separate basis strings; they are never mixed.
   */
  readonly custom?: { readonly count: number; readonly version: number }
}

/** Plain words for each segment, for the reader's "measured on a different basis" line. Keyed, so it cannot drift from the shape. */
export const BASIS_LABELS: Readonly<Record<keyof Basis, string>> = {
  format: 'the basis format',
  engines: 'the engine set',
  locale: 'the locale',
  geo: 'the geography',
  bank: 'the bank version',
  unprompted: 'the prompt count',
  runs: 'the runs per cell',
  set: 'the competitor set',
  custom: 'the custom prompt set',
}

/** The order segments are written and compared in. The first seven are positional and fixed. */
export const BASIS_KEYS = ['format', 'engines', 'locale', 'geo', 'bank', 'unprompted', 'runs', 'set', 'custom'] as const satisfies readonly (keyof Basis)[]

const POSITIONAL = 7

/** The string every metric carries. Byte-identical to the pre-ADR-0016 form when no tail segment applies. */
export function formatBasis(b: Basis): string {
  const parts = [
    b.format,
    `engines=${[...b.engines].sort().join(',')}`,
    b.locale,
    b.geo,
    `${b.bank.slug}@${b.bank.version}`,
    `unprompted=${b.unprompted}`,
    `runs=${b.runs}`,
  ]
  if (b.set !== undefined) parts.push(`set=${b.set}`)
  if (b.custom) parts.push(`custom=${b.custom.count}@${b.custom.version}`)
  // A separator inside a field would silently become an extra segment on every metric of a scan. Refuse here, the one place the string is made.
  const bad = parts.find((p) => p.includes('|'))
  if (bad !== undefined) throw new Error(`basis field contains the separator: ${JSON.stringify(bad)}`)
  return parts.join('|')
}

const int = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null)
const keyed = (s: string | undefined, key: string): string | null => (s !== undefined && s.startsWith(`${key}=`) ? s.slice(key.length + 1) : null)

/**
 * The inverse of `formatBasis`. Null when the string is not a basis this
 * definition can read; the caller supplies its own default, because a
 * measurement that never recorded its scope cannot have it recovered, and
 * guessing narrow is as wrong as guessing wide.
 *
 * ⚠️ CANONICAL OR NOTHING. `compare()` refuses on the raw string, so two
 * strings that differ at all are two bases, and a parser that read them as one
 * would let the record print "nothing differs" under a refused comparison. A
 * string parses only if writing the result back reproduces it byte for byte:
 * a repeated tail key, a tail out of order, a leading zero, an unsorted engine
 * list are all null here and compared as raw text below.
 */
export function parseBasis(s: string): Basis | null {
  const b = parseLoosely(s)
  return b && formatBasis(b) === s ? b : null
}

function parseLoosely(s: string): Basis | null {
  const parts = s.split('|')
  if (parts.length < POSITIONAL) return null
  const [format, enginesRaw, locale, geo, bankRaw, unpromptedRaw, runsRaw, ...tail] = parts
  const engines = keyed(enginesRaw, 'engines')
  const at = bankRaw?.lastIndexOf('@') ?? -1
  const bankVersion = at > 0 ? int(bankRaw!.slice(at + 1)) : null
  const unprompted = int(keyed(unpromptedRaw, 'unprompted') ?? undefined)
  const runs = int(keyed(runsRaw, 'runs') ?? undefined)
  if (!format || engines === null || !locale || !geo || bankVersion === null || unprompted === null || runs === null) return null

  let set: number | undefined
  let custom: Basis['custom']
  for (const t of tail) {
    const setRaw = keyed(t, 'set')
    const customRaw = keyed(t, 'custom')
    if (setRaw !== null) {
      const v = int(setRaw)
      if (v === null) return null
      set = v
    } else if (customRaw !== null) {
      const m = /^(\d+)@(\d+)$/.exec(customRaw)
      if (!m) return null
      custom = { count: Number(m[1]), version: Number(m[2]) }
    } else {
      return null
    }
  }
  return {
    format,
    engines: engines === '' ? [] : engines.split(','),
    locale,
    geo,
    bank: { slug: bankRaw!.slice(0, at), version: bankVersion },
    unprompted,
    runs,
    ...(set !== undefined ? { set } : {}),
    ...(custom ? { custom } : {}),
  }
}

/** One segment's value in words, for the difference line. */
function shown(b: Basis, key: keyof Basis): string {
  const v = b[key]
  if (v === undefined) return 'absent'
  if (key === 'engines') return (v as readonly string[]).join(',')
  if (key === 'bank') return `${b.bank.slug}@${b.bank.version}`
  if (key === 'custom') return `${b.custom!.count}@${b.custom!.version}`
  return String(v)
}

/**
 * Which segments of two basis strings differ, in words a reader can act on:
 * "measured on a different basis: the bank version (crm-software@1 against
 * crm-software@2)". Null when nothing differs. Previous is named first, then
 * current, matching how the record reads.
 *
 * A string this definition cannot parse (an older form, a hand-edited file)
 * gets one line naming both strings whole. Labelling its segments by position
 * would put the wrong word on every one; the whole string is the only true
 * thing that can be said about it.
 */
export function basisDifference(current: string, previous: string): string | null {
  if (current === previous) return null
  const a = parseBasis(current)
  const b = parseBasis(previous)
  if (!a || !b) return `measured on a different basis: the basis (${previous || 'absent'} against ${current || 'absent'})`
  const diffs: string[] = []
  for (const key of BASIS_KEYS) {
    const x = shown(a, key)
    const y = shown(b, key)
    if (x !== y) diffs.push(`${BASIS_LABELS[key]} (${y} against ${x})`)
  }
  return diffs.length ? `measured on a different basis: ${diffs.join(', ')}` : null
}
