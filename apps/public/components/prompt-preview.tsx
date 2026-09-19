'use client'

import { useState } from 'react'
import { MIN_N_FOR_COMPARISON } from '@bliprank/stats'
import type { PreviewResponse } from '@/lib/preview-contract'
import { filePromptSet } from '@/lib/custom-prompt-request'
import { fetchPreview } from '@/lib/preview'
import { DEFAULT_TRACK_DAYS, MAX_TRACK_DAYS, type TrackedStatus } from '@/lib/tracked'
import { SCHEDULE_FACT } from '@/lib/planned'

/**
 * WHAT THE SCAN WILL ASK, BEFORE IT ASKS IT — AND, SINCE ADR-0016 AMENDMENT 1,
 * WHERE THE PERSON EDITS IT.
 *
 * The step between typing a domain and buying a scan. It answers the two
 * questions a reader has to answer for themselves before a mention rate means
 * anything: what market do you think I am in, and what did you ask on my
 * behalf? Both used to be answerable only afterwards, on a different page,
 * which is the wrong order twice over — the visitor learns the basis of a
 * number after reading it, and the quota is spent before anyone could object.
 *
 * THE ENTRY FLOW (owner decision 2026-09-16, MVP_PLAN C3). The prompts shown
 * are the domain's current set: the bank's on first entry, the person's own
 * latest version after that. The person edits them here — removes, adds,
 * rewords — and "Save these questions" stores the result as the domain's
 * prompt set, version V, through the same versioned path the manage page uses,
 * with PROPERTY 2 enforced on the way in (a prompt that names the subject or a
 * tracked brand is refused with the reason, and nothing is saved). From then
 * on THAT set is the measurement: the headline carries its basis and says
 * "your N prompts, version V". Then the person says for how many days, and
 * "Run this scan" runs the first cycle now and switches the daily re-check on
 * until that day; zero days is one scan and no re-check.
 *
 * A MEASUREMENT RECORD, LIKE EVERY OTHER SURFACE HERE. Outside the edit mode
 * the prompts are paper: real, verbatim, in the order a cycle sends them. How
 * the category was decided sits BESIDE them in the margin, because "CRM
 * software" means one thing when the host is Pipedrive and another when a
 * model authored the category from the homepage twenty seconds ago.
 */

/** Plain-English provenance for each way a category can be decided. */
function sourceLine(preview: PreviewResponse): { cap: string; line: string; gloss: string; flag: boolean } {
  switch (preview.source) {
    case 'leader-domain':
      return {
        cap: 'Matched a tracked brand',
        line: preview.evidence,
        gloss: 'This domain is one we already track in this category, so the category is not an inference.',
        flag: false,
      }
    case 'domain-token':
      return {
        cap: 'Matched on the domain',
        line: preview.evidence,
        gloss: 'The category came from a whole word in the domain name itself.',
        flag: false,
      }
    case 'site-content':
      return {
        cap: 'Read your homepage',
        line: preview.evidence,
        gloss: 'We fetched the page once, matched its own words against the category vocabulary, and wrote the answer down. It will not change between scans.',
        flag: false,
      }
    case 'correction':
      return {
        cap: 'Corrected by a person',
        line: preview.correction ? `from ${preview.correction.from}, ${preview.correction.at.slice(0, 10)}` : preview.evidence,
        gloss: `A person chose this category from the list and wrote down why${preview.correction ? `: "${preview.correction.reason}"` : ''}. Nothing was re-derived, and the earlier record is kept beside this one.`,
        flag: false,
      }
    case 'generated':
      return {
        cap: 'New category',
        line: preview.evidence,
        gloss: preview.competitors.length
          ? preview.competitorSet !== undefined
            ? "No category we hold fitted this business, so one was written for it from your homepage and kept. The prompts below have not been reviewed by a human. The competitors listed are this domain's own adjusted set: chosen by a person from rivals whose alias tables have been reviewed, not guessed by us."
            : 'No category we hold fitted this business, so one was written for it from your homepage and kept. The prompts below have not been reviewed by a human. The competitors listed were not chosen by us — each was promoted because the engines themselves named it in answers we collected.'
          : 'No category we hold fitted this business, so one was written for it from your homepage and kept. The prompts below have not been reviewed by a human, and no competitors were named — we will not guess who you compete with.',
        flag: true,
      }
    default:
      return {
        cap: 'No category',
        line: preview.evidence || 'nothing identified this business',
        gloss: 'We could not place this business, so it is measured against a general business-software prompt set and no competitors are shown.',
        flag: true,
      }
  }
}

