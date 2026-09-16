import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN, type ScanResultFile } from '../lib/scan-result'
import { customMovement } from '../lib/scan-result-custom'
import { CustomPromptsBlock } from './custom-prompts-block'

/**
 * The second measurement, rendered from a synthetic block on the bundled
 * reference scan. Under test: it is its own record with its own interval,
 * never compared with the headline; "asked, nothing came back" is said as a
 * collection outcome; a file without the block renders nothing.
 */

const basis = (v: number) => `grader|engines=chatgpt,copilot,gemini,google-ai-mode,google-ai-overviews|en-US|US|crm-software@1|unprompted=0|runs=1|custom=2@${v}`
const metric = (value: number, n: number, v = 1) => ({ value, ci_low: Math.max(0, value - 0.2), ci_high: Math.min(1, value + 0.2), n, algo_version: 'det-2', collection_path: 'third-party-grounded', comparison_basis: basis(v) })
const withBlock = (over: Partial<{ version: number; answersScored: number; value: number; day: string }> = {}): ScanResultFile =>
  ({
    ...SCAN,
    collectedAt: `${over.day ?? '2026-09-01'}T10:00:00.000Z`,
    run: { ...(SCAN as { run?: object }).run, day: over.day ?? '2026-09-01' },
    customPrompts: {
      version: over.version ?? 1,
      prompts: ['best crm for a two-person studio', 'which crm works offline on a phone'],
      comparisonBasis: basis(over.version ?? 1),
      counts: { cellsRequested: 10, answersScored: over.answersScored ?? 10 },
      brands: (over.answersScored ?? 10) > 0 ? [{ id: 'pipedrive', name: 'Pipedrive', isSubject: true, mentions: Math.round((over.value ?? 0.5) * 10), citations: 0, metric: metric(over.value ?? 0.5, over.answersScored ?? 10, over.version ?? 1) }] : [],
    },
  }) as unknown as ScanResultFile

describe('your prompts, as a second record', () => {
  it('states the rate with its interval over its own answers, says it is not compared with the headline, lists the prompts, names the set version', () => {
    const scan = withBlock()
    const html = renderToStaticMarkup(<CustomPromptsBlock scan={scan} cycles={[scan]} />)
    expect(html).toContain('Your prompts')
    expect(html).toContain('separate measurement from the headline')
    expect(html).toContain('not compared with each other')
    expect(html).toContain('best crm for a two-person studio')
    expect(html).toContain('prompt set version 1')
    expect(html).toContain('50.0%')
  })

  it('asked and nothing came back is a collection outcome, not a zero', () => {
    const html = renderToStaticMarkup(<CustomPromptsBlock scan={withBlock({ answersScored: 0 })} cycles={[]} />)
    expect(html).toContain('no answer came back to score')
    expect(html).toContain('not a zero')
    expect(html).not.toContain('%')
  })

  it('a file without the block renders nothing, and two cycles on the same set compare while a changed set does not', () => {
    expect(renderToStaticMarkup(<CustomPromptsBlock scan={SCAN} cycles={[SCAN]} />)).toBe('')
    const a = withBlock({ day: '2026-09-01', value: 0.5 })
    const b = withBlock({ day: '2026-09-08', value: 0.55 })
    const same = customMovement([a, b])
    expect(same?.verdict.significance).not.toBe('not-comparable')
    const c = withBlock({ day: '2026-09-15', version: 2, value: 0.9 })
    const changed = customMovement([a, b, c])
    expect(changed?.verdict.significance).toBe('not-comparable')
    expect(changed?.why).toContain('the custom prompt set')
    const html = renderToStaticMarkup(<CustomPromptsBlock scan={c} cycles={[a, b, c]} />)
    expect(html).toContain('not comparable')
  })
})
