/**
 * THE ANSWERS THEMSELVES, fetched only when a reader asks to read them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHY THIS IS LOADED AND NOT BUNDLED.
 *
 * Measured, not assumed: one scan's answer text is 200,311 characters —
 * 191 KB raw, 64 KB gzipped, against the 2.5 KB gzipped that the whole result
 * file weighs. `apps/public` is on Cloudflare Pages precisely because it sits on
 * acquisition traffic nobody can forecast (ADR-0002), and putting 64 KB of
 * evidence into the first paint of a landing page — for the overwhelming
 * majority of visitors who will never open it — is the wrong trade.
 *
 * A dynamic `import()` was tried first and MEASURED TO WORK: webpack emitted it
 * as its own 221 KB chunk, on no page's critical path. It is not what shipped,
 * and the reason is worth writing down because the obvious one is wrong.
 *
 * The evidence is a STATIC ASSET under `public/`, fetched at runtime, because:
 *
 *   - ADR-0002 puts this app on Cloudflare Pages specifically because static
 *     asset requests there are free and unlimited. A JSON file is one of those.
 *     A 221 KB JS chunk is not: it is JavaScript, parsed by the JS engine, to
 *     hand back an object a JSON parser would have produced faster.
 *   - It collapses two mechanisms into one. Both sources below are now a fetch,
 *     and `loadAnswers` has a single path with a single set of failure modes.
 *   - It takes the bundler out of the decision. Code-splitting is a compiler
 *     behaviour that a config change or a version bump can quietly alter; a file
 *     under `public/` cannot end up in a chunk because nothing compiles it.
 *
 * ⚠️ AND A NOTE ON HOW THIS WAS MEASURED, because the first attempt got it
 * wrong. Searching the built chunks for a string from the corpus found it on
 * every critical path — but the string was a PROMPT, which `@bliprank/taxonomy`
 * legitimately ships to the client for the pre-flight screen. Answer text has to
 * be searched for with a phrase that can only come from an answer. A needle that
 * matches two different things measures neither.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO SOURCES, ONE FUNCTION, AND THE SPLIT MIRRORS HOW SCANS ALREADY REACH THIS
 * APP.
 *
 *   BUNDLED — the committed reference scan. Its evidence is a static file at
 *   `/scan-answers.json`, which Cloudflare Pages serves for free and which
 *   exists on a static export where there is no server and no route.
 *
 *   SESSION — a scan this browser ran through /api/scan, which exists only on
 *   the local demo. Its evidence comes from the route, read back out of the
 *   answer store on the machine that collected it.
 *
 * Neither path stores answer text in `localStorage`. `rememberScan` keeps every
 * scan a browser has run, and 191 KB of text per scan against a ~5 MB quota
 * would start silently failing to remember scans that cost real money after
 * about twenty-five of them — and `rememberScan` swallows that failure by
 * design, so the symptom would be "your scan is gone".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE BASIS IS CHECKED BEFORE A SINGLE ANSWER IS SHOWN.
 *
 * `comparison_basis` identifies the sample: engines, locale, geo, category and
 * version, prompt count, runs. If the evidence file's basis is not the result's
 * basis, these are the answers to a different measurement — a different prompt
 * count, or a category whose competitor set has since moved — and showing them
 * under this number would be worse than showing nothing, because a reader
 * checking our arithmetic would be checking it against the wrong input.
 */

import { BUNDLED_SCANS, type ScanResultFile } from '@/lib/scan-result'

export interface StoredAnswer {
  readonly prompt: string
  readonly engine: string
  /** Verbatim and whole, exactly as the engine returned it. Never excerpted. */
  readonly text: string
  /**
   * The engine returned no answer text at all.
   *
   * ⚠️ NOT THE SAME CLAIM AS "did not mention you", and the difference is on the
   * sheet. Every empty answer in this corpus is a `google-ai-overviews` cell
   * where Google showed no AI Overview for the query. The scorer counts it as an
   * answer in which the brand was not mentioned — pipedrive.com's published
   * 38/85 = 44.71% against 38/83 = 45.78% without them. Whether an absent
   * overview belongs in the denominator is a scoring rule and human-owned; what
   * this flag does is stop a blank box reading as a silent engine.
   */
  readonly empty: boolean
  readonly collectedAt: string
}

export interface ScanAnswers {
  readonly domain: string
  readonly category: string
  readonly day: string
  readonly comparisonBasis: string
  readonly answers: readonly StoredAnswer[]
}

/** What a surface gets back: the evidence, or a sentence saying why not. */
export type AnswersResult = { readonly ok: true; readonly answers: ScanAnswers } | { readonly ok: false; readonly message: string }

function isStoredAnswer(a: unknown): a is StoredAnswer {
  if (typeof a !== 'object' || a === null) return false
  const x = a as Partial<StoredAnswer>
  return typeof x.prompt === 'string' && typeof x.engine === 'string' && typeof x.text === 'string'
}

