/**
 * Authoring a prompt bank for a category the taxonomy does not have — behind a
 * provider seam, so the model can be swapped without touching code.
 *
 * ADR-0009 rung 4. Everything about WHY this exists, and about the competitor
 * rule it must never break, is in `resolve-category.ts`. This module is only
 * about getting one prompt set out of some model and refusing anything else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SEAM, AND WHY IT IS ENV-DRIVEN RATHER THAN A CODE CHOICE.
 *
 * The default models are free tiers. Free tiers get rate-limited, deprecated and
 * withdrawn, usually at the least convenient moment, and the response to that
 * must be editing one line of `.env.local` — not a deploy. So:
 *
 *   BANK_AUTHOR_MODEL           the model. Change this alone to swap models.
 *   BANK_AUTHOR_FALLBACK_MODEL  tried when the first one fails. '' disables it.
 *   BANK_AUTHOR_PROVIDER        'openai-compatible' (default) or 'anthropic'.
 *   BANK_AUTHOR_BASE_URL        any OpenAI-compatible host. Default OpenRouter.
 *   BANK_AUTHOR_API_KEY         else OPENROUTER_API_KEY, else ANTHROPIC_API_KEY.
 *
 * OpenRouter rather than Nvidia's API directly, and it is the simpler of the two
 * here rather than the more capable: the `vendor/model:free` slugs ARE
 * OpenRouter's addressing scheme, one key reaches both named models and every
 * later replacement for them, and the wire format is the OpenAI chat-completions
 * shape that essentially every host speaks. Pointing `BANK_AUTHOR_BASE_URL` at
 * Nvidia's own NIM endpoint needs no code change either — that is the point of
 * the seam.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ NO `response_format`, DELIBERATELY, AND THE PARSER CARRIES THE WEIGHT.
 *
 * Sending `response_format: {type:'json_object'}` is the textbook way to ask for
 * JSON, and on a fleet of free models it is a trap: a host that does not support
 * it for the chosen model answers 400. That failure is indistinguishable from
 * "the model is down", so the configured model would silently never run and the
 * fallback would answer every request — with nobody told that the model they
 * chose was not the one being used.
 *
 * So the request asks for JSON in words, and `parseCandidate` is written to
 * survive what models actually return: a fenced block, a preamble, a trailing
 * apology. Defensive parsing is needed regardless of the flag, so the flag buys
 * nothing and costs a whole failure mode.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE COMPETITOR RULE SURVIVES A LOOSER PROVIDER. THIS IS THE IMPORTANT PART.
 *
 * With the Anthropic tool schema, "no competitors" was STRUCTURAL: the schema had
 * no such field, so the model could not supply one. A free model answering with
 * open JSON can put `"competitors": ["Razer", "Logitech"]` in the object, and
 * some will, because homepages are full of rivals and being helpful is what these
 * models do.
 *
 * That is fine, and it changes nothing, because the enforcement was never the
 * schema alone:
 *
 *   1. `parseCandidate` reads exactly three keys and ignores every other one.
 *      There is no path by which a competitor field reaches a `GeneratedBank`;
 *      the type has nowhere to put it.
 *   2. `resolve-category.ts` constructs `leaders: []` itself, from nothing.
 *   3. `readGeneratedBanks` DROPS a stored bank that has acquired leaders, so a
 *      hand-edited file cannot reintroduce them either.
 *
 * Three independent refusals, and the tests feed a response full of invented
 * rivals to prove all three hold. A model that mentions competitors is not an
 * error; it is a field nothing reads.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { fileCapUsd, ledgerStores, type LedgerStores } from './ledger-stores.js'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { Budget } from '@bliprank/collector'

/** Change this alone to swap models. */
export const DEFAULT_BANK_AUTHOR_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'

