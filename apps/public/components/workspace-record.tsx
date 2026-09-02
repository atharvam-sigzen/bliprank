'use client'

import { useEffect, useState } from 'react'
import { assertProvisionalAllowed, confidenceGrade, formatProvenance } from '@bliprank/stats'
import { ActionLink } from '@/components/action-link'
import { themedUrl, useTheme } from '@/components/theme'
import { HeadToHeadSection } from '@/components/head-to-head-section'
import { PromptBreakdown } from '@/components/prompt-breakdown'
import { RangeRail } from '@/components/range-rail'
import { PREVIEW_SCORE_CAPTION, missingNote, previewScore } from '@/lib/preview-score'
import { Planned, SCHEDULE_FACT } from '@/lib/planned'
import { BUNDLED_SCANS, runInfoOf, scanFor, subjectOf, type ScanResultFile } from '@/lib/scan-result'
import { PROMPTS_PER_CYCLE, preflightPrompts, workspaceFor, type Workspace } from '@/lib/workspace'

// Module scope, exactly as the Grader does it. This component renders a
// Confidence Grade, and the grade is only reached after a browser read — so
// relying on confidenceGrade to throw would mean discovering the block in front
// of a customer rather than at build time. This fails `next build` instead.
assertProvisionalAllowed('The workspace record')

/** The worked-example app's origin; localhost in dev, the deploy URL in prod. */
const DASHBOARD_URL = process.env['NEXT_PUBLIC_DASHBOARD_URL'] ?? 'http://localhost:3000'

/**
 * Which side of the plan the surrounding page sells. It changes the copy that
 * names the plan, and one placement: on a brand page the workspace facts live
 * on /dashboard/workspace and the record carries a pointer to them, while an
 * agency client page keeps them inline. Never a figure, a state, or a rule.
 */
export type WorkspaceContext = 'brand' | 'agency-client'

/**
 * THE MEASUREMENT RECORD FOR ONE DOMAIN — two states, and the empty one is the
 * honest one.
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
 * committed artefact; no code path in this component can reach a provider (R3).
 */
export function WorkspaceRecord({ domain, context }: { domain: string; context: WorkspaceContext }) {
  const workspace = workspaceFor(domain)
  // The mounting page resolved this domain before rendering the record, so a
  // null here is a caller bug. Refusing in words beats rendering a record of
  // nothing.
  if (!workspace) {
    return (
      <section className="record">
        <p className="prose">{domain} is not a usable domain, so no workspace opens around it.</p>
      </section>
    )
  }
  return workspace.hasData ? (
    <Measured workspace={workspace} context={context} />
  ) : (
    <Preflight workspace={workspace} context={context} />
  )
}

/**
 * STATE A — a cycle has been collected.
 *
 * Reachable for any domain this build holds a scan for — the committed one and
 * anything /api/scan cached into the registry.
 */
