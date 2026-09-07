import { realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

// The canonical repo root, spelled the way `root` below needs it — see the note
// there about the drive letter's case being load-bearing on win32. Every path
// this config hands to vite is built from it so no id can differ by case.
const ROOT = realpathSync.native(process.cwd()).replace(/\\/g, '/')

/**
 * `@/…` resolves against apps/public, matching its tsconfig (`@/*` -> `./*`).
 * Returning null falls through to vite's own resolution, so a genuinely
 * missing file still errors rather than silently landing elsewhere.
 */
function resolveAppAlias(id: string): string | null {
  const base = `${ROOT}/apps/public/${id}`
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not this extension; try the next.
    }
  }
  return null
}

// Resolve react the way apps/public does, once, so every specifier below is
// pinned to the SAME copy. `resolve.dedupe` cannot do this here: it resolves
// from the workspace root, where pnpm hoists no react.
// Forward slashes, even on win32: vite's externalization test looks for
// '/node_modules/' in the id, and a backslashed path sails past it — the
// aliased react is then transformed as project source, a SECOND evaluation
// beside the CJS copy react-dom/server requires natively.
const require_ = createRequire(new URL('./apps/public/package.json', import.meta.url))
const resolveReact = (id: string) => require_.resolve(id).replace(/\\/g, '/')

export default defineConfig({
  // THE DRIVE LETTER'S CASE IS LOAD-BEARING (win32). Vite derives module ids
  // from the cwd as typed — `d:\bliprank` in one shell, `D:\bliprank` in
  // another — and externalized modules are imported natively by that id. But
  // react-dom/server's own `require('react')` crosses a pnpm symlink, which
  // node realpaths to the CANONICAL case. `d:/…/react/index.js` and
  // `D:\…\react\index.js` are then two distinct cache keys, two evaluations of
  // React, and a null hooks dispatcher in every renderToStaticMarkup — in a
  // lowercase-cwd shell only, which is why this suite was "green and red
  // depending on cache state". Pinning root to the realpathed cwd makes every
  // id canonical regardless of how the shell spelt the drive.
  root: ROOT,
  // The `@/*` path alias, so a component can be rendered in a test the same way
  // Next resolves it. Regex-anchored on `@/` rather than keyed on `@`: a bare
  // `@` key is a prefix match and would rewrite every `@bliprank/*` import in
  // the monorepo.
  resolve: {
    alias: [
      // The empty replacement hands the resolver the bare subpath ('lib/x'),
      // which it joins onto apps/public — see resolveAppAlias above.
      { find: /^@\//, replacement: '', customResolver: (id: string) => resolveAppAlias(id) },
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
