import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Resolve react the way apps/public does, once, so every specifier below is
// pinned to the SAME copy. `resolve.dedupe` cannot do this here: it resolves
// from the workspace root, where pnpm hoists no react.
const resolveReact = createRequire(new URL('./apps/public/package.json', import.meta.url)).resolve

export default defineConfig({
  // apps/public's `@/*` path alias, so a component can be rendered in a test the
  // same way Next resolves it. Regex-anchored on `@/` rather than keyed on `@`:
  // a bare `@` key is a prefix match and would rewrite every `@bliprank/*`
  // import in the monorepo.
  resolve: {
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL('./apps/public/', import.meta.url)) },
      // One React instance, guaranteed at resolution time rather than left to
      // the externalization cache. Without these the suite's health depends on
      // the state of node_modules/.vite: a stale cache externalises
      // `react-dom/server` against a second React whose hooks dispatcher is
      // null, and every renderToStaticMarkup of a hooks component dies on
      // "Cannot read properties of null (reading 'useState')".
      // `server.deps.inline` below was not enough on its own (vitest 3.2.7 /
      // pnpm / win32) — it was observed both green and red depending on cache
      // state — so the specifiers are pinned to absolute paths instead.
      { find: /^react$/, replacement: resolveReact('react') },
      { find: /^react\/jsx-runtime$/, replacement: resolveReact('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolveReact('react/jsx-dev-runtime') },
      { find: /^react-dom$/, replacement: resolveReact('react-dom') },
      { find: /^react-dom\/server$/, replacement: resolveReact('react-dom/server') },
    ],
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
    // Vitest otherwise inlines/transforms `react` while externalising
    // `react-dom/server` to node_modules, giving the SSR renderer a second React
    // whose hooks dispatcher is null — every renderToStaticMarkup of a hooks
    // component then throws "Cannot read properties of null (reading 'useState')".
    // Inlining both keeps one React instance across test and renderer.
    server: { deps: { inline: ['react', 'react-dom'] } },
  },
})
