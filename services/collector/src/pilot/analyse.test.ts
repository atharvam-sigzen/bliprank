import { describe, expect, it } from 'vitest'
import { cacheCell, type RawAnswer } from '@bliprank/contracts'
import { analyseEngine, cites, deffAt, dispersionRatio, icc, mentionRegex, mentions, rhoFromRatio } from './analyse.js'
import { fixtureAdapter, unit } from './fixture-adapter.js'

describe('mention / citation detection (rule R1: alias tables, no model)', () => {
  const zoho = { id: 'zoho', name: 'Zoho CRM', aliases: ['zoho crm', 'zoho'], domains: ['zoho.com'] }
  const re = mentionRegex(zoho)
  it.each([
    ['Zoho CRM is cheap', true],
    ['try ZOHO.', true],
    ['zoho’s plans', true], // apostrophe is a boundary
    ['Zohoville is a town', false], // no partial-word matches
    ['nothing here', false],
  ])('%j → %s', (text, expected) => {
    expect(mentions(text, re)).toBe(expected)
  })
  it('citation matches owned domains incl. subdomains, not lookalikes', () => {
    expect(cites(['https://www.zoho.com/crm/'], zoho)).toBe(true)
    expect(cites(['https://help.zoho.com/portal'], zoho)).toBe(true)
    expect(cites(['https://notzoho.com/x'], zoho)).toBe(false)
    expect(cites(['not a url'], zoho)).toBe(false)
  })
})

describe('icc — one-way ANOVA intra-cell correlation', () => {
  it('≈0 for independent Bernoulli runs, ≈1 for all-or-nothing cells, closed form for equal m', () => {
    const N = 400
    const m = 10
    const indep = Array.from({ length: N }, (_, i) => {
      let k = 0
      for (let j = 0; j < m; j++) if (unit(`i${i}j${j}`) < 0.3) k++
      return { k, m }
    })
    const r0 = icc(indep)
    expect(r0.m0).toBe(m)
    expect(Math.abs(r0.rho)).toBeLessThan(0.05)
    const allOrNothing = Array.from({ length: N }, (_, i) => ({ k: unit(`c${i}`) < 0.3 ? m : 0, m }))
    expect(icc(allOrNothing).rho).toBeGreaterThan(0.95)
    // equal-m closed form from the methodology skill: MSB = mΣ(p̂ᵢ−p̄)²/(N−1), MSW = Σmp̂ᵢ(1−p̂ᵢ)/(N(m−1))
    const pbar = indep.reduce((s, c) => s + c.k, 0) / (N * m)
    const msb = (m * indep.reduce((s, c) => s + (c.k / m - pbar) ** 2, 0)) / (N - 1)
    const msw = indep.reduce((s, c) => s + m * (c.k / m) * (1 - c.k / m), 0) / (N * (m - 1))
    expect(r0.rho).toBeCloseTo((msb - msw) / (msb + (m - 1) * msw), 12)
  })
  it('recovers the fixture adapter’s planted correlation at fixed p', () => {
    for (const rho of [0, 0.125, 0.4]) {
      const cells: { k: number; m: number }[] = []
      for (let i = 0; i < 600; i++) {
        const key = `cell-${i}`
        let k = 0
        for (let j = 0; j < 10; j++) {
          // same construction as fixture-adapter.mention with fixed p = 0.4
          const c = unit(`${key}|B|c`) < 0.4
          const copies = unit(`${key}|B|z|${j}`) < Math.sqrt(rho)
          if (copies ? c : unit(`${key}|B|b|${j}`) < 0.4) k++
        }
        cells.push({ k, m: 10 })
      }
      expect(icc(cells).rho).toBeCloseTo(rho, 1)
    }
  })
  it('degenerate inputs give rho 0, never NaN', () => {
    expect(icc([]).rho).toBe(0)
    expect(icc([{ k: 1, m: 1 }]).rho).toBe(0)
    expect(icc([{ k: 0, m: 5 }, { k: 0, m: 5 }]).rho).toBe(0)
  })
})

