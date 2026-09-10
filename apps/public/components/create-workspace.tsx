'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

/** One name, one button; POSTs to `/api/workspaces` and re-renders the account page. */
export function CreateWorkspace() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [state, setState] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null })

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setState({ busy: true, message: null })
    try {
      const res = await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      const body = (await res.json()) as { message?: string }
      if (res.ok) {
        setName('')
        setState({ busy: false, message: null })
        router.refresh()
      } else {
        setState({ busy: false, message: body.message ?? 'No answer from the server.' })
      }
    } catch {
      setState({ busy: false, message: 'The request did not reach the server. Check the connection and try again.' })
    }
  }

  return (
    <form onSubmit={submit} aria-busy={state.busy}>
      <label className="field__label" htmlFor="workspace-name">
        New workspace
      </label>
      <div className="field__row">
        <input id="workspace-name" className="field" type="text" name="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Client or brand name" />
        <button className="btn btn--primary" type="submit" disabled={state.busy}>
          {state.busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      {state.message ? (
        <p className="note note--flag" role="alert">
          <span className="note__line">{state.message}</span>
        </p>
      ) : null}
    </form>
  )
}