/**
 * Tried when the primary fails for ANY reason, including a schema refusal.
 *
 * ⚠️ A DIFFERENT VENDOR FROM THE PRIMARY, ON PURPOSE. The first failure this
 * chain ever saw in anger was "Upstream error from Nvidia: Service temporarily
 * overloaded" — a vendor-side outage, not a model-side one. A fallback from the
 * same vendor is not a fallback; it is the same outage twice, with the second
 * copy costing another timeout before anyone is told.
 *
 * Chosen by measurement, not from a list. Against the real task on 2026-09-01:
 * both free Nemotrons timed out past 40s, `google/gemma-4-31b-it:free` and
 * `z-ai/glm-5.2:free` answered 429 "temporarily rate-limited upstream", and this
 * one produced a valid bank in ~8s. That ranking will change — which is the
 * entire reason it is an env var.
 *
 * An OpenRouter slug, so it is only defaulted for the default OpenRouter setup —
 * see `bankAuthorConfig`. Point the base URL somewhere else and this has to be
 * named, or it would be a second attempt at a model that host cannot serve.
 */
export const DEFAULT_BANK_AUTHOR_FALLBACK_MODEL = 'minimax/minimax-m3:free'

export const DEFAULT_BANK_AUTHOR_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Per attempt, not for the whole author.
 *
 * Two attempts at 25s fit inside the preview route's 60s ceiling with room for
 * the homepage fetch that preceded them. A free tier that hangs is the common
 * case, not the rare one, and a person is waiting on this.
 *
 * ⚠️ THE CEILING IS THE ROUTE'S, NOT THE MODEL'S, AND IT IS NOT GENEROUS. On
 * 2026-09-01 the free Nemotron tier did not finish inside FORTY seconds. Raising
 * this to suit it would push two attempts past the route's own limit, so the
 * honest answer is that a model too slow for 25s is a model this cannot use
 * today — and the fallback is what makes that survivable rather than fatal.
 */
export const DEFAULT_BANK_AUTHOR_TIMEOUT_MS = 25_000

export const GENERATED_DISCOVERY = 10
export const GENERATED_PROBLEM_LED = 7

/**
 * The author's own dollar ledger — `bank-author-ledger.json` in the data dir.
 *
 * ⚠️ EVERY MODEL ATTEMPT IS CHARGED BEFORE IT IS MADE, whichever provider
 * answers, through the same `Budget` the collector uses (R3). The 2026-09-09
 * audit found this path reachable from the public preview route with a request
 * cap but no dollar ledger. The default models are free tiers, so the default
 * price is $0 and the ledger still COUNTS every attempt; point
 * `BANK_AUTHOR_MODEL` at a paid model and `BANK_AUTHOR_USD_PER_CALL` is the
 * price that makes the cap mean something. A cap that is reached is a failure
 * like any other here: the bank is null and the domain falls back to the
 * general bucket — authoring degrades, a scan never breaks.
 */
export interface AuthorLedger {
  readonly file: string
  readonly capUsd: number
  readonly usdPerCall: number
  /** Where the ledger lives: Upstash on the deployment, the file otherwise (ledger-stores.ts, MVP_PLAN B3b). Resolved from the file's directory when absent. */
  readonly stores?: LedgerStores
}
export const DEFAULT_BANK_AUTHOR_CAP_USD = 5
export const DEFAULT_BANK_AUTHOR_USD_PER_CALL = 0
export const authorLedgerFile = (dataDir: string): string => join(dataDir, 'bank-author-ledger.json')

/**
 * Charge one attempt on `model`. Throws `BudgetExceeded` before any request.
 *
 * The file's own cap wins over the configured one, exactly as `ledgerCapUsd`
 * does for the collector's ledger: `Budget` refuses to RAISE a cap from code,
 * so a ledger a person raised by hand is not written back down by a default.
 */
async function chargeAttempt(ledger: AuthorLedger, model: string): Promise<void> {
  // A file's own cap wins over the configured one; an unreadable file is
  // `Budget`'s to refuse. In KV the configured cap is the cap.
  const stores = ledger.stores ?? ledgerStores(dirname(ledger.file), process.env)
  const capUsd = (stores.backend === 'file' ? fileCapUsd(ledger.file) : null) ?? ledger.capUsd
  await stores.spend(basename(ledger.file), capUsd, () => ledger.usdPerCall).charge(model)
}

export type BankAuthorProvider = 'openai-compatible' | 'anthropic'

