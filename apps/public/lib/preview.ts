/**
 * Client side of the prompt preview: ask the server what a scan would do.
 *
 * A plain JSON POST rather than the SSE the scan uses, because there is nothing
 * to stream — at most one homepage fetch and one authoring call, both bounded,
 * and neither produces intermediate output worth showing.
 *
 * Fails toward SAYING SO, like everything else on this path. There is no branch
 * that invents a category for a request that did not succeed: a failed preview
 * is reported as a failed preview, and the scan behind it is not started.
 */

import type { PreviewResponse } from './preview-contract'
import { rememberDecision } from './resolved-category'

export type PreviewOutcome =
  | { readonly ok: true; readonly preview: PreviewResponse }
  | { readonly ok: false; readonly kind: string; readonly message: string }

export async function fetchPreview(domain: string, signal?: AbortSignal): Promise<PreviewOutcome> {
  let res: Response
  try {
    res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    return { ok: false, kind: 'network', message: `Could not reach the preview service: ${(e as Error).message}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, kind: 'http', message: `The preview service answered ${res.status} with no readable body.` }
  }

  if (!res.ok) {
    const e = body as { kind?: string; message?: string }
    return { ok: false, kind: String(e.kind ?? 'failed'), message: String(e.message ?? `The preview service answered ${res.status}.`) }
  }

  const preview = body as PreviewResponse
  if (!preview?.category || !Array.isArray(preview.prompts)) {
    return { ok: false, kind: 'failed', message: 'The preview service answered with no category.' }
  }

  // Mirrored into this browser HERE, at the one place a preview is received, so
  // every other screen agrees with what is about to be shown. Doing it in the
  // component would mean a caller that forgets leaves the dashboard contradicting
  // the Grader — which is the defect this whole path exists to close.
  rememberDecision(preview)
  return { ok: true, preview }
}
