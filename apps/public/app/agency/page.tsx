'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ProductBar } from '@/components/chrome'
import { RangeRail } from '@/components/range-rail'
import { CONCEPT_NOTICE, PORTFOLIO } from '@/lib/agency-fixture'
import { NO_SCHEDULER_NOTE, Planned } from '@/lib/planned'
import { PREVIEW_SCORE_CAPTION, previewScore } from '@/lib/preview-score'
import { FEATURED_ID, tierById } from '@/lib/agency-pricing'
import { runInfoOf, scanFor, subjectOf } from '@/lib/scan-result'
import { collectionStatus, readAgencyDomains, removeAgencyDomain, workspaceFor, type Workspace } from '@/lib/workspace'
import { assertProvisionalAllowed, confidenceGrade, formatProvenance } from '@bliprank/stats'

// Module scope on purpose: the grades below are only computed once the reader
// has clients, so relying on `confidenceGrade` to throw would mean discovering
// the block in front of an audience. This fails `next build` instead.
assertProvisionalAllowed('The agency portfolio')

/**
 * THE AGENCY PORTFOLIO — three groups of rows, and the difference between them
 * is the entire point of the screen.
 *
 * A portfolio is the surface where a tool is most tempted to fill the grid.
 * Every row wants a number so the table looks finished, and the row with no
 * number is the one a competitor quietly seeds with a plausible figure. So this
 * page keeps three populations strictly apart and never lets one borrow the
 * other's typography:
 *
 *   COLLECTED — a domain the reader added that has a committed scan behind it.
 *     Rail, interval, preview score, precision grade. Real, and the only rows
 *     on the page that are.
 *   QUEUED — a domain the reader added that has never been collected. It gets
 *     its category, its prompt allocation and its engine set, because all of
 *     that is true before a single answer exists — and NOT ONE metric, because
 *     none exists. The row is visibly a different kind of thing.
 *   WORKED EXAMPLE — the six invented clients from `agency-fixture`, kept and
 *     labelled as illustrative exactly as before.
 *
 * ⚠️ STILL A CONCEPT. There are no agency accounts, no tenancy and no
 * cross-workspace query. The added list is this browser's localStorage and
 * nothing else. Tenancy is human-owned (CLAUDE.md §4) and a real portfolio
 * crosses a workspace boundary on every row.
 */

/**
 * The plan the pool is COMPARED against — never attached. This is the featured
 * AGENCY tier from `agency-pricing.ts`, the same plan book /agency/pricing
 * sells; the brand tiers in `pricing.ts` have no pooled prompts and drawing a
 * portfolio against one measured it with the wrong plan book. The wording below
 * follows ManagePrompts: what the plan WOULD allow, not an allowance held.
 */
const POOL_PLAN = tierById(FEATURED_ID)

