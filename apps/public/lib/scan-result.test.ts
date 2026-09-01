/**
 * THE DEFECT THIS FILE EXISTS FOR.
 *
 * `run` was declared REQUIRED on `ScanResultFile` and seventeen call sites read
 * `scan.run.day`, `scan.run.engines.length` and `scan.run.spentUsd` through it.
 * Two shapes of scan file exist: the CLI envelope, which has a run block, and
 * the file `/api/scan` caches, which did not. So scanning a domain through the
 * UI cached a file that crashed the UI that read it — `TypeError: Cannot read
 * properties of undefined`, on the dashboard, for the domain the visitor had
 * just paid to measure.
 *
 * Two rules are asserted here and they are the whole point:
 *
 *   1. Every field of `RunInfo` is either recorded by the file or derived from
 *      something the file actually carries. Where nothing carries it, the answer
 *      is `null` or `'unknown'` — never a stand-in. A `spentUsd` of 0 for a scan
 *      that bought 85 answers is a fabricated number, and a numeric slot reads
 *      as a small measurement rather than as an absence.
 *
 *   2. A cached file the app cannot read fails a test rather than a demo.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { buildHeadToHead } from './head-to-head'
import { previewScore } from './preview-score'
import { BUNDLED_SCANS, SCAN, SIGZEN, measuresCurrentCategory, rememberScan, runInfoOf, scanFor, scans, subjectOf, type ScanResultFile } from './scan-result'
import { workspaceFor } from './workspace'

const SIGZEN_ENGINES = ['chatgpt', 'copilot', 'gemini', 'google-ai-mode', 'google-ai-overviews']

describe('runInfoOf — recorded when recorded, derived when not, invented never', () => {
  it('uses the run block VERBATIM when the file has one', () => {
    const info = runInfoOf(SCAN)
    expect(info).toEqual({ day: SCAN.run.day, engines: SCAN.run.engines, spentUsd: SCAN.run.spentUsd ?? null, mode: SCAN.run.mode })
    // Recorded, not re-derived: a run block whose day disagrees with
    // `collectedAt` still reports the day the runner said it ran.
    const shifted: ScanResultFile = { ...SCAN, run: { ...SCAN.run, day: '2020-01-01' }, collectedAt: '2026-08-25T00:00:00.000Z' }
    expect(runInfoOf(shifted).day).toBe('2020-01-01')
    // A recorded spend is used verbatim; a run block that records none yields
    // null, not 0 - the same rule as a file with no run block at all.
    expect(runInfoOf({ ...SCAN, run: { ...SCAN.run, spentUsd: 0.176 } }).spentUsd).toBe(0.176)
    const { spentUsd: _dropped, ...noSpend } = SCAN.run
    expect(runInfoOf({ ...SCAN, run: noSpend }).spentUsd).toBeNull()
  })

  it('derives day and engines for a file with NO run block, and refuses to invent a cost', () => {
    const info = runInfoOf(SIGZEN)
    expect(SIGZEN.run).toBeUndefined()
    expect(info.day).toBe('2026-08-25')
    expect(info.engines).toEqual(SIGZEN_ENGINES)

    // ⚠️ EXACTLY null, and the assertion is written twice on purpose: `toBe(0)`
    // and `toBeNull()` both pass for a value that is falsy, and 0 here is the
    // bug. This file records no spend, so nothing may be printed for it.
    expect(info.spentUsd).toBeNull()
    expect(Object.is(info.spentUsd, null)).toBe(true)
    expect(info.spentUsd).not.toBe(0)

    // 'unknown', not 'live'. A cached file is not evidence of where its answers
    // came from, and the page may not claim a provider it cannot see.
    expect(info.mode).toBe('unknown')
  })

  it('a file with no run and no parseable comparisonBasis yields engines [] without throwing', () => {
    const junk = { ...SIGZEN, comparisonBasis: 'grader|en-US|US' } as ScanResultFile
    expect(runInfoOf(junk).engines).toEqual([])
    // Not even a string, which is what a hand-edited or truncated cache file
    // looks like. The count is omitted; nothing throws.
    const missing = { ...SIGZEN, comparisonBasis: undefined as unknown as string, collectedAt: undefined as unknown as string }
    expect(runInfoOf(missing)).toEqual({ day: '', engines: [], spentUsd: null, mode: 'unknown' })
  })
})

describe('scanFor — a registry, not one constant', () => {
  it('resolves every scan this build holds, in any typed form', () => {
    expect(scanFor('pipedrive.com')?.domain).toBe('pipedrive.com')
    expect(scanFor('https://www.Pipedrive.com/')?.domain).toBe('pipedrive.com')

    // The one that used to be invisible: scanned through the UI, cached, and
    // then unreachable because `scanFor` only ever matched the committed scan.
    // sigzen is no longer bundled, so this now exercises the path it was always
    // really about — a SESSION scan resolving in any typed form.
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    rememberScan(SIGZEN)
    expect(scanFor('sigzen.com')?.domain).toBe('sigzen.com')
    expect(scanFor(' SIGZEN.com ')?.domain).toBe('sigzen.com')
    vi.unstubAllGlobals()
  })

  it('returns null for a domain this build has not scanned', () => {
    expect(scanFor('example.com')).toBeNull()
    expect(scanFor('')).toBeNull()
  })
})

describe('the live-scanned domain is COLLECTED everywhere, not just on the Grader', () => {
  it('workspaceFor(sigzen.com) reports data and the day it was collected', () => {
    // Through the session registry, which is where a live-scanned domain now
    // lives: sigzen was dropped from BUNDLED_SCANS because rung 4 reclassifies
    // it, and the claim under test — a scan the Grader collected is COLLECTED on
    // the dashboard too — is about the cached path, not about being bundled.
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    rememberScan(SIGZEN)

    const w = workspaceFor('sigzen.com')
    expect(w).not.toBeNull()
    expect(w!.hasData).toBe(true)
    expect(w!.lastRunDay).toBe('2026-08-25')
    expect(w!.answersCollected).toBe(85)

    vi.unstubAllGlobals()
  })

  it('THE ZERO-COMPETITOR PATH: one brand is measured, ranked against nothing, and says so', () => {
    const subject = subjectOf(SIGZEN)
    const competitors = SIGZEN.brands.filter((b) => !b.isSubject)
    expect(competitors).toEqual([])

    // The position component is REPORTED MISSING rather than scored. Half credit
    // for an absent input would have paid this brand for comparisons that never
    // happened.
    const preview = previewScore(subject, competitors)
    expect(preview.missing).toContain('competitive position')
    expect(preview.parts.map((p) => p.label)).toEqual(['mention rate'])
    expect(preview.comparable).toBe(0)
    expect(Number.isFinite(preview.score)).toBe(true)

    // And the chart is a chart of one row rather than an error.
    const h = buildHeadToHead({ label: subject.name, metric: subject.metric }, [])
    expect(h.rows).toHaveLength(1)
    expect(h.subject.isSubject).toBe(true)

    // The fallback disclosure has something to render, which is what stops the
    // category name reading as if it had been determined.
    expect(SIGZEN.fallback?.reason).toBe('unclassified')
  })
})

/**
 * THE GUARD.
 *
 * `services/grader/data-live/results/` is what `/api/scan` writes and is NOT
 * committed, so on a clean checkout this loop sees nothing and the bundled scans
 * carry the assertions. On the machine where a live scan has run — the machine
 * where this class of defect appears — every cached file is put through the same
 * accessors the pages use. A file the app cannot read fails here rather than in
 * front of someone.
 */
