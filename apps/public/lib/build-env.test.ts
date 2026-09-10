import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
 *
 * The same file pins the other facts about the build that live outside any
 * package: the CI gate (MVP_PLAN B0) and the absence of a linter that the
 * source used to address by name.
 */
const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))

describe('the harness does not set NODE_ENV', () => {
  const settings = JSON.parse(readFileSync(root('.claude/settings.json'), 'utf8')) as { env?: Record<string, string> }

  it('.claude/settings.json leaves NODE_ENV to the tool that owns it', () => {
    expect(settings.env?.['NODE_ENV']).toBeUndefined()
  })
})

describe('the CI gate (MVP_PLAN B0)', () => {
  const ci = readFileSync(root('.github/workflows/ci.yml'), 'utf8')

  it('runs on every push and pull request', () => {
    expect(ci).toMatch(/^on:\n\s+push:\n\s+pull_request:/m)
  })

  it('runs exactly the two commands the gate is made of, in order', () => {
    const runs = [...ci.matchAll(/^\s+- run: (.+)$/gm)].map((m) => m[1])
    expect(runs).toEqual(['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test'])
  })

  it('is offline by construction: no key, no collection flag, no secret reaches the job (R3)', () => {
    // The header names the flags to say they are absent; only the YAML itself is checked.
    const yaml = ci.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(yaml).not.toMatch(/OPENWEBNINJA|ANTHROPIC_API_KEY|COLLECTION_ENABLED|GRADER_LIVE_SCAN|DATABASE_URL|secrets\./)
  })
})

describe('no linter is addressed by name', () => {
  // Strict tsc is the gate. A directive naming a linter that is not installed
  // is a promise nothing keeps; B0 removed the three that existed.
  it('no eslint-disable directive in tracked source', () => {
    const tracked = execFileSync('git', ['ls-files', '--', 'apps', 'packages', 'services', 'scripts'], { cwd: root(''), encoding: 'utf8' })
      .split('\n')
      .filter((p) => /\.(ts|tsx|mjs|js)$/.test(p) && !p.endsWith('lib/build-env.test.ts'))
    expect(tracked.length).toBeGreaterThan(100)
    const offenders = tracked.filter((p) => readFileSync(root(p), 'utf8').includes('eslint-' + 'disable'))
    expect(offenders).toEqual([])
  })
})
