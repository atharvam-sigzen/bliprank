import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cyclePath, dayOf, latestCycle, latestPath, listCycles, readCycle, writeCycle } from './cycles.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-cycles-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const result = (domain: string, day: string, extra: Record<string, unknown> = {}) => ({
  status: 'scanned',
  domain,
  category: 'crm-software',
  run: { day, mode: 'live' },
  collectedAt: `${day}T10:00:00.000Z`,
  brands: [{ id: 'x', isSubject: true, metric: { value: 0.4 } }],
  ...extra,
})

describe('a cycle is one domain on one day', () => {
  it('dayOf prefers the runner-stamped day and falls back to collectedAt, never to the clock', () => {
    expect(dayOf({ status: 'scanned', domain: 'a.com', run: { day: '2026-09-03' }, collectedAt: '2026-09-04T01:00:00Z' })).toBe('2026-09-03')
    expect(dayOf({ status: 'scanned', domain: 'a.com', collectedAt: '2026-09-04T01:00:00Z' })).toBe('2026-09-04')
    expect(dayOf({ status: 'scanned', domain: 'a.com' })).toBeNull()
    expect(dayOf({ status: 'scanned', domain: 'a.com', run: { day: 'yesterday' } })).toBeNull()
  })

  it('writes the cycle file AND the latest file with the same bytes', () => {
    const w = writeCycle(dir, result('acme.com', '2026-09-02'))
    expect('refuse' in w).toBe(false)
    if ('refuse' in w) return
    expect(w.day).toBe('2026-09-02')
    expect(readFileSync(w.cycle, 'utf8')).toBe(readFileSync(w.latest, 'utf8'))
    expect(w.cycle).toBe(cyclePath(dir, 'acme.com', '2026-09-02'))
    expect(w.latest).toBe(latestPath(dir, 'acme.com'))
  })

  it('refuses to file what is not a finished scan, and what has no day', () => {
    expect(writeCycle(dir, { status: 'no-answers', domain: 'acme.com', run: { day: '2026-09-02' } })).toHaveProperty('refuse')
    expect(writeCycle(dir, { status: 'scanned', domain: 'acme.com' })).toHaveProperty('refuse')
    expect(listCycles(dir, 'acme.com')).toEqual([])
  })
})

describe('cycles coexist: a second day never overwrites the first', () => {
  it('two days are two cycles, oldest first, and the latest file follows the newest write', () => {
    writeCycle(dir, result('acme.com', '2026-09-02', { tag: 'first' }))
    writeCycle(dir, result('acme.com', '2026-09-05', { tag: 'second' }))
    const cycles = listCycles<{ status: string; domain: string; tag?: string }>(dir, 'acme.com')
    expect(cycles.map((c) => c.day)).toEqual(['2026-09-02', '2026-09-05'])
    expect(cycles.map((c) => c.result.tag)).toEqual(['first', 'second'])
    expect(latestCycle(dir, 'acme.com')?.day).toBe('2026-09-05')
    expect(JSON.parse(readFileSync(latestPath(dir, 'acme.com'), 'utf8')).tag).toBe('second')
  })

  it('the same day written twice is one cycle — the cache key is per day, so it is the same measurement', () => {
    writeCycle(dir, result('acme.com', '2026-09-02', { tag: 'a' }))
    writeCycle(dir, result('acme.com', '2026-09-02', { tag: 'b' }))
    expect(listCycles(dir, 'acme.com')).toHaveLength(1)
  })

  it('⚠️ a domain scanned before this store existed has exactly one cycle: its latest file', () => {
    // The three results already on disk have no cycles directory. They must
    // read as one cycle each, not as zero, or the dashboard would say "no
    // cycle collected" about a scan that cost real money.
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeFileSync(latestPath(dir, 'legacy.com'), JSON.stringify(result('legacy.com', '2026-08-25')))
    const cycles = listCycles(dir, 'legacy.com')
    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.day).toBe('2026-08-25')
    expect(cycles[0]!.file).toBe(latestPath(dir, 'legacy.com'))
    // And a later cycle joins it rather than replacing it.
    writeCycle(dir, result('legacy.com', '2026-09-03'))
    expect(listCycles(dir, 'legacy.com').map((c) => c.day)).toEqual(['2026-08-25', '2026-09-03'])
  })

  it('a legacy latest file without a run block still counts, by collectedAt', () => {
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeFileSync(latestPath(dir, 'old.com'), JSON.stringify({ status: 'scanned', domain: 'old.com', collectedAt: '2026-08-20T09:00:00Z' }))
    expect(listCycles(dir, 'old.com').map((c) => c.day)).toEqual(['2026-08-20'])
  })

  it('domains do not see each other', () => {
    writeCycle(dir, result('a.com', '2026-09-02'))
    writeCycle(dir, result('b.com', '2026-09-03'))
    expect(listCycles(dir, 'a.com').map((c) => c.day)).toEqual(['2026-09-02'])
    expect(listCycles(dir, 'b.com').map((c) => c.day)).toEqual(['2026-09-03'])
  })
})

describe('what is skipped, and why', () => {
  it('audit rows, unparseable files, and a file whose name disagrees with its day', () => {
    writeCycle(dir, result('acme.com', '2026-09-02'))
    const d = join(dir, 'results', 'cycles', 'acme.com')
    writeFileSync(join(d, '2026-09-02.det-1.audit.json'), JSON.stringify(result('acme.com', '2026-09-02')))
    writeFileSync(join(d, '2026-09-03.json'), '{ not json')
    // Filed under the 4th, claims the 5th: a filing error, trusted neither way.
    writeFileSync(join(d, '2026-09-04.json'), JSON.stringify(result('acme.com', '2026-09-05')))
    expect(listCycles(dir, 'acme.com').map((c) => c.day)).toEqual(['2026-09-02'])
  })

  it("a file for ANOTHER domain in this domain's directory is not listed — the directory is not the identity", () => {
    writeCycle(dir, result('acme.com', '2026-09-02'))
    writeFileSync(join(dir, 'results', 'cycles', 'acme.com', '2026-09-03.json'), JSON.stringify(result('other.com', '2026-09-03')))
    expect(listCycles(dir, 'acme.com').map((c) => c.day)).toEqual(['2026-09-02'])
    // And a latest file holding another domain's result is not this domain's cycle either.
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeFileSync(latestPath(dir, 'ghost.com'), JSON.stringify(result('someone-else.com', '2026-09-04')))
    expect(listCycles(dir, 'ghost.com')).toEqual([])
  })

  it('readCycle finds a day, and refuses a non-day rather than globbing', () => {
    writeCycle(dir, result('acme.com', '2026-09-02'))
    expect(readCycle(dir, 'acme.com', '2026-09-02')?.day).toBe('2026-09-02')
    expect(readCycle(dir, 'acme.com', '2026-09-09')).toBeNull()
    expect(readCycle(dir, 'acme.com', '..')).toBeNull()
  })
})