const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'services', 'grader', 'data-live', 'results')

const cachedFiles = (): readonly { name: string; scan: ScanResultFile }[] =>
  existsSync(RESULTS)
    ? readdirSync(RESULTS)
        .filter((f) => f.endsWith('.json'))
        .map((name) => ({ name, scan: JSON.parse(readFileSync(join(RESULTS, name), 'utf8')) as ScanResultFile }))
    : []

describe('every scan file this build could load renders', () => {
  const cases = [
    ...BUNDLED_SCANS.map((scan, i) => ({ name: `bundled:${scan.domain ?? i}`, scan })),
    ...cachedFiles().map((f) => ({ name: `data-live:${f.name}`, scan: f.scan })),
  ]

  it.each(cases)('$name', ({ scan }) => {
    // A file that is not a finished scan is refused by `scanFor`, which is how
    // the pages never try to render one. That is the assertion for it.
    if (scan.status !== 'scanned') {
      expect(scanFor(scan.domain)).toBeNull()
      return
    }

    const run = runInfoOf(scan)
    expect(typeof run.day).toBe('string')
    expect(Array.isArray(run.engines)).toBe(true)
    // Either a real recorded figure or null. Never 0 standing in for "unknown".
    expect(run.spentUsd === null || typeof run.spentUsd === 'number').toBe(true)
    if (scan.run === undefined) expect(run.spentUsd).toBeNull()

    const subject = subjectOf(scan)
    expect(subject).toBeDefined()
    const competitors = scan.brands.filter((b) => !b.isSubject)
    expect(() => previewScore(subject, competitors)).not.toThrow()
    if (competitors.length > 0) {
      expect(() =>
        buildHeadToHead({ label: subject.name, metric: subject.metric }, competitors.map((b) => ({ label: b.name, metric: b.metric }))),
      ).not.toThrow()
    }

    // A RECORDED COST IS THIS RUN'S, NOT THE LEDGER'S.
    //
    // `runGrader` used to stamp `budget.state.spentUsd` - the lifetime total for
    // the whole data dir - into every result, so a 22-call scan claimed $0.7640
    // against a true ceiling of 22 x $0.008. The dearest payg engine bounds any
    // honest per-run figure; anything above it is somebody else's spend.
    if (run.spentUsd !== null) expect(run.spentUsd).toBeLessThanOrEqual(scan.counts.providerCalls * 0.008 + 1e-9)

    // Registry membership is a property of THIS build, not of the file. A
    // cached scan that was never bundled is correctly absent, and asserting
    // otherwise turned the suite red on the next successful live scan - which
    // teaches the next reader to delete the guard.
    const w = workspaceFor(scan.domain)
    if (scanFor(scan.domain) === null) {
      expect(w?.hasData).toBe(false)
      return
    }
    expect(w?.hasData).toBe(true)
    expect(w?.answersCollected).toBe(scan.counts.answersScored)
  })
})

