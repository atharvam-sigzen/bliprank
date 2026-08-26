'use client'

import { useEffect, useState } from 'react'
import { assertProvisionalAllowed, confidenceGrade, formatProvenance } from '@bliprank/stats'
import { ProductBar } from '@/components/chrome'
import { RangeRail } from '@/components/range-rail'
import { PREVIEW_SCORE_CAPTION, missingNote, previewScore } from '@/lib/preview-score'
import { runInfoOf, scanFor, subjectOf, type ScanResultFile } from '@/lib/scan-result'
import { ACTIVE_STORAGE_KEY, PROMPTS_PER_CYCLE, preflightPrompts, readActiveDomain, workspaceFor, type Workspace } from '@/lib/workspace'

// Module scope, exactly as the Grader does it. This page renders a Confidence
// Grade, and the grade is only reached after a browser read — so relying on
// confidenceGrade to throw would mean discovering the block in front of a
// customer rather than at build time. This fails `next build` instead.
assertProvisionalAllowed('The brand dashboard')

/** Same env hook the product bar uses, so every cross-origin link agrees. */
const DASHBOARD_URL = process.env['NEXT_PUBLIC_DASHBOARD_URL'] ?? 'http://localhost:3000'

/**
 * THE BRAND DASHBOARD — two states, and the empty one is the honest one.
 *
 * A dashboard is where this product is most tempted to lie. The template
 * instinct is a grid of tiles with a number in each, and a workspace that has
 * never run a cycle has nothing to put in them — so the tiles get demo data, a
 * sparkline of noise, a "0%" that is really "unknown". Every one of those is the
 * substitution BlipRank exists to argue against.
 *
 * So there are two states and they are different SCREENS, not the same screen
 * with blanks. With data, the page is a record: the subject, the interval, the
 * provenance in the margin. Without data, it is a PRE-FLIGHT: the category we
 * placed the domain in, the seventeen questions a cycle would ask, the five
 * surfaces it would ask them on, and the arithmetic of what that costs. All of
 * that is true before anything is collected, none of it is a result, and the
 * strongest thing on the empty screen is a list of real prompts rather than an
 * illustration of a number.
 *
 * Nothing here collects. `workspaceFor` classifies offline and `scanFor` reads a
 * committed artefact; no code path on this page can reach a provider (R3).
 */
