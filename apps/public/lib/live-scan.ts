/**
 * Client side of a live scan: POST, then read Server-Sent Events until done.
 *
 * A full scan is 17 prompts across 5 engines and G3 allows p95 ≤ 90 seconds.
 * A browser sitting on a pending fetch for that long is indistinguishable from
 * a hung page, so the server emits an event per cell and this turns them into
 * something the screen can show.
 *
 * Everything here fails toward saying so. There is no path that substitutes a
 * number for a request that did not happen.
 */

import { servedFactsOf, type ServedSetFacts } from './served-set'

export type ScanEvent =
  | { kind: 'stage'; stage: string }
  | { kind: 'cached'; domain: string; served?: ServedSetFacts }
  | { kind: 'begin'; domain: string; total: number; engines: number; prompts: number }
  | { kind: 'progress'; done: number; total: number; cell: string; outcome: string; providerCalls: number }
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; errorKind: string; message: string }

/**
 * Parses an SSE body incrementally. `EventSource` cannot be used because this
 * is a POST with a JSON body, and the browser's EventSource is GET-only.
 */
export interface LiveScanOptions {
  readonly signal?: AbortSignal
  /**
   * Ask for ANOTHER cycle of a domain the server already holds, rather than
   * its cached latest. The route skips its cache and nothing else: every gate
   * a first scan passes still runs (ADR-0013).
   */
  readonly newCycle?: boolean
}

export async function runLiveScan(domain: string, onEvent: (e: ScanEvent) => void, opts: LiveScanOptions = {}): Promise<void> {
  let res: Response
  try {
    res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.newCycle ? { domain, cycle: 'new' } : { domain }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (e) {
    onEvent({ kind: 'error', errorKind: 'network', message: `Could not reach the scan service: ${(e as Error).message}` })
    return
  }

  if (!res.ok || !res.body) {
    onEvent({ kind: 'error', errorKind: 'http', message: `The scan service answered ${res.status}.` })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line. Anything after the last one is
    // a partial frame and stays in the buffer until the rest arrives.
    let split: number
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      let event = 'message'
      let data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (!data) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue
      }
      if (event === 'error') onEvent({ kind: 'error', errorKind: String(parsed['kind'] ?? 'failed'), message: String(parsed['message'] ?? 'The scan failed.') })
      else if (event === 'result') onEvent({ kind: 'result', result: parsed })
      else if (event === 'cached') {
        const served = servedFactsOf(parsed['served'])
        onEvent({ kind: 'cached', domain: String(parsed['domain'] ?? domain), ...(served ? { served } : {}) })
      }
      else if (event === 'begin') onEvent({ kind: 'begin', domain, total: Number(parsed['total'] ?? 0), engines: Number(parsed['engines'] ?? 0), prompts: Number(parsed['prompts'] ?? 0) })
      else if (event === 'stage') onEvent({ kind: 'stage', stage: String(parsed['stage'] ?? '') })
      else if (event === 'progress')
        onEvent({
          kind: 'progress',
          done: Number(parsed['done'] ?? 0),
          total: Number(parsed['total'] ?? 0),
          cell: String(parsed['cell'] ?? ''),
          outcome: String(parsed['outcome'] ?? ''),
          providerCalls: Number(parsed['providerCalls'] ?? 0),
        })
    }
  }
}

/**
 * How many of the five engines actually answered.
 *
 * Reported plainly rather than hidden: "4 of 5 engines responded" is a smaller
 * sample and a wider interval, and a reader is entitled to know which it is.
 * A scan that silently dropped an engine would still produce a number — just a
 * number about a different thing than the one it claims.
 */
export function enginesResponded(cells: readonly { cell: string; outcome: string }[]): { ok: number; total: number; failed: readonly string[] } {
  const byEngine = new Map<string, boolean>()
  for (const c of cells) {
    const engine = c.cell.split(' ')[0] ?? ''
    if (!engine) continue
    const good = c.outcome === 'collected' || c.outcome === 'cache-hit'
    byEngine.set(engine, (byEngine.get(engine) ?? false) || good)
  }
  const failed = [...byEngine.entries()].filter(([, ok]) => !ok).map(([e]) => e)
  return { ok: [...byEngine.values()].filter(Boolean).length, total: byEngine.size, failed }
}