describe('deffAt / dispersionRatio', () => {
  it('DEFF = 1 + (m−1)ρ, floored at ρ = 0', () => {
    expect(deffAt(0.125, 5)).toBeCloseTo(1.5)
    expect(deffAt(-0.2, 5)).toBe(1)
  })
  it('dispersion ratio ≈ 1 for two independent halves of the same cells, ≫ 1 when the second set drifts', () => {
    const pairs = Array.from({ length: 800 }, (_, i) => {
      let kA = 0
      let kB = 0
      for (let j = 0; j < 5; j++) {
        if (unit(`a${i}${j}`) < 0.3) kA++
        if (unit(`b${i}${j}`) < 0.3) kB++
      }
      return { kA, mA: 5, kB, mB: 5 }
    })
    const d = dispersionRatio(pairs, 200)!
    expect(d.ratio).toBeCloseTo(1, 0)
    expect(d.ci.ratioLo).toBeLessThan(1)
    expect(d.ci.ratioHi).toBeGreaterThan(1)
    const drifted = pairs.map((p) => ({ ...p, kB: p.kA >= 2 ? 0 : 5 }))
    expect(dispersionRatio(drifted, 200)!.ratio).toBeGreaterThan(2)
    expect(dispersionRatio([{ kA: 1, mA: 5, kB: 1, mB: 4 }])).toBeNull()
    expect(dispersionRatio([{ kA: 0, mA: 5, kB: 0, mB: 5 }])).toBeNull() // no information at all
  })
  it('exact inversion recovers a planted day×cell correlation (0.05 / 0.125 / 0.25) at m=10, N=6000', () => {
    // Model: fixed p per cell, per-day latent c ~ Bern(p), each run copies c w.p. √ρ else independent Bern(p).
    for (const rho of [0.05, 0.125, 0.25]) {
      const pairs = []
      for (let i = 0; i < 6000; i++) {
        const p = 0.15 + 0.7 * unit(`p${i}`) // heterogeneous, persists across days
        const day = (d: number) => {
          const c = unit(`c${i}d${d}`) < p
          let k = 0
          for (let j = 0; j < 10; j++) if (unit(`z${i}d${d}j${j}`) < Math.sqrt(rho) ? c : unit(`b${i}d${d}j${j}`) < p) k++
          return k
        }
        pairs.push({ kA: day(1), mA: 10, kB: day(2), mB: 10 })
      }
      const d = dispersionRatio(pairs, 100)!
      const naive = (d.ratio - 1) / 9
      expect(Math.abs(d.rhoRaw - rho)).toBeLessThan(0.02) // exact inversion lands on the planted value
      if (rho >= 0.125) expect(naive - rho).toBeGreaterThan(Math.abs(d.rhoRaw - rho)) // naive (D−1)/(m−1) over-reads
      expect(rhoFromRatio(1, 10)).toBe(0)
    }
  }, 60_000)
})

