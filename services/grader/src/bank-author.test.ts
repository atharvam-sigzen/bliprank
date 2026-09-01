import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BANK_AUTHOR_BASE_URL,
  DEFAULT_BANK_AUTHOR_FALLBACK_MODEL,
  DEFAULT_BANK_AUTHOR_MODEL,
  GENERATED_DISCOVERY,
  GENERATED_PROBLEM_LED,
  authorBank,
  bankAuthorConfig,
  extractJsonObject,
  parseCandidate,
  type BankAuthorConfig,
} from './bank-author.js'

const CONFIG: BankAuthorConfig = {
  provider: 'openai-compatible',
  model: 'primary/model:free',
  fallbackModel: 'fallback/model:free',
  baseUrl: 'https://openrouter.test/api/v1',
  apiKey: 'k',
  timeoutMs: 500,
}

const bankJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    display_name: 'Gaming peripherals',
    description: 'Keyboards, mice and headsets built for gaming.',
    prompts: [
      ...Array.from({ length: GENERATED_DISCOVERY }, (_, i) => ({ text: `Best gaming keyboard, option ${i}`, intent: 'discovery' })),
      ...Array.from({ length: GENERATED_PROBLEM_LED }, (_, i) => ({ text: `My wrists ache, case ${i}`, intent: 'problem-led' })),
    ],
    ...over,
  })

/** An OpenAI-compatible chat-completions reply carrying `content`. */
const chat = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { 'content-type': 'application/json' } })

const input = (fetchImpl: typeof fetch, config: BankAuthorConfig = CONFIG, log?: (m: string) => void) => ({
  host: 'acmegear.com',
  title: 'Acme Gaming',
  description: 'Keyboards and mice',
  headings: 'Built for play',
  existingSlugs: ['crm-software'],
  config,
  fetchImpl,
  ...(log ? { log } : {}),
})

