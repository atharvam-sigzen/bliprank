import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * THE FORWARD ACTION — a destination label, not a sentence.
 *
 * An inline link asks to be read; this asks to be pressed. It stands on its
 * own line with a short label naming where it goes ("Manage prompts",
 * "Worked example") and the disclosure prose stays OUTSIDE it, as plain
 * prose — a sentence-long link is a control nobody can aim at. The right
 * chevron is what says "forward" so the resting state needs no underline;
 * hover and focus add one, which is the same restatement every quiet link
 * on the sheet uses.
 *
 * Styling lives in globals.css under `.actionlink` (44px minimum target).
 * The chevron rides currentColor and is aria-hidden: the label already says
 * where the action leads. `external` changes nothing visually — a different
 * glyph would make the reader learn two marks for one gesture — it only
 * adds rel="noreferrer" because the destination is another origin.
 */
export function ActionLink({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  const chevron = (
    <svg className="actionlink__chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  return external ? (
    <a className="actionlink" href={href} rel="noreferrer">
      {children}
      {chevron}
    </a>
  ) : (
    <Link className="actionlink" href={href}>
      {children}
      {chevron}
    </Link>
  )
}