export interface BankAuthorConfig {
  readonly provider: BankAuthorProvider
  readonly model: string
  /** '' or undefined disables the second attempt. */
  readonly fallbackModel?: string | undefined
  readonly baseUrl: string
  readonly apiKey: string
  readonly timeoutMs: number
  /** Where every attempt is charged. Required: there is no unmetered config. */
  readonly ledger: AuthorLedger
}

export interface GenerateInput {
  readonly host: string
  readonly title: string
  readonly description: string
  readonly headings: string
  readonly existingSlugs: readonly string[]
  readonly config: BankAuthorConfig
  /** Injected in tests; production gets the global. */
  readonly fetchImpl?: typeof fetch
  readonly log?: (message: string) => void
}

export interface GeneratedBank {
  readonly displayName: string
  readonly description: string
  readonly prompts: readonly { readonly text: string; readonly intent: 'discovery' | 'problem-led' }[]
  /** Which model actually answered. Provenance: it goes on the record. */
  readonly model: string
}

/**
 * Resolve the author's configuration from the environment.
 *
 * Returns null when no key can be found, which is the "authoring is off" state —
 * `resolveCategory` then falls back exactly as it did before authoring existed.
 * `readKey` is passed in rather than imported so this stays free of the dotenv
 * loader's file IO and can be exercised without one.
 */
export function bankAuthorConfig(env: NodeJS.ProcessEnv, readKey: (name: string) => string | undefined, dataDir: string, ledgers?: LedgerStores): BankAuthorConfig | null {
  const provider = (env['BANK_AUTHOR_PROVIDER'] ?? 'openai-compatible') as BankAuthorProvider
  // Explicit key first, then the conventional name for whichever provider is
  // selected. Two names rather than one because a machine may legitimately hold
  // both, and "which key does this use" should not depend on ordering.
  const apiKey =
    readKey('BANK_AUTHOR_API_KEY') ?? (provider === 'anthropic' ? readKey('ANTHROPIC_API_KEY') : readKey('OPENROUTER_API_KEY'))
  if (!apiKey) return null

  /*
   * THE DEFAULT FALLBACK ONLY APPLIES TO THE DEFAULT SETUP.
   *
   * `minimax/minimax-m3:free` is an OpenRouter slug. Carrying it
   * into an Anthropic config, or one pointed at Nvidia's own NIM endpoint,
   * names a model that host has never heard of — so the second attempt is
   * guaranteed to fail, and to fail in the one place nobody looks, since a
   * failed fallback is silent by design.
   *
   * Change the provider or the host and the fallback becomes something you
   * have to name. Nothing is inferred, and a single-model setup is a perfectly
   * good answer.
   */
  const baseUrl = env['BANK_AUTHOR_BASE_URL']
  const isDefaultSetup = provider !== 'anthropic' && (baseUrl === undefined || baseUrl.replace(/\/+$/, '') === DEFAULT_BANK_AUTHOR_BASE_URL)
  const fallback = env['BANK_AUTHOR_FALLBACK_MODEL'] ?? (isDefaultSetup ? DEFAULT_BANK_AUTHOR_FALLBACK_MODEL : '')
  const model = env['BANK_AUTHOR_MODEL'] ?? DEFAULT_BANK_AUTHOR_MODEL
  const usdPerCall = Number(env['BANK_AUTHOR_USD_PER_CALL'] ?? DEFAULT_BANK_AUTHOR_USD_PER_CALL)
  /*
   * ⚠️ A PAID MODEL WITHOUT A PRICE IS REFUSED, NOT METERED AT ZERO. At $0 a
   * call the cap can never be reached, so the "dollar ledger" would count
   * attempts and stop nothing. That is right for a `:free` slug and wrong for
   * everything else: an operator who swaps in a paid model and forgets the
   * price would get unmetered spend bounded only by the preview route's hourly
   * cap (cost-sentinel, 2026-09-09). Refusing here surfaces the omission on
   * the first request rather than on the invoice.
   */
  for (const m of [model, fallback.trim()]) {
    if (m && !/:free$/.test(m) && !(usdPerCall > 0)) {
      throw new RangeError(`${m} is not a :free slug, so BANK_AUTHOR_USD_PER_CALL must be set to the price per call (R3)`)
    }
  }
  return {
    provider: provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
    model,
    // An explicitly empty value disables the second attempt, which is the only
    // way to say "use one model and tell me when it breaks".
    ...(fallback.trim() ? { fallbackModel: fallback.trim() } : {}),
    baseUrl: (baseUrl ?? DEFAULT_BANK_AUTHOR_BASE_URL).replace(/\/+$/, ''),
    apiKey,
    timeoutMs: Number(env['BANK_AUTHOR_TIMEOUT_MS'] ?? DEFAULT_BANK_AUTHOR_TIMEOUT_MS),
    ledger: {
      file: authorLedgerFile(dataDir),
      capUsd: Number(env['BANK_AUTHOR_CAP_USD'] ?? DEFAULT_BANK_AUTHOR_CAP_USD),
      usdPerCall,
      stores: ledgers ?? ledgerStores(dataDir, env),
    },
  }
}