type Edit = { readonly kind: 'view' } | { readonly kind: 'editing'; drafts: readonly string[]; added: string; saving: boolean; refusal: string | null }

/**
 * A SMALL SET IS A SMALL SAMPLE, AND THE PERSON IS TOLD BEFORE BUYING IT (C3
 * stats review, MAJOR 6). n is questions x engines at one run per cell. Below
 * `MIN_N_FOR_COMPARISON` answers `compare()` refuses every pair, so no two
 * cycles and no competitor row can be compared: the cycle buys a rate with a
 * wide range and a page of "not enough data". That is honest, and it should
 * not be a surprise. A WARNING, never a refusal: one question measured with
 * its real interval is a legitimate thing to want, and the floor itself is
 * PROVISIONAL pending G0 (packages/stats/src/format.ts), which is why this is
 * computed against the constant and names no count of its own. Whether to
 * refuse below some size is the methodology owner's decision (ADR-0016
 * Amendment 1).
 */
export function smallSampleWarning(questions: number, engines: number): string | null {
  const n = questions * engines
  if (questions <= 0 || engines <= 0 || n >= MIN_N_FOR_COMPARISON) return null
  return `A small set is a small sample: ${questions} ${questions === 1 ? 'question' : 'questions'} on ${engines} ${engines === 1 ? 'engine' : 'engines'} is ${n} answers, and below ${MIN_N_FOR_COMPARISON} answers no two cycles and no competitor row can be compared. You get a rate with a wide range and nothing to compare it with.`
}

