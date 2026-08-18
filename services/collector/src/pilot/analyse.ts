/**
 * G0 pilot analysis — PHASES.md deliverable 0.6 and gate G0.
 *
 * Reads pilot/data/<day>/<engine>.jsonl (+ the second day), detects brand
 * mentions deterministically (alias table, word boundaries — rule R1), and per
 * engine reports $/answer, latency, three correlation estimates, DEFF at 5
 * runs/cell, n_eff at the Starter unit, the Wilson interval at p̂ = 0.25 on
 * n_eff, and evaluates the G0 rows.
 *
 * Which ρ̂ drives the gate — and why. The prompt bank is fixed, so between-prompt
 * heterogeneity is a fixed effect: it cancels in cycle-to-cycle comparisons and
 * only makes a single-cycle Wilson interval conservative. What makes Wilson
 * anti-conservative is the day×cell component: runs of one cell within a cycle
 * being more alike than runs of that cell across cycles (caching, per-day
 * state). For that component the day-to-day dispersion ratio of per-cell counts
 * is heterogeneity-free: E[D_day] = 1 + (m−1)·ρ_u, so ρ̂_u = (D_day − 1)/(m − 1)
 * and DEFF_R = 1 + (R−1)·ρ̂_u. The single-day one-way ANOVA ρ̂ (cell effect
 * included) is an UPPER bound on ρ_u; the within-day pass-to-pass ratio gives a
 * lower-bound proxy (temporal clustering at the pass scale). The gate needs the
 * second day; with one day it is NOT RUN and both bounds are reported.
 *
 * Usage: pnpm collector:analyse -- --day 2026-08-19 [--day2 2026-08-20] [--json out.json] [--md out.md]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINES, type EngineId, type RawAnswer } from '@bliprank/contracts'
import { wilson } from '@bliprank/stats'
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

/** Gate thresholds — docs/PHASES.md G0 (restated 2026-08-18). */
export const G0 = { deffMax: 1.5, neffMin: 100, starterN: 150, runsPerCell: 5, pHat: 0.25, lo: 0.17, hi: 0.35 } as const

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function mentionRegex(b: BrandDef): RegExp {
  // Longest alias first so "zoho crm" is tried before "zoho"; \b on both sides; case-insensitive.
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
 * sizes allowed (m0 = (n − Σm²/n)/(N−1); equals m when all cells have m runs).
 * MSB = Σ mᵢ(p̂ᵢ − p̄)²/(N−1) · … , MSW = Σ mᵢp̂ᵢ(1−p̂ᵢ)/(n − N), ρ̂ = (MSB − MSW)/(MSB + (m0−1)MSW).
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

/**
 * Dispersion ratio between two run-sets of the same cells: Σ(kA−kB)² over its
 * expectation under "same p, independent draws" — (mA+mB)·p̂(1−p̂)·n/(n−1) per
 * cell, using the pooled p̂. ≈1 under H0; >1 means the two sets differ more than
 * binomial noise (drift between passes/days, or correlation within a set).
 * Cells need mA = mB (the smaller side is truncated to match).
 */
export function dispersionRatio(pairs: readonly { kA: number; mA: number; kB: number; mB: number }[]): Dispersion | null {
  let num = 0
  let den = 0
  let cells = 0
  let mSum = 0
  for (const p of pairs) {
    if (p.mA < 1 || p.mB < 1 || p.mA !== p.mB) continue
    const n = p.mA + p.mB
    const ph = (p.kA + p.kB) / n
    const exp = n * ph * (1 - ph) * (n / (n - 1))
    num += (p.kA - p.kB) ** 2
    den += exp
    cells++
    mSum += p.mA
  }
  if (!cells || den === 0) return null
  const ratio = num / den
  const m = mSum / cells
  const rho = m > 1 ? Math.max(0, (ratio - 1) / (m - 1)) : 0
  return { ratio, cells, m, rho }
}

interface EngineData {
  answers: RawAnswer[]
  failed: number
  parseFailures: number
  rejected: number
}

function loadDay(dataDir: string, day: string, engine: EngineId): EngineData {
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

const subCount = (cell: Cell, runs: readonly number[]) => {
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

export interface Dispersion {
  ratio: number
  cells: number
  /** runs per cell on each side of the comparison */
  m: number
  /** implied within-set correlation beyond the cell effect: (ratio − 1)/(m − 1), floored at 0 */
  rho: number
}

export interface EngineReport {
  engine: EngineId
  answers: number
  emptyAnswers: number
  failed: number
  parseFailures: number
  rejected: number
  attempts: number
  usdCharged: number
  usdPerAnswer: number | null
  latencyMs: { p50: number; p95: number; max: number }
  byBrand: BrandStat[]
  /** single-day one-way ANOVA over brand × prompt cells — an upper bound on ρ_u */
  anova: { N: number; n: number; m0: number; pbar: number; rho: number; deff5: number }
  /** within-day, first half of runs vs second half — lower-bound proxy */
  passToPass: Dispersion | null
  /** day-1 vs day-2 per cell — the gate estimator */
  dayToDay: Dispersion | null
  gate: {
    /** 'RUN' when a second day exists, else 'NOT RUN' (provisional numbers only) */
    status: 'RUN' | 'NOT RUN'
    rhoUsed: number | null
    deff5: number | null
    neff: number | null
    interval: { lo: number; hi: number } | null
    parseable: boolean
    latencyP95: boolean
    deff: boolean | null
    neffOk: boolean | null
    intervalOk: boolean | null
    pass: boolean | null
  }
  /** what the gate would say on the within-day proxy alone — never a pass */
  provisional: { rho: number; deff5: number; neff: number; interval: { lo: number; hi: number } } | null
}

export function analyseEngine(engine: EngineId, day1: EngineData, day2: EngineData | null, bank: AnalysisBank, ledger: { calls: number; usd: number } | null, runsPerCellPilot: number): EngineReport {
  const brands = bank.brands
  const cellsByBrand = buildCells(day1.answers, brands, 'mention')
  const citesByBrand = buildCells(day1.answers, brands, 'citation')
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

  // within-day: first half of runs vs second half (passes are separated in time)
  const half = Math.floor(runsPerCellPilot / 2)
  const A = Array.from({ length: half }, (_, i) => i)
  const B = Array.from({ length: half }, (_, i) => i + half)
  const passToPass = dispersionRatio(
    pooledCells.map((c) => {
      const a = subCount(c, A)
      const b = subCount(c, B)
      const m = Math.min(a.m, b.m)
      const a2 = subCount(c, A.slice(0, m))
      const b2 = subCount(c, B.slice(0, m))
      return { kA: a2.k, mA: a2.m, kB: b2.k, mB: b2.m }
    }),
  )
  let dayToDay: Dispersion | null = null
  if (day2 && day2.answers.length) {
    const cells2 = buildCells(day2.answers, brands, 'mention')
    const pairs: { kA: number; mA: number; kB: number; mB: number }[] = []
    const promptOf1 = new Map<string, string>()
    for (const a of day1.answers) promptOf1.set(a.cell.key, a.prompt)
    for (const b of brands) {
      const c1 = cellsByBrand.get(b.id)!
      const c2 = cells2.get(b.id)!
      // keys differ across days (date bucket) — join on the prompt text
      const byPrompt2 = new Map<string, Cell>()
      for (const a of day2.answers) if (c2.has(a.cell.key)) byPrompt2.set(a.prompt, c2.get(a.cell.key)!)
      for (const [key, cell] of c1) {
        const other = byPrompt2.get(promptOf1.get(key) ?? '')
        if (!other) continue
        const m = Math.min(cell.m, other.m)
        const runs = Array.from({ length: runsPerCellPilot }, (_, i) => i)
        const a1 = subCount(cell, runs.slice(0, m))
        const a2 = subCount(other, runs.slice(0, m))
        pairs.push({ kA: a1.k, mA: a1.m, kB: a2.k, mB: a2.m })
      }
    }
    dayToDay = dispersionRatio(pairs)
  }

  const evalRho = (rho: number) => {
    const deff5 = deffAt(rho, G0.runsPerCell)
    const neff = G0.starterN / deff5
    const w = wilson(G0.pHat * neff, neff)
    return { deff5, neff, interval: { lo: w.ci_low, hi: w.ci_high } }
  }
  const lat = day1.answers.map((a) => a.latencyMs)
  const attempts = ledger?.calls ?? day1.answers.length
  const usd = ledger?.usd ?? 0
  const parseable = day1.answers.length > 0 && day1.parseFailures === 0
  const latencyP95 = percentile(lat, 95) <= 20_000
  const provisional = passToPass ? { rho: passToPass.rho, ...evalRho(passToPass.rho) } : null

  let gate: EngineReport['gate']
  if (dayToDay) {
    const e = evalRho(dayToDay.rho)
    const deffOk = e.deff5 <= G0.deffMax
    const neffOk = e.neff >= G0.neffMin
    const intervalOk = e.interval.lo >= G0.lo && e.interval.hi <= G0.hi
    gate = { status: 'RUN', rhoUsed: dayToDay.rho, ...e, parseable, latencyP95, deff: deffOk, neffOk, intervalOk, pass: parseable && deffOk && neffOk && intervalOk }
  } else {
    gate = { status: 'NOT RUN', rhoUsed: null, deff5: null, neff: null, interval: null, parseable, latencyP95, deff: null, neffOk: null, intervalOk: null, pass: null }
  }
  return {
    engine,
    answers: day1.answers.length,
    emptyAnswers: day1.answers.filter((a) => !a.text.trim()).length,
    failed: day1.failed,
    parseFailures: day1.parseFailures,
    rejected: day1.rejected,
    attempts,
    usdCharged: usd,
    usdPerAnswer: day1.answers.length ? usd / day1.answers.length : null,
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: percentile(lat, 100) },
    byBrand,
    anova,
    passToPass,
    dayToDay,
    gate,
    provisional,
  }
}

export function renderMarkdown(day: string, day2: string | null, reports: EngineReport[]): string {
  const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d))
  const pf = (b: boolean | null) => (b === null ? 'NOT RUN' : b ? 'PASS' : 'FAIL')
  const iv = (i: { lo: number; hi: number } | null | undefined) => (i ? `[${f(i.lo)}, ${f(i.hi)}]` : '—')
  const lines: string[] = []
  lines.push(`# G0 pilot report — ${day}${day2 ? ` (day-to-day vs ${day2})` : ' (single day — gate NOT RUN)'}`, '')
  lines.push('| Engine | answers | failed (unparseable / rejected) | $/answer | latency p50 / p95 ms | ρ̂_u day×cell (gate) | DEFF₅ | n_eff | Wilson @0.25 on n_eff | ρ̂ pass-to-pass (proxy) | ρ̂ ANOVA (upper bound) | G0 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of reports) {
    lines.push(
      `| ${r.engine} | ${r.answers} (${r.emptyAnswers} empty) | ${r.failed} (${r.parseFailures} / ${r.rejected}) | ${r.usdPerAnswer === null ? '—' : '$' + r.usdPerAnswer.toFixed(4)} | ${r.latencyMs.p50} / ${r.latencyMs.p95} | ${f(r.gate.rhoUsed)} | ${f(r.gate.deff5, 2)} | ${f(r.gate.neff, 1)} | ${iv(r.gate.interval)} | ${f(r.passToPass?.rho)} | ${f(r.anova.rho)} | **${pf(r.gate.pass)}** |`,
    )
  }
  lines.push('', '## Gate rows per engine', '', '| Engine | 5/5 parseable | p95 ≤ 20s | DEFF₅ ≤ 1.5 | n_eff ≥ 100 | interval ⊆ [0.17, 0.35] | day-to-day D (m runs) | pass-to-pass D |', '|---|---|---|---|---|---|---|---|')
  for (const r of reports) {
    lines.push(
      `| ${r.engine} | ${pf(r.gate.parseable)} | ${pf(r.gate.latencyP95)} | ${pf(r.gate.deff)} (${f(r.gate.deff5, 2)}) | ${pf(r.gate.neffOk)} (${f(r.gate.neff, 1)}) | ${pf(r.gate.intervalOk)} | ${r.dayToDay ? `${f(r.dayToDay.ratio, 2)} (m=${r.dayToDay.m}, ${r.dayToDay.cells} cells)` : 'not run'} | ${r.passToPass ? `${f(r.passToPass.ratio, 2)} (m=${r.passToPass.m})` : '—'} |`,
    )
  }
  if (reports.some((r) => r.gate.status === 'NOT RUN' && r.provisional)) {
    lines.push('', '## Provisional (single day, within-day proxy only — not a gate result)', '', '| Engine | ρ̂ pass-to-pass | DEFF₅ | n_eff | Wilson @0.25 | ρ̂ ANOVA upper bound → DEFF₅ |', '|---|---|---|---|---|---|')
    for (const r of reports) if (r.provisional) lines.push(`| ${r.engine} | ${f(r.provisional.rho)} | ${f(r.provisional.deff5, 2)} | ${f(r.provisional.neff, 1)} | ${iv(r.provisional.interval)} | ${f(r.anova.rho)} → ${f(r.anova.deff5, 2)} |`)
  }
  lines.push('', '## Per brand (mention indicator, single-day ANOVA; DEFF at 5 runs/cell)', '', '| Engine | Brand | cells N | runs n | p̄ mention | ρ̂ ANOVA | DEFF₅ (upper bound) | citation rate |', '|---|---|---|---|---|---|---|---|')
  for (const r of reports) for (const b of r.byBrand) lines.push(`| ${r.engine} | ${b.brand} | ${b.N} | ${b.n} | ${f(b.pbar)} | ${f(b.rho)} | ${f(b.deff5, 2)} | ${f(b.citeRate)} |`)
  lines.push(
    '',
    'Notes: ρ̂_u is the day×cell correlation — how much more alike two runs of one cell are within a day than across days — from the day-to-day dispersion ratio D of per-cell counts, ρ̂_u = (D − 1)/(m − 1); it is free of the fixed between-prompt heterogeneity of the bank, which cancels in cycle-to-cycle comparisons and only makes single-cycle Wilson conservative. DEFF₅ = 1 + 4·ρ̂_u; n_eff = 150 / DEFF₅ (Starter unit: 30 prompts × 5 runs); the Wilson interval is at p̂ = 0.25 on n_eff. The pass-to-pass ratio (first vs second half of the day’s runs) is a within-day proxy; the one-way ANOVA ρ̂ over brand × prompt cells includes the fixed cell effect and is an upper bound. D ≈ 1 means the two run-sets differ only by binomial noise.',
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
  const engines = (args.has('engines') ? String(args.get('engines')).split(',') : [...ENGINES]) as EngineId[]
  const reports = engines.map((e) => analyseEngine(e, loadDay(dataDir, day, e), day2 ? loadDay(dataDir, day2, e) : null, bank, ledger?.byEngine[e] ?? null, runs))
  const md = renderMarkdown(day, day2, reports)
  const outJson = args.has('json') ? String(args.get('json')) : join(PILOT_DIR, 'results', `${day}-report.json`)
  const outMd = args.has('md') ? String(args.get('md')) : join(PILOT_DIR, 'results', `${day}-report.md`)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(PILOT_DIR, 'results'), { recursive: true })
  writeFileSync(outJson, JSON.stringify({ day, day2, generatedAt: new Date().toISOString(), reports }, null, 2) + '\n')
  writeFileSync(outMd, md)
  console.log(md)
  console.error(`wrote ${outJson} and ${outMd}`)
}
