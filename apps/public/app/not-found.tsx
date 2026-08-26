import { BackLink } from '@/components/back-link'

/**
 * The 404 is a page a demo can reach by accident, so it is a designed page
 * rather than a bare heading: browser-default type in the middle of a styled
 * app reads as something broken, and it offers a way back instead of a dead end.
 */
export default function NotFound() {
  return (
    <main className="shell">
      <BackLink href="/" label="Back to the free Grader" />

      <header className="masthead">
        <div>
          <h1>Page not found</h1>
          <p className="cycle">AI Visibility Grader</p>
        </div>
      </header>
      <p>That page does not exist.</p>
    </main>
  )
}
