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

import { BUNDLED_SCANS, runInfoOf, type ScanResultFile } from '@/lib/scan-result'

/** One source an answer cited, with the class the scan's own rules assigned it (ADR-0005, ADR-0014). */
export interface StoredCitation {
  readonly url: string
  readonly position: number
  readonly sourceClass: string
  /** The registrable domain the class was decided on. What a surface prints. */
  readonly domain: string
}

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
  /** Every source this answer cited, in the engine's order. Empty when it cited none. */
  readonly citations: readonly StoredCitation[]
  /** An answer to one of the customer's own prompts (ADR-0016): evidence for the second block, never counted in the headline's diagnostics. */
  readonly custom?: true
}

export interface ScanAnswers {
  readonly domain: string
  readonly category: string
  readonly day: string
  readonly comparisonBasis: string
  /** The scoring rule set that classified the citations; '' on a file written before they were carried. */
  readonly algoVersion: string
  readonly answers: readonly StoredAnswer[]
}

function parseCitations(value: unknown): readonly StoredCitation[] {
  if (!Array.isArray(value)) return []
  const out: StoredCitation[] = []
  for (const c of value) {
    const x = (c ?? {}) as Partial<StoredCitation>
    if (typeof x.url !== 'string' || !x.url || typeof x.sourceClass !== 'string' || typeof x.domain !== 'string') continue
    out.push({ url: x.url, position: typeof x.position === 'number' && Number.isFinite(x.position) ? x.position : out.length, sourceClass: x.sourceClass, domain: x.domain })
  }
  return out
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
/** The headline's own answers: everything that is not an answer to a custom prompt. The diagnostics count these and only these. */
export function headlineAnswers(answers: ScanAnswers): ScanAnswers {
  return { ...answers, answers: answers.answers.filter((a) => !a.custom) }
}

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
    citations: parseCitations((a as { citations?: unknown }).citations),
    ...((a as { custom?: unknown }).custom === true ? { custom: true as const } : {}),
  }))
  return {
    domain: v.domain,
    category: typeof v.category === 'string' ? v.category : '',
    day: typeof v.day === 'string' ? v.day : '',
    comparisonBasis: typeof v.comparisonBasis === 'string' ? v.comparisonBasis : '',
    algoVersion: typeof v.algoVersion === 'string' ? v.algoVersion : '',
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
  // The citations' classes are re-derived at read time under the scorer THEN in
  // force. If that is not the rule set the result was scored with, the classes
  // on screen are not the classes behind the result's own citation counts (R5).
  // A file too old to name a rule set is allowed, and says so on the surface.
  if (answers.algoVersion && scan.algoVersion && answers.algoVersion !== scan.algoVersion) {
    return `this evidence was classified under ${answers.algoVersion} while the numbers above were scored under ${scan.algoVersion}, so its source classes are not the ones behind them`
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
  // Membership by IDENTITY, not by domain: a later cycle of the bundled domain
  // that this browser collected is a session scan, and its evidence is on the
  // machine that collected it, not in the committed file for the earlier day.
  if (BUNDLED_SCANS.includes(scan)) return '/scan-answers.json'
  // The cycle's own day, so the route reads THAT cycle's answers and not the
  // latest one's — which, after a new cycle, may be a different measurement.
  const day = runInfoOf(scan).day
  return `/api/answers?domain=${encodeURIComponent(scan.domain)}${day ? `&day=${day}` : ''}`
}

/**
 * Evidence for one scan: the committed file when it is the reference scan, the
 * route when it is one this browser collected.
 *
 * Never throws. Every failure is a sentence a reader can act on, because this
 * sits under a number and "could not load" with no reason invites the reader to
 * assume the evidence is being withheld rather than missing.
 */
async function fetchAnswers(scan: ScanResultFile, fetchImpl: typeof fetch): Promise<AnswersResult> {
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
    // A static host that answers an unknown path with its own HTML not-found
    // page and a 200 is the deployment saying the route does not exist, not
    // the store saying something unparseable.
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      return { ok: false, message: 'The answers for this scan are not available in this build. They live on the machine that collected them.' }
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

/**
 * ONE DOWNLOAD PER SCAN. Two sections read the evidence now — the per-question
 * drawer and the cited sources — and the file is the largest thing on the
 * page. A successful read is memoised per evidence URL and basis for the life
 * of the page; a refusal is not, so a 404 on a deployment that later gains the
 * route, or a network blip, is retried on the next press. An injected fetch
 * (tests) bypasses the memo: a test that fakes two different servers for one
 * scan must see both.
 */
const memo = new Map<string, Promise<AnswersResult>>()

export function loadAnswers(scan: ScanResultFile, fetchImpl: typeof fetch = fetch): Promise<AnswersResult> {
  if (fetchImpl !== fetch) return fetchAnswers(scan, fetchImpl)
  const key = `${evidenceUrl(scan)}|${scan.comparisonBasis}`
  let held = memo.get(key)
  if (!held) {
    held = fetchAnswers(scan, fetchImpl).then((r) => {
      if (!r.ok) memo.delete(key)
      return r
    })
    memo.set(key, held)
  }
  return held
}
