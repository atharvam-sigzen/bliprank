import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { CreateWorkspace } from '@/components/create-workspace'
import { identityConfig } from '@/lib/auth/config'
import { appDb } from '@/lib/auth/db'
import { meOf } from '@/lib/auth/handlers'
import { currentUser } from '@/lib/auth/supabase'

export const metadata: Metadata = { title: 'Your account — BlipRank' }
export const dynamic = 'force-dynamic'

/**
 * THE ACCOUNT PAGE — who you are to this product, and what you own.
 *
 * Rendered on the server from the verified session and `workspaces_of()`
 * (migration 0003). Not signed in: straight to sign-in. Signed in with no
 * account row (a confirm that failed half-way): the sign-in page explains.
 *
 * What it does NOT yet do (MVP_PLAN B3, D1): open a workspace. The dashboard
 * and the agency portfolio still read this browser's registry; the workspace
 * rows here are the account's ownership record until B3 moves the store
 * behind them. The page says that rather than linking to something that
 * would show the wrong data.
 */
export default async function Account() {
  const identity = identityConfig(process.env)
  if (!identity.on) redirect('/sign-in?error=off')
  const got = await meOf({ user: () => currentUser(identity.config), db: appDb(identity.config) })
  if (!got) redirect('/sign-in')

  const brandFull = got.account.kind === 'brand' && got.workspaces.some((w) => w.role === 'owner')
  return (
    <main className="shell shell--pricing">
      <ProductBar current={got.account.kind === 'agency' ? 'agency' : 'grader'} />
      <BackLink href="/" label="Back to the Grader" />
      <header className="letterhead">
        <h1>Your account</h1>
        <p>
          Signed in as <strong>{got.account.email}</strong>, a {got.account.kind === 'agency' ? 'agency' : 'brand'} account.
        </p>
      </header>

      <section className="card" aria-labelledby="workspaces-h">
        <h2 id="workspaces-h">Workspaces</h2>
        {got.workspaces.length === 0 ? (
          <p className="note__gloss">None yet. {got.account.kind === 'agency' ? 'Create one per client.' : 'Create the one for your domain.'}</p>
        ) : (
          <ul>
            {got.workspaces.map((w) => (
              <li key={w.id}>
                {w.name} <span className="note__gloss">({w.role})</span>
              </li>
            ))}
          </ul>
        )}
        {brandFull ? (
          <p className="note__gloss">A brand account has one workspace. To manage several, ask us to make this an agency account.</p>
        ) : (
          <CreateWorkspace />
        )}
      </section>

      <p className="note">
        <span className="note__line">
          A workspace here is the account's ownership record. Measurements still live where they were collected until the store moves behind
          accounts (MVP_PLAN B3); the Grader and the workspace record are unchanged meanwhile.
        </span>
      </p>
    </main>
  )
}
