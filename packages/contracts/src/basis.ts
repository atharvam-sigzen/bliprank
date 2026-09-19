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
 *
 * ⚠️ THE CUSTOM TAIL IDENTIFIES THE SAMPLE, NOT ONLY ITS LABEL (MVP_PLAN C3r
 * item 1). `custom=K@V` said how many prompts and which stored version, and a
 * version number is unique per host and store only: two different lists saved
 * as "3 prompts, version 1" on two domains wore one string, and `compare()`
 * would have put them side by side. The tail now ends in a fingerprint of the
 * list itself, `custom=K@V#<12 hex>` (repeats kept, order and spelling left
 * out: see `promptSetFingerprint`), made and read in this file and nowhere
 * else. With it the fingerprint is the identity and `@V` is the pointer to the
 * stored list: a person who goes back to a list they asked before gets a new
 * version number and the SAME sample, and `sameBasis` says so. A stored cycle
 * without the fingerprint still parses, byte for byte, and is the same basis
 * only as a string that is equal to it: what never recorded its list cannot
 * have it vouched for afterwards.
 *
 * ⚠️ NOTHING HERE MAY IMPORT A NODE-ONLY MODULE. Browser-side code reads this
 * file through the `/basis` subpath, which is why the hash is written out
 * below rather than taken from `node:crypto` (`basis.test.ts` holds it to
 * Node's own SHA-256 over a sweep of inputs).
 */

import { NORMALISATION_VERSION, normalisePrompt } from './normalise.js'

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
  readonly custom?: CustomBasis
}

/**
 * The custom tail. `fingerprint` is absent only on a string stored before
 * C3r; every writer goes through `customBasisOf`, which always sets it.
 */
