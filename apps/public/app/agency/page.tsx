'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ActionLink } from '@/components/action-link'
import { ProductBar } from '@/components/chrome'
import { PortfolioClientRow } from '@/components/portfolio-row'
import { FEATURED_ID, tierById } from '@/lib/agency-pricing'
import { cyclesFor, syncCycles } from '@/lib/cycles'
import { SCHEDULE_FACT } from '@/lib/planned'
import { NOT_A_RANKING, ORDER_NOTE, OWN_SET_NOTE, PORTFOLIO_NOTICE, UTC_NOTE, byAttention, portfolioRowOf, type PortfolioRowModel, type TrackedRead } from '@/lib/portfolio'
import { scanFor } from '@/lib/scan-result'
import type { TrackedStatus } from '@/lib/tracked'
import { collectionStatus, readAgencyDomains, removeAgencyDomain, workspaceFor, type Workspace } from '@/lib/workspace'
import { assertProvisionalAllowed } from '@bliprank/stats'

// Module scope on purpose: the grades below are only computed once the reader
// has clients, so relying on `confidenceGrade` to throw would mean discovering
// the block in front of an audience. This fails `next build` instead.
assertProvisionalAllowed('The agency portfolio')

/**
 * THE AGENCY PORTFOLIO — two groups of rows, both real (MVP_PLAN D1).
 *
 * A portfolio is the surface where a tool is most tempted to fill the grid.
 * Every row wants a number so the table looks finished, and the row with no
 * number is the one a competitor quietly seeds with a plausible figure. Until
 * D1 this page did a politer version of that itself: six invented clients
 * with made-up counts, labelled illustrative, always rendered. They are
 * deleted, and the file that held them with them. What is left:
 *
 *   COLLECTED — a domain the person added that has a really collected cycle
 *     on this machine. Drawn from that client's own latest cycle: the rate
 *     with its range and n, the trend as `compare()`'s verdict in words, the
 *     daily checks and the days remaining, and whose questions produced the
 *     number. Ordered by what needs attention, never by rate
 *     (`lib/portfolio.ts`).
 *   QUEUED — a domain the person added that has never been collected. Its
 *     category, its prompt allocation and its engine set, because all of that
 *     is true before a single answer exists, and NOT ONE metric, because none
 *     exists.
 *
 * WHERE THE NUMBERS COME FROM. The client LIST is this browser's localStorage
 * (there are no agency accounts in the MVP; owner decision 2026-09-16). The
 * RESULTS are the machine's store: on opening, every added domain's cycles are
 * fetched from `/api/cycles` and its daily-check status from `/api/tracked`,
 * so a cycle the daily loop filed overnight is on this page in the morning.
 * Post-MVP, accounts, workspaces and invitations wire the list to
 * `workspaces_of` and RLS with no change to this screen.
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

  // Bumped when the store's cycles have been merged into this browser's registry, so the rows are re-derived from them.
  const [synced, setSynced] = useState(0)
  const [tracked, setTracked] = useState<Readonly<Record<string, TrackedRead>>>({})

  useEffect(() => {
    setMounted(true)
    const added = readAgencyDomains()
    setDomains(added)
    // THE MACHINE'S STORE IS THE SOURCE OF THE NUMBERS. Both reads are GETs that spend nothing. `/api/cycles` answers 404 for a
    // domain the store does not hold, and the row keeps what this browser already knew. `/api/tracked` answers 200 with
    // `tracked: false` for a domain nobody switched on, and refuses (409, 503) where the store cannot be read at all: then the
    // row SAYS the re-check could not be read, and is never ranked with the clients that need nothing.
    let live = true
    void Promise.all(
      added.map(async (domain) => {
        await syncCycles(domain)
        try {
          const res = await fetch(`/api/tracked?domain=${encodeURIComponent(domain)}`, { cache: 'no-store' })
          return [domain, res.ok ? ((await res.json()) as TrackedStatus) : null] as const
        } catch {
          return [domain, null] as const
        }
      }),
    ).then((pairs) => {
      if (!live) return
      setTracked(Object.fromEntries(pairs))
      setSynced((n) => n + 1)
    })
    return () => {
      live = false
    }
  }, [])

  // A stored entry that no longer resolves to a workspace is dropped rather
  // than rendered as a broken row.
  const spaces = domains.map(workspaceFor).filter((w): w is Workspace => w !== null)
  // A row carries a number only when a cycle was really collected for it. `synced` is read so the rows are re-derived once the
  // store's cycles have arrived; the registry itself is module state, not React state.
  void synced
  const today = new Date().toISOString().slice(0, 10)
  // ROWS WAIT FOR THE READS THEY ARE ORDERED BY. Drawn before the statuses arrive they would all rank "nothing to do" and then
  // re-sort under the reader a moment later (statistics review of D1, MINOR 1); until then the page says it is reading.
  const ready = mounted && synced > 0
  // A scan with no day cannot be placed on a time axis, so `cyclesFor` leaves it out, and it is still a collected scan: it is a
  // row of one cycle, "undated", never a queued client under a heading that says "no measurement of any kind" (MINOR 6).
  const cyclesOf = (domain: string) => {
    const dated = cyclesFor(domain)
    const any = scanFor(domain)
    return dated.length > 0 ? dated : any ? [any] : []
  }
  const rows: readonly PortfolioRowModel[] = ready
    ? byAttention(spaces.map((w) => portfolioRowOf(w.domain, cyclesOf(w.domain), w.domain in tracked ? (tracked[w.domain] ?? null) : undefined, today)).filter((r): r is PortfolioRowModel => r !== null))
    : []
  const queued = ready ? spaces.filter((w) => cyclesOf(w.domain).length === 0) : []
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
        <aside className="note">
          <span className="note__cap">Real checks, local list</span>
          <span className="note__gloss">{PORTFOLIO_NOTICE}</span>
          <span className="note__line">{mounted ? `${spaces.length} added · ${rows.length} collected` : 'reading this browser'}</span>
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
              arithmetic run offline over each client&apos;s CATEGORY set: it is what collection would cost this portfolio in prompts, not a
              record of anything collected. A client measured over questions of its own asks those instead, and its row says how many.
            </p>

            {/* A forward action on its own line: a short destination label,
                with the disclosure kept as plain prose beside it rather than
                folded into the link text. */}
            <ActionLink href="/agency/add">Add a client</ActionLink>
            <p className="prose">
              Adding a client to this portfolio resolves its classification and prompt allocation offline, and nothing is collected.
            </p>

            {mounted && spaces.length === 0 ? (
              <section className="record">
                <h3 className="record__title">No clients added</h3>
                <p className="prose">
                  Nothing has been added to this portfolio, so there is nothing to show. No sample clients are drawn in its place: a row
                  appears here only for a client you add, and carries a number only once a check has really been collected for it.
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

      {/* 1 — COLLECTED. Real cycles, ordered by what needs attention, never by rate. */}
      {mounted && !ready && spaces.length > 0 ? <p className="prose">Reading this machine&apos;s checks for the clients in this browser.</p> : null}
      {ready && rows.length > 0 ? (
        <section className="section" aria-labelledby="collected-heading">
          <h2 id="collected-heading">Collected</h2>
          <div className="annotated">
            <div className="annotated__body">
              {/* UNCONDITIONAL. Every client in its own category is the NORMAL state of a portfolio, and then no two rows share a
                  basis: the first draft said this only when a row had its own set, and its order note ended "two clients whose
                  ranges overlap are not first and second", which invites the inverse (statistics review of D1, MAJOR 3). */}
              <p className="prose prose--flag" data-not-a-ranking>
                {NOT_A_RANKING}
                {rows.some((r) => r.ownSet) ? ` ${OWN_SET_NOTE}` : ''}
              </p>
              <p className="prose" data-order-note>
                {ORDER_NOTE}
              </p>
              {/* The re-check is an INSTRUCTION on every row; what actually schedules one is said here, once, in the words every
                  other surface uses (MAJOR 1). */}
              <p className="prose" data-schedule-fact>
                A row says whether a client is SET to be re-checked daily, which is a person&apos;s instruction, not a record that checks ran.
                Schedule: {SCHEDULE_FACT}.
              </p>
              <ul className="portfolio">
                {rows.map((row) => (
                  <PortfolioClientRow key={row.domain} row={row} onRemove={remove} />
                ))}
              </ul>
            </div>
            <aside className="note">
              <span className="note__cap">Basis</span>
              <span className="note__line">each row: its own latest check</span>
              <span className="note__line">95% range, with its sample size</span>
              <span className="note__line">{UTC_NOTE}</span>
              <span className="note__gloss">
                These rows render checks a budgeted runner already collected on this machine. Opening this page collects nothing and spends
                nothing.
              </span>
            </aside>
          </div>
        </section>
      ) : null}

      {/* 2 — QUEUED. No rail, no score, no grade, and a status line that says
          why in words. A reader must not have to notice an absence. */}
      {ready && queued.length > 0 ? (
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

      <section className="section">
        <h2>What this page does and does not do</h2>
        <p className="prose">
          One row per client, each carrying its own range rather than a league table of point estimates. A portfolio is where the temptation to
          rank is strongest and where ranking is least defensible: two clients whose ranges overlap are not first and second, and this view says so
          instead of sorting them by rate.
        </p>
        <p className="prose prose--flag">
          There are no agency accounts, no client workspaces and no sharing in this build. The list of clients is this browser&apos;s; the
          checks are this machine&apos;s. Client isolation is the one thing a trust-positioned product cannot prototype casually, so accounts and
          invitations arrive with the data model behind them, not before it.
        </p>
        <p className="prose">
          Adding a client resolves its category and its prompt allocation offline. Its first check, and its daily checks, are started from the
          client&apos;s own record. The rest of the client lifecycle is drawn as a mockup, each stage marked as intent rather than shown as a
          feature.
        </p>
        <ActionLink href="/agency/lifecycle">Client lifecycle</ActionLink>
      </section>
    </main>
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

      {/* The marks column, where a collected row carries Precision, holds a
          status instead. Not a greyed-out score, not a dash:
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
