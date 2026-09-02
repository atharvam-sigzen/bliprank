'use client'

import type { PreviewResponse } from '@/lib/preview-contract'

/**
 * WHAT THE SCAN WILL ASK, BEFORE IT ASKS IT.
 *
 * The step between typing a domain and buying a scan. It answers the two
 * questions a reader has to answer for themselves before a mention rate means
 * anything: what market do you think I am in, and what did you ask on my
 * behalf?
 *
 * Both used to be answerable only afterwards, on a different page, which is the
 * wrong order twice over — the visitor learns the basis of a number after
 * reading it, and the quota is spent before anyone could object.
 *
 * A MEASUREMENT RECORD, LIKE EVERY OTHER SURFACE HERE. The prompts are the
 * paper: real, verbatim, in the order a cycle sends them, and nothing on this
 * screen edits them. How the category was decided sits BESIDE them in the
 * margin, because "CRM software" means one thing when the host is Pipedrive and
 * another when a model authored the category from the homepage twenty seconds
 * ago, and the difference belongs next to the claim rather than in a log.
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
    case 'generated':
      return {
        cap: 'New category',
        // The evidence, not the name. The name is the headline four
        // centimetres to the left, and repeating it in the margin spends the
        // one line the margin has on something already on screen.
        line: preview.evidence,
        /*
         * ⚠️ THE SECOND HALF IS DERIVED, NOT ASSERTED. This line used to end
         * "and no competitors were named" unconditionally, which was true of
         * every authored category because there was no mechanism by which one
         * could acquire a rival. There is now: a competitor promoted from
         * brands the engines actually named in collected answers
         * (`promote-competitors.ts`). Leaving the sentence hardcoded would tell
         * a customer looking straight at their own competitor list that we
         * refuse to name one — the same defect the head-to-head section carried
         * when it told an authored category it had not been categorised.
         */
        gloss: preview.competitors.length
          ? 'No category we hold fitted this business, so one was written for it from your homepage and kept. The prompts below have not been reviewed by a human. The competitors listed were not chosen by us — each was promoted because the engines themselves named it in answers we collected.'
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

export function PromptPreview({
  preview,
  onConfirm,
  onCancel,
  busy,
}: {
  preview: PreviewResponse
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
}) {
  const source = sourceLine(preview)
  const cells = preview.prompts.length * preview.engines.length

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

          {/* IN THE BODY COLUMN, NOT UNDER THE GRID. These sentences explain the
              margin note beside them, so they belong level with it — and the
              body column is three lines tall against a six-line note, which left
              a hand's width of blank paper between the description and the next
              thing anyone reads. */}
          {preview.fallback?.reason === 'ambiguous' ? (
            <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
              {preview.domain} fits more than one category at once ({preview.fallback.candidates.join(', ')}), so picking one would be inventing
              a fact. It will be measured against a general business-software prompt set, with no competitor set.
            </p>
          ) : null}

          {/* SAID BEFORE THE BUTTON, NOT AFTER IT. A generated bank carries no
              competitors, and a reader who is about to spend a scan on it is
              entitled to know that the chart will have one bar. */}
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
          {/* FRESHNESS, BESIDE PROVENANCE, NOT INSTEAD OF IT. `source` says how
              the category was decided and never changes; this says whether that
              happened now or earlier. Collapsing the two into one "decided
              earlier" label lost the more useful half — a reader wants to know
              it was a tracked brand match first, and that it has been stable
              since second. */}
          {preview.previouslyDecided ? (
            <span className="note__line">
              decided{preview.decidedAt ? ` ${preview.decidedAt.slice(0, 10)}` : ' earlier'}, reused since
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
        <h2>The {preview.prompts.length} questions we will ask</h2>
        <div className="annotated">
          <div className="annotated__body">
            <p className="prose">
              These go to {preview.engines.length} answer engines exactly as written. None of them names your brand — a prompt that named you
              would measure our own phrasing rather than what the engines volunteer.
            </p>
            <ol className="promptlist">
              {preview.prompts.map((prompt) => (
                <li className="promptlist__item" key={prompt.text}>
                  <span className="promptlist__text">{prompt.text}</span>
                  <span className="promptlist__intent">{prompt.intent}</span>
                </li>
              ))}
            </ol>
          </div>
          <aside className={`note${preview.verified ? '' : ' note--flag'}`}>
            <span className="note__cap">This scan</span>
            <span className="note__line">{preview.category}</span>
            <span className="note__line">
              <span className="num">{preview.prompts.length}</span> prompts × <span className="num">{preview.engines.length}</span> engines ={' '}
              <span className="num">{cells}</span> requests
            </span>
            <span className="note__gloss">
              {preview.verified
                ? 'This bank was written and reviewed by hand.'
                : 'This bank has not been reviewed by a human, and is marked unverified everywhere it appears.'}
            </span>
          </aside>
        </div>
      </section>

      <div style={{ marginTop: 'var(--space-5)' }}>
        <button type="button" className="btn btn--primary record__action" style={{ marginRight: 'var(--space-3)' }} onClick={onConfirm} disabled={busy}>
          {busy ? 'Starting…' : 'Run this scan'}
        </button>
        <button type="button" className="btn btn--quiet record__action" onClick={onCancel} disabled={busy}>
          Check a different domain
        </button>
      </div>

      <p className="metric__interval" style={{ marginTop: 'var(--space-3)' }}>
        Nothing has been collected yet. Reading this page cost nothing and charged nothing.
      </p>
    </section>
  )
}
