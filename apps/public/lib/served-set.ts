/**
 * WHEN THE RECORD SERVED IS NOT A MEASUREMENT OF THE QUESTIONS NOW IN FORCE
 * (MVP_PLAN C3r item 5).
 *
 * One check runs per UTC day, because the answer cache is keyed by day: a
 * second scan on a day that has its cycle would read the same answers back.
 * So a person who edits their questions on a day whose check already ran, and
 * presses the button, is served the stored cycle. That is right, and until
 * this existed it was silent: the page showed a number measured over version 1
 * to a person who had just saved version 2, and said nothing. They would
 * reasonably read it as the new questions' result.
 *
 * The rule stays (one cycle a day, nothing re-bought). What changes is that the
 * page says, in plain words, which questions the check they are looking at was
 * asked, that the newer ones were not asked, and from which day they will be.
 *
 * ⚠️ "CAN RUN FROM", NEVER "WILL RUN ON" (stats review of C3r, MAJOR 2). The
 * date is the first day a check is POSSIBLE. Whether one happens depends on
 * things this sentence does not know: a domain that is not re-checked daily
 * is checked when a person starts a check, a domain tracked until today is
 * `expired` tomorrow, and the daily loop runs only where its owner armed it.
 * "They will be asked from the next check, on the 20th" was a promise nothing
 * kept. What IS true is that whenever the next check runs, it asks the
 * questions in force.
 *
 * The facts come from the server (`/api/scan`, on the `cached` event): the day
 * and the set the served cycle was measured over, read off its own basis, and
 * the set in force in the store now. This file only words them, so the
 * sentence can be tested without a route.
 */

export interface ServedSetFacts {
  /** The UTC day the served cycle was collected. */
  readonly servedDay: string
  /** The version of the person's own questions the served cycle asked, or null when it asked the category's. */
  readonly servedVersion: number | null
  /** The version in force in the store now, or null when the category's questions are. */
  readonly inForceVersion: number | null
  /** Today, UTC. */
  readonly today: string
  /** The first day a new check can run: today when the served cycle is older, else the day after it. */
  readonly nextCheckFrom: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const versionOrNull = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined)

/** The facts as they arrive on the wire, or null when they are not the shape this file words: a page never builds a sentence out of a guess. */
export function servedFactsOf(raw: unknown): ServedSetFacts | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const servedVersion = versionOrNull(r['servedVersion'])
  const inForceVersion = versionOrNull(r['inForceVersion'])
  const days = [r['servedDay'], r['today'], r['nextCheckFrom']]
  if (servedVersion === undefined || inForceVersion === undefined || !days.every((d): d is string => typeof d === 'string' && DAY.test(d))) return null
  return { servedDay: days[0]!, servedVersion, inForceVersion, today: days[1]!, nextCheckFrom: days[2]! }
}

const asked = (version: number | null): string => (version === null ? 'the category’s questions' : `version ${version} of your questions`)

/** The sentence, or null when the served cycle asked exactly what is in force. */
export function servedSetNotice(f: ServedSetFacts): string | null {
  if (f.servedVersion === f.inForceVersion) return null
  const when = f.servedDay === f.today ? `Today’s check (${f.servedDay}) already ran` : `The latest check ran on ${f.servedDay}`
  const newer = f.inForceVersion === null ? 'The category’s questions, in force again since you cleared your own,' : `${f.servedVersion === null ? 'Your own questions' : 'The questions you saved since'} (version ${f.inForceVersion})`
  const next =
    f.servedDay === f.today
      ? `were not asked today, because one check runs per day. They will be asked at the next check, which can run from ${f.nextCheckFrom}.`
      : `have not been asked yet. They will be asked at the next check, which can run from ${f.nextCheckFrom}.`
  return `${when}, on ${asked(f.servedVersion)}; that is the result shown here. ${newer} ${next}`
}