const AUTHORING_SYSTEM = `You author prompt banks for an AI search visibility measurement product.

A prompt bank is the set of questions real buyers type into ChatGPT, Gemini and
Copilot when they are looking for a product in a category — BEFORE they know
which brands exist. We send those questions to the engines and measure which
brands the engines volunteer in reply.

Two intents:
- discovery: someone looking for this kind of product and naming no brand.
  "Best mechanical keyboard for programmers with a quiet switch"
- problem-led: someone describing the problem, not the product category.
  "My wrists hurt after long coding sessions, what should I change about my desk setup"

ABSOLUTE RULES, and a bank breaking any of them is discarded:
1. NEVER name a company, brand, product or vendor in any prompt. Not the site's
   own brand, not a competitor, not a market leader, not an example. A prompt
   that names a brand measures our phrasing instead of the engine's answer, and
   naming competitors we have not measured is the specific dishonesty this
   product exists to argue against.
2. Write questions a BUYER would type, not questions a marketer would write.
   Specific, awkward, concrete. Budgets, constraints, use cases, geographies.
3. The category is the MARKET the business competes in, not the business itself.
   A company selling gaming keyboards is in "gaming peripherals", not in
   "Acme Corp products".
4. No prompt over 200 characters. No duplicates.

Do NOT list competitors, leading brands or example vendors anywhere in your
answer. There is no field for them and any you supply is discarded unread.

Answer with a single JSON object and nothing else — no prose before it, no
explanation after it, no markdown fence. Exactly this shape:

{
  "display_name": "The market, title case, two to four words",
  "description": "One sentence on what companies in this category sell.",
  "prompts": [
    { "text": "the question, verbatim, naming no brand", "intent": "discovery" }
  ]
}

"intent" is exactly "discovery" or "problem-led". Nothing else.`

const userMessage = (input: GenerateInput): string =>
  [
    `Homepage of ${input.host}.`,
    '',
    `Title: ${input.title || '(none)'}`,
    `Description: ${input.description || '(none)'}`,
    `Headings: ${input.headings.slice(0, 2_000) || '(none)'}`,
    '',
    `Categories that already exist (do not duplicate one of these; if the business genuinely belongs in one, use that exact name): ${input.existingSlugs.join(', ')}`,
    '',
    `Write ${GENERATED_DISCOVERY} discovery prompts and ${GENERATED_PROBLEM_LED} problem-led prompts.`,
  ].join('\n')

/**
 * Pull a JSON object out of whatever the model actually said.
 *
 * Models wrap JSON in ```json fences, prefix it with "Here is the bank:", and
 * append a closing remark, and the weaker and cheaper the model the more of that
 * happens. Scanning for the first balanced `{...}` handles all three without
 * caring which occurred — and braces inside string literals are tracked, because
 * a prompt containing `{` would otherwise close the object early and lose the
 * rest of the bank.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Model output → a `GeneratedBank`, or null.
 *
 * ⚠️ READS EXACTLY THREE KEYS. Everything else in the object is ignored,
 * including any `competitors`, `leaders`, `brands` or `vendors` the model
 * decided to be helpful with. That is refusal number one of three — see the
 * module docblock. The type has nowhere to put them, so there is no later step
 * that could be forgotten.
 *
 * Every field is checked rather than cast. This is parsing a stranger's JSON on
 * a path that writes to disk and then decides what a customer's numbers are a
 * measurement of; `as GeneratedBank` would be a decision to trust a free model's
 * output shape, which is the one thing the caller is explicitly not doing.
 */
