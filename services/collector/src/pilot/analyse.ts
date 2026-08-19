/**
 * G0 pilot analysis — PHASES.md deliverable 0.6 and gate G0.
 *
 * Reads pilot/data/<day>/<engine>.jsonl (+ the second day), detects brand
 * mentions deterministically (alias table, word boundaries — rule R1), and per
 * engine reports $/answer (actual plan and Mega-normalised), latency, the
 * correlation estimates below, DEFF at 5 runs/cell, n_eff at the Starter unit,
 * the Wilson interval at p̂ = 0.25 on n_eff, and evaluates the G0 rows.
 *
 * Which ρ̂ drives the gate — and why. The prompt bank is fixed, so between-prompt
 * heterogeneity is a fixed effect: it cancels in cycle-to-cycle comparisons and
 * only makes a bank-conditional single-cycle Wilson interval conservative. What
 * makes Wilson anti-conservative is the day×cell component: runs of one cell
 * within a cycle being more alike than runs of that cell across cycles (caching,
 * per-day state). The day-to-day dispersion ratio D of per-cell counts is free of
 * the fixed cell effect; with the pooled p̂ in its denominator its expectation is
 * E[D] = [1 + (m−1)ρ_u] / [1 − (m−1)ρ_u/(2m−1)], which inverts exactly to
 * ρ̂_u = (D − 1) / [(m − 1)(1 + D/(2m − 1))]. DEFF_R = 1 + (R−1)·ρ̂_u.
 * The gate uses the 95% upper confidence limit of ρ̂_u (bootstrap over cells), so
 * a borderline engine fails rather than passing on noise. The single-day one-way
 * ANOVA ρ̂ (cell effect included) is an UPPER bound on ρ_u and is reported, never
 * gated. The within-day pass-to-pass ratio measures sub-day clustering — a
 * different estimand, neither an upper nor a lower bound — and is reported as such.
 *
 * Two things this design cannot see and says so: (a) a cycle-level shift common
 * to all cells (σ²_g — model deploys, index refreshes) is not identifiable from
 * two days; the engine-level day shift is reported as a diagnostic and ≥4 cycles
 * are needed to estimate it; (b) the certified n_eff is bank-conditional — it
 * does not cover generalisation from a 30-prompt bank to a category.
 *
 * Usage: pnpm collector:analyse -- --day 2026-08-19 [--day2 2026-08-20] [--json out.json] [--md out.md]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINES, type EngineId, type RawAnswer } from '@bliprank/contracts'
import { wilson } from '@bliprank/stats'
import { PRICE_USD_PER_CALL, type OwnPlan } from '../adapters/openwebninja.js'
import { PILOT_DIR } from './collect.js'
import { parseArgs, percentile } from './util.js'

export interface BrandDef {
  id: string
  name: string
  aliases: string[]
  domains: string[]
}
export interface AnalysisBank {
  brands: BrandDef[]
  competitors?: BrandDef[]
  prompts: string[]
}

/** Gate thresholds — docs/PHASES.md G0. */
export const G0 = {
  deffMax: 1.5,
  neffMin: 100,
  starterN: 150,
  runsPerCell: 5,
  pHat: 0.25,
  lo: 0.17,
  hi: 0.35,
  usdPerAnswerMax: 0.0022,
  latencyP95Ms: 20_000,
  emptyRateMax: 0.05,
  identicalTextRateMax: 0.5,
  bootstrapReps: 1000,
} as const

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function mentionRegex(b: BrandDef): RegExp {
  // Longest alias first so "zoho crm" is tried before "zoho"; letter/digit boundaries; case-insensitive.
  const alts = [...b.aliases].sort((a, z) => z.length - a.length).map(escapeRe)
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'iu')
}

export function mentions(text: string, re: RegExp): boolean {
  return re.test(text.normalize('NFKC'))
}

