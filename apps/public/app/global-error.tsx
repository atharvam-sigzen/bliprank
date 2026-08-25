'use client'

/**
 * The App Router's own error boundary.
 *
 * ⚠️ CORRECTION, and it is worth keeping: this was added believing it would fix
 * `next build`, which had been failing with "Html should not be imported outside
 * of pages/_document". It did not. The real cause was NODE_ENV being set to
 * `development` in the build environment, which makes Next fall back to the
 * pages-router error page while prerendering /404 and /500. `NODE_ENV=production
 * next build` succeeds with or without this file.
 *
 * It stays on its own merits rather than the ones it was added for. Without a
 * global error boundary, a component that throws in front of an audience shows
 * a raw framework error page; with one, it shows something that says what
 * happened in the product's own voice — and says the thing this product always
 * says, which is that no number is being shown because none was produced.
 *
 * It must render its own `<html>` and `<body>`: a global error replaces the root
 * layout entirely, so nothing from `layout.tsx` is available here — including
 * the stylesheet. Everything below is therefore inline by necessity rather than
 * by choice, and it is the one place in this codebase where that is correct.
 */

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-GB">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          padding: '3rem 1.5rem',
          background: '#f6f6f3',
          color: '#15181d',
          fontFamily: 'Georgia, "Times New Roman", serif',
          lineHeight: 1.6,
        }}
      >
        <main style={{ maxWidth: '38rem', margin: '0 auto' }}>
          {/* The oxide leader, drawn by hand — the refusal marker the rest of
              the product uses, since the stylesheet cannot be reached. */}
          <div style={{ width: 28, height: 2, background: '#b3341f', marginBottom: '1rem' }} />
          <h1 style={{ fontSize: '1.75rem', fontWeight: 400, margin: '0 0 1rem', lineHeight: 1.2 }}>Something broke on this page</h1>
          <p style={{ margin: '0 0 1rem' }}>
            This is a fault in the application, not a result. No measurement is being shown because none was produced, and nothing here falls back
            to sample data.
          </p>
          {error.digest ? (
            <p style={{ margin: '0 0 1.5rem', fontFamily: 'ui-monospace, monospace', fontSize: '0.8125rem', color: '#5a6675' }}>
              reference {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 44,
              padding: '0 1.25rem',
              background: 'transparent',
              color: '#1e5a7d',
              border: '1px solid #828d9e',
              borderRadius: 8,
              font: 'inherit',
              fontSize: '0.9375rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
