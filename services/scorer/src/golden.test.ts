import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GOLDEN_SET_TARGET, runGoldenSet, validateGoldenCase, type GoldenCase } from './golden.js'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'answers')

function loadGolden(): GoldenCase[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) as GoldenCase)
}

describe('golden set — structure', () => {
  const cases = loadGolden()

  it('is non-empty and every case is structurally valid', () => {
    expect(cases.length).toBeGreaterThan(0)
    const errs = cases.flatMap(validateGoldenCase)
    expect(errs).toEqual([])
  })

  it('every case declares what edge it covers, so the set does not silently duplicate itself', () => {
    for (const c of cases) expect(c.covers, `${c.id} has no "covers" note`).toBeTruthy()
  })

  it('ids are unique', () => {
    const ids = cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the validator actually rejects a bad label', () => {
    const base = cases[0]!
    expect(validateGoldenCase({ ...base, label: { ...base.label, mentioned: false, position: 3 } })).toContainEqual(expect.stringContaining('position is not null'))
    expect(validateGoldenCase({ ...base, brand: { ...base.brand, aliases: [] } })).toContainEqual(expect.stringContaining('no aliases'))
    expect(validateGoldenCase({ ...base, label: { ...base.label, citationClasses: { '99': 'owned' } } })).toContainEqual(
      expect.stringContaining('does not exist'),
    )
  })
})

describe('golden set — agreement harness', () => {
  const report = runGoldenSet(loadGolden())

  it('the seed set agrees with the scorer on every labelled field', () => {
    const failing = report.deterministic.filter((f) => f.rate < 1)
    expect(failing.flatMap((f) => f.disagreements)).toEqual([])
    expect(report.citationClass.disagreements).toEqual([])
  })

  it('ADR-0005: nothing a human labelled otherwise came back as `owned`', () => {
    expect(report.silentOwned).toEqual([])
  })

  it('does NOT claim G2 — the set is far below the target size', () => {
    expect(report.cases).toBeLessThan(GOLDEN_SET_TARGET)
    expect(report.gateStatus).toBe('NOT_RUN')
    expect(report.gateNote).toMatch(/NOT RUN/)
  })

  it('the harness reports FAIL rather than throwing when a label disagrees', () => {
    const cases = loadGolden()
    const broken = { ...cases[0]!, id: 'broken', label: { ...cases[0]!.label, mentioned: !cases[0]!.label.mentioned } }
    const r = runGoldenSet([broken])
    expect(r.deterministicRate).toBeLessThan(1)
    expect(r.deterministic.find((f) => f.field === 'mentioned')?.disagreements).toHaveLength(1)
  })

  it('a padded set at target size would be judged, not skipped', () => {
    // Same seven cases repeated to reach the target: proves the gate arithmetic
    // wires up. It is NOT evidence about accuracy — the same cases repeated
    // carry no more information than one pass of them.
    const cases = loadGolden()
    const padded = Array.from({ length: GOLDEN_SET_TARGET }, (_, i) => ({ ...cases[i % cases.length]!, id: `pad-${i}` }))
    const r = runGoldenSet(padded)
    expect(r.gateStatus).toBe('PASS')
    expect(r.gateNote).toMatch(/deterministic 100\.0%/)
  })
})