export function PromptPreview({
  preview: initial,
  onConfirm,
  onCancel,
  busy,
  trackable = false,
}: {
  preview: PreviewResponse
  /** Start the first cycle now. Called after the re-check is switched on (or not asked for). */
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
  /** Whether the daily re-check can be offered: the machine's own store only (MVP_PLAN C3). Off, the days section is not rendered and the press is one scan. */
  trackable?: boolean
}) {
  const [preview, setPreview] = useState(initial)
  const [edit, setEdit] = useState<Edit>({ kind: 'view' })
  const [days, setDays] = useState<number>(trackable ? DEFAULT_TRACK_DAYS : 0)
  const [tracking, setTracking] = useState<{ busy: boolean; refusal: string | null }>({ busy: false, refusal: null })
  /** What a save did, when it did not simply apply: said in words, never left to be inferred from the list snapping back. */
  const [notice, setNotice] = useState<string | null>(null)
  const source = sourceLine(preview)
  const cells = preview.prompts.length * preview.engines.length

  function startEditing() {
    setEdit({ kind: 'editing', drafts: preview.prompts.map((p) => p.text), added: '', saving: false, refusal: null })
  }

  async function save() {
    if (edit.kind !== 'editing') return
    const list = [...edit.drafts.map((d) => d.trim()).filter(Boolean), ...(edit.added.trim() ? [edit.added.trim()] : [])]
    setEdit({ ...edit, saving: true, refusal: null })
    // The same versioned path the manage page uses; PROPERTY 2 is enforced there, and a refusal comes back with its reason.
    const filed = await filePromptSet(preview.domain, list, 'edited on entry from the record')
    if (!filed.ok) {
      setEdit({ ...edit, saving: false, refusal: filed.message })
      return
    }
    // APPLIED, OR FILED: the two are different facts and the press says which (C3
    // tenancy re-check). On the machine's own store, and for an owner or admin,
    // the set is saved as the next version. For a member with identity on it is
    // filed as a request, the set in force is unchanged, and the list below
    // goes back to it, which without this sentence reads as the edit being lost.
    setNotice(filed.applied ? null : 'Filed for an owner or admin of this workspace to apply. Nothing changes until they do, so the questions below are still the set in force.')
    // Re-read the preview so what is shown is what the store holds, version and all.
    const next = await fetchPreview(preview.domain)
    if (next.ok) setPreview(next.preview)
    setEdit({ kind: 'view' })
  }

  async function confirm() {
    setTracking({ busy: true, refusal: null })
    if (days > 0) {
      // The instruction: re-check daily until the day `days` from now. Written before the first cycle, so the record can say so as soon as it exists.
      try {
        const res = await fetch('/api/tracked', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: preview.domain, on: true, days }) })
        const body = (await res.json().catch(() => ({}))) as Partial<TrackedStatus> & { message?: string }
        if (!res.ok || body.tracked !== true) {
          setTracking({ busy: false, refusal: body.message ?? 'The daily re-check could not be switched on, so nothing was started.' })
          return
        }
      } catch {
        setTracking({ busy: false, refusal: 'The daily re-check could not be switched on, so nothing was started.' })
        return
      }
    }
    setTracking({ busy: false, refusal: null })
    onConfirm()
  }

  const editing = edit.kind === 'editing'

  return (
    <section className="record" aria-live="polite">
      <h2 className="record__domain">{preview.domain}</h2>

      <div className="annotated" style={{ marginTop: 'var(--space-2)' }}>
        <div className="annotated__body">
          <p className="readout__cap">Category</p>
          <p className="score">
            <span className="score__value">{preview.categoryName}</span>
            {preview.generated ? <span className="score__flag">new</span> : null}
          </p>
          {preview.categoryDescription ? (
            <p className="prose" style={{ marginTop: 'var(--space-2)' }}>
              {preview.categoryDescription}
            </p>
          ) : null}

          {preview.fallback?.reason === 'ambiguous' ? (
            <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
              {preview.domain} fits more than one category at once ({preview.fallback.candidates.join(', ')}), so picking one would be inventing
              a fact. It will be measured against a general business-software prompt set, with no competitor set.
            </p>
          ) : null}

          {preview.competitors.length === 0 ? (
            <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
              No competitor set for this category, so this scan measures your mention rate and does not rank you against anyone. We only ever
              name a rival the engines actually named first; a plausible list we had not measured would be a guess wearing a chart.
            </p>
          ) : (
            <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
              You will be ranked against <span className="num">{preview.competitors.length}</span> tracked brands in this category:{' '}
              {preview.competitors.join(', ')}.
            </p>
          )}
        </div>
        <aside className={`note${source.flag ? ' note--flag' : ''}`} aria-label="How this category was decided">
          <span className={`note__cap${source.flag ? ' note__cap--flag' : ''}`}>{source.cap}</span>
          {source.line ? <span className="note__line">{source.line}</span> : null}
          {preview.previouslyDecided ? (
            <span className="note__line">
              decided{preview.decidedAt ? ` ${preview.decidedAt.slice(0, 10)}` : ' earlier'}, reused since
              {preview.version > 1 ? ` · record version ${preview.version}` : ''}
            </span>
          ) : null}
          <span className="note__gloss">
            {source.gloss}
            {preview.previouslyDecided
              ? ' This domain already had a category on record, so nothing was fetched and nothing was re-derived — which is what keeps two scans of it comparable.'
              : ''}
          </span>
        </aside>
      </div>

      <section className="section">
        <h2>{preview.promptSet ? `Your ${preview.prompts.length} questions, version ${preview.promptSet.version}` : `The ${preview.prompts.length} questions we will ask`}</h2>
        <div className="annotated">
          <div className="annotated__body">
            <p className="prose">
              These go to {preview.engines.length} answer engines exactly as written. None of them names your brand — a prompt that named you
              would measure our own phrasing rather than what the engines volunteer, and one that does is refused when you save.
              {preview.promptSet
                ? ' These are your own questions, and the number they produce is measured over them: it carries their version, and a later edit starts a new line on the trend.'
                : ' You can edit them before anything runs; the edited set is then what every cycle asks.'}
            </p>
            {editing ? (
              <div className="promptedit" data-prompt-edit>
                <ol className="promptlist">
                  {edit.drafts.map((text, i) => (
                    <li className="promptlist__item" key={i}>
                      <input
                        className="field"
                        aria-label={`Question ${i + 1}`}
                        value={text}
                        onChange={(e) => setEdit({ ...edit, drafts: edit.drafts.map((d, j) => (j === i ? e.target.value : d)) })}
                        disabled={edit.saving}
                      />
                      <button type="button" className="btn btn--quiet" aria-label={`Remove question ${i + 1}`} onClick={() => setEdit({ ...edit, drafts: edit.drafts.filter((_, j) => j !== i) })} disabled={edit.saving}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ol>
                <div className="field__row">
                  <input className="field" aria-label="Add a question" placeholder="Add a question of your own" value={edit.added} onChange={(e) => setEdit({ ...edit, added: e.target.value })} disabled={edit.saving} />
                  <button
                    type="button"
                    className="btn btn--quiet"
                    onClick={() => (edit.added.trim() ? setEdit({ ...edit, drafts: [...edit.drafts, edit.added.trim()], added: '' }) : undefined)}
                    disabled={edit.saving || !edit.added.trim()}
                  >
                    Add
                  </button>
                </div>
                {edit.refusal ? (
                  <p role="alert" className="field__error">
                    {edit.refusal}
                  </p>
                ) : null}
                {smallSampleWarning(edit.drafts.filter((d) => d.trim()).length + (edit.added.trim() ? 1 : 0), preview.engines.length) ? (
                  <p className="prose prose--flag" data-small-sample>
                    {smallSampleWarning(edit.drafts.filter((d) => d.trim()).length + (edit.added.trim() ? 1 : 0), preview.engines.length)}
                  </p>
                ) : null}
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn--primary record__action" onClick={() => void save()} disabled={edit.saving || edit.drafts.filter((d) => d.trim()).length + (edit.added.trim() ? 1 : 0) === 0}>
                    {edit.saving ? 'Saving…' : 'Save these questions'}
                  </button>
                  <button type="button" className="btn btn--quiet record__action" onClick={() => setEdit({ kind: 'view' })} disabled={edit.saving} style={{ marginLeft: 'var(--space-3)' }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <ol className="promptlist">
                  {preview.prompts.map((prompt) => (
                    <li className="promptlist__item" key={prompt.text}>
                      <span className="promptlist__text">{prompt.text}</span>
                      <span className="promptlist__intent">{prompt.intent === 'own' ? 'yours' : prompt.intent}</span>
                    </li>
                  ))}
                </ol>
                {notice ? (
                  <p role="status" className="prose prose--flag" data-save-notice>
                    {notice}
                  </p>
                ) : null}
                {smallSampleWarning(preview.prompts.length, preview.engines.length) ? (
                  <p className="prose prose--flag" data-small-sample>
                    {smallSampleWarning(preview.prompts.length, preview.engines.length)}
                  </p>
                ) : null}
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn--quiet record__action" onClick={startEditing} disabled={busy || tracking.busy}>
                    Edit these questions
                  </button>
                </div>
              </>
            )}
          </div>
          <aside className={`note${preview.verified || preview.promptSet ? '' : ' note--flag'}`}>
            <span className="note__cap">This scan</span>
            <span className="note__line">{preview.category}</span>
            <span className="note__line">
              <span className="num">{preview.prompts.length}</span> prompts × <span className="num">{preview.engines.length}</span> engines ={' '}
              <span className="num">{cells}</span> requests
            </span>
            {preview.promptSet ? (
              <span className="note__line" data-prompt-set>
                your {preview.promptSet.count} prompts, version {preview.promptSet.version}
              </span>
            ) : null}
            <span className="note__gloss">
              {preview.promptSet
                ? 'Your own set is the measurement. Its basis names the version, so cycles asked the same questions compare and a change of questions does not pretend to.'
                : preview.verified
                  ? 'This bank was written and reviewed by hand.'
                  : 'This bank has not been reviewed by a human, and is marked unverified everywhere it appears.'}
            </span>
          </aside>
        </div>
      </section>

      {trackable ? (
      <section className="section" data-track-days>
        <h2>Re-check daily</h2>
        <div className="annotated">
          <div className="annotated__body">
            <label className="field__label" htmlFor="track-days">
              For how many days
            </label>
            <div className="field__row">
              <input
                id="track-days"
                className="field"
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_TRACK_DAYS}
                value={days}
                onChange={(e) => setDays(Math.max(0, Math.min(MAX_TRACK_DAYS, Math.trunc(Number(e.target.value) || 0))))}
                disabled={busy || tracking.busy || editing}
              />
            </div>
            <p className="prose prose--flag" style={{ marginTop: 'var(--space-2)' }}>
              {days > 0
                ? `The first cycle runs now, and ${preview.domain} is re-checked with these ${preview.prompts.length} questions on every engine each day for ${days} day${days === 1 ? '' : 's'}, then stops. Schedule: ${SCHEDULE_FACT}.`
                : 'Zero days: one scan now, and no daily re-check.'}
            </p>
            {tracking.refusal ? (
              <p role="alert" className="field__error">
                {tracking.refusal}
              </p>
            ) : null}
          </div>
        </div>
      </section>
      ) : null}

      <div style={{ marginTop: 'var(--space-5)' }}>
        <button type="button" className="btn btn--primary record__action" style={{ marginRight: 'var(--space-3)' }} onClick={() => void confirm()} disabled={busy || tracking.busy || editing}>
          {busy || tracking.busy ? 'Starting…' : 'Run this scan'}
        </button>
        <button type="button" className="btn btn--quiet record__action" onClick={onCancel} disabled={busy || tracking.busy}>
          Check a different domain
        </button>
      </div>

      <p className="metric__interval" style={{ marginTop: 'var(--space-3)' }}>
        Nothing has been collected yet. Reading this page cost nothing and charged nothing.
      </p>
    </section>
  )
}