export function parseCandidate(raw: unknown, model: string): GeneratedBank | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>

  const displayName = typeof o['display_name'] === 'string' ? o['display_name'].trim() : ''
  const description = typeof o['description'] === 'string' ? o['description'].trim() : ''
  if (!displayName) return null

  const rawPrompts = o['prompts']
  if (!Array.isArray(rawPrompts)) return null

  const prompts: { text: string; intent: 'discovery' | 'problem-led' }[] = []
  for (const p of rawPrompts) {
    if (typeof p !== 'object' || p === null) continue
    const q = p as Record<string, unknown>
    const text = typeof q['text'] === 'string' ? q['text'].trim() : ''
    const intent = q['intent']
    if (!text) continue
    if (intent !== 'discovery' && intent !== 'problem-led') continue
    prompts.push({ text, intent })
  }
  if (prompts.length === 0) return null

  return { displayName, description, prompts, model }
}

/** One attempt against an OpenAI-compatible chat-completions endpoint. */
/**
 * ONE TEXT COMPLETION, against whichever host `config` names.
 *
 * ⚠️ EXTRACTED FROM `askOpenAiCompatible`, WHICH NOW CALLS IT — not written
 * beside it. A second copy of this request would be a second place for the
 * OpenRouter attribution headers, the 200-with-an-error-body case and the
 * timeout to be got right, and the copy nobody is looking at is the one that
 * rots. The bank author's behaviour is unchanged: same endpoint, same headers,
 * same temperature, same absence of `response_format` (see the section above on
 * why that flag is a trap on a fleet of free models).
 *
 * The second caller is the AEO gap drafter (`aeo-audit.ts`), which needs prose
 * rather than JSON — so the JSON extraction stays where it was, in `authorBank`,
 * and this returns whatever the model said.
 */