/**
 * REGRESSIONS. One per defect that was real.
 */
describe('a scan collected this session is visible on every surface', () => {
  const NOTION: ScanResultFile = { ...SIGZEN, domain: 'notion.so' }

  it('scanFor and workspaceFor find it after rememberScan, and bundled scans still win', () => {
    // vitest runs in node; the stash is a no-op without storage, which is the
    // SSR/static-export case and must not throw.
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })

    expect(scanFor('notion.so')).toBeNull()
    expect(workspaceFor('notion.so')?.hasData).toBe(false)

    rememberScan(NOTION)

    expect(scanFor('notion.so')?.domain).toBe('notion.so')
    expect(scanFor('https://WWW.Notion.so/pricing')?.domain).toBe('notion.so')
    const w = workspaceFor('notion.so')
    expect(w?.hasData).toBe(true)
    expect(w?.answersCollected).toBe(85)
    expect(w?.lastRunDay).toBe('2026-08-25')

    // Stored once, not appended per scan, and the committed demo scan is never
    // shadowed by a session one.
    rememberScan(NOTION)
    expect(scans().filter((s) => s.domain === 'notion.so')).toHaveLength(1)
    rememberScan({ ...SCAN, counts: { ...SCAN.counts, answersScored: 1 } })
    expect(scanFor('pipedrive.com')?.counts.answersScored).toBe(SCAN.counts.answersScored)

    vi.unstubAllGlobals()
  })

  it('an unfinished scan is not remembered, and no storage is not a crash', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    rememberScan({ ...SIGZEN, domain: 'queued.com', status: 'no-answers' })
    expect(scanFor('queued.com')).toBeNull()
    vi.unstubAllGlobals()

    // No localStorage at all: the bundled scans still resolve.
    expect(() => rememberScan(NOTION)).not.toThrow()
    expect(scans()).toEqual(BUNDLED_SCANS)
  })

  it('a corrupted or stale-build session entry is dropped, never a crash', () => {
    // Storage is a trust boundary: every one of these is legal JSON under the
    // key, and each used to crash a different surface — '{}' the spread in
    // scans(), '[null]' the chrome's status filter, a scan with no domain the
    // normaliser, one with empty brands the subjectOf non-null assertion.
    const cases = [
      '{}',
      '[null]',
      '"a string"',
      JSON.stringify([{ status: 'scanned' }]),
      JSON.stringify([{ status: 'scanned', domain: 'x.com', brands: [] }]),
      JSON.stringify([{ status: 'scanned', domain: 'x.com', brands: [{ id: 'x' }] }]), // no counts
      // Passed the old shallow guard, then crashed intervalWidth on
      // `undefined - undefined` in every record surface.
      JSON.stringify([{ domain: 'x.com', status: 'scanned', brands: [{}], counts: {} }]),
      // Rendered '−NaN% / +NaN%': metric present but empty.
      JSON.stringify([{ ...SIGZEN, domain: 'x.com', brands: [{ ...SIGZEN.brands[0], metric: {} }] }]),
      // Crashed HeadToHeadSection at scan.categoryName.toLowerCase().
      JSON.stringify([{ ...SIGZEN, domain: 'x.com', categoryName: undefined }]),
      // counts present but answersScored missing (stale-build shape drift).
      JSON.stringify([{ ...SIGZEN, domain: 'x.com', counts: {} }]),
    ]
    for (const raw of cases) {
      vi.stubGlobal('localStorage', { getItem: () => raw, setItem: () => undefined })
      expect(scans()).toEqual(BUNDLED_SCANS)
      // The BUNDLED scan still resolves through a corrupt session entry — that
      // is the claim. It was asserted on sigzen, which stopped being bundled;
      // pipedrive is the domain that actually carries the property now.
      expect(scanFor('pipedrive.com')?.domain).toBe('pipedrive.com')
      expect(workspaceFor('pipedrive.com')?.hasData).toBe(true)
      vi.unstubAllGlobals()
    }

    // A valid entry sharing the array with a corrupt one survives the filter.
    const NOTION_OK: ScanResultFile = { ...SIGZEN, domain: 'notion.so' }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([null, NOTION_OK]), setItem: () => undefined })
    expect(scanFor('notion.so')?.domain).toBe('notion.so')
    vi.unstubAllGlobals()
  })
})

