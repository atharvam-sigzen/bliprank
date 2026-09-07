/**
 * THE PLANNED MARKER.
 *
 * PLANNED says the CAPABILITY is not built. No code produces this yet, and what
 * is on screen is the shape of a view rather than a record of anything. It is
 * deliberately not "preview" or "provisional": those words describe a number
 * whose method may still change, and a reader who sees PLANNED has to be able
 * to tell that no code ran at all. (A "preview" visibility score once sat
 * beside this marker; it was removed on 2026-09-02 because a composite with
 * placeholder weights and no interval was the kind of figure this product
 * refuses from everyone else.) Two surfaces need this marker today and they
 * must not word the gap two ways, so the wording lives here.
 *
 * THIS FILE IS THE ONLY COPY. Until 2026-09-07 apps/web (the fixture-only
 * worked example, since retired) carried a duplicate that `planned.test.ts`
 * held character-for-character to this one, because the two deploys could not
 * share an import. Any future surface states the gap by importing from here.
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
export const SCHEDULE_FACT = 'daily (intended); nothing schedules a cycle yet, a person starts each one from the workspace record'

/**
 * The marker itself, presented exactly as `score__flag` is: mono, uppercase,
 * small, amber-bordered. Same instrument, different reading.
 */
export function Planned() {
  return <span className="flag flag--planned">planned</span>
}