export function cites(urls: readonly string[], b: BrandDef): boolean {
  return urls.some((u) => {
    try {
      const url = new URL(u)
      const hostPath = (url.hostname.replace(/^www\./, '') + url.pathname).toLowerCase()
      return b.domains.some((d) => hostPath === d || hostPath.startsWith(d + '/') || hostPath.endsWith('.' + d) || hostPath.includes('.' + d + '/') || hostPath.startsWith(d))
    } catch {
      return false
    }
  })
}

export interface Cell {
  k: number
  m: number
  /** outcome per run index, for run-set splits */
  runs: Map<number, 0 | 1>
}

export interface Icc {
  N: number
  n: number
  m0: number
  pbar: number
  msb: number
  msw: number
  /** raw estimate; may be slightly negative under underdispersion */
  rho: number
}

/**
 * One-way ANOVA intra-cluster correlation for a binary outcome, unequal cluster
 * sizes allowed. MSB = Σ mᵢ(p̂ᵢ − p̄)² / (N − 1); MSW = Σ mᵢ p̂ᵢ(1 − p̂ᵢ) / (n − N);
 * m0 = (n − Σmᵢ²/n) / (N − 1) (= m when all cells have m runs);
 * ρ̂ = (MSB − MSW) / (MSB + (m0 − 1)·MSW).
 */
export function icc(cells: readonly { k: number; m: number }[]): Icc {
  const used = cells.filter((c) => c.m >= 2)
  const N = used.length
  const n = used.reduce((s, c) => s + c.m, 0)
  if (N < 2 || n <= N) return { N, n, m0: N ? n / N : 0, pbar: n ? used.reduce((s, c) => s + c.k, 0) / n : 0, msb: 0, msw: 0, rho: 0 }
  const pbar = used.reduce((s, c) => s + c.k, 0) / n
  const msb = used.reduce((s, c) => s + c.m * (c.k / c.m - pbar) ** 2, 0) / (N - 1)
  const msw = used.reduce((s, c) => s + c.m * (c.k / c.m) * (1 - c.k / c.m), 0) / (n - N)
  const m0 = (n - used.reduce((s, c) => s + c.m * c.m, 0) / n) / (N - 1)
  const denom = msb + (m0 - 1) * msw
  const rho = denom > 0 ? (msb - msw) / denom : 0
  return { N, n, m0, pbar, msb, msw, rho }
}

export const deffAt = (rho: number, m: number): number => 1 + (m - 1) * Math.max(0, rho)

export interface Pair {
  kA: number
  mA: number
  kB: number
  mB: number
}

export interface Dispersion {
  ratio: number
  cells: number
  /** cells that carried information (pooled p̂ strictly between 0 and 1) */
  informativeCells: number
  /** runs per cell on each side of the comparison */
  m: number
  /** exact inversion of E[D]; unfloored */
  rhoRaw: number
  /** max(0, rhoRaw) */
  rho: number
  /** bootstrap over cells: 2.5% / 97.5% quantiles of ratio and of rho */
  ci: { ratioLo: number; ratioHi: number; rhoHi: number }
}

/** ρ from D by exact inversion of E[D] = [1+(m−1)ρ]/[1−(m−1)ρ/(2m−1)]. */
export const rhoFromRatio = (ratio: number, m: number): number => (m > 1 ? (ratio - 1) / ((m - 1) * (1 + ratio / (2 * m - 1))) : 0)

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Dispersion ratio between two run-sets of the same cells: Σ(kA−kB)² over
 * (mA+mB)·p̂(1−p̂)·n/(n−1) per cell with the pooled p̂ (unbiased under H0). D ≈ 1
 * when the two sets differ only by binomial noise, and any exchangeable
 * correlation shared by both sets cancels exactly. Cells need mA = mB.
 * Returns null when no cell carries information.
 */
