import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // deploy-check.test.ts stands up a fresh PGlite instance and runs three
    // migrations per case, because the states it tests (role attributes, ad-hoc
    // grants, a legacy key present before 0002) cannot be undone inside one
    // database. That is several seconds per test, not the default 5s budget.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