function Measured({ workspace, context }: { workspace: Workspace; context: WorkspaceContext }) {
  const scan: ScanResultFile | null = scanFor(workspace.domain)
  // `hasData` is derived from exactly this call, so the branch cannot be taken.
  // The guard exists because the type system cannot know that, and falling back
  // to the pre-flight screen is the correct behaviour if it ever changes.
  if (!scan) return <Preflight workspace={workspace} context={context} />

  // A scan cached by /api/scan carries no run block. Everything the cycle note
  // needs is derived from what the file does hold, and what it does not hold is
  // omitted rather than defaulted.
  const run = runInfoOf(scan)
  const subject = subjectOf(scan)
  const metric = subject.metric
  const { grade, note } = confidenceGrade(metric)
  const preview = previewScore(subject, scan.brands.filter((b) => !b.isSubject))
  // Object identity against the compiled-in constants, the same derivation the
  // chrome's switcher uses: scans() returns the bundled files by reference, so
  // a scan not in BUNDLED_SCANS is one this browser collected this session.
  const bundled = BUNDLED_SCANS.includes(scan)

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
          {/* A DEMO IS LABELLED AS ONE. The bundled scans resolve for every
              visitor identically, so a reader who opened one from the switcher
              must not mistake it for a record of their own workspace. Session
              scans carry no such note: those really were collected from this
              browser. */}
          {bundled ? (
            <>
              <span className="note__cap note__cap--flag" style={{ marginTop: 'var(--space-3)' }}>
                Reference scan
              </span>
              <span className="note__gloss">
                A demonstration record bundled with this build, shown to every visitor. It is a real collected scan, but it is not a measurement
                of this visitor&apos;s own workspace.
              </span>
            </>
          ) : null}
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

      {/* The same comparison the Grader renders, from the same scan file. The
          zero-competitor branch inside it keeps its honest prose: a fallback
          scan is measured alone and says so rather than drawing a chart. */}
      <HeadToHeadSection scan={scan} />

      {/* The per-question table, from the same cycle. It renders its own honest
          absence when the file predates `promptRows`, so this surface makes no
          claim about the split that the data does not carry. */}
      <PromptBreakdown scan={scan} />

      {/*
        ⚠️ THE CHART THIS COMPONENT STILL REFUSES TO DRAW.

        One cycle is one point, and a line through one point is a shape with no
        measurement under it. A picture asserting more than the data contains is
        refused in words instead.

        THE BY-ENGINE TABLE USED TO BE THE SECOND ENTRY HERE, and the reason it
        gave was sound but the fact underneath it was wrong. "The per-engine
        split is not in this cycle's stored payload" was true of the payload and
        false of the pipeline: `scoreAnswer` computed it for every answer and
        `runScan` summed it away before writing the file. The rate was never
        divided five ways — the rows are kept now, and `PromptBreakdown` counts
        them. What was refused was the division, and the division is still
        refused: a file without rows gets the sentence, not a grid.
      */}
      <section className="section">
        <h2>What is not on this page</h2>
        {/* Only claimed when the comparison actually rendered. A fallback scan
            has no competitor set, and the section above already states that
            absence in its own words. */}
        {scan.brands.some((b) => !b.isSubject) ? (
          <p className="prose">
            The head-to-head comparison is not in this list: it is above, drawn from this same cycle. What follows is what genuinely cannot be
            drawn yet.
          </p>
        ) : null}
        <p className="prose prose--flag" style={{ marginTop: 'var(--space-3)' }}>
          There is no trend chart. A trend needs at least two cycles to compare and this workspace has one
          {run.day ? (
            <>
              , collected on <span className="num">{run.day}</span>
            </>
          ) : null}
          . A line through a single point would be drawing movement that has not been measured.
        </p>
        <WorkedExample />
      </section>

      {context === 'brand' ? <WorkspacePointer /> : <WorkspaceFacts workspace={workspace} context={context} />}
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
function Preflight({ workspace, context }: { workspace: Workspace; context: WorkspaceContext }) {
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
                {workspace.engines.length} answer surfaces. Not a sample of them, and not a paraphrase: this is the list, exactly as it would be
                sent.
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

      {context === 'brand' ? <WorkspacePointer /> : <WorkspaceFacts workspace={workspace} context={context} />}

      <section className="section">
        <h2>A worked example</h2>
        <WorkedExample />
      </section>
    </>
  )
}

/**
 * THE POINTER THAT REPLACED THE INLINE FACTS, brand side only. The workspace's
 * fixed facts moved to /dashboard/workspace — a real page for what the bar's
 * anchor pretended to be — and the record keeps one line saying where they
 * went. It keeps `id="settings"` because the brand bar's "Workspace" link is a
 * full page load of /dashboard#settings, and a nav anchor that scrolls nowhere
 * is a page claiming a surface it has not built.
 */