describe('no scan file carries a fabricated cost', () => {
  it('the committed reference scan records no spend rather than the ledger total', () => {
    // $0.7640 was the whole data dir's lifetime spend, stamped onto a 22-call
    // scan. It is removed, not corrected: the real figure is not recoverable.
    expect(SCAN.run.spentUsd).toBeUndefined()
    expect(runInfoOf(SCAN).spentUsd).toBeNull()
  })
})

/**
 * THE STALE-CATEGORY CACHE, which served a measurement of a different thing.
 *
 * `/api/scan` keyed its result cache on the domain alone. sigzen.com was
 * collected under `general-business-software` and recorded since as
 * `erp-software`, so the preview offered the ERP prompts and the cache answered
 * with the general-business-software number. Same domain, different question,
 * no indication on screen that the two had parted company.
 */
describe('measuresCurrentCategory — the category is part of the cache key', () => {
  const under = (category: string) => ({ ...SIGZEN, category })

  it('a result collected under a category we no longer decide is a MISS', () => {
    // The exact specimen: collected general-business-software, recorded erp.
    expect(measuresCurrentCategory(under('general-business-software'), 'erp-software')).toBe(false)
  })

  it('a result collected under the category we still decide is a hit', () => {
    expect(measuresCurrentCategory(under('crm-software'), 'crm-software')).toBe(true)
  })

  it('no record is not a mismatch — a scan predating the mechanism still stands', () => {
    // Invalidating every result collected before records existed would re-spend
    // the whole cache to learn nothing.
    expect(measuresCurrentCategory(under('general-business-software'), null)).toBe(true)
  })

  it('a file recording no category is kept rather than guessed at', () => {
    // Cannot be checked. Refuse to guess, in the direction that does not spend.
    const { category: _dropped, ...noCategory } = SIGZEN
    expect(measuresCurrentCategory(noCategory, 'erp-software')).toBe(true)
    expect(measuresCurrentCategory({ ...SIGZEN, category: '' }, 'erp-software')).toBe(true)
    expect(measuresCurrentCategory({ ...SIGZEN, category: 42 }, 'erp-software')).toBe(true)
  })

  it('junk that is not an object is a miss, never a served result', () => {
    for (const junk of [null, undefined, 'a string', 42, []]) {
      expect(measuresCurrentCategory(junk, 'crm-software')).toBe(false)
    }
  })
})
