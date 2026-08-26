/**
 * Custom prompts a visitor adds to a domain's workspace, per domain.
 *
 * Offline and spend-free (R3): these are stored strings, nothing more. They
 * describe what a cycle WOULD ask on top of the category bank; no scheduler
 * exists, so nothing here implies collection.
 *
 * Storage discipline follows lib/workspace.ts exactly: every access is inside
 * try/catch, and a failed write still returns the would-be list so a private
 * window reads as absent persistence, never as a broken button.
 */

export const CUSTOM_PROMPTS_KEY_PREFIX = 'bliprank-custom-prompts:'

const MAX_LENGTH = 200

function keyFor(domain: string): string {
  return CUSTOM_PROMPTS_KEY_PREFIX + domain
}

function writeRaw(domain: string, prompts: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(keyFor(domain), JSON.stringify(prompts))
  } catch {
    // Private window, exhausted quota, or SSR. The caller already holds the
    // would-be list; the only loss is persistence across reloads.
  }
}

export function readCustomPrompts(domain: string): readonly string[] {
  try {
    const raw = globalThis.localStorage?.getItem(keyFor(domain))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as readonly unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * The caller's list united with what storage holds, caller first, deduplicated
 * case-insensitively. The caller's state is the source of truth when storage is
 * unavailable — a throwing localStorage reads as [], and basing the operation
 * on that empty read is how a second add got refused as "already on the list"
 * and a remove wiped the whole visible list. Storage entries not in the
 * caller's state (another tab's adds) are kept, not clobbered.
 */
function withStored(domain: string, current: readonly string[]): readonly string[] {
  const out = [...current]
  const seen = new Set(current.map((p) => p.toLowerCase()))
  for (const p of readCustomPrompts(domain)) {
    const lower = p.toLowerCase()
    if (!seen.has(lower)) {
      out.push(p)
      seen.add(lower)
    }
  }
  return out
}

/**
 * Returns the list INCLUDING the new prompt even when the write failed, and
 * whether it was added. `added` is false for empty, over-length (>200 chars
 * after trimming) and case-insensitive duplicate text — the caller branches on
 * that, never on a length comparison against its own state.
 */
export function addCustomPrompt(domain: string, text: string, current: readonly string[]): { list: readonly string[]; added: boolean } {
  const trimmed = text.trim()
  const base = withStored(domain, current)
  if (!trimmed || trimmed.length > MAX_LENGTH) return { list: base, added: false }
  const lower = trimmed.toLowerCase()
  if (base.some((p) => p.toLowerCase() === lower)) return { list: base, added: false }
  const list = [...base, trimmed]
  writeRaw(domain, list)
  return { list, added: true }
}

/** Removal matches case-insensitively, the same rule that refused the duplicate. */
export function removeCustomPrompt(domain: string, text: string, current: readonly string[]): readonly string[] {
  const lower = text.trim().toLowerCase()
  const next = withStored(domain, current).filter((p) => p.toLowerCase() !== lower)
  writeRaw(domain, next)
  return next
}
