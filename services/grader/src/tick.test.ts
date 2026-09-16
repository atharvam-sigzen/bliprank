import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { printDue } from './tick.js'

/**
 * The tick CLI's dry listing. It collects nothing and books nothing; what it
 * must show is what the ledger already holds that an operator would otherwise
 * never see (MVP_PLAN C2r item 3).
 */

/** This test is one process over its scratch directory, which the file ledgers require it to say (B3c item 4). */
const ONE: NodeJS.ProcessEnv = { COLLECTOR_TOPOLOGY: 'single-process' }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bliprank-tick-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const mark = (day: string, published: number, failed: number) => ({
  capUsd: 1,
  spentUsd: 0,
  calls: 0,
  domains: {},
  fanOut: { startedAt: `${day}T06:15:00.000Z`, publishedAt: `${day}T06:15:01.000Z`, published, failed },
})

describe("the dry listing surfaces the fan-out's failed publishes", () => {
  it("prints today's and yesterday's failed count when non-zero, and nothing about a day with none or a day the fan-out never ran", async () => {
    writeFileSync(join(dir, 'daily-spend.json'), JSON.stringify({ '2026-09-15': mark('2026-09-15', 3, 2), '2026-09-16': mark('2026-09-16', 4, 1), '2026-09-14': mark('2026-09-14', 1, 9) }))
    const lines: string[] = []
    await printDue(dir, ONE, '2026-09-16', (s) => lines.push(s))
    expect(lines[0]).toMatch(/^tick · 2026-09-16 · 0 tracked/)
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^  fan-out 2026-09-16: 1 domain job\(s\) QStash did not take \(4 published\); those hosts did not run that day/),
        expect.stringMatching(/^  fan-out 2026-09-15: 2 domain job\(s\) QStash did not take \(3 published\)/),
      ]),
    )
    // Two days back is not today's operator's question; and a day with no failure prints no such line.
    expect(lines.some((l) => l.includes('2026-09-14'))).toBe(false)
    const quiet: string[] = []
    writeFileSync(join(dir, 'daily-spend.json'), JSON.stringify({ '2026-09-16': mark('2026-09-16', 4, 0) }))
    await printDue(dir, ONE, '2026-09-16', (s) => quiet.push(s))
    expect(quiet.some((l) => l.includes('did not take'))).toBe(false)
    // No ledger at all: the listing prints as it always did.
    rmSync(join(dir, 'daily-spend.json'))
    const none: string[] = []
    await printDue(dir, ONE, '2026-09-16', (s) => none.push(s))
    expect(none[0]).toMatch(/^tick · 2026-09-16/)
    expect(none.some((l) => l.includes('did not take') || l.includes('daily ledger:'))).toBe(false)
  })

  it('a reservation left running past a quarter of an hour is named, with what to do; a settled line is not', async () => {
    writeFileSync(
      join(dir, 'daily-spend.json'),
      JSON.stringify({
        '2026-09-10': {
          ...mark('2026-09-10', 2, 0),
          spentUsd: 1.1,
          domains: {
            'ws-1:acme.test': { spentUsd: 0.69, calls: 0, status: 'running', at: '2026-09-10T06:20:00.000Z' },
            'ws-1:beta.test': { spentUsd: 0.41, calls: 85, status: 'scanned', at: '2026-09-10T06:21:00.000Z' },
          },
        },
      }),
    )
    const lines: string[] = []
    await printDue(dir, ONE, '2026-09-10', (s) => lines.push(s))
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^ {2}in flight ws-1:acme\.test: reserved \$0\.690 since 2026-09-10T06:20:00\.000Z and never settled; if that run died, repair daily-spend\.json/)]))
    expect(lines.some((l) => l.includes('beta.test'))).toBe(false)
  })

  it('a corrupt daily ledger is reported on its own line, and the listing still prints', async () => {
    writeFileSync(join(dir, 'daily-spend.json'), 'not json')
    const lines: string[] = []
    await printDue(dir, ONE, '2026-09-16', (s) => lines.push(s))
    expect(lines[0]).toMatch(/^tick · 2026-09-16/)
    expect(lines.some((l) => /^  daily ledger: .*daily-spend\.json is not readable JSON/.test(l))).toBe(true)
  })
})