export default function AgencyPortfolio() {
  // Storage is read after mount, never during render: SSR has no localStorage,
  // and a first client render that disagreed with the server would hydrate into
  // a different list than the one the reader is looking at.
  const [mounted, setMounted] = useState(false)
  const [domains, setDomains] = useState<readonly string[]>([])

  useEffect(() => {
    setMounted(true)
    setDomains(readAgencyDomains())
  }, [])

  // A stored entry that no longer resolves to a workspace is dropped rather
  // than rendered as a broken row.
  const spaces = domains.map(workspaceFor).filter((w): w is Workspace => w !== null)
  const collected = spaces.filter((w) => w.hasData)
  const queued = spaces.filter((w) => !w.hasData)
  const allocated = spaces.reduce((total, w) => total + w.promptCount, 0)

  const remove = (domain: string) => setDomains(removeAgencyDomain(domain))

  return (
    <main className="shell shell--grader">
      <ProductBar current="agency" />

      <div className="annotated masthead">
        <div className="annotated__body">
          <h1>Agency portfolio</h1>
          <p className="lede">Every client, every category, with the interval attached — one sheet.</p>
        </div>
        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">Concept preview</span>
          <span className="note__gloss">{CONCEPT_NOTICE}</span>
          <span className="note__line">
            {mounted ? `${spaces.length} added · ${collected.length} collected` : 'reading this browser'}
          </span>
          <span className="note__line">{PORTFOLIO.length} illustrative clients</span>
        </aside>
      </div>

      {/* THE POOL, ABOVE THE ROWS. A cap is a fact about the whole portfolio,
          and putting it under the clients would let a reader add their sixth
          before meeting it. */}
      <section className="section" aria-labelledby="pool-heading">
        <h2 id="pool-heading">Prompt pool</h2>

        <div className="annotated">
          <div className="annotated__body">
            {/* THE POOL WAITS FOR THE LIST IT DESCRIBES. Before the effect has
                run, `domains` is empty because it is UNREAD, not because it is
                empty — and an empty track reading "0 of 200 across 0 clients"
                states that as fact to an agency that has five. The margin note
                already says "reading this browser"; the instrument has to
                agree with it rather than contradict it in mono. */}
            {mounted ? (
              <div className="pool">
                <div className="pool__track" aria-hidden="true">
                  {/* Layout-only inline width, the way the rail positions its
                      band. Clamped so an over-allocated pool cannot draw past
                      its own track; the legend states the true figures. */}
                  <div className="pool__fill" style={{ width: `${Math.min(100, (allocated / POOL_PLAN.pooledPrompts) * 100)}%` }} />
                </div>
                <p className="pool__legend">
                  <span className="num">{allocated}</span> prompts allocated across <span className="num">{spaces.length}</span>{' '}
                  {spaces.length === 1 ? 'client' : 'clients'}, against the <span className="num">{POOL_PLAN.pooledPrompts}</span> the{' '}
                  {POOL_PLAN.name} plan would pool
                </p>
              </div>
            ) : (
              <p className="pool__legend">Reading this browser&apos;s portfolio.</p>
            )}

            {mounted && allocated > POOL_PLAN.pooledPrompts ? (
              <p className="prose prose--flag">
                This portfolio allocates more prompts than the {POOL_PLAN.name} pool carries. Nothing in this build enforces a cap, so the figure
                is shown as it is rather than being clipped to look compliant.
              </p>
            ) : null}

            <p className="prose prose--flag">
              No plan is attached to this portfolio in this build, so no cap applies to it. The track above compares the allocation with what the{' '}
              {POOL_PLAN.name} plan&apos;s pooled prompts would allow — a statement about the offer, not an allowance this portfolio holds.
            </p>

            <p className="prose">
              A cycle for a client asks its category&apos;s unprompted prompt set across all five answer surfaces. The allocation above is that
              arithmetic run offline: it is what collection would cost this portfolio in prompts, not a record of anything collected.
            </p>

            {/* A link, not a button dressed as one. `.btn` sets no
                text-decoration, so an anchor wearing it arrives underlined
                through a filled panel — and a navigation is not chassis: it is
                not a control you operate on this page. */}
            <p className="prose">
              <strong>
                <Link href="/agency/add">Add a client to this portfolio</Link>
              </strong>{' '}
              — classification and the prompt allocation resolve offline, and nothing is collected.
            </p>

            {mounted && spaces.length === 0 ? (
              <section className="record">
                <h3 className="record__title">No clients added</h3>
                <p className="prose">
                  Nothing has been added to this portfolio, so there is nothing to show. The worked example further down is invented and is
                  labelled as such; it is not this portfolio with sample data in it.
                </p>
              </section>
            ) : null}
          </div>

          <aside className="note">
            <span className="note__cap">Would allow</span>
            <span className="note__line">{POOL_PLAN.pooledPrompts} pooled prompts</span>
            <span className="note__line">${POOL_PLAN.usdPerMonth}/mo · {POOL_PLAN.name}</span>
            <span className="note__gloss">
              Added clients live in this browser only. There are no agency accounts in this build, so nothing here is billed, metered or held to a
              cap.
            </span>
          </aside>
        </div>
      </section>

      {/* 1 — COLLECTED. */}
      {mounted && collected.length > 0 ? (
        <section className="section" aria-labelledby="collected-heading">
          <h2 id="collected-heading">Collected</h2>
          <div className="annotated">
            <div className="annotated__body">
              <ul className="portfolio">
                {collected.map((w) => (
                  <CollectedRow key={w.domain} workspace={w} onRemove={remove} />
                ))}
              </ul>
            </div>
            <aside className="note">
              <span className="note__cap">Basis</span>
              <span className="note__line">wilson-95 · algo det-1</span>
              <span className="note__gloss">
                These rows render a scan a budgeted runner already produced. Opening this page collects nothing and spends nothing.
              </span>
              <span className="note__gloss">
                {PREVIEW_SCORE_CAPTION}. Precision grades how much each sample knows; the score is a separate, provisional read on visibility.
              </span>
            </aside>
          </div>
        </section>
      ) : null}

      {/* 2 — QUEUED. No rail, no score, no grade, and a status line that says
          why in words. A reader must not have to notice an absence. */}
      {mounted && queued.length > 0 ? (
        <section className="section" aria-labelledby="queued-heading">
          <h2 id="queued-heading">Queued — no cycle in this record</h2>
          <div className="annotated">
            <div className="annotated__body">
              <p className="prose prose--flag">
                These clients have no measurement of any kind. Their category, prompt allocation and engine set are real and resolve offline; the
                rows carry no rate, no score and no grade because none has been collected. Nothing on this page fills that gap with an estimate.
              </p>
              <ul className="portfolio">
                {queued.map((w) => (
                  <QueuedRow key={w.domain} workspace={w} onRemove={remove} />
                ))}
              </ul>
            </div>
            <aside className="note note--flag">
              <span className="note__cap note__cap--flag">No data</span>
              {/* Words, not "0 cycles · 0 answers". The count is not knowable
                  from this page — see QueuedRow — and a zero here asserted it. */}
              <span className="note__line">no rate · no score · no grade</span>
              <span className="note__gloss">
                Collection runs in a budgeted runner, not from this screen. Adding a client queues nothing and buys nothing.
              </span>
            </aside>
          </div>
        </section>
      ) : null}

      {/* THE LIFECYCLE LEGEND — one, marked planned, below the added groups.
          The rows above carry only the two states that can actually occur in
          this build: a collected cycle with its real day, or queued with
          nothing. The fuller vocabulary is described here in words, once —
          never drawn as empty status columns, which would render an unbuilt
          capability as table furniture. */}
      {mounted && spaces.length > 0 ? (
        <section className="section" aria-label="Run status legend">
          <div className="annotated">
            <div className="annotated__body">
              <p className="prose">
                <Planned /> Once recurring collection exists, every added row will carry a run status — queued, running, done or failed — with its
                last and next run. Today a row states only what is true: the day of a collected cycle, or that no cycle exists in this record.
              </p>
            </div>
            <aside className="note note--flag">
              <span className="note__cap note__cap--flag">Planned</span>
              <span className="note__gloss">{NO_SCHEDULER_NOTE}</span>
            </aside>
          </div>
        </section>
      ) : null}

      {/* 3 — THE WORKED EXAMPLE, labelled exactly as it was before. */}
      <section className="section" aria-labelledby="example-heading">
        <h2 id="example-heading">Worked example — invented clients</h2>

        <div className="annotated">
          <div className="annotated__body">
            <p className="prose prose--flag">
              The six rows below are illustrative and the clients do not exist. They are here to show what a full portfolio looks like when every
              row carries its interval — including the thin sample and the one measured at zero. No figure in this group was collected from
              anything.
            </p>

            {/*
              One sheet, not a grid of client cards. The plan dissolves cards
              into paper, and a portfolio is exactly where the template instinct
              (six boxed tiles with a big number each) is strongest — and worst,
              because boxing them invites reading the numbers as scores out of
              ten rather than as measurements with ranges.

              These rows stay NON-CLICKABLE while the added rows above are
              anchors: the clients are invented, and a detail page for an
              invented client would be a fabricated record wearing the same
              chrome as a real one.
            */}
            <ul className="portfolio">
              {PORTFOLIO.map((row) => {
                const { grade } = confidenceGrade(row.metric)
                return (
                  <li className="portfolio__row" key={row.client}>
                    <div className="portfolio__head">
                      <span className="portfolio__client">{row.client}</span>
                      <span className="portfolio__category">{row.categoryName} · illustrative</span>
                    </div>

                    {/* The signature device, in a table cell. Same rail, same
                        fixed 0-100 scale, same settle — so a row cannot show a
                        figure without showing how much it does not know. */}
                    <div className="portfolio__rail">
                      <RangeRail label="Mention rate" metric={row.metric} />
                    </div>

                    <div className="portfolio__marks">
                      <span className="portfolio__mark">
                        <span className="readout__cap">Visibility</span>
                        <span className="score">
                          <span className="score__value num">{row.preview.score}</span>
                          <span className="score__of">/ 100</span>
                          <span className="score__flag">preview</span>
                        </span>
                      </span>
                      <span className="portfolio__mark">
                        <span className="readout__cap">Precision</span>
                        <span className="portfolio__grade num">{grade}</span>
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <aside className="note note--flag">
            <span className="note__cap note__cap--flag">Illustrative</span>
            <span className="note__line">wilson-95 · algo det-1</span>
            <span className="note__line">5 engines · unprompted set</span>
            <span className="note__gloss">
              Every interval in this group is real arithmetic over invented counts. The figures are made up; the maths that turns them into a range
              is the same code the Grader runs, so no row shows a shape that could not occur.
            </span>
            <span className="note__gloss">
              {PREVIEW_SCORE_CAPTION}. Precision grades how much each sample knows; the score is a separate, provisional read on visibility.
            </span>
          </aside>
        </div>
      </section>

      <section className="section">
        <h2>What an agency would actually get</h2>
        <p className="prose">
          One row per client, each carrying its own interval rather than a league table of point estimates. A portfolio is where the temptation to
          rank is strongest and where ranking is least defensible: two clients whose ranges overlap are not first and second, and this view says so
          instead of sorting them.
        </p>
        <p className="prose">
          <strong>quillbase.app</strong> is deliberately in the worked example on a thin sample. Its range is visibly wider than the others, which
          is what a small sample looks like when nobody hides it — and the reason a portfolio built on point estimates alone would rank it
          confidently and wrongly.
        </p>
        <p className="prose prose--flag">
          None of this is wired to anything. There are no agency accounts, no client workspaces and no cross-client queries in this build. Client
          isolation is the one thing a trust-positioned product cannot prototype casually, so the data model behind this screen gets designed
          before the screen does.
        </p>

        {/* A link to a mockup, not to a feature. It sits at the end of the
            caveat section rather than beside "Add a client" for that reason:
            next to a working control it would read as a second working control,
            and the sentence around it has to do the work the position does. */}
        <p className="prose">
          Adding a client is the only step of the client lifecycle that runs today.{' '}
          <Link href="/agency/lifecycle">The rest of the arc is drawn as a mockup</Link>: a scheduled cycle, a collection run, a first result and the
          first comparison, each stage marked as intent rather than shown as a feature. Nothing on it has been collected or scheduled.
        </p>
      </section>
    </main>
  )
}

/**
 * A client with a committed scan behind it. Everything on this row is derived
 * from that scan — there is no branch here that can produce a figure without
 * one, because `scanFor` returning null renders nothing at all.
 */
function CollectedRow({ workspace, onRemove }: { workspace: Workspace; onRemove: (domain: string) => void }) {
  const scan = scanFor(workspace.domain)
  // `hasData` is derived from this same call, so null is unreachable — but the
  // alternative to a guard is a non-null assertion, and an assertion is how a
  // row eventually renders undefined as a number.
  if (!scan) return null

  const run = runInfoOf(scan)
  const subject = subjectOf(scan)
  const { grade } = confidenceGrade(subject.metric)
  const preview = previewScore(
    subject,
    scan.brands.filter((b) => !b.isSubject),
  )

  return (
    <li className="portfolio__row">
      <div className="portfolio__head">
        {/* The head is the door to this client's record. The remove button
            stays a SIBLING of the anchor, never a child — no nested
            interactive elements. The day printed here comes from runInfoOf
            and is the row's run status: the one state a collected row can
            truthfully claim. */}
        <Link className="portfolio__link" href={`/agency/client/${encodeURIComponent(workspace.domain)}`}>
          <span className="portfolio__client">{workspace.domain}</span>
          <span className="portfolio__category">
            {scan.categoryName}
            {run.day ? ` · collected — cycle of ${run.day}` : ' · collected'} · {scan.counts.answersScored} answers
          </span>
        </Link>
        <span className="portfolio__category">{formatProvenance(subject.metric)}</span>
        <RemoveButton domain={workspace.domain} onRemove={onRemove} />
      </div>

      <div className="portfolio__rail">
        <RangeRail label="Mention rate" metric={subject.metric} />
      </div>

      <div className="portfolio__marks">
        <span className="portfolio__mark">
          <span className="readout__cap">Visibility</span>
          <span className="score">
            <span className="score__value num">{preview.score}</span>
            <span className="score__of">/ 100</span>
            <span className="score__flag">preview</span>
          </span>
        </span>
        <span className="portfolio__mark">
          <span className="readout__cap">Precision</span>
          <span className="portfolio__grade num">{grade}</span>
        </span>
      </div>
    </li>
  )
}

/**
 * A client that has never been collected.
 *
 * ⚠️ THE ONE RULE OF THIS FILE. There is no metric on this row, no rail, no
 * score and no grade — not a dash, not a zero, not a greyed-out figure. A
 * placeholder in a numeric slot is read as a small number, and a small number
 * for a client nobody has measured is the exact lie this product exists to
 * refuse. What the row shows instead is what is genuinely known before
 * collection: the category, the prompts a cycle would ask, and the surfaces it
 * would ask them on.
 */
function QueuedRow({ workspace, onRemove }: { workspace: Workspace; onRemove: (domain: string) => void }) {
  return (
    <li className="portfolio__row">
      <div className="portfolio__head">
        {/* Same door as a collected row — a queued client still has a record
            page (its pre-flight facts). Remove stays outside the anchor. */}
        <Link className="portfolio__link" href={`/agency/client/${encodeURIComponent(workspace.domain)}`}>
          <span className="portfolio__client">{workspace.domain}</span>
          <span className="portfolio__category">
            {workspace.categoryName}
            {workspace.confident ? '' : ' · category not confirmed'}
          </span>
        </Link>
        <RemoveButton domain={workspace.domain} onRemove={onRemove} />
      </div>

      {/* The marks column, where a collected row carries Visibility and
          Precision, holds a status instead. Not a greyed-out score, not a dash:
          a sentence, in the same slot, so the difference is unmissable. */}
      <div className="portfolio__marks">
        <span className="portfolio__mark">
          <span className="readout__cap">Status</span>
          <span className="portfolio__category">{collectionStatus(workspace)}</span>
        </span>
      </div>

      {/* The row's full-width second line. A queued row has no rail, so the
          slot the rail would occupy carries the facts that do exist instead. */}
      <div className="portfolio__rail">
        <dl className="wsfact">
          <dt className="wsfact__key">Prompts per cycle</dt>
          <dd className="wsfact__val num">{workspace.promptCount}</dd>

          <dt className="wsfact__key">Answer surfaces</dt>
          <dd className="wsfact__val num">{workspace.engines.length}</dd>

          <dt className="wsfact__key">Answers per cycle</dt>
          <dd className="wsfact__val num">{workspace.promptCount * workspace.engines.length}</dd>
        </dl>

        {/* NO "Cycles collected: 0" ROW. A scanned domain resolves through the
            registry now, so this row is only ever the queued state — but the
            count of cycles behind a domain still is not knowable from a scan
            file, which records one cycle and not how many exist. A hard `0` in
            the mono figure voice would assert "nothing was collected". The
            count is not knowable here, so it is not printed; the status line
            above says what is known. */}

        {workspace.confident ? null : <p className="prose prose--flag">{workspace.fallbackReason}</p>}
      </div>
    </li>
  )
}

function RemoveButton({ domain, onRemove }: { domain: string; onRemove: (domain: string) => void }) {
  return (
    <button type="button" className="btn btn--quiet" onClick={() => onRemove(domain)} style={{ marginTop: 'var(--space-2)' }}>
      Remove {domain}
    </button>
  )
}
