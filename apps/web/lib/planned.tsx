/**
 * DUPLICATE. The source of truth is `apps/public/lib/planned.tsx`.
 *
 * apps/web and apps/public are separate apps on separate deploys with no
 * workspace dependency between them, and the shared thing here is four strings
 * of copy rather than a type or a calculation - not enough to justify a package
 * that both would then have to depend on. So it is copied, and
 * `apps/public/lib/planned.test.ts` compares the two files' exports so a change
 * to one without the other fails the suite.
 *
 * Edit the public copy first. This one follows.
 */

/** The label a planned surface prints beside its heading. One source, one wording. */
export const PLANNED_CAPTION = 'Planned view: the capability behind it is not built yet'

/** The specific gap, for the surfaces that imply a schedule. */
export const NO_SCHEDULER_NOTE =
  'Recurring collection is not built yet. These cycles were not collected on a schedule and no scheduler exists; a run happens only when a person starts one. The interval maths and the significance rules shown here are the real ones.'

/** The `Schedule` row of a workspace record: the intended cadence, and the truth about it. */
export const SCHEDULE_FACT = 'daily (intended); nothing schedules a cycle yet'

/** Presented exactly as `score__flag` is: mono, uppercase, small, amber-bordered. */
export function Planned() {
  return <span className="flag flag--planned">planned</span>
}