export async function askText(
  config: BankAuthorConfig,
  model: string,
  system: string,
  user: string,
  opts: { readonly maxTokens?: number; readonly fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch
  // Charged first. A refusal here is a thrown BudgetExceeded, and no request follows it.
  await chargeAttempt(config.ledger, model)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter's attribution headers. Ignored by every other
        // OpenAI-compatible host, and being identifiable is the correct posture
        // for a request we make on someone else's behalf — the same reasoning as
        // the named User-Agent in fetch-site.ts.
        'HTTP-Referer': 'https://bliprank.com',
        'X-Title': 'BlipRank prompt-bank authoring',
      },
      body: JSON.stringify({
        model,
        // Low, not zero. Zero is not reproducible on a shared free endpoint
        // anyway — batching and routing see to that — and the result is written
        // down once and reused forever, so the reproducibility that matters is
        // the RECORD's, not the sampler's.
        temperature: 0.3,
        max_tokens: opts.maxTokens ?? 4_000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) {
      // The body, truncated, because a free tier's 429 says which limit and when
      // it lifts, and "429" alone sends someone to the wrong dashboard.
      const detail = await res.text().catch(() => '')
      throw new Error(`${model} answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } }
    // OpenRouter can answer 200 with an error object when an upstream provider
    // fails, so a successful status is not a successful call.
    if (body.error?.message) throw new Error(`${model}: ${body.error.message}`)
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error(`${model} returned no content`)
    return content
  } finally {
    clearTimeout(timer)
  }
}

/** The bank author's own call: the authoring system prompt, through `askText`. */
const askOpenAiCompatible = (input: GenerateInput, model: string): Promise<string> =>
  askText(input.config, model, AUTHORING_SYSTEM, userMessage(input), { ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) })

/**
 * One attempt against Anthropic.
 *
 * Kept as a selectable provider rather than deleted: CLAUDE.md §6 names Sonnet 5
 * for customer-facing generation, the SDK is already a dependency, and a seam
 * with one implementation behind it is not a seam. `BANK_AUTHOR_PROVIDER=anthropic`
 * plus a model id is the whole switch.
 *
 * It uses a forced tool call, so the "no competitor field" rule is structural on
 * this path as well as enforced by the parser. Both paths land in the same
 * `parseCandidate`, so neither gets a weaker check than the other.
 */
async function askAnthropic(input: GenerateInput, model: string): Promise<string> {
  // The same ledger as the OpenAI-compatible path: no provider is unmetered.
  await chargeAttempt(input.config.ledger, model)
  const client = new Anthropic({ apiKey: input.config.apiKey, timeout: input.config.timeoutMs })
  const response = await client.messages.create({
    model,
    max_tokens: 8_000,
    system: AUTHORING_SYSTEM,
    tool_choice: { type: 'tool', name: 'publish_category' },
    tools: [
      {
        name: 'publish_category',
        description: 'Publish the category and its prompt bank. There is deliberately no field for competitors or leading brands.',
        input_schema: {
          type: 'object',
          properties: {
            display_name: { type: 'string', description: 'The market, in title case, two to four words.' },
            description: { type: 'string', description: 'One sentence describing what companies in this category sell.' },
            prompts: {
              type: 'array',
              minItems: GENERATED_DISCOVERY + GENERATED_PROBLEM_LED,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'The question, verbatim, naming no brand. Under 200 characters.' },
                  intent: { type: 'string', enum: ['discovery', 'problem-led'] },
                },
                required: ['text', 'intent'],
                additionalProperties: false,
              },
            },
          },
          required: ['display_name', 'description', 'prompts'],
          additionalProperties: false,
        },
      },
    ],
    messages: [{ role: 'user', content: userMessage(input) }],
  })
  const block = response.content.find((b) => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') throw new Error(`${model} returned no tool call`)
  // Re-serialised so both providers reach `parseCandidate` through the same
  // door. One parser, one set of rules, no path with a weaker check on it.
  return JSON.stringify(block.input)
}

/**
 * Author a bank: the configured model, then the fallback, then nothing.
 *
 * ⚠️ NEVER THROWS. Returns null for every failure — network, timeout, HTTP
 * error, unparseable output, a shape that does not survive `parseCandidate`.
 * `resolveCategory` reads null as "no bank was authored" and falls back to the
 * general bucket, which is precisely what it did before authoring existed. A
 * flaky free model degrades the classification and never breaks a scan.
 *
 * ONE ATTEMPT PER MODEL, and no backoff. A person is waiting on a preview, and
 * a second attempt at a model that just rate-limited is a second wait for the
 * same answer. The fallback model IS the retry, and it is a retry that changes
 * something.
 *
 * A schema refusal counts as a failure and moves to the fallback: "unreliable"
 * and "unavailable" are the same event from here, and a model that answers
 * confidently in the wrong shape is the worse of the two.
 */
export async function authorBank(input: GenerateInput): Promise<GeneratedBank | null> {
  const log = input.log ?? (() => {})
  const ask = input.config.provider === 'anthropic' ? askAnthropic : askOpenAiCompatible

  const models = [input.config.model, ...(input.config.fallbackModel ? [input.config.fallbackModel] : [])]
  for (const [i, model] of models.entries()) {
    try {
      const text = await ask(input, model)
      const candidate = parseCandidate(extractJsonObject(text), model)
      if (!candidate) throw new Error(`${model} produced no bank this could parse`)
      if (i > 0) log(`bank-author: ${input.config.model} did not answer usably; ${model} did`)
      return candidate
    } catch (e) {
      const why = (e as Error).message
      log(`bank-author: ${model} failed (${why})`)
      // Fall through to the next model. Nothing is rethrown: the caller's
      // contract is a bank or nothing, and "nothing" already has a correct
      // meaning downstream.
    }
  }
  return null
}