export function dispersionRatio(pairs: readonly Pair[], reps: number = G0.bootstrapReps): Dispersion | null {
  const usable = pairs.filter((p) => p.mA >= 1 && p.mB >= 1 && p.mA === p.mB)
  const terms = usable.map((p) => {
    const n = p.mA + p.mB
    const ph = (p.kA + p.kB) / n
    return { num: (p.kA - p.kB) ** 2, den: n * ph * (1 - ph) * (n / (n - 1)), m: p.mA }
  })
  const informative = terms.filter((t) => t.den > 0)
  if (!informative.length) return null
  const sum = (ts: readonly { num: number; den: number }[]) => ts.reduce((s, t) => s + t.num, 0) / ts.reduce((s, t) => s + t.den, 0)
  const ratio = sum(informative)
  const m = informative.reduce((s, t) => s + t.m, 0) / informative.length
  const rhoRaw = rhoFromRatio(ratio, m)
  const rnd = prng(20260818)
  const ratios: number[] = []
  for (let r = 0; r < reps; r++) {
    const sample = Array.from({ length: informative.length }, () => informative[Math.floor(rnd() * informative.length)]!)
    ratios.push(sum(sample))
  }
  ratios.sort((a, b) => a - b)
  const q = (p: number) => ratios[Math.min(ratios.length - 1, Math.max(0, Math.floor(p * ratios.length)))]!
  const ratioLo = q(0.025)
  const ratioHi = q(0.975)
  return { ratio, cells: usable.length, informativeCells: informative.length, m, rhoRaw, rho: Math.max(0, rhoRaw), ci: { ratioLo, ratioHi, rhoHi: Math.max(0, rhoFromRatio(ratioHi, m)) } }
}

interface EngineData {
  answers: RawAnswer[]
  failed: number
  parseFailures: number
  rejected: number
}

export function loadDay(dataDir: string, day: string, engine: EngineId): EngineData {
  const file = join(dataDir, day, `${engine}.jsonl`)
  const answers: RawAnswer[] = []
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        answers.push(JSON.parse(line) as RawAnswer)
      } catch {
        /* torn line */
      }
    }
  }
  let failed = 0
  let parseFailures = 0
  let rejected = 0
  const ff = join(dataDir, day, 'failures.jsonl')
  if (existsSync(ff)) {
    for (const line of readFileSync(ff, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const f = JSON.parse(line) as { engine: string; kind: string }
        if (f.engine !== engine) continue
        failed++
        if (f.kind === 'unparseable') parseFailures++
        if (f.kind === 'rejected') rejected++
      } catch {
        /* ignore */
      }
    }
  }
  return { answers, failed, parseFailures, rejected }
}

/** brand → prompt cell key → Cell */
function buildCells(answers: readonly RawAnswer[], brands: readonly BrandDef[], signal: 'mention' | 'citation'): Map<string, Map<string, Cell>> {
  const res = new Map<string, Map<string, Cell>>()
  const regs = new Map(brands.map((b) => [b.id, mentionRegex(b)] as const))
  for (const b of brands) res.set(b.id, new Map())
  for (const a of answers) {
    const urls = a.citations.map((c) => c.url)
    for (const b of brands) {
      const hit = signal === 'mention' ? mentions(a.text, regs.get(b.id)!) : cites(urls, b)
      const cells = res.get(b.id)!
      const cell = cells.get(a.cell.key) ?? { k: 0, m: 0, runs: new Map() }
      if (cell.runs.has(a.run)) continue // duplicate line from a resumed run
      cell.runs.set(a.run, hit ? 1 : 0)
      cell.m++
      if (hit) cell.k++
      cells.set(a.cell.key, cell)
    }
  }
  return res
}

/** Count over exactly the given run indices (only those present). */
const countRuns = (cell: Cell, runs: Iterable<number>) => {
  let k = 0
  let m = 0
  for (const r of runs) {
    const v = cell.runs.get(r)
    if (v === undefined) continue
    m++
    k += v
  }
  return { k, m }
}

