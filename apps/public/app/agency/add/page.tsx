'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ProductBar } from '@/components/chrome'
import { ScanRefusal } from '@/components/scan-progress'
import {
  PROMPTS_PER_CYCLE,
  addAgencyDomain,
  collectionLine,
  collectionStatus,
  preflightPrompts,
  readAgencyDomains,
  workspaceFor,
  type Workspace,
} from '@/lib/workspace'

/**
 * ADD A CLIENT — the one screen on this product where inventing a number would
 * be easiest and worst.
 *
 * A brand-new client has no measurement. None. (A domain this build already
 * collected is the other case, and the sheet says so from the same field the
 * portfolio reads — the two screens are not allowed to disagree.) Every tool in
 * this category
 * fills that moment with something: a zero, a dash that reads as a zero, an
 * industry average, a "your score will appear here" placeholder that a
 * screenshot cannot be told apart from a real reading. This page shows what is
 * actually knowable before collection — the category, the prompts a cycle would
 * ask, the surfaces it would ask them on — and then stops, because that is
 * where knowledge stops.
 *
 * ⚠️ NOTHING HERE COLLECTS. `workspaceFor` and `preflightPrompts` are pure
 * offline lookups over the committed taxonomy and prompt banks (R3): no fetch,
 * no adapter, no spend, no `COLLECTION_ENABLED` path. Adding a client writes one
 * string to this browser's localStorage. The confirmed state says "queued" and
 * means it literally — there is no queue behind it and no runner watching one.
 *
 * THE FORM IS CHASSIS, THE OUTCOME IS PAPER. The domain field is a control you
 * operate, so it sits in a panel. What comes back — a refusal, a preflight, a
 * confirmation — is the record of an outcome and is typeset on the sheet, the
 * same division the Grader draws.
 */

type State =
  | { phase: 'idle' }
  | { phase: 'refused'; message: string }
  | { phase: 'duplicate'; domain: string }
  | { phase: 'preview'; workspace: Workspace }
  | { phase: 'added'; workspace: Workspace }

/** Enough of the bank to prove the prompts are real, not enough to be the bank. */
const PREFLIGHT_SHOWN = 5

export default function AddClient() {
  const [typed, setTyped] = useState('')
  const [state, setState] = useState<State>({ phase: 'idle' })

  // The portfolio count is read from storage, so it renders only after mount:
  // SSR has no localStorage and a private window throws on the property itself.
  const [mounted, setMounted] = useState(false)
  const [count, setCount] = useState(0)

  useEffect(() => {
    setMounted(true)
    setCount(readAgencyDomains().length)
  }, [])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const workspace = workspaceFor(typed)

    // Not a domain. Note this is the SAME guard the portfolio uses, so a string
    // that cannot become a workspace never becomes a row either.
    if (!workspace) {
      setState({
        phase: 'refused',
        message: `"${typed.trim()}" is not a domain, so no workspace was created for it. A workspace needs a host we can classify — a filename or a stray phrase gives nothing to measure and nothing to measure it against.`,
      })
      return
    }

    if (readAgencyDomains().includes(workspace.domain)) {
      setState({ phase: 'duplicate', domain: workspace.domain })
      return
    }

    setState({ phase: 'preview', workspace })
  }

  function confirm(workspace: Workspace) {
    setCount(addAgencyDomain(workspace.domain).length)
    setState({ phase: 'added', workspace })
  }

  function reset() {
    setTyped('')
    setState({ phase: 'idle' })
  }

  return (
    <main className="shell shell--grader">
      <ProductBar current="agency" />

      <div className="annotated masthead">
        <div className="annotated__body">
          <h1>Add a client</h1>
          <p className="lede">See what a cycle would ask before anything is collected for it.</p>
        </div>
        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">Collects nothing</span>
          <span className="note__gloss">
            Adding a client classifies a domain and reserves prompts against a plan. It does not collect an answer, call a provider or spend
            anything, and it shows no figure for a client that has never been measured.
          </span>
          <span className="note__line">{mounted ? `${count} in this portfolio` : 'reading this browser'}</span>
        </aside>
      </div>

      <section className="addclient">
        <div className="annotated">
          {/* The one instrument you operate, so the one panel on the page. */}
          <form className="card annotated__body" onSubmit={submit} noValidate>
            {/* Visible label, not a placeholder: a placeholder disappears the
                moment it is needed, which is when the user starts typing. */}
            <label className="field__label" htmlFor="client-domain">
              Client domain
            </label>
            <p id="client-domain-help" className="metric__interval" style={{ marginTop: 0, marginBottom: 'var(--space-2)' }}>
              We work out the category and the prompts a cycle would ask. Nothing is collected.
            </p>
            <div className="field__row">
              <input
                id="client-domain"
                name="client-domain"
                type="text"
                inputMode="url"
                autoComplete="url"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-describedby="client-domain-help"
                placeholder="acme.com"
                // Class, not an inline style: inline colours are invisible to
                // the contrast suite and an inline transition cannot be reached
                // by prefers-reduced-motion.
                className="field"
              />
              <button type="submit" className="btn btn--primary">
                Check this domain
              </button>
            </div>
          </form>

          <aside className="note">
            <span className="note__cap">Offline</span>
            <span className="note__line">classification · prompt bank</span>
            <span className="note__line">{PROMPTS_PER_CYCLE} prompts × 5 surfaces</span>
            <span className="note__gloss">
              Classification and the prompt bank are committed data and resolve with no network call, which is why this step is free and why it can
              be shown before you commit to anything.
            </span>
          </aside>
        </div>

        {state.phase === 'refused' ? (
          <ScanRefusal kind="unclassified" message={state.message} onReset={reset} />
        ) : state.phase === 'duplicate' ? (
          <Duplicate domain={state.domain} onReset={reset} />
        ) : state.phase === 'preview' ? (
          <Preflight workspace={state.workspace} onConfirm={confirm} onReset={reset} />
        ) : state.phase === 'added' ? (
          <Added workspace={state.workspace} onReset={reset} />
        ) : null}
      </section>

      <section className="section">
        <h2>Why there is no number on this page</h2>
        <p className="prose">
          A client with no collected cycle has been measured zero times. The honest render of zero measurements is not a zero, not a dash and not a faded
          figure waiting to fill in: it is a sentence saying no cycle has run. Anything that occupies a numeric slot gets read as a small number,
          and a small number nobody collected is worse than an empty column.
        </p>
        <p className="prose">
          What this page does show is real and checkable: the category comes from the committed taxonomy, the prompts come from that category&apos;s
          bank, and the allocation is those prompts multiplied by the five answer surfaces. All of it is true before collection, none of it is a
          result.
        </p>
      </section>
    </main>
  )
}

