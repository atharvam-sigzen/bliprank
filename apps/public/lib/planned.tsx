/**
 * THE PLANNED MARKER - the second kind of provisional, and it is not the first.
 *
 * `PREVIEW_SCORE_CAPTION` says the METHOD is not settled: the number is real,
 * produced by code that ran, but the rubric behind it may still change.
 * PLANNED says something stricter and worse: the CAPABILITY is not built. No
 * code produces this yet, and what is on screen is the shape of a view rather
 * than a record of anything.
 *
 * Keeping them apart matters because they resolve differently. A preview number
 * becomes final when the rubric is signed off. A planned view stays a drawing
 * until somebody writes the thing that fills it. Two surfaces need this marker
 * today and they must not word the gap two ways, so the wording lives here,
 * exactly as the preview caption does.
 *
 * apps/web cannot import from this file: separate app, separate deploy, no
 * workspace dependency between them. `apps/web/lib/planned.tsx` is a duplicate
 * of this module and THIS FILE IS THE SOURCE OF TRUTH. `planned.test.ts` asserts
 * the two agree character for character, so drift fails the suite rather than
 * shipping two descriptions of one gap.
 */

/** The label a planned surface prints beside its heading. One source, one wording. */
export const PLANNED_CAPTION = 'Planned view: the capability behind it is not built yet'

/**
 * The specific gap, for the surfaces that imply a schedule.
 *
 * Three parts on purpose: what is missing, what that means about the data on
 * screen, and what is nonetheless real. The last clause is not softening.
 * Dropping it would suggest the whole panel is a mock-up, when the interval
 * arithmetic under it is production code.
 */
export const NO_SCHEDULER_NOTE =
  'Recurring collection is not built yet. These cycles were not collected on a schedule and no scheduler exists; a run happens only when a person starts one. The interval maths and the significance rules shown here are the real ones.'

/** The `Schedule` row of a workspace record: the intended cadence, and the truth about it. */
export const SCHEDULE_FACT = 'daily (intended); nothing schedules a cycle yet'

/**
 * The marker itself, presented exactly as `score__flag` is: mono, uppercase,
 * small, amber-bordered. Same instrument, different reading.
 */
export function Planned() {
  return <span className="flag flag--planned">planned</span>
}