describe('analyseEngine end to end on fixture answers', () => {
  const bank = {
    brands: [
      { id: 'hubspot', name: 'HubSpot', aliases: ['hubspot'], domains: ['hubspot.com'] },
      { id: 'salesforce', name: 'Salesforce', aliases: ['salesforce'], domains: ['salesforce.com'] },
      { id: 'zoho', name: 'Zoho CRM', aliases: ['zoho crm', 'zoho'], domains: ['zoho.com'] },
    ],
    prompts: Array.from({ length: 60 }, (_, i) => `prompt number ${i} about crm`),
  }
  async function collectDayHet(day: string, rho: number) {
    return collectWith(fixtureAdapter('gemini', { rho, latencyMs: 0 }), day)
  }
  async function collectDay(day: string, rho: number, p: number) {
    return collectWith(fixtureAdapter('gemini', { rho, p, latencyMs: 0 }), day)
  }
  async function collectWith(adapter: ReturnType<typeof fixtureAdapter>, day: string) {
    const answers: RawAnswer[] = []
    for (let run = 0; run < 10; run++) {
      for (const prompt of bank.prompts) {
        const cell = cacheCell({ prompt, engine: 'gemini', locale: 'en-US', geo: 'US', dateBucket: day })
        answers.push(await adapter.collect({ cell, prompt, run }))
      }
    }
    return { answers, failed: 0, parseFailures: 0, rejected: 0 }
  }
  it('independent runs → PASS; day×cell correlation → FAIL; one day → NOT RUN; replays → integrity FAIL', async () => {
    const good = analyseEngine('gemini', await collectDay('2026-08-19', 0, 0.3), await collectDay('2026-08-20', 0, 0.3), bank, { calls: 600, usd: 4.2 }, 10, 'payg')
    expect(good.answers).toBe(600)
    expect(good.usdPerAnswer).toBeCloseTo(0.007)
    expect(good.usdPerAnswerAtMega).toBeCloseTo(0.002)
    expect(good.gate.cost).toBe(true)
    expect(good.dayToDay!.cells).toBe(180)
    expect(good.dayToDay!.m).toBe(10)
    expect(good.dayToDay!.ratio).toBeCloseTo(1, 0)
    expect(good.gate.status).toBe('RUN')
    expect(good.gate.rhoUpper!).toBeLessThan(0.125)
    expect(good.gate.deff5!).toBeLessThan(1.5)
    expect(good.gate.integrity).toBe(true)
    expect(good.gate.pass).toBe(true)
    expect(good.identicalTextRate).toBeLessThan(0.5)

    // heterogeneous fixed p with independent runs: ANOVA bound well above 0, ρ̂_u near 0
    const het = analyseEngine('gemini', await collectDayHet('2026-08-19', 0), await collectDayHet('2026-08-20', 0), bank, null, 10)
    expect(het.anova.rho).toBeGreaterThan(0.1)
    expect(het.dayToDay!.rho).toBeLessThan(0.05)
    expect(het.gate.pass).toBe(true)

    const bad = analyseEngine('gemini', await collectDay('2026-08-19', 0.6, 0.3), await collectDay('2026-08-20', 0.6, 0.3), bank, null, 10)
    expect(bad.dayToDay!.rho).toBeGreaterThan(0.4)
    expect(bad.gate.deff5!).toBeGreaterThan(1.5)
    expect(bad.gate.deff).toBe(false)
    expect(bad.gate.pass).toBe(false)
    expect(bad.gate.reasons.join(' ')).toMatch(/DEFF/)

    const single = analyseEngine('gemini', await collectDay('2026-08-19', 0.6, 0.3), null, bank, null, 10)
    expect(single.gate.status).toBe('NOT RUN')
    expect(single.gate.pass).toBeNull()
    expect(single.dayToDay).toBeNull()

    // day 2 is a byte-for-byte replay of day 1: D → 0, identical-text rate 100% → integrity FAIL, never a pass
    const d1 = await collectDay('2026-08-19', 0, 0.3)
    const replay = { ...d1, answers: d1.answers.map((a) => ({ ...a, cell: { ...a.cell, dateBucket: '2026-08-20', key: a.cell.key + 'x' } })) }
    const cached = analyseEngine('gemini', d1, replay, bank, null, 10)
    expect(cached.identicalTextRate).toBe(1)
    expect(cached.dayToDay === null || cached.dayToDay.ratio < 0.5).toBe(true)
    expect(cached.gate.pass).not.toBe(true)
  })

  it('pairs cells on the run indices both days actually have, not by position', async () => {
    const d1 = await collectDay('2026-08-19', 0, 0.3)
    const d2full = await collectDay('2026-08-20', 0, 0.3)
    // drop run 3 from every day-2 cell: a per-run failure must not silently delete the cell
    const d2 = { ...d2full, answers: d2full.answers.filter((a) => a.run !== 3) }
    const r = analyseEngine('gemini', d1, d2, bank, null, 10)
    expect(r.dayToDay!.cells).toBe(180)
    expect(r.dayToDay!.m).toBe(9)
    expect(r.dayToDayM5!.m).toBe(5)
  })

  it('empty answers are excluded from cells for chat engines and count against parseable', async () => {
    const d1 = await collectDay('2026-08-19', 0, 0.3)
    const blanks = { ...d1, answers: d1.answers.map((a, i) => (i % 5 === 0 ? { ...a, text: '' } : a)) }
    const r = analyseEngine('gemini', blanks, null, bank, null, 10)
    expect(r.emptyRate).toBeCloseTo(0.2)
    expect(r.gate.parseable).toBe(false)
    expect(r.byBrand[0]!.n).toBe(480)
    const aio = analyseEngine('google-ai-overviews', { ...blanks }, null, bank, null, 10)
    expect(aio.gate.parseable).toBe(true) // "no overview" is a legitimate empty answer there
  })
})
