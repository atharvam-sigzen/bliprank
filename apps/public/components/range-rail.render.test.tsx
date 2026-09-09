import { readFileSync } from 'node:fs'
import { formatBounds, formatInterval, formatValue, type Metric } from '@bliprank/stats'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RangeRail } from './range-rail'

/**
 * The range rail prints the digits `packages/stats/format` prints, and no
 * others (CLAUDE.md §8). The audit found the bounds formatted inline with
 * `toFixed`, which is a second opinion on what an interval reads as.
 */
const metric = (over: Partial<Metric> = {}): Metric => ({
  value: 0.25,
  ci_low: 0.17,
  ci_high: 0.35,
  n: 150,
  algo_version: 'det-3',
  collection_path: 'third-party-grounded',
  comparison_basis: 'engines=5|en-US|US|bank-1|cycle',
  ...over,
})

const html = (m: Metric, dp?: number) => renderToStaticMarkup(<RangeRail label="Mention rate" metric={m} {...(dp === undefined ? {} : { dp })} />)

describe('the rail’s numbers are the formatter’s numbers', () => {
  it('a wide interval prints each bound as formatBounds gives it', () => {
    const m = metric()
    const out = html(m)
    const b = formatBounds(m)
    expect(out).toContain(`>${b.low}<`)
    expect(out).toContain(`>${b.high}<`)
    expect(out).toContain(formatValue(m))
    expect(out).toContain(formatInterval(m))
  })

  it('a narrow interval prints once, as formatInterval gives it', () => {
    const m = metric({ value: 0.02, ci_low: 0.005, ci_high: 0.045 })
    const out = html(m, 2)
    expect(out).toContain(`>${formatInterval(m, 2)}<`)
  })

  it('never formats a number itself', () => {
    const src = readFileSync(new URL('./range-rail.tsx', import.meta.url), 'utf8')
    expect(src).not.toMatch(/toFixed\(/)
  })
})