/** Pair two cells on the run indices they BOTH have (never by position). */
function pairOnCommonRuns(a: Cell, b: Cell, limit?: number): Pair {
  const common = [...a.runs.keys()].filter((r) => b.runs.has(r)).sort((x, y) => x - y)
  const use = limit ? common.slice(0, limit) : common
  const ca = countRuns(a, use)
  const cb = countRuns(b, use)
  return { kA: ca.k, mA: ca.m, kB: cb.k, mB: cb.m }
}

export interface BrandStat {
  brand: string
  N: number
  n: number
  m0: number
  pbar: number
  rho: number
  deff5: number
  citeRate: number
}

export interface EngineReport {
  engine: EngineId
  plan: OwnPlan | null
  answers: number
  emptyAnswers: number
  emptyRate: number
  failed: number
  parseFailures: number
  rejected: number
  attempts: number
  usdCharged: number
  usdPerAnswer: number | null
  /** the same attempts priced at the Mega marginal rate — what the cost model assumes */
  usdPerAnswerAtMega: number | null
  latencyMs: { p50: number; p95: number; max: number }
  byBrand: BrandStat[]
  /** single-day one-way ANOVA over brand × prompt cells — an upper bound on ρ_u */
  anova: { N: number; n: number; m0: number; pbar: number; rho: number; deff5: number }
  /** within-day, first half of runs vs second half — sub-day clustering, a different estimand */
  passToPass: Dispersion | null
  /** day-1 vs day-2 per cell on common run indices — the gate estimator */
  dayToDay: Dispersion | null
  /** same, restricted to the first 5 common runs — checks exchangeability across m */
  dayToDayM5: Dispersion | null
  /** engine-level day shift diagnostic (σ_g is not identifiable from two days) */
  dayShift: { p1: number; p2: number; delta: number; zNaive: number } | null
  /** fraction of day-2 answers whose text is byte-identical to a day-1 answer of the same cell */
  identicalTextRate: number | null
  gate: {
    status: 'RUN' | 'NOT RUN'
    /** 95% upper confidence limit of ρ̂_u used for the verdict */
    rhoUpper: number | null
    rhoPoint: number | null
    deff5: number | null
    neff: number | null
    interval: { lo: number; hi: number } | null
    parseable: boolean
    latencyP95: boolean
    cost: boolean | null
    integrity: boolean | null
    deff: boolean | null
    neffOk: boolean | null
    intervalOk: boolean | null
    pass: boolean | null
    reasons: string[]
  }
}

function evalRho(rho: number) {
  const deff5 = deffAt(rho, G0.runsPerCell)
  const neff = G0.starterN / deff5
  const w = wilson(G0.pHat * neff, neff)
  return { deff5, neff, interval: { lo: w.ci_low, hi: w.ci_high } }
}

