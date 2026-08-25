import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // apps/public's `@/*` path alias, so a component can be rendered in a test the
  // same way Next resolves it. Regex-anchored on `@/` rather than keyed on `@`:
  // a bare `@` key is a prefix match and would rewrite every `@bliprank/*`
  // import in the monorepo.
  resolve: {
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('./apps/public/', import.meta.url)) }],
  },
  // React 17+ automatic runtime, matching what Next compiles the apps with.
  // Without it esbuild falls back to the classic transform and any component
  // rendered in a test dies on "React is not defined" — a failure about the
  // harness, not the component.
  esbuild: { jsx: 'automatic' },
  test: {
    // packages/db/src/deploy-check.test.ts stands up a fresh PGlite instance and
    // runs three migrations per case — the states it tests (role attributes,
    // ad-hoc grants, a legacy signing key present before 0002) cannot be undone
    // inside one database, so isolation is the only way to test them. That is
    // seconds per test, not the default 5s budget. packages/db carries the same
    // setting for when the suite is run from inside that package.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