/** Already in the portfolio. Stated plainly, and nothing is written twice. */
function Duplicate({ domain, onReset }: { domain: string; onReset: () => void }) {
  return (
    <div className="annotated addclient__result">
      <section className="record annotated__body" aria-live="polite">
        <h2 className="record__title">{domain} is already in this portfolio</h2>
        <p className="prose">
          It was not added again and nothing changed. A portfolio holding the same client twice would double its prompt allocation against the plan
          cap without measuring anything twice.
        </p>
        <button type="button" onClick={onReset} className="btn btn--quiet record__action">
          Add a different client
        </button>
      </section>
      <aside className="note">
        <span className="note__cap">Unchanged</span>
        <span className="note__line">0 written</span>
        <span className="note__gloss">The portfolio is a list of distinct domains, so a repeat is a no-op rather than an error.</span>
      </aside>
    </div>
  )
}

/**
 * THE PREFLIGHT — what would be asked, shown before anything is committed.
 *
 * Every element here is knowable without collecting: the category from the
 * taxonomy, the prompts from that category's bank, the allocation from
 * multiplying the two. The one thing that is NOT on this sheet is any figure
 * that could be mistaken for a result, because there is not one.
 */
function Preflight({ workspace, onConfirm, onReset }: { workspace: Workspace; onConfirm: (w: Workspace) => void; onReset: () => void }) {
  const prompts = preflightPrompts(workspace.categorySlug, PREFLIGHT_SHOWN)
  const answers = workspace.promptCount * workspace.engines.length

  return (
    <div className="annotated addclient__result">
      <section className="record annotated__body" aria-live="polite">
        {/* `.record__title`, not `.record__domain`. That headline means "the
            subject of a measurement", and a
            sheet whose own next sentence may say nothing has been collected
            cannot wear it. */}
        <h2 className="record__title">{workspace.domain}</h2>

        <p className="prose">
          Not added yet. This is what a cycle would ask for {workspace.domain}, and what it would consume from the plan.{' '}
          {workspace.hasData
            ? `A cycle has already been collected for it on ${workspace.lastRunDay}, so it would join the portfolio carrying that result rather than empty.`
            : 'No answer has been collected and no figure is available for this client.'}
        </p>

        {/*
          THE FALLBACK, DECLARED BEFORE IT COSTS ANYTHING. A domain we cannot
          categorise still gets a workspace, but against the general bank and
          with no competitor set — and the reader is told that here rather than
          discovering it in a report with an empty comparison.
        */}
        {workspace.confident ? null : <p className="prose prose--flag">{workspace.fallbackReason}</p>}

        <dl className="wsfact">
          <dt className="wsfact__key">Category</dt>
          <dd className="wsfact__val">{workspace.categoryName}</dd>

          <dt className="wsfact__key">Classification</dt>
          <dd className="wsfact__val">{workspace.confident ? 'confident' : 'fell back to the general bank'}</dd>

          <dt className="wsfact__key">Prompts per cycle</dt>
          <dd className="wsfact__val num">{workspace.promptCount}</dd>

          <dt className="wsfact__key">Answer surfaces</dt>
          <dd className="wsfact__val num">{workspace.engines.length}</dd>

          <dt className="wsfact__key">Answers per cycle</dt>
          <dd className="wsfact__val num">{answers}</dd>

          <dt className="wsfact__key">Status if added</dt>
          <dd className="wsfact__val">{collectionStatus(workspace)}</dd>
        </dl>

        <div className="preflight">
          <p className="preflight__lead">
            {prompts.length === 0
              ? 'This category has no prompt bank in this build, so there are no prompts to show.'
              : `The first ${prompts.length} of ${workspace.promptCount} prompts a cycle would ask, exactly as they are written in the bank:`}
          </p>
          <ol className="promptlist">
            {prompts.map((p) => (
              <li className="promptlist__item" key={p.text}>
                <span className="promptlist__text">{p.text}</span>
                <span className="promptlist__intent">{p.intent}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Existing classes only: the flex row places the pair, `record__action`
            gives the spacing that closes a record. */}
        <div className="field__row record__action">
          <button type="button" className="btn btn--primary" onClick={() => onConfirm(workspace)}>
            Add {workspace.domain}
          </button>
          <button type="button" className="btn btn--quiet" onClick={onReset}>
            Cancel
          </button>
        </div>
      </section>

      <aside className="note">
        <span className="note__cap">Preflight</span>
        <span className="note__line">{workspace.categorySlug}</span>
        <span className="note__line">{workspace.engines.join(', ')}</span>
        <span className="note__line">{collectionLine(workspace)}</span>
        <span className="note__gloss">
          These prompts are the committed bank for this category, not examples written for this screen. They are what would be asked if a cycle
          ever ran.
        </span>
      </aside>
    </div>
  )
}

/**
 * Added — and the confirmation says what was and was not done.
 *
 * ⚠️ NOT ONE METRIC ON THIS SHEET. The client exists in a list; nothing has
 * been measured for it. If a percentage ever appears here, the page is lying.
 */
function Added({ workspace, onReset }: { workspace: Workspace; onReset: () => void }) {
  return (
    <div className="annotated addclient__result">
      <section className="record annotated__body" aria-live="polite">
        <h2 className="record__title">{workspace.domain} added</h2>

        <p className="prose">
          Status: <strong>{collectionStatus(workspace)}</strong>. It is in the portfolio as a {workspace.categoryName.toLowerCase()} client with{' '}
          {workspace.promptCount} prompts allocated.{' '}
          {workspace.hasData
            ? `Its cycle of ${workspace.lastRunDay} is already in this record, so the portfolio shows its mention rate with the interval attached.`
            : 'No answer has been collected for it, so it carries no mention rate, no score and no grade, and it will not until a cycle runs.'}
        </p>

        <p className="prose prose--flag">
          Nothing was collected when you pressed that button and nothing was spent. Collection runs in a budgeted runner, and there is no runner
          watching this list.
        </p>

        <div className="field__row record__action">
          <button type="button" className="btn btn--primary" onClick={onReset}>
            Add another client
          </button>
        </div>

        {/* A link, not a button wearing `.btn`: `.btn` sets no text-decoration,
            so an anchor in it arrives underlined through a filled panel. */}
        <p className="prose">
          <Link href="/agency">Back to the portfolio</Link>
        </p>
      </section>

      <aside className="note">
        <span className="note__cap">Written</span>
        <span className="note__line">{workspace.domain}</span>
        <span className="note__line">{workspace.categorySlug}</span>
        <span className="note__line">{collectionLine(workspace)}</span>
        <span className="note__gloss">
          Stored in this browser only. There are no agency accounts in this build, so the list does not leave this device and nothing is billed
          against it.
        </span>
      </aside>
    </div>
  )
}
