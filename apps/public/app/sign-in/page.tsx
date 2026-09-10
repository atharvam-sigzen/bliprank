import type { Metadata } from 'next'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { SignInForm } from '@/components/sign-in-form'
import { identityConfig, IDENTITY_OFF } from '@/lib/auth/config'

export const metadata: Metadata = {
  title: 'Sign in — BlipRank',
  description: 'Sign in with a link sent to your email. No password.',
}

/**
 * SIGN-IN — a magic link, and the one question the account never asks again.
 *
 * The form asks for an email and whether this account is a brand (one
 * workspace of its own) or an agency (many client workspaces). The kind is
 * chosen here because migration 0003 fixes it at account creation: a brand
 * account owns one workspace, and the database refuses a second. Changing
 * kind later is an operator action, not a form.
 *
 * With identity off this page says so in one sentence and offers nothing
 * that looks like it would work.
 */
export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const identity = identityConfig(process.env)
  const { error } = await searchParams
  const reason =
    error === 'link'
      ? 'That sign-in link is not valid any more. Links work once and for a short while; request a new one.'
      : error === 'account'
        ? 'You are signed in, but no account could be created. The cause has been logged; try again in a moment.'
        : error === 'off'
          ? IDENTITY_OFF
          : null
  return (
    <main className="shell shell--pricing">
      <ProductBar current="grader" />
      <BackLink href="/" label="Back to the Grader" />
      <header className="letterhead">
        <h1>Sign in</h1>
        <p>A link is sent to your email. There is no password to keep.</p>
      </header>
      {reason ? (
        <p className="note note--flag" role="status">
          <span className="note__line">{reason}</span>
        </p>
      ) : null}
      {identity.on ? (
        <SignInForm />
      ) : (
        <p className="note">
          <span className="note__line">{IDENTITY_OFF} The Grader and the reference record work without an account.</span>
        </p>
      )}
    </main>
  )
}