export function analyseEngine(
  engine: EngineId,
  day1: EngineData,
  day2: EngineData | null,
  bank: AnalysisBank,
  ledger: { calls: number; usd: number } | null,
  runsPerCellPilot: number,
  plan: OwnPlan | null = null,
): EngineReport {
  const brands = bank.brands
  // An empty body is a legitimate outcome only for AI Overviews (no overview shown);
  // for chat engines it is a failed answer and must not be scored as "not mentioned".
  const emptiesAreAnswers = engine === 'google-ai-overviews'
  const scorable = (d: EngineData) => (emptiesAreAnswers ? d.answers : d.answers.filter((a) => a.text.trim() !== ''))
  const answers1 = scorable(day1)
  const emptyAnswers = day1.answers.filter((a) => !a.text.trim()).length
  const emptyRate = day1.answers.length ? emptyAnswers / day1.answers.length : 0

  const cellsByBrand = buildCells(answers1, brands, 'mention')
  const citesByBrand = buildCells(answers1, brands, 'citation')
  const byBrand: BrandStat[] = brands.map((b) => {
    const cells = [...cellsByBrand.get(b.id)!.values()]
    const s = icc(cells)
    const cc = [...citesByBrand.get(b.id)!.values()]
    const citeRate = cc.reduce((a, c) => a + c.k, 0) / Math.max(1, cc.reduce((a, c) => a + c.m, 0))
    return { brand: b.id, N: s.N, n: s.n, m0: s.m0, pbar: s.pbar, rho: s.rho, deff5: deffAt(s.rho, G0.runsPerCell), citeRate }
  })
  const pooledCells = brands.flatMap((b) => [...cellsByBrand.get(b.id)!.values()])
  const ps = icc(pooledCells)
  const anova = { N: ps.N, n: ps.n, m0: ps.m0, pbar: ps.pbar, rho: ps.rho, deff5: deffAt(ps.rho, G0.runsPerCell) }

  // within-day: first half of run indices vs second half, on the runs each cell actually has
  const half = Math.floor(runsPerCellPilot / 2)
  const passToPass = dispersionRatio(
    pooledCells.map((c) => {
      const present = [...c.runs.keys()].sort((x, y) => x - y)
      const A = present.filter((r) => r < half)
      const B = present.filter((r) => r >= half)
      const m = Math.min(A.length, B.length)
      const a = countRuns(c, A.slice(0, m))
      const b = countRuns(c, B.slice(0, m))
      return { kA: a.k, mA: a.m, kB: b.k, mB: b.m }
    }),
  )

  let dayToDay: Dispersion | null = null
  let dayToDayM5: Dispersion | null = null
  let dayShift: EngineReport['dayShift'] = null
  let identicalTextRate: number | null = null
  if (day2 && day2.answers.length) {
    const answers2 = scorable(day2)
    const cells2 = buildCells(answers2, brands, 'mention')
    const promptOf1 = new Map<string, string>()
    for (const a of answers1) promptOf1.set(a.cell.key, a.prompt)
    const pairs: Pair[] = []
    const pairs5: Pair[] = []
    let k1 = 0
    let n1 = 0
    let k2 = 0
    let n2 = 0
    for (const b of brands) {
      const c1 = cellsByBrand.get(b.id)!
      const c2 = cells2.get(b.id)!
      const byPrompt2 = new Map<string, Cell>()
      for (const a of answers2) if (c2.has(a.cell.key)) byPrompt2.set(a.prompt, c2.get(a.cell.key)!)
      for (const [key, cell] of c1) {
        const other = byPrompt2.get(promptOf1.get(key) ?? '')
        if (!other) continue
        pairs.push(pairOnCommonRuns(cell, other))
        pairs5.push(pairOnCommonRuns(cell, other, 5))
        k1 += cell.k
        n1 += cell.m
        k2 += other.k
        n2 += other.m
      }
    }
    dayToDay = dispersionRatio(pairs)
    dayToDayM5 = dispersionRatio(pairs5)
    if (n1 && n2) {
      const p1 = k1 / n1
      const p2 = k2 / n2
      const pbar = (k1 + k2) / (n1 + n2)
      const se = Math.sqrt(pbar * (1 - pbar) * (1 / n1 + 1 / n2))
      dayShift = { p1, p2, delta: p2 - p1, zNaive: se > 0 ? (p2 - p1) / se : 0 }
    }
    // cached replays: day-2 text byte-identical to a day-1 text of the same prompt
    const texts1 = new Map<string, Set<string>>()
    for (const a of answers1) (texts1.get(a.prompt) ?? texts1.set(a.prompt, new Set()).get(a.prompt)!).add(a.text)
    const nonEmpty2 = answers2.filter((a) => a.text.trim() !== '')
    const identical = nonEmpty2.filter((a) => texts1.get(a.prompt)?.has(a.text)).length
    identicalTextRate = nonEmpty2.length ? identical / nonEmpty2.length : null
  }

  const lat = day1.answers.map((a) => a.latencyMs)
  const attempts = ledger?.calls ?? day1.answers.length
  const usd = ledger?.usd ?? 0
  const usdPerAnswer = day1.answers.length && ledger ? usd / day1.answers.length : null
  const usdPerAnswerAtMega = day1.answers.length && ledger ? (attempts * PRICE_USD_PER_CALL.mega[engine]) / day1.answers.length : null

  const reasons: string[] = []
  const parseable = day1.answers.length > 0 && day1.parseFailures === 0 && (emptiesAreAnswers || emptyRate <= G0.emptyRateMax)
  if (!parseable) reasons.push(day1.answers.length ? `parse failures ${day1.parseFailures}, empty rate ${(emptyRate * 100).toFixed(1)}%` : 'no answers')
  const latencyP95 = percentile(lat, 95) <= G0.latencyP95Ms
  if (!latencyP95) reasons.push(`latency p95 ${percentile(lat, 95)} ms > ${G0.latencyP95Ms}`)
  const cost = usdPerAnswerAtMega === null ? null : usdPerAnswerAtMega <= G0.usdPerAnswerMax
  if (cost === false) reasons.push(`$/answer at Mega marginal ${usdPerAnswerAtMega!.toFixed(4)} > ${G0.usdPerAnswerMax} (retries/failures)`)

  let gate: EngineReport['gate']
  if (dayToDay) {
    const integrity = !(dayToDay.ci.ratioHi < 1 || (identicalTextRate ?? 0) >= G0.identicalTextRateMax)
    if (!integrity) reasons.push(`day-2 answers look like replays: D 95% CI [${dayToDay.ci.ratioLo.toFixed(2)}, ${dayToDay.ci.ratioHi.toFixed(2)}] below 1 or identical-text rate ${((identicalTextRate ?? 0) * 100).toFixed(0)}%`)
    const e = evalRho(dayToDay.ci.rhoHi)
    const deffOk = e.deff5 <= G0.deffMax
    const neffOk = e.neff >= G0.neffMin
    const intervalOk = e.interval.lo >= G0.lo && e.interval.hi <= G0.hi
    if (!deffOk) reasons.push(`DEFF₅ upper ${e.deff5.toFixed(2)} > ${G0.deffMax} (ρ̂_u ${dayToDay.rho.toFixed(3)}, 95% upper ${dayToDay.ci.rhoHi.toFixed(3)})`)
    gate = {
      status: 'RUN',
      rhoUpper: dayToDay.ci.rhoHi,
      rhoPoint: dayToDay.rho,
      ...e,
      parseable,
      latencyP95,
      cost,
      integrity,
      deff: deffOk,
      neffOk,
      intervalOk,
      pass: parseable && latencyP95 && cost !== false && integrity && deffOk && neffOk && intervalOk,
      reasons,
    }
  } else {
    gate = { status: 'NOT RUN', rhoUpper: null, rhoPoint: null, deff5: null, neff: null, interval: null, parseable, latencyP95, cost, integrity: null, deff: null, neffOk: null, intervalOk: null, pass: null, reasons }
  }
  return {
    engine,
    plan,
    answers: day1.answers.length,
    emptyAnswers,
    emptyRate,
    failed: day1.failed,
    parseFailures: day1.parseFailures,
    rejected: day1.rejected,
    attempts,
    usdCharged: usd,
    usdPerAnswer,
    usdPerAnswerAtMega,
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: percentile(lat, 100) },
    byBrand,
    anova,
    passToPass,
    dayToDay,
    dayToDayM5,
    dayShift,
    identicalTextRate,
    gate,
  }
}

