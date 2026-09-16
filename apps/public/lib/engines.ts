/**
 * ENGINE DISPLAY NAMES — one map, every surface.
 *
 * The engines are stored, compared and keyed by slug (`google-ai-overviews`),
 * which is right: the id is what the collection path, the comparison basis and
 * every stored row agree on, and it must never change to suit a heading. But
 * the slug was also what a reader saw, on the per-question table header, the
 * engine strip, the evidence chips, the "returned no sources" line and the
 * collection progress. Five surfaces, five raw slugs.
 *
 * ⚠️ AN UNKNOWN ID SURFACES, IT DOES NOT HIDE. `engineName` returns the id
 * itself when it has no entry, so a sixth engine added tomorrow renders as
 * `perplexity` — visibly unnamed, next to four proper names, which is a
 * prompt to add it. The alternatives are both worse: a map that threw would
 * break a page over a label, and one that fell back to something generic
 * ("Other engine", or dropping the row) would silently misreport which surface
 * a measurement came from. `engines.test.ts` asserts every engine the shipped
 * scan actually carries has a name, so the gap is caught before a reader sees
 * it rather than after.
 *
 * Same shape and same fallback rule as `labelFor` in citations.ts, deliberately:
 * two id-to-label maps in one codebase should not behave differently.
 */
const ENGINE_NAMES: Readonly<Record<string, string>> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  copilot: 'Copilot',
  'google-ai-mode': 'Google AI Mode',
  'google-ai-overviews': 'Google AI Overviews',
}

/** The reader's name for an engine, or the id itself when nobody has named it. */
export const engineName = (id: string): string => ENGINE_NAMES[id] ?? id

/** Every id this build can name. Exported for the test that keeps it complete. */
export const NAMED_ENGINES: readonly string[] = Object.keys(ENGINE_NAMES)

/**
 * A collection progress line, `"<engine-id> <prompt…>"`, with the id replaced.
 *
 * The engine is baked into one string by the runner (`services/grader/src/
 * scan.ts`), so there is no separate field to read on this side. Splitting the
 * FIRST TOKEN is exact rather than heuristic: an engine id is a slug and never
 * contains a space. If that ever stops being true the head simply will not
 * match a name and the line renders exactly as it does today, which is the
 * failure mode worth having.
 */
export function namedCell(cell: string): string {
  const space = cell.indexOf(' ')
  if (space === -1) return engineName(cell)
  const head = cell.slice(0, space)
  const named = engineName(head)
  return named === head ? cell : `${named}${cell.slice(space)}`
}
