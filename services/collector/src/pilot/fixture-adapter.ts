/**
 * Offline stand-in for a provider — the P1.3 "second provider" in miniature.
 * Zero network, zero spend, deterministic. Answers mention the bank's brands
 * with a per-cell probability and a tunable intra-cell correlation, so the
 * analysis pipeline (ρ̂ / DEFF / n_eff) can be verified against known truth.
 *
 * Correlation model: the cell's mention probability p is a fixed property of the
 * prompt (persists across days — real prompt heterogeneity). Within one
 * collection day the cell has a latent draw c ~ Bern(p) plus per-run z ~ Bern(√ρ);
 * run j reports c when z=1 else an independent Bern(p). So two runs of the same
 * cell on the same day have correlation ρ beyond the fixed cell effect, and runs
 * on different days share only the cell effect — the day×cell structure the G0
 * estimator targets.
 */

import { createHash } from 'node:crypto'
import type { AnswerBody, CollectRequest, EngineAdapter, EngineId, RawAnswer } from '@bliprank/contracts'
import { sleep } from './util.js'

export interface FixtureOptions {
  /** Target intra-cell correlation of the mention indicator. */
  rho?: number
  /** Fixed mention probability for every cell; default: heterogeneous per cell. */
  p?: number
  brands?: readonly string[]
  latencyMs?: number
}

/** Deterministic uniform in [0,1) from a seed string. */
export function unit(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) / 2 ** 32
}

export function fixtureAdapter(engine: EngineId, opts: FixtureOptions = {}): EngineAdapter {
  const rho = opts.rho ?? Number(process.env['FIXTURE_RHO'] ?? 0.1)
  const fixedP = opts.p ?? (process.env['FIXTURE_P'] ? Number(process.env['FIXTURE_P']) : undefined)
  const brands = opts.brands ?? ['HubSpot', 'Salesforce', 'Zoho CRM']
  const latency = opts.latencyMs ?? 8
  const id = `fixture:${engine}`

  const mention = (prompt: string, day: string, brand: string, run: number): boolean => {
    const p = fixedP ?? 0.15 + 0.7 * unit(`${engine}|${prompt}|${brand}|p`) // fixed per prompt, all days
    const c = unit(`${engine}|${prompt}|${brand}|${day}|c`) < p // the day's latent state
    const copies = unit(`${engine}|${prompt}|${brand}|${day}|z|${run}`) < Math.sqrt(Math.max(0, rho))
    return copies ? c : unit(`${engine}|${prompt}|${brand}|${day}|b|${run}`) < p
  }

  return {
    id,
    provider: 'fixture',
    engine,
    collectionPath: 'third-party-grounded',
    rateLimit: () => ({ rps: 1000, burst: 1000 }),
    normalise: (payload): AnswerBody => {
      const d = payload as { reply_text?: string }
      const text = typeof d?.reply_text === 'string' ? d.reply_text : ''
      return { text, citations: [] }
    },
    async collect(req: CollectRequest): Promise<RawAnswer> {
      if (latency > 0) await sleep(latency)
      const mentioned = brands.filter((b) => mention(req.prompt, req.cell.dateBucket, b, req.run))
      // Real engines never repeat a long answer byte-for-byte unless it is cached, so
      // give each run its own wording; identical text across days then means replay.
      const salt = unit(`${engine}|${req.prompt}|${req.cell.dateBucket}|${req.run}|salt`).toString(36).slice(2, 8)
      const text = mentioned.length
        ? `For "${req.prompt}" the usual recommendations are ${mentioned.join(', ')}. Each has trade-offs (ref ${salt}).`
        : `For "${req.prompt}" it depends on your team size and budget; compare a few options before deciding (ref ${salt}).`
      const payload = { status: 'OK', request_id: `fixture-${req.run}`, data: { reply_text: text } }
      return {
        text,
        citations: [],
        cell: req.cell,
        prompt: req.prompt,
        run: req.run,
        adapter: id,
        collectionPath: 'third-party-grounded',
        collectedAt: new Date().toISOString(),
        latencyMs: latency,
        providerCalls: 0,
        payload,
      }
    },
  }
}
