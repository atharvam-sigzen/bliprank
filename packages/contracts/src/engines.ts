/** The five answer surfaces. Values are part of the cache key: append-only, never rename. */
export const ENGINES = [
  'chatgpt',
  'gemini',
  'copilot',
  'google-ai-mode',
  'google-ai-overviews',
] as const

export type EngineId = (typeof ENGINES)[number]
