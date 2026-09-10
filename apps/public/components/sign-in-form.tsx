'use client'

import { useState, type FormEvent } from 'react'

/**
 * The sign-in form: email, the account kind, one button. Posts JSON to
 * `/api/auth/sign-in` and then shows the server's sentence, whichever it is.
 * The kind is a radio pair with real labels rather than a toggle, because it
 * is chosen once and the choice has consequences the label states.
 */
export function SignInForm() {
  const [email, setEmail] = useState('')
  const [kind, setKind] = useState<'brand' | 'agency'>('brand')
  const [state, setState] = useState<{ busy: boolean; message: string | null; sent: boolean }>({ busy: false, message: null, sent: false })

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setState({ busy: true, message: null, sent: false })
    try {
      const res = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, kind }),
      })
      const body = (await res.json()) as { message?: string }
      setState({ busy: false, message: body.message ?? 'No answer from the server.', sent: res.ok })
    } catch {
      setState({ busy: false, message: 'The request did not reach the server. Check the connection and try again.', sent: false })
    }
  }

  if (state.sent) {
    return (
      <p className="note" role="status">
        <span className="note__line">{state.message}</span>
      </p>
    )
  }

  return (
    <form className="card" onSubmit={submit} aria-busy={state.busy}>
      <label className="field__label" htmlFor="sign-in-email">
        Email
      </label>
      <div className="field__row">
        <input
          id="sign-in-email"
          className="field"
          type="email"
          name="email"
          autoComplete="email"
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
      </div>

      <fieldset>
        <legend className="field__label">This account is</legend>
        <label>
          <input type="radio" name="kind" value="brand" checked={kind === 'brand'} onChange={() => setKind('brand')} /> a brand: one workspace, for our own domain
        </label>
        <br />
        <label>
          <input type="radio" name="kind" value="agency" checked={kind === 'agency'} onChange={() => setKind('agency')} /> an agency: a workspace per client
        </label>
      </fieldset>

      <p className="note__gloss">The choice is made once. A brand account is refused a second workspace; changing an account's kind later is done by us, on request.</p>

      <button className="btn btn--primary" type="submit" disabled={state.busy}>
        {state.busy ? 'Sending…' : 'Send me a sign-in link'}
      </button>
      {state.message ? (
        <p className="note note--flag" role="alert">
          <span className="note__line">{state.message}</span>
        </p>
      ) : null}
    </form>
  )
}
