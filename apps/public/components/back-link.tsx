import Link from 'next/link'

/**
 * THE BACK AFFORDANCE — one component, one position, one voice.
 *
 * Every page below the fork doors gets its way back from here: an arrow and a
 * label that names the actual destination ("Back to the Grader", "Back to the
 * portfolio"), never a bare arrow the reader has to guess at. It sits at the
 * top of the content column, above the letterhead, on every page that uses it,
 * so the way back is always in the same place.
 *
 * Styling lives in globals.css under `.backlink` (44px minimum target). The
 * arrow is inline SVG on currentColor so it takes the link's colour in every
 * state, and it is aria-hidden: the label already says where the link goes.
 * The label gets its own span so the sheet can address the words without
 * catching the chevron.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="backlink" href={href}>
      <svg className="backlink__arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="backlink__label">{label}</span>
    </Link>
  )
}
