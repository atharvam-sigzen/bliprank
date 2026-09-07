import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * THE BUILD ENVIRONMENT IS PART OF THE BUILD.
 *
 * `next build` failed for two weeks on this repo with "<Html> should not be
 * imported outside of pages/_document" while prerendering /404 and /500, and
 * it was recorded twice as a pre-existing defect in the app. It was not. The
 * Claude Code harness settings injected `NODE_ENV=development` into every
 * process an agent session spawned, and a production build under a
 * development NODE_ENV makes Next fall back to the pages-router error page.
 * The same build with NODE_ENV unset, or `production`, has always passed.
 *
 * Re-running the failing build under the same poisoned environment "confirmed
 * the defect" every time, which is exactly what confirming the environment
 * looks like. So the environment is pinned here, where a reappearance fails
 * the suite rather than the next deploy attempt: the harness may set flags
 * the product reads, and it may not set the one Next owns.
 */
describe('the harness does not set NODE_ENV', () => {
  const settings = JSON.parse(readFileSync(new URL('../../../.claude/settings.json', import.meta.url), 'utf8')) as { env?: Record<string, string> }

  it('.claude/settings.json leaves NODE_ENV to the tool that owns it', () => {
    expect(settings.env?.['NODE_ENV']).toBeUndefined()
  })
})
