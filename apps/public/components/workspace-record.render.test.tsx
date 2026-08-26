/**
 * THE MEASURED RECORD, ACTUALLY RENDERED — the three claims this change made:
 *
 *   1. The head-to-head the Grader renders now renders in the record too,
 *      including the zero-competitor branch's honest prose (sigzen).
 *   2. A bundled reference scan is labelled as one in the letterhead margin.
 *   3. Brand context carries the pointer to /dashboard/workspace instead of
 *      the inline facts; agency context keeps the facts inline.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCAN, SIGZEN } from '../lib/scan-result'
import { WorkspaceRecord } from './workspace-record'

const brand = (domain: string) => renderToStaticMarkup(<WorkspaceRecord domain={domain} context="brand" />)

describe('head-to-head parity in the measured record', () => {
  it('renders the comparison for a scan with competitors', () => {
    const html = brand(SCAN.domain)
    expect(html).toContain('How that compares in')
    expect(html).toContain('h2h')
    // The "what is not on this page" list no longer implies the comparison is absent.
    expect(html).toContain('The head-to-head comparison is not in this list')
  })

  it('keeps the honest zero-competitor prose for sigzen', () => {
    const html = brand(SIGZEN.domain)
    expect(html).toContain('There is no comparison on this scan')
    // No chart, and no claim that a comparison sits above.
    expect(html).not.toContain('The head-to-head comparison is not in this list')
  })
})

describe('the reference-scan note', () => {
  it('labels a bundled demo record in the letterhead margin', () => {
    for (const domain of [SCAN.domain, SIGZEN.domain]) {
      const html = brand(domain)
      expect(html).toContain('Reference scan')
      expect(html).toContain('demonstration record bundled with this build')
    }
  })
})

describe('where the workspace facts live', () => {
  it('brand context points at /dashboard/workspace and renders no inline facts', () => {
    const html = brand(SCAN.domain)
    expect(html).toContain('href="/dashboard/workspace"')
    expect(html).toContain('id="settings"')
    expect(html).not.toContain('Tracked domain')
  })

  it('agency context keeps the facts inline', () => {
    const html = renderToStaticMarkup(<WorkspaceRecord domain={SCAN.domain} context="agency-client" />)
    expect(html).toContain('Tracked domain')
    expect(html).not.toContain('href="/dashboard/workspace"')
  })
})