export default function BrandDashboard() {
  // `undefined` means "storage not read yet" and is deliberately distinct from
  // `null`, which means "no workspace". Reading localStorage during render would
  // produce a server/client mismatch, and on this page the mismatch is visible:
  // a reader with data would see the pre-flight screen flash first.
  const [workspace, setWorkspace] = useState<Workspace | null | undefined>(undefined)

  useEffect(() => {
    const active = readActiveDomain()
    setWorkspace(active ? workspaceFor(active) : null)
    // THE HASH HAS TO BE RESOLVED TWICE. The bar's "Workspace" link is a full
    // page load of /dashboard#settings; the browser looks for #settings while
    // the page is still <Booting />, finds nothing, and never retries. So the
    // scroll is redone once the state that owns the anchor exists.
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [])

  return (
    <main className="shell shell--grader">
      <ProductBar current="dashboard" />
      {workspace === undefined ? (
        <Booting />
      ) : workspace === null ? (
        <NoWorkspace />
      ) : workspace.hasData ? (
        <Measured workspace={workspace} />
      ) : (
        <Preflight workspace={workspace} />
      )}
    </main>
  )
}

/**
 * The pre-mount shell. Neutral on purpose: it names no domain, shows no figure
 * and commits to neither state, because at this point the page genuinely does
 * not know which one it is in.
 */
function Booting() {
  return (
    <section className="record" aria-busy="true">
      <p className="prose">Opening the workspace saved in this browser.</p>
    </section>
  )
}

/**
 * No active domain. The Grader is the only door into a workspace, so point at it.
 *
 * It carries `id="settings"` because the product bar's "Workspace" link exists
 * in this state too, and a nav entry aimed at a section this state never renders
 * is a link that silently does nothing.
 */
function NoWorkspace() {
  return (
    <div className="annotated">
      <section className="record annotated__body" id="settings">
        <h1 className="record__title">No workspace yet</h1>
        <p className="prose">
          A workspace opens around one domain, and this browser has none set. Scan a domain in the <a href="/">Grader</a> and it becomes the
          subject of this dashboard.
        </p>
        {/* No sample dashboard is rendered in its place. A placeholder screen
            teaches the reader that the numbers here are decorative. */}
        <p className="prose">Nothing is shown below because nothing has been measured.</p>
        <WorkedExample />
      </section>
      <aside className="note">
        <span className="note__cap">Storage</span>
        <span className="note__line">key {ACTIVE_STORAGE_KEY}</span>
        <span className="note__gloss">
          The active domain is kept in this browser only. There is no account behind it yet, so clearing site data clears the workspace.
        </span>
      </aside>
    </div>
  )
}

/**
 * STATE A — a cycle has been collected.
 *
 * Reachable for any domain this build holds a scan for — the committed one and
 * anything /api/scan cached into the registry.
 */
function Measured({ workspace }: { workspace: Workspace }) {
  const scan: ScanResultFile | null = scanFor(workspace.domain)
  // `hasData` is derived from exactly this call, so the branch cannot be taken.
  // The guard exists because the type system cannot know that, and falling back
  // to the pre-flight screen is the correct behaviour if it ever changes.
  if (!scan) return <Preflight workspace={workspace} />

  // A scan cached by /api/scan carries no run block. Everything the cycle note
  // needs is derived from what the file does hold, and what it does not hold is
  // omitted rather than defaulted.
  const run = runInfoOf(scan)
  const subject = subjectOf(scan)
  const metric = subject.metric
  const { grade, note } = confidenceGrade(metric)
  const preview = previewScore(subject, scan.brands.filter((b) => !b.isSubject))

  return (
    <>
      <header className="annotated masthead">
        <div className="annotated__body">
          <h1 className="record__domain">{workspace.domain}</h1>
          <p className="lede">{workspace.categoryName}</p>
        </div>
        <aside className="note">
          <span className="note__cap">Cycle</span>
          <span className="note__line">
            <strong>{scan.counts.answersScored} answers</strong>
            {run.engines.length > 0 ? ` · ${run.engines.length} engines` : ''}
          </span>
          {run.day ? <span className="note__line">day {run.day}</span> : null}
          <span className="note__line">{formatProvenance(metric)}</span>
          {/* THE COST LINE IS OMITTED, NOT ZEROED. This file may not record
              spend; `$0.0000` would state that a scan which bought 85 answers
              cost nothing, and an empty slot in the mono figure voice still
              reads as a measurement. No line at all is the only honest option. */}
          {run.spentUsd === null ? null : <span className="note__line">cost ${run.spentUsd.toFixed(4)}</span>}
          <span className="note__gloss">
            One cycle, collected by a budgeted runner. Opening this page collects nothing and costs nothing.
          </span>
        </aside>
      </header>

      {/* THE FALLBACK, CARRIED THROUGH TO THE WORKSPACE. The category was not
          identified, so this cycle ran against the general bank and has no
          competitor set. Without this line the lede reads "General business
          software" as if it had been determined. */}
      {scan.fallback ? (
        <p className="prose prose--flag" style={{ marginBottom: 'var(--space-4)' }}>
          {scan.fallback.reason === 'ambiguous'
            ? `${scan.domain} leads more than one category at once (${scan.fallback.candidates.join(', ')}), so none was chosen for it.`
            : `We could not identify a category for ${scan.domain}: ${scan.fallback.detail}.`}{' '}
          It was measured against the general business-software prompt set, which carries no competitor set — so the rate below is real, and there
          is nothing on this page ranking it against a rival. It is also not comparable with a scan run on a category prompt set.
        </p>
      ) : null}

      <section className="record">
        {/* The rail with its papers beside it. Same instrument as the Grader,
            same discipline: the figure cannot be photographed without the range
            around it or without where it came from. */}
        <div className="annotated">
          <div className="annotated__body">
            <RangeRail label="Mention rate" metric={metric} />
          </div>
          <aside className="note">
            <span className="note__cap">Basis</span>
            <span className="note__line">{scan.categoryName}</span>
            <span className="note__line">
              {scan.counts.answersScored} answers{run.engines.length > 0 ? ` · ${run.engines.length} engines` : ''}
            </span>
            {run.day ? <span className="note__line">day {run.day}</span> : null}
            <span className="note__line">{formatProvenance(metric)}</span>
            <span className="note__gloss">
              From prompts that name no brand, so the number measures what the engines volunteer rather than what we prompted them with.
            </span>
          </aside>
        </div>

        {/*
          THE PREVIEW SCORE, presented exactly as the Grader presents it.
          Duplicated markup rather than shared: the two surfaces must agree on
          the wording and the shape, and the wording is the point. If a third
          surface needs it, that is the moment to extract a component.
        */}
        <div className="annotated" style={{ marginTop: 'var(--space-5)' }}>
          <div className="annotated__body">
            <p className="readout__cap">Visibility</p>
            <p className="score">
              <span className="score__value num">{preview.score}</span>
              <span className="score__of">/ 100</span>
              <span className="score__flag">preview</span>
            </p>
            <p className="prose prose--flag" style={{ marginTop: 'var(--space-2)' }}>
              {PREVIEW_SCORE_CAPTION}. It combines the mention rate with competitive position on placeholder weights, carries no confidence
              interval, and is not comparable with anyone else&apos;s score, including a later version of this one.
            </p>
          </div>
          <aside className="note note--flag">
            <span className="note__cap note__cap--flag">How it is made</span>
            {preview.parts.map((part) => (
              <span className="note__line" key={part.label}>
                {part.label} {(part.weight * 100).toFixed(0)}% · {part.points.toFixed(1)} pts
              </span>
            ))}
            <span className="note__gloss">
              {missingNote(preview)}
            </span>
          </aside>
        </div>

        {/* The grade sits apart from the score and is labelled, because a bare
            badge beside a number reads as one compound verdict. They answer
            different questions: how visible, and how much the sample knows. */}
        <div className="gradeline">
          <span className="gradebadge" aria-hidden="true">
            <span className="gradebadge__cap">PRECISION</span>
            {grade}
          </span>
          <div>
            <p style={{ margin: 0, fontWeight: 600 }}>Precision {grade}</p>
            <p className="metric__interval" style={{ marginTop: 2 }}>
              {note}
            </p>
          </div>
        </div>
      </section>

      {/*
        ⚠️ THE TWO CHARTS THIS PAGE REFUSES TO DRAW.

        One cycle is one point, and a line through one point is a shape with no
        measurement under it. The stored payload also holds no per-engine split,
        so a by-engine table would have to divide a total by five and present the
        result as five findings. Both are the same failure — a picture asserting
        more than the data contains — and both are refused in words instead.
      */}
      <section className="section">
        <h2>What is not on this page</h2>
        <p className="prose prose--flag">
          There is no trend chart. A trend needs at least two cycles to compare and this workspace has one
          {run.day ? (
            <>
              , collected on <span className="num">{run.day}</span>
            </>
          ) : null}
          . A line through a single point would be drawing movement that has not been measured.
        </p>
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
          There is no breakdown by engine either. {run.engines.length > 0 ? `The ${run.engines.length} surfaces` : 'The answer surfaces'} were
          scored together into one rate of{' '}
          <span className="num">{scan.counts.answersScored}</span> answers, and the per-engine split is not in this cycle&apos;s stored payload.
          Splitting the total five ways would be arithmetic presented as evidence.
        </p>
        <WorkedExample />
      </section>

      <WorkspaceFacts workspace={workspace} />
    </>
  )
}

/**
 * STATE B — no cycle has ever run.
 *
 * The pre-flight. Everything on this screen is true before collection: the
 * classification, the bank, the surfaces and the cell arithmetic all resolve
 * offline. Nothing on it is a result, and the prompt list is deliberately the
 * largest thing here, because the real questions are more convincing than any
 * mock-up of an answer would be.
 */
function Preflight({ workspace }: { workspace: Workspace }) {
  const prompts = preflightPrompts(workspace.categorySlug, PROMPTS_PER_CYCLE)
  const cells = prompts.length * workspace.engines.length

  return (
    <>
      <header className="annotated masthead">
        <div className="annotated__body">
          {/* `.record__title`. `.record__domain` means "subject of a
              measurement" and this branch has none; `.masthead h1` happens to
              mask the size difference, which makes it an accident rather than
              a decision. */}
          <h1 className="record__title">{workspace.domain}</h1>
          <p className="lede">{workspace.categoryName}</p>
        </div>
        <aside className="note">
          <span className="note__cap">Workspace</span>
          <span className="note__line">status queued</span>
          <span className="note__line">{workspace.engines.length} engines</span>
          <span className="note__line">
            {prompts.length} prompts × {workspace.engines.length} engines
          </span>
          <span className="note__line">= {cells} cells per cycle</span>
          <span className="note__gloss">
            The tracked domain is fixed for the life of this workspace, because every measurement stored against it is keyed to it.
          </span>
        </aside>
      </header>

      {/* The classification is a claim like any other, so a shaky one says so
          in full rather than showing a category name with no hedge on it. */}
      {!workspace.confident ? (
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-4)' }}>
          We could not place {workspace.domain} in a category. {workspace.fallbackReason}
        </p>
      ) : null}

      <section className="record">
        <div className="preflight">
          <p className="readout__cap">Status: no cycle collected</p>
          <p className="preflight__lead">
            No collected cycle for {workspace.domain} is in this build, so there is no mention rate, no interval and no score on this page.
            Nothing is shown because this browser holds no measurement of it, and a placeholder figure here would be indistinguishable from a
            real one. That is a statement about what this record contains, not a claim that the domain was never measured.
          </p>
        </div>
      </section>

      {prompts.length > 0 ? (
        <section className="section">
          <h2>The questions a cycle asks</h2>
          <div className="annotated">
            <div className="annotated__body">
              <p className="prose">
                These are the {prompts.length} prompts from the {workspace.categoryName.toLowerCase()} bank, asked on every one of the{' '}
                {workspace.engines.length} answer surfaces, daily. Not a sample of them, and not a paraphrase: this is the list, exactly as it
                would be sent.
              </p>
              <ol className="promptlist">
                {prompts.map((prompt) => (
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
              <span className="note__line">{prompts.length} unprompted</span>
              <span className="note__gloss">
                Every prompt here names no brand. A prompt that names you measures our own phrasing rather than what the engines volunteer, so
                those are excluded from the rate by construction.
              </span>
            </aside>
          </div>
        </section>
      ) : null}

      <WorkspaceFacts workspace={workspace} />

      <section className="section">
        <h2>A worked example</h2>
        <WorkedExample />
      </section>
    </>
  )
}

/**
 * The settings, as a record rather than a form. Nothing here is editable,
 * because none of it is stored anywhere an edit could go yet, and a disabled
 * input that looks operable is a worse lie than a printed fact.
 */
function WorkspaceFacts({ workspace }: { workspace: Workspace }) {
  // `id` because the product bar's "Workspace" link lands here. There are four
  // states, not two, and this section is in two of them — `NoWorkspace` carries
  // the same id for its own, and `Booting` resolves into one of the three a tick
  // later, which is why the effect re-runs the scroll.
  return (
    <section className="section" id="settings">
      <h2>Workspace</h2>
      <dl className="wsfact">
        <dt className="wsfact__key">Tracked domain</dt>
        <dd className="wsfact__val">{workspace.domain} (LOCKED)</dd>

        <dt className="wsfact__key">Category</dt>
        <dd className="wsfact__val">
          {workspace.categoryName}
          {workspace.confident ? '' : ' (fallback bank)'}
        </dd>

        <dt className="wsfact__key">Prompts per cycle</dt>
        <dd className="wsfact__val">
          <span className="num">{workspace.promptCount}</span>
        </dd>

        <dt className="wsfact__key">Engines</dt>
        <dd className="wsfact__val">{workspace.engines.join(' · ')}</dd>

        <dt className="wsfact__key">Schedule</dt>
        <dd className="wsfact__val">daily</dd>

        <dt className="wsfact__key">Last run</dt>
        {/* "no cycle in this record", not "never". This page reads the
            committed artefact; a domain scanned live through /api/scan is
            cached elsewhere and would be invisible to it. Absence of a record
            is what is known, and it is not the same claim as absence of a run. */}
        <dd className="wsfact__val">
          {workspace.lastRunDay === null ? 'no cycle in this record' : <span className="num">{workspace.lastRunDay}</span>}
        </dd>
      </dl>

      {/* THE LOCKED DOMAIN RULE, stated once, where the lock is shown. */}
      <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
        On a brand plan the tracked domain is fixed when the workspace is created. Every stored measurement is keyed to that domain, so changing
        it would not move the history across, it would quietly turn a record of one subject into a record of another. An agency plan adds a
        separate workspace per client instead, which is the same rule seen from the other side.
      </p>
    </section>
  )
}

/**
 * The link to `apps/web`. Labelled as illustrative every time it appears: that
 * app is a design surface running on made-up cycles, and a reader who lands on
 * it from here must not mistake its charts for their own measurements.
 */
function WorkedExample() {
  return (
    <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
      <a href={DASHBOARD_URL}>See a worked example with three months of cycles</a>. The figures there are illustrative, not collected, and belong
      to no real brand.
    </p>
  )
}
