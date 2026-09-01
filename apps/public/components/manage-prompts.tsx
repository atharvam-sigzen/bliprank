'use client'

import { useEffect, useState } from 'react'
import { BackLink } from '@/components/back-link'
import { TIERS, capRefusal, type Tier } from '@/lib/pricing'
import { addCustomPrompt, readCustomPrompts, removeCustomPrompt } from '@/lib/custom-prompts'
import { PROMPTS_PER_CYCLE, preflightPrompts, workspaceFor } from '@/lib/workspace'

/**
 * MANAGE PROMPTS — the curated bank as a record, custom prompts as a control.
 *
 * Two materials on one page, and the split is the point. The bank is paper:
 * these are the real prompts a cycle would send, exactly as written, and
 * nothing here edits them. The custom list is chassis: a field and a list a
 * visitor operates, stored in this browser only.
 *
 * ⚠️ NO PLAN IS ATTACHED IN THIS BUILD, and this page does not pretend
 * otherwise. There is no billing, no checkout and no entitlement anywhere in
 * the repo — `lib/pricing.ts` says so in its own docblock — so a cap presented
 * as "your limit" would be describing a purchase that has not happened.
 *
 * What it does instead is let you CHECK against a plan. Pick one and the Add
 * control enforces that plan's cap for as long as it is picked, refusing an
 * addition that would take the pool over and saying which plan refused it. Pick
 * none — the default — and nothing is enforced, which is exactly the behaviour
 * that shipped before. The caps themselves come from the published tiers and are
 * still statements about the OFFER.
 *
 * Nothing here schedules or collects a custom prompt: adding one changes the
 * allocation arithmetic on this page and nothing else.
 */