function WorkspacePointer() {
  return (
    <section className="section" id="settings">
      <h2>Workspace</h2>
      <ActionLink href="/dashboard/workspace">Workspace settings</ActionLink>
      <p className="prose">
        The tracked domain, the category bank, the engines and the schedule for this workspace live on that page, along with prompt management.
      </p>
    </section>
  )
}

/**
 * The settings, as a record rather than a form. Nothing here is editable,
 * because none of it is stored anywhere an edit could go yet, and a disabled
 * input that looks operable is a worse lie than a printed fact.
 *
 * Exported: on the brand side these facts render on /dashboard/workspace, and
 * the record above carries only the pointer to them. Agency client pages keep
 * them inline.
 */
export function WorkspaceFacts({ workspace, context }: { workspace: Workspace; context: WorkspaceContext }) {
  // `id` because the brand bar's "Workspace" link lands on /dashboard#settings.
  // On the brand overview that anchor is now `WorkspacePointer`; here it serves
  // the agency client pages and the workspace page, where this section renders.
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

        {/* TWO ROWS, TWO KINDS OF CLAIM, AND THEY NEVER SHARE A MARKER. "Last
            checked" is a fact read from the record and carries no flag; "Next
            check" describes a capability nothing has built, so it wears the
            planned marker. Folding them into one row would stamp a real date as
            provisional or launder a plan as a fact — both are the same lie. */}
        <dt className="wsfact__key">Last checked</dt>
        {/* "no cycle in this record", not "never". This reads the committed
            artefact; a domain scanned live through /api/scan is cached
            elsewhere and would be invisible to it. Absence of a record is what
            is known, and it is not the same claim as absence of a run. */}
        <dd className="wsfact__val">
          {workspace.lastRunDay === null ? 'no cycle in this record' : <span className="num">{workspace.lastRunDay}</span>}
        </dd>

        <dt className="wsfact__key">Next check</dt>
        <dd className="wsfact__val">
          {SCHEDULE_FACT}; a run happens only when a person starts one <Planned />
        </dd>
      </dl>

      {context === 'brand' ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <ActionLink href="/dashboard/prompts">Manage prompts</ActionLink>
          <p className="prose">The curated bank this workspace would ask, and any prompts of your own beside it.</p>
        </div>
      ) : null}

      {/* THE LOCKED DOMAIN RULE, stated once, where the lock is shown. The
          wording names the side of the plan the surrounding page sells; the
          rule itself is identical on both. */}
      {context === 'brand' ? (
        <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
          On a brand plan the tracked domain is fixed when the workspace is created. Every stored measurement is keyed to that domain, so
          changing it would not move the history across, it would quietly turn a record of one subject into a record of another. An agency plan
          adds a separate workspace per client instead, which is the same rule seen from the other side.
        </p>
      ) : (
        <p className="prose" style={{ marginTop: 'var(--space-3)' }}>
          Each client is its own workspace, and its tracked domain is fixed when the workspace is created. Every stored measurement is keyed to
          that domain, so changing it would not move the history across, it would quietly turn a record of one subject into a record of another.
          To track a different domain, add it as another client instead.
        </p>
      )}
    </section>
  )
}

/**
 * The link to `apps/web`. Labelled as illustrative every time it appears: that
 * app is a design surface running on made-up cycles, and a reader who lands on
 * it from here must not mistake its charts for their own measurements.
 */
export function WorkedExample() {
  const theme = useTheme()
  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      {/* themedUrl: the worked example is a different origin, so the theme
          chosen here cannot reach its localStorage. The query parameter is how
          the choice crosses; `system` sends nothing and the media query
          decides there as it does here. */}
      <ActionLink href={themedUrl(DASHBOARD_URL, theme)} external>
        Worked example
      </ActionLink>
      <p className="prose">
        A demonstration of the multi-cycle view. The figures there are illustrative, not collected, they belong to no real brand, and the run of
        cycles they are drawn on was never collected on a schedule.
      </p>
    </div>
  )
}