export interface CustomBasis {
  readonly count: number
  readonly version: number
  readonly fingerprint?: string
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
  if (b.custom) {
    if (b.custom.fingerprint !== undefined && !FINGERPRINT.test(b.custom.fingerprint)) throw new Error(`basis fingerprint is not ${FINGERPRINT_HEX} lower-case hex characters: ${JSON.stringify(b.custom.fingerprint)}`)
    parts.push(`custom=${customText(b.custom)}`)
  }
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
      const m = /^(\d+)@(\d+)(?:#([0-9a-f]+))?$/.exec(customRaw)
      if (!m || (m[3] !== undefined && !FINGERPRINT.test(m[3]))) return null
      custom = { count: Number(m[1]), version: Number(m[2]), ...(m[3] !== undefined ? { fingerprint: m[3] } : {}) }
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

/**
 * IS THIS MEASUREMENT OVER A PERSON'S OWN SET, and which one: the custom tail
 * of a HEADLINE basis, or null. One predicate (MVP_PLAN C3r item 6), because
 * three readers each had their own and one of them had dropped half of it: the
 * re-score read any `custom=` tail as a headline set without asking for
 * `unprompted=0`.
 *
 * Both halves are the definition (ADR-0016 Amendment 1): the tail says whose
 * questions, and `unprompted=0` says the bank's were not asked beside them.
 * ⚠️ Call it on the HEADLINE's basis, the scan's own `comparisonBasis`.
 * Decision 4's second block carried a basis of the same shape on its own
 * field; the two are told apart by the field they live in, not by the string,
 * so a caller holding a block's basis must not ask this.
 */
export function headlineSetOf(headlineBasis: string | undefined): CustomBasis | null {
  const b = parseBasis(headlineBasis ?? '')
  return b?.custom && b.unprompted === 0 ? b.custom : null
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
 * The custom segment's line in the difference, or null when the two describe
 * one sample. Two fingerprinted tails over the same list are one sample
 * whatever their version numbers say; everything else is compared as written.
 * When the count and version read the same and the strings still differ, the
 * words say which of the two reasons it is, because "3@1 against 3@1" tells a
 * reader nothing.
 */
function customDifference(current: CustomBasis | undefined, previous: CustomBasis | undefined): string | null {
  if (!current && !previous) return null
  if (current && previous && sameList(current, previous)) return null
  const x = current ? `${current.count}@${current.version}` : 'absent'
  const y = previous ? `${previous.count}@${previous.version}` : 'absent'
  if (x !== y) return `${BASIS_LABELS.custom} (${y} against ${x})`
  // Said as what the two strings show, never as a history. "Two different lists" would be untrue of a list nobody touched
  // after a change of normaliser, and "stored before" would be untrue of a file an older build wrote later (stats review, MINOR 2 and 5).
  if (current?.fingerprint !== undefined && previous?.fingerprint !== undefined) return `${BASIS_LABELS.custom} (${x} on both, and the questions recorded for the two do not match)`
  if (current?.fingerprint !== previous?.fingerprint) return `${BASIS_LABELS.custom} (${x} on both, and one of them does not record which questions it held)`
  return null
}

/** One list, asked twice: both tails carry a fingerprint, the fingerprints agree, and so do the counts. The version is the pointer, not the identity. */
const sameList = (a: CustomBasis, b: CustomBasis): boolean => a.fingerprint !== undefined && a.fingerprint === b.fingerprint && a.count === b.count

/**
 * THE RULE FOR "THE SAME BASIS", in one place. Equal strings are the same
 * basis. Two strings that differ are the same basis in exactly one case: both
 * are canonical, both carry a fingerprinted custom tail over the same list,
 * and nothing else differs, so the only thing that moved is the version
 * number a revert to an earlier list is given. Anything else, including a
 * string this definition cannot parse, is a different basis.
 *
 * `compare()` (packages/stats) refuses on the raw string and does not open it.
 * A caller that compares across cycles asks this first and hands `compare()`
 * one string for the pair when it answers true (`compareCycles`,
 * apps/public/lib/cycles.ts). A caller that does not ask gets a refusal, never
 * a comparison it should not have had.
 */
export function sameBasis(a: string, b: string): boolean {
  return basisDifference(a, b) === null
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
    if (key === 'custom') {
      const line = customDifference(a.custom, b.custom)
      if (line) diffs.push(line)
      continue
    }
    const x = shown(a, key)
    const y = shown(b, key)
    if (x !== y) diffs.push(`${BASIS_LABELS[key]} (${y} against ${x})`)
  }
  return diffs.length ? `measured on a different basis: ${diffs.join(', ')}` : null
}

/**
 * THE SAME DIFFERENCE, FOR A READER WHO HAS NEVER SEEN A BASIS STRING (stats
 * review of C3r, MAJOR 3). `basisDifference` names segments for an auditor:
 * "the prompt count (17 against 0), the custom prompt set (absent against
 * 6@1)". On the record's day list, which is the plain reading of the trend,
 * that line told a client their second day "asked 0 prompts" directly after
 * telling them it asked "your 6 prompts": the segment counts the BANK's
 * questions, and `6@1` is notation. This says what changed between the two
 * days in the words a person would use, from the same parsed segments, so the
 * two readings cannot disagree about WHETHER something changed: it is null
 * exactly when `basisDifference` is.
 */
export function basisChangeWords(current: string, previous: string): string | null {
  if (basisDifference(current, previous) === null) return null
  const a = parseBasis(current)
  const b = parseBasis(previous)
  if (!a || !b) return 'the two days were measured in ways this record cannot line up'
  const said: string[] = []
  const questions = (x: Basis): string => (x.custom && x.unprompted === 0 ? `your own ${x.custom.count} ${x.custom.count === 1 ? 'question' : 'questions'} (version ${x.custom.version})` : `the category\u2019s ${x.unprompted} ${x.unprompted === 1 ? 'question' : 'questions'}`)
  if (b.unprompted !== a.unprompted || customDifference(a.custom, b.custom) !== null) {
    said.push(questions(a) === questions(b) ? 'the questions asked were not the same list, though saved under the same count and version' : `the day before was asked ${questions(b)}, and this day ${questions(a)}`)
  }
  if (b.bank.slug !== a.bank.slug) said.push('the category it was measured under changed')
  else if (b.bank.version !== a.bank.version) said.push(`the category\u2019s question bank moved from version ${b.bank.version} to version ${a.bank.version}`)
  if ([...a.engines].sort().join(',') !== [...b.engines].sort().join(',')) said.push('it was asked on a different set of AI engines')
  if (a.locale !== b.locale || a.geo !== b.geo) said.push('it was asked for a different language or country')
  if (a.runs !== b.runs) said.push('each question was asked a different number of times')
  if (a.set !== b.set) said.push('the list of competitors it is scored against was changed')
  if (a.format !== b.format) said.push('it was measured by a different method')
  return said.length ? said.join('; ') : 'the two days were measured in ways this record cannot line up'
}

/**
 * IS THE LIST A STORE HOLDS NOW THE LIST A STORED CYCLE ASKED? The version in a
 * basis is a pointer into a store a person can edit; the count, and since C3r
 * item 1 the fingerprint, say what the pointer pointed at. One check, for every
 * reader that re-reads a set by version (the re-score pre-flight, the evidence
 * reader): a reader that skipped it would re-derive, or show evidence for, a
 * different sample under the old cycle's name. A tail stored before the
 * fingerprint can only be held to its count, and that is said where it is used.
 */
export function customBasisMismatch(stored: CustomBasis, prompts: readonly string[]): 'count' | 'fingerprint' | null {
  if (prompts.length !== stored.count) return 'count'
  return stored.fingerprint !== undefined && promptSetFingerprint(prompts) !== stored.fingerprint ? 'fingerprint' : null
}

// ------------------------------------------------------------ the fingerprint

const FINGERPRINT_HEX = 12
const FINGERPRINT = new RegExp(`^[0-9a-f]{${FINGERPRINT_HEX}}$`)

const customText = (c: CustomBasis): string => `${c.count}@${c.version}${c.fingerprint !== undefined ? `#${c.fingerprint}` : ''}`

/**
 * The fingerprint of a prompt list. THE RECIPE, WHOLE, so anyone holding the
 * list can reproduce it with a standard tool: put each prompt through the
 * cache key's own normaliser; sort the results by code unit; take the SHA-256
 * of the UTF-8 JSON text of `[NORMALISATION_VERSION, [the sorted prompts]]`;
 * keep its first twelve hex characters. No prompt is dropped and none is
 * merged (`basis.test.ts` holds the code to exactly this, for every list).
 *
 * WHAT IS LEFT OUT, AND WHAT IS NOT. Order and spelling are left out because
 * they are left out of the measurement: the cache key normalises a prompt
 * before it keys the cell, and a cycle's answers are pooled whatever order the
 * cells were asked in. REPEATS ARE KEPT, because a cycle asks one cell per
 * list ENTRY (`customCellsFor`, services/grader/src/scan.ts): a prompt listed
 * twice is a question weighted twice, so [A, A, B] and [A, B, B] are two
 * samples at one K and must not wear one string. An earlier draft dropped
 * repeats and the statistics review measured exactly that pair sharing a
 * basis (MAJOR 1). The saved path never stores a repeat
 * (`checkCustomPromptsWith`); this is what holds when a list arrives some
 * other way.
 *
 * The normaliser's version is inside the hash because a change of normaliser
 * changes the cells, and so the sample: the fingerprint then moves because
 * its definition says so, not by accident.
 *
 * Forty-eight bits is enough for what it guards. The case that matters is two
 * lists meeting by chance within ONE domain's history at the same count: the
 * birthday bound, about 2 in 10^11 at a hundred versions. Nobody gains by
 * forging one, since the only comparison a forged fingerprint unlocks is
 * between two of the forger's own numbers.
 */
export function promptSetFingerprint(prompts: readonly string[]): string {
  const list = prompts.map(normalisePrompt).sort()
  return sha256Hex(new TextEncoder().encode(JSON.stringify([NORMALISATION_VERSION, list]))).slice(0, FINGERPRINT_HEX)
}

/** THE ONLY WAY A WRITER MAKES THE CUSTOM TAIL: the count, the stored version, and the fingerprint of the list itself. */
export function customBasisOf(prompts: readonly string[], version: number): CustomBasis {
  return { count: prompts.length, version, fingerprint: promptSetFingerprint(prompts) }
}

// SHA-256 (FIPS 180-4), written out because this file runs in a browser bundle
// where `node:crypto` does not resolve and WebCrypto's digest is asynchronous.
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** Exported for `basis.test.ts`, which holds it to Node's implementation; nothing else should need it. */
export function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32))
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0)
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!
      const y = w[i - 2]!
      w[i] = (w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    const next = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) | 0
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('')
}
