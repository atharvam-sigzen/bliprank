import { defineConfig } from 'vitest/config'

export default defineConfig({
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