describe('the model and provider come from the environment, not from code', () => {
  const key = (n: string) => (n === 'OPENROUTER_API_KEY' ? 'or-key' : undefined)

  it('defaults to Nemotron on OpenRouter, with Llama behind it', () => {
    const c = bankAuthorConfig({} as NodeJS.ProcessEnv, key)!
    expect(c.provider).toBe('openai-compatible')
    expect(c.model).toBe(DEFAULT_BANK_AUTHOR_MODEL)
    expect(c.fallbackModel).toBe(DEFAULT_BANK_AUTHOR_FALLBACK_MODEL)
    expect(c.baseUrl).toBe(DEFAULT_BANK_AUTHOR_BASE_URL)
  })

  it('swaps the model on ONE env var — the whole point of the seam', () => {
    // Free tiers get rate-limited and withdrawn. The response has to be an edit
    // to .env.local, not a deploy.
    const c = bankAuthorConfig({ BANK_AUTHOR_MODEL: 'qwen/qwen-2.5-72b-instruct:free' } as NodeJS.ProcessEnv, key)!
    expect(c.model).toBe('qwen/qwen-2.5-72b-instruct:free')
    expect(c.fallbackModel).toBe(DEFAULT_BANK_AUTHOR_FALLBACK_MODEL)
  })

  it('points at any other OpenAI-compatible host on one more', () => {
    const c = bankAuthorConfig({ BANK_AUTHOR_BASE_URL: 'https://integrate.api.nvidia.com/v1/' } as NodeJS.ProcessEnv, key)!
    // Trailing slash trimmed, or the request would be to `/v1//chat/completions`.
    expect(c.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
    /*
     * And the OpenRouter-flavoured fallback does NOT come along. It is an
     * OpenRouter slug; on Nvidia's own endpoint it names a model that host has
     * never heard of, so the second attempt would be guaranteed to fail — in
     * the one place nobody looks, since a failed fallback is silent by design.
     */
    expect(c.fallbackModel).toBeUndefined()
  })

  it('does not carry an OpenRouter slug into an Anthropic config either', () => {
    const c = bankAuthorConfig({ BANK_AUTHOR_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv, () => 'ant')!
    expect(c.fallbackModel).toBeUndefined()
    // Naming one explicitly still works — nothing is inferred, only defaulted.
    const named = bankAuthorConfig(
      { BANK_AUTHOR_PROVIDER: 'anthropic', BANK_AUTHOR_FALLBACK_MODEL: 'claude-haiku-4-5' } as NodeJS.ProcessEnv,
      () => 'ant',
    )!
    expect(named.fallbackModel).toBe('claude-haiku-4-5')
  })

  it('switches provider, and then takes the provider-conventional key', () => {
    const both = (n: string) => ({ OPENROUTER_API_KEY: 'or', ANTHROPIC_API_KEY: 'ant' })[n]
    expect(bankAuthorConfig({ BANK_AUTHOR_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv, both)!.apiKey).toBe('ant')
    expect(bankAuthorConfig({} as NodeJS.ProcessEnv, both)!.apiKey).toBe('or')
    // An explicit key outranks both, so a machine holding several is not
    // ambiguous about which one this uses.
    expect(bankAuthorConfig({} as NodeJS.ProcessEnv, (n) => (n === 'BANK_AUTHOR_API_KEY' ? 'explicit' : 'other'))!.apiKey).toBe('explicit')
  })

  it('an empty fallback disables the second attempt', () => {
    // The only way to say "use one model and tell me when it breaks".
    expect(bankAuthorConfig({ BANK_AUTHOR_FALLBACK_MODEL: '' } as NodeJS.ProcessEnv, key)!.fallbackModel).toBeUndefined()
  })

  it('is null with no key at all, which is the authoring-is-off state', () => {
    expect(bankAuthorConfig({} as NodeJS.ProcessEnv, () => undefined)).toBeNull()
  })
})

describe('parsing what models actually return', () => {
  it('unwraps a fenced block with a preamble and a sign-off', () => {
    const wrapped = `Sure! Here is the bank:\n\n\`\`\`json\n${bankJson()}\n\`\`\`\n\nLet me know if you need changes.`
    expect(parseCandidate(extractJsonObject(wrapped), 'm')?.displayName).toBe('Gaming peripherals')
  })

  it('does not stop at a brace inside a string', () => {
    // A prompt containing `{` would close the object early and lose the rest of
    // the bank — silently, as a short bank, which `rejectionReason` would then
    // blame on the model.
    const withBrace = JSON.parse(bankJson()) as { prompts: { text: string }[] }
    withBrace.prompts[0]!.text = 'Best keyboard for a {small} desk'
    const parsed = parseCandidate(extractJsonObject(`noise ${JSON.stringify(withBrace)} trailing`), 'm')
    expect(parsed?.prompts).toHaveLength(GENERATED_DISCOVERY + GENERATED_PROBLEM_LED)
  })

  it('returns null for prose, truncated JSON and an array', () => {
    expect(extractJsonObject('I cannot help with that.')).toBeNull()
    expect(extractJsonObject('{"display_name": "Gaming per')).toBeNull()
    expect(parseCandidate(extractJsonObject('[1,2,3]'), 'm')).toBeNull()
  })

  it('drops a prompt with an intent the scan does not run', () => {
    // Only discovery and problem-led are ever sent (scan.ts PROPERTY 2). A
    // `comparison` prompt names brands by construction, so letting one through
    // would put a guaranteed mention in the sample.
    const mixed = JSON.parse(bankJson()) as { prompts: { text: string; intent: string }[] }
    mixed.prompts.push({ text: 'Which is better, A or B?', intent: 'comparison' })
    const parsed = parseCandidate(mixed, 'm')!
    expect(parsed.prompts.every((p) => p.intent === 'discovery' || p.intent === 'problem-led')).toBe(true)
  })

  it('records which model answered — provenance, not a log line', () => {
    expect(parseCandidate(JSON.parse(bankJson()), 'nvidia/nemotron-3-super-120b-a12b:free')!.model).toBe('nvidia/nemotron-3-super-120b-a12b:free')
  })
})

describe('⚠️ INVENTED COMPETITORS CANNOT SURVIVE A LOOSER PROVIDER', () => {
  it('ignores every competitor-shaped field a model volunteers', async () => {
    /*
     * With a forced tool call, "no competitors" was STRUCTURAL — the schema had
     * no such field. A free model answering with open JSON can and will put one
     * in, because homepages are full of rivals and being helpful is what these
     * models do.
     *
     * The parser reads exactly three keys. There is no path by which any of
     * these reaches a GeneratedBank, and the type has nowhere to put them.
     */
    const helpful = bankJson({
      competitors: ['Razer', 'Logitech', 'SteelSeries'],
      leaders: [{ id: 'razer', name: 'Razer', aliases: ['Razer'], domains: ['razer.com'] }],
      brands: ['Corsair'],
      market_leaders: ['HyperX'],
    })
    const bank = await authorBank(input(async () => chat(helpful)))
    expect(bank).not.toBeNull()
    const serialised = JSON.stringify(bank)
    for (const invented of ['Razer', 'Logitech', 'SteelSeries', 'Corsair', 'HyperX']) {
      expect(serialised).not.toContain(invented)
    }
    expect(Object.keys(bank!).sort()).toEqual(['description', 'displayName', 'model', 'prompts'])
  })
})

describe('the fallback chain, and never throwing', () => {
  it('uses the primary when it answers', async () => {
    const asked: string[] = []
    const bank = await authorBank(
      input(async (_u, init) => {
        asked.push(JSON.parse(String(init?.body)).model)
        return chat(bankJson())
      }),
    )
    expect(asked).toEqual(['primary/model:free'])
    expect(bank?.model).toBe('primary/model:free')
  })

  it('moves to the fallback when the primary is rate-limited', async () => {
    const asked: string[] = []
    const bank = await authorBank(
      input(async (_u, init) => {
        const model = JSON.parse(String(init?.body)).model as string
        asked.push(model)
        return model === 'primary/model:free' ? new Response('rate limit exceeded', { status: 429 }) : chat(bankJson())
      }),
    )
    expect(asked).toEqual(['primary/model:free', 'fallback/model:free'])
    expect(bank?.model).toBe('fallback/model:free')
  })

  it('treats UNRELIABLE the same as unavailable — garbage moves to the fallback too', async () => {
    // "or unreliable" in the requirement. A model that answers confidently in
    // the wrong shape is the worse of the two failures, not a lesser one.
    const asked: string[] = []
    const bank = await authorBank(
      input(async (_u, init) => {
        const model = JSON.parse(String(init?.body)).model as string
        asked.push(model)
        return chat(model === 'primary/model:free' ? 'I am not able to write prompt banks.' : bankJson())
      }),
    )
    expect(asked).toHaveLength(2)
    expect(bank?.model).toBe('fallback/model:free')
  })

  it('catches an error object returned with HTTP 200', async () => {
    // OpenRouter answers 200 with `{error}` when an upstream provider fails, so
    // a successful status is not a successful call.
    const bank = await authorBank(
      input(async (_u, init) =>
        JSON.parse(String(init?.body)).model === 'primary/model:free'
          ? new Response(JSON.stringify({ error: { message: 'upstream is down' } }), { status: 200 })
          : chat(bankJson()),
      ),
    )
    expect(bank?.model).toBe('fallback/model:free')
  })

  it('returns null — never throws — when both models fail', async () => {
    // The contract the whole degradation rests on. `resolveCategory` reads null
    // as "no bank was authored" and falls back to the general bucket, exactly
    // as it did before authoring existed.
    const bank = await authorBank(input(async () => new Response('down', { status: 503 })))
    expect(bank).toBeNull()
  })

  it('returns null when the transport itself throws', async () => {
    const bank = await authorBank(
      input(async () => {
        throw new Error('ECONNRESET')
      }),
    )
    expect(bank).toBeNull()
  })

  it('gives up on a hanging model rather than holding the request open', async () => {
    const bank = await authorBank(
      input((_u, init) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
        }),
      ),
    )
    expect(bank).toBeNull()
  })

  it('stops after one attempt per model — the fallback IS the retry', async () => {
    // No backoff, no second try at a model that just rate-limited: a person is
    // waiting on a preview, and retrying the same model is a second wait for
    // the same answer.
    let calls = 0
    await authorBank(
      input(async () => {
        calls += 1
        return new Response('nope', { status: 500 })
      }),
    )
    expect(calls).toBe(2)
  })

  it('says which model failed and why, so a dead free tier is diagnosable', async () => {
    const lines: string[] = []
    await authorBank(
      input(
        async (_u, init) =>
          JSON.parse(String(init?.body)).model === 'primary/model:free' ? new Response('quota exhausted', { status: 429 }) : chat(bankJson()),
        CONFIG,
        (m) => lines.push(m),
      ),
    )
    expect(lines.join(' ')).toContain('primary/model:free failed')
    expect(lines.join(' ')).toContain('429')
    expect(lines.join(' ')).toContain('quota exhausted')
    expect(lines.join(' ')).toContain('fallback/model:free did')
  })

  it('makes one attempt when the fallback is disabled', async () => {
    let calls = 0
    const bank = await authorBank(
      input(
        async () => {
          calls += 1
          return new Response('down', { status: 503 })
        },
        { ...CONFIG, fallbackModel: undefined },
      ),
    )
    expect(calls).toBe(1)
    expect(bank).toBeNull()
  })
})

describe('the request itself', () => {
  it('posts to the configured host with a bearer token and no response_format', async () => {
    let url = ''
    let body: Record<string, unknown> = {}
    let headers: Record<string, string> = {}
    await authorBank(
      input(async (u, init) => {
        url = String(u)
        body = JSON.parse(String(init?.body))
        headers = init?.headers as Record<string, string>
        return chat(bankJson())
      }),
    )
    expect(url).toBe('https://openrouter.test/api/v1/chat/completions')
    expect(headers['Authorization']).toBe('Bearer k')
    // Deliberately absent: a host that does not support it for the chosen model
    // answers 400, which is indistinguishable from "the model is down", so the
    // configured model would silently never run. See the module docblock.
    expect(body['response_format']).toBeUndefined()
    expect(body['model']).toBe('primary/model:free')
  })

  it('sends the homepage and the existing slugs, and tells the model not to name brands', async () => {
    let body: { messages: { role: string; content: string }[] } = { messages: [] }
    await authorBank(
      input(async (_u, init) => {
        body = JSON.parse(String(init?.body))
        return chat(bankJson())
      }),
    )
    const system = body.messages.find((m) => m.role === 'system')!.content
    const user = body.messages.find((m) => m.role === 'user')!.content
    expect(system).toContain('NEVER name a company, brand, product or vendor')
    expect(system).toContain('any you supply is discarded unread')
    expect(user).toContain('acmegear.com')
    expect(user).toContain('crm-software')
  })
})