export function ManagePrompts({ domain, backHref, backLabel }: { domain: string; backHref: string; backLabel: string }) {
  const workspace = workspaceFor(domain)
  const [custom, setCustom] = useState<readonly string[]>([])
  const [draft, setDraft] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  /*
   * Component state, not storage, and deliberately.
   *
   * This is a lens on the published plans, not an entitlement. Persisting it
   * would make it look like a plan this workspace HOLDS — the one thing this
   * page must not imply — and the honest version of that state is a row in a
   * subscriptions table that does not exist.
   */
  const [checkAgainst, setCheckAgainst] = useState<Tier['id'] | ''>('')

  // Storage is read in an effect, not during render: the server rendered this
  // component with an empty list, and reading localStorage mid-render would
  // make the first client render disagree with it.
  useEffect(() => {
    setCustom(readCustomPrompts(domain))
  }, [domain])

  if (!workspace) {
    return (
      <section className="record">
        <p className="prose">{domain} is not a usable domain, so it has no prompt bank to manage.</p>
      </section>
    )
  }

  const curated = preflightPrompts(workspace.categorySlug, PROMPTS_PER_CYCLE)
  const total = curated.length + custom.length
  const checked = TIERS.find((t) => t.id === checkAgainst)

  const onAdd = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = draft.trim()
    if (!trimmed) return

    /*
     * THE CAP IS CHECKED BEFORE THE ADD, NOT AFTER IT.
     *
     * One pool, any split — `lib/pricing.ts` — so the curated bank counts
     * against the same allowance. Checking afterwards and rolling back would
     * mean the prompt was briefly stored, and a failed rollback in a private
     * window would leave it there permanently over the cap.
     */
    const overCap = capRefusal(checked, curated.length, custom.length)
    if (overCap) {
      setRefusal(overCap)
      return
    }

    const { list, added } = addCustomPrompt(domain, trimmed, custom)
    if (!added) {
      // The lib refused it. Saying why beats a button that appears to do
      // nothing — and the only two reasons are length and duplication.
      setRefusal(
        trimmed.length > 200
          ? 'A prompt is capped at 200 characters.'
          : 'That prompt is already on the list (matching ignores case).'
      )
      return
    }
    setCustom(list)
    setDraft('')
    setRefusal(null)
  }

  return (
    <>
      <BackLink href={backHref} label={backLabel} />

      <header className="annotated masthead">
        <div className="annotated__body">
          <h1 className="record__title">Tracked prompts</h1>
          <p className="lede">{workspace.domain} · {workspace.categoryName}</p>
        </div>
        <aside className="note">
          <span className="note__cap">Allocation</span>
          <span className="note__line">{curated.length} curated + {custom.length} your own</span>
          <span className="note__line">= {total} tracked prompts</span>
          <span className="note__gloss">
            One pool, any split. The curated bank and your own prompts draw on the same allowance under every published plan.
          </span>
        </aside>
      </header>

      <section className="section">
        <h2>The curated bank</h2>
        <div className="annotated">
          <div className="annotated__body">
            <p className="prose">
              The {curated.length} prompts of the {workspace.categoryName.toLowerCase()} bank&apos;s unprompted set. These are real, exactly as a
              cycle would send them, and none of them names a brand.
            </p>
            <ol className="promptlist">
              {curated.map((prompt) => (
                <li className="promptlist__item" key={prompt.text}>
                  <span className="promptlist__text">{prompt.text}</span>
                  <span className="promptlist__intent">{prompt.intent}</span>
                </li>
              ))}
            </ol>
          </div>
          <aside className="note">
            <span className="note__cap">Bank</span>
            <span className="note__line">{workspace.categorySlug}</span>
            <span className="note__line">{curated.length} unprompted</span>
            <span className="note__gloss">
              A prompt that names you measures our own phrasing rather than what the engines volunteer, so those are excluded by construction.
            </span>
          </aside>
        </div>
      </section>

      <section className="section">
        <h2>Your own prompts</h2>
        <div className="annotated">
          <div className="annotated__body">
            <form className="card" onSubmit={onAdd}>
              <label className="field__label" htmlFor="custom-prompt">
                Add a prompt
              </label>
              <div className="field__row">
                <input
                  id="custom-prompt"
                  className={`field${refusal ? ' field--invalid' : ''}`}
                  type="text"
                  value={draft}
                  maxLength={200}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setRefusal(null)
                  }}
                  placeholder="e.g. best invoicing tool for a two-person studio"
                  {...(refusal ? { 'aria-describedby': 'custom-prompt-error' } : {})}
                />
                <button type="submit" className="btn btn--primary">
                  Add
                </button>
              </div>
              {refusal ? (
                <p id="custom-prompt-error" role="alert" className="field__error">
                  {refusal}
                </p>
              ) : null}
            </form>

            {custom.length === 0 ? (
              <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
                No custom prompts are stored in this browser for {workspace.domain}.
              </p>
            ) : (
              <ol className="promptlist" style={{ marginTop: 'var(--space-3)' }}>
                {custom.map((text) => (
                  <li className="promptlist__item" key={text.toLowerCase()}>
                    <span className="promptlist__text">{text}</span>
                    <button type="button" className="btn btn--quiet" onClick={() => setCustom(removeCustomPrompt(domain, text, custom))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
            )}

            {/* THE HONESTY LINE. A list of prompts under an "Add" button reads
                as configuration of a running system, and there is no running
                system. Said in prose, next to the control that invites the
                misreading. */}
            <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
              Custom prompts are stored in this browser only. Nothing schedules or collects them, because recurring collection is not built;
              adding one changes the allocation arithmetic on this page and nothing else. No prompt on this list has been asked of any engine.
            </p>
          </div>
          <aside className="note">
            <span className="note__cap">Storage</span>
            <span className="note__line">this browser only</span>
            <span className="note__line">cap 200 characters</span>
            <span className="note__gloss">
              There is no account behind this list yet, so clearing site data clears it.
            </span>
          </aside>
        </div>
      </section>

      <section className="section">
        <h2>Against the published plans</h2>
        <div className="annotated">
          <div className="annotated__body">
            <p className="prose">
              <span className="num">{curated.length}</span> curated + <span className="num">{custom.length}</span> your own ={' '}
              <span className="num">{total}</span> tracked prompts.
            </p>
            {/* The caps are conditional statements about the OFFER, derived
                from the published tiers. Rendering one as this workspace's
                limit would imply a purchase that has not happened. */}
            <p className="prose prose--flag" style={{ marginTop: 'var(--space-2)' }}>
              No plan is attached to this workspace in this build, so nothing here is an allowance you hold. Pick one below to hold the list to
              that plan&apos;s cap while you work.
            </p>

            {/* THE CHECKER. A select rather than three buttons: this is one
                choice from a short closed list, which is the control a native
                select is for, and it comes with keyboard and screen-reader
                behaviour nobody has to reimplement. */}
            <div className="field__row field__row--inline" style={{ marginTop: 'var(--space-3)' }}>
              <label className="field__label" htmlFor="check-plan">
                Hold this list to
              </label>
              <select
                id="check-plan"
                className="field"
                value={checkAgainst}
                onChange={(e) => {
                  setCheckAgainst(e.target.value as Tier['id'] | '')
                  setRefusal(null)
                }}
              >
                <option value="">no cap</option>
                {TIERS.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.name} — {tier.prompts} prompts
                  </option>
                ))}
              </select>
            </div>

            {checked ? (
              <p className="prose" style={{ marginTop: 'var(--space-2)' }}>
                {total >= checked.prompts ? (
                  <>
                    This workspace is at <span className="num">{total}</span> of the <span className="num">{checked.prompts}</span>{' '}
                    {checked.name} allows, so adding another prompt is refused until one is removed.
                  </>
                ) : (
                  <>
                    <span className="num">{checked.prompts - total}</span> of {checked.name}&apos;s{' '}
                    <span className="num">{checked.prompts}</span> prompts are still free.
                  </>
                )}
              </p>
            ) : null}
          </div>
          <aside className="note">
            <span className="note__cap">{checked ? 'Holding to' : 'Would allow'}</span>
            {TIERS.map((tier) => (
              <span className="note__line" key={tier.id}>
                {tier.id === checkAgainst ? '▸ ' : ''}
                {tier.name} {tier.prompts} prompts{total > tier.prompts ? ` — over the ${tier.name} cap` : ''}
              </span>
            ))}
            <span className="note__gloss">
              Caps come from the published plans and are shared between the curated bank and your own prompts — one pool, any split. Choosing one
              here checks against it; it buys nothing and stores nothing.
            </span>
          </aside>
        </div>
      </section>
    </>
  )
}