export function renderMarkdown(day: string, day2: string | null, reports: EngineReport[]): string {
  const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d))
  const pf = (b: boolean | null) => (b === null ? 'NOT RUN' : b ? 'PASS' : 'FAIL')
  const iv = (i: { lo: number; hi: number } | null | undefined) => (i ? `[${f(i.lo)}, ${f(i.hi)}]` : '—')
  const usd = (x: number | null) => (x === null ? '—' : '$' + x.toFixed(4))
  const plan = reports.find((r) => r.plan)?.plan ?? 'unknown'
  const lines: string[] = []
  lines.push(`# G0 pilot report — ${day}${day2 ? ` (day-to-day vs ${day2})` : ' (single day — gate NOT RUN)'}`, '', `Provider plan charged: **${plan}**. $/answer is shown as charged and re-priced at the Mega marginal rate the cost model assumes; the cost row is judged on the latter.`, '')
  lines.push('| Engine | answers (empty) | failed (unparseable / rejected) | $/answer charged | $/answer @Mega | latency p50 / p95 ms | ρ̂_u point (95% upper) | DEFF₅ on upper | n_eff | Wilson @0.25 on n_eff | G0 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of reports) {
    lines.push(
      `| ${r.engine} | ${r.answers} (${r.emptyAnswers}) | ${r.failed} (${r.parseFailures} / ${r.rejected}) | ${usd(r.usdPerAnswer)} | ${usd(r.usdPerAnswerAtMega)} | ${r.latencyMs.p50} / ${r.latencyMs.p95} | ${f(r.gate.rhoPoint)} (${f(r.gate.rhoUpper)}) | ${f(r.gate.deff5, 2)} | ${f(r.gate.neff, 1)} | ${iv(r.gate.interval)} | **${pf(r.gate.pass)}** |`,
    )
  }
  lines.push('', '## Gate rows per engine', '', '| Engine | parseable (empty ≤ 5%) | p95 ≤ 20s | $/answer @Mega ≤ 0.0022 | day-2 not replays | DEFF₅ ≤ 1.5 (95% upper) | n_eff ≥ 100 | interval ⊆ [0.17, 0.35] | reasons |', '|---|---|---|---|---|---|---|---|---|')
  for (const r of reports) {
    lines.push(`| ${r.engine} | ${pf(r.gate.parseable)} | ${pf(r.gate.latencyP95)} | ${pf(r.gate.cost)} | ${pf(r.gate.integrity)} | ${pf(r.gate.deff)} (${f(r.gate.deff5, 2)}) | ${pf(r.gate.neffOk)} (${f(r.gate.neff, 1)}) | ${pf(r.gate.intervalOk)} | ${r.gate.reasons.join('; ') || '—'} |`)
  }
  lines.push('', '## Correlation estimates per engine', '', '| Engine | day-to-day D [95% CI] (m, cells) | ρ̂_u raw | ρ̂_u on first 5 runs | pass-to-pass D → sub-day ρ̂ | ANOVA ρ̂ (upper bound) → DEFF₅ | day shift p̂₁ → p̂₂ (naive z) | identical-text rate |', '|---|---|---|---|---|---|---|---|')
  for (const r of reports) {
    const dd = r.dayToDay
    lines.push(
      `| ${r.engine} | ${dd ? `${f(dd.ratio, 2)} [${f(dd.ci.ratioLo, 2)}, ${f(dd.ci.ratioHi, 2)}] (m=${f(dd.m, 1)}, ${dd.informativeCells}/${dd.cells})` : 'not run'} | ${f(dd?.rhoRaw)} | ${f(r.dayToDayM5?.rho)} | ${r.passToPass ? `${f(r.passToPass.ratio, 2)} → ${f(r.passToPass.rho)}` : '—'} | ${f(r.anova.rho)} → ${f(r.anova.deff5, 2)} | ${r.dayShift ? `${f(r.dayShift.p1)} → ${f(r.dayShift.p2)} (z ${f(r.dayShift.zNaive, 1)})` : '—'} | ${r.identicalTextRate === null ? '—' : (r.identicalTextRate * 100).toFixed(0) + '%'} |`,
    )
  }
  lines.push('', '## Per brand (mention indicator, single-day ANOVA; DEFF at 5 runs/cell)', '', '| Engine | Brand | cells N | runs n | p̄ mention | ρ̂ ANOVA | DEFF₅ (upper bound) | citation rate |', '|---|---|---|---|---|---|---|---|')
  for (const r of reports) for (const b of r.byBrand) lines.push(`| ${r.engine} | ${b.brand} | ${b.N} | ${b.n} | ${f(b.pbar)} | ${f(b.rho)} | ${f(b.deff5, 2)} | ${f(b.citeRate)} |`)
  lines.push(
    '',
    'Notes: ρ̂_u is the day×cell correlation — how much more alike two runs of one cell are within a day than across days — from the day-to-day dispersion ratio D of per-cell counts, inverted exactly: ρ̂_u = (D − 1)/[(m − 1)(1 + D/(2m − 1))]. It is free of the fixed between-prompt heterogeneity of the bank, which cancels in cycle-to-cycle comparisons and only makes the (bank-conditional) single-cycle Wilson interval conservative. The gate uses the 95% upper confidence limit of ρ̂_u (bootstrap over cells). DEFF₅ = 1 + 4·ρ̂; n_eff = 150 / DEFF₅ (Starter unit: 30 prompts × 5 runs); the Wilson interval is at p̂ = 0.25 on n_eff. The pass-to-pass ratio (first vs second half of the day’s runs) measures sub-day clustering — a different estimand, not a bound. The one-way ANOVA ρ̂ includes the fixed cell effect and is an upper bound. A D confidence interval entirely below 1, or a high identical-text rate, means day 2 replayed day 1 (cached answers) and the gate fails on integrity. Not identifiable from two days: a cycle-level shift common to all cells (σ_g); the day-shift column is a diagnostic only and ≥4 cycles are needed to estimate it. The certified n_eff is bank-conditional — it describes THIS BANK ON THIS ENGINE and does not cover generalisation from the bank to a category. Known blind spot: a cycle-level shift common to all cells (σ_g) is not identifiable from two days; the day-shift column is a diagnostic only.',
  )
  return lines.join('\n') + '\n'
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const day = String(args.get('day') ?? new Date().toISOString().slice(0, 10))
  const day2 = args.has('day2') ? String(args.get('day2')) : null
  const dataDir = String(args.get('data') ?? join(PILOT_DIR, 'data'))
  const bank = JSON.parse(readFileSync(String(args.get('bank') ?? join(PILOT_DIR, 'bank.json')), 'utf8')) as AnalysisBank
  const runs = Number(args.get('runs') ?? 10)
  const ledgerFile = join(dataDir, day, 'ledger.json')
  const ledger = existsSync(ledgerFile) ? (JSON.parse(readFileSync(ledgerFile, 'utf8')) as { byEngine: Record<string, { calls: number; usd: number }> }) : null
  const metaFile = join(dataDir, day, 'meta.json')
  const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { plan?: OwnPlan }) : {}
  const plan = (args.get('plan') as OwnPlan | undefined) ?? meta.plan ?? null
  const engines = (args.has('engines') ? String(args.get('engines')).split(',') : [...ENGINES]) as EngineId[]
  const reports = engines.map((e) => analyseEngine(e, loadDay(dataDir, day, e), day2 ? loadDay(dataDir, day2, e) : null, bank, ledger?.byEngine[e] ?? null, runs, plan))
  const md = renderMarkdown(day, day2, reports)
  const outDir = join(PILOT_DIR, 'results')
  const outJson = args.has('json') ? String(args.get('json')) : join(outDir, `${day}-report.json`)
  const outMd = args.has('md') ? String(args.get('md')) : join(outDir, `${day}-report.md`)
  if (!args.has('json') || !args.has('md')) mkdirSync(outDir, { recursive: true })
  writeFileSync(outJson, JSON.stringify({ day, day2, plan, generatedAt: new Date().toISOString(), reports }, null, 2) + '\n')
  writeFileSync(outMd, md)
  console.log(md)
  console.error(`wrote ${outJson} and ${outMd}`)
}