/**
 * Shape guard. The bundled file is committed and the route is ours, but both
 * arrive as untyped JSON and one malformed entry would reach `.text.length` in a
 * render. Same discipline as `isScanBrand`.
 */
export function parseAnswers(value: unknown): ScanAnswers | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<ScanAnswers>
  if (typeof v.domain !== 'string' || !Array.isArray(v.answers)) return null
  const answers = v.answers.filter(isStoredAnswer).map((a) => ({
    prompt: a.prompt,
    engine: a.engine,
    text: a.text,
    // Derived here rather than trusted, so a file written before the flag
    // existed still distinguishes an absent answer from a silent one.
    empty: a.empty === true || a.text.trim() === '',
    collectedAt: typeof a.collectedAt === 'string' ? a.collectedAt : '',
  }))
  return {
    domain: v.domain,
    category: typeof v.category === 'string' ? v.category : '',
    day: typeof v.day === 'string' ? v.day : '',
    comparisonBasis: typeof v.comparisonBasis === 'string' ? v.comparisonBasis : '',
    answers,
  }
}

/**
 * Do these answers belong to this result?
 *
 * The domain must match and the basis must match. An evidence file recording no
 * basis at all is REFUSED rather than accepted — unlike a missing cost or a
 * missing run block, where absence is the honest state, here the whole point is
 * to prove these answers produced these numbers, and an unverifiable claim is
 * exactly the thing this feature exists to replace.
 */
export function belongsTo(answers: ScanAnswers, scan: ScanResultFile): string | null {
  if (typedDomain(answers.domain) !== typedDomain(scan.domain)) return `these answers were collected for ${answers.domain}, not ${scan.domain}`
  if (!answers.comparisonBasis) return 'this evidence file does not record which measurement it belongs to'
  if (answers.comparisonBasis !== scan.comparisonBasis) {
    return 'these answers are from a scan measured on a different basis, so they are not the input to the numbers above'
  }
  return null
}

/** Answers for one prompt on one engine. An array, because a cell may hold more than one run. */
export type AnswerIndex = ReadonlyMap<string, readonly StoredAnswer[]>

export const answerKey = (prompt: string, engine: string): string => `${prompt} ${engine}`

export function indexAnswers(answers: ScanAnswers): AnswerIndex {
  const byKey = new Map<string, StoredAnswer[]>()
  for (const a of answers.answers) {
    const k = answerKey(a.prompt, a.engine)
    const held = byKey.get(k)
    if (held) held.push(a)
    else byKey.set(k, [a])
  }
  return byKey
}

const typedDomain = (d: string) => d.trim().toLowerCase().replace(/^www\./, '')

/**
 * Where this scan's evidence lives.
 *
 * ⚠️ MEMBERSHIP IS CHECKED BEFORE THE FETCH, not after. A scan this browser
 * collected must not download 191 KB of the reference scan's answers purely to
 * discover they are the wrong ones. `BUNDLED_SCANS` is already in memory and
 * answers the question for free.
 *
 * The URL identifies the file; `belongsTo` then checks the basis, because a
 * matching domain is not a matching measurement.
 */
export function evidenceUrl(scan: ScanResultFile): string {
  return BUNDLED_SCANS.some((b) => typedDomain(b.domain) === typedDomain(scan.domain))
    ? '/scan-answers.json'
    : `/api/answers?domain=${encodeURIComponent(scan.domain)}`
}

/**
 * Evidence for one scan: the committed file when it is the reference scan, the
 * route when it is one this browser collected.
 *
 * Never throws. Every failure is a sentence a reader can act on, because this
 * sits under a number and "could not load" with no reason invites the reader to
 * assume the evidence is being withheld rather than missing.
 */
export async function loadAnswers(scan: ScanResultFile, fetchImpl: typeof fetch = fetch): Promise<AnswersResult> {
  let raw: unknown
  try {
    const res = await fetchImpl(evidenceUrl(scan))
    if (!res.ok) {
      // A static export has no route handlers at all, so a session scan's
      // evidence answers 404 there. That is a fact about the deployment, not
      // about the scan, and the message may not imply otherwise.
      return {
        ok: false,
        message:
          res.status === 404
            ? 'The answers for this scan are not available in this build. They live on the machine that collected them.'
            : `The answer store answered ${res.status}, so the text behind these numbers could not be read.`,
      }
    }
    raw = (await res.json()) as unknown
  } catch (e) {
    return { ok: false, message: `Could not reach the answer store: ${(e as Error).message}` }
  }

  const parsed = parseAnswers(raw)
  if (!parsed) return { ok: false, message: 'The evidence file for this scan could not be read.' }
  const wrong = belongsTo(parsed, scan)
  if (wrong) return { ok: false, message: `${wrong}. Nothing is shown rather than the wrong text under the right number.` }
  return { ok: true, answers: parsed }
}
