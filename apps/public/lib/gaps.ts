/**
 * The gap report, as the client reads it. ADR-0014.
 *
 * Same shape of arrangement as the answers (ADR-0011): a separate artefact,
 * fetched when a reader asks — the committed `/gap-report.json` for the bundled
 * reference scan, `/api/gaps` for a scan this machine collected — and checked
 * against the result it sits under before a line of it is shown. A report
 * about the wrong cycle's prompts under the right number would be worse than
 * no report.
 *
 * Everything in it is a fact about a document at the moment it was read. The
 * hedges the server writes into every `why` are printed, not summarised away,
 * and the surface repeats the one sentence that matters: none of it is a
 * measured cause of anything.
 */

import { BUNDLED_SCANS, runInfoOf, type ScanResultFile } from '@/lib/scan-result'

export interface GapFinding {
  readonly id: string
  readonly status: 'present' | 'weak' | 'missing'
  readonly what: string
  readonly why: string
  readonly evidence: string
}

export interface GapCoverage {
  readonly prompt: string
  readonly covered: readonly string[]
  readonly missing: readonly string[]
  readonly ratio: number
}

export interface GapReport {
  readonly domain: string
  readonly category: string
  readonly day: string
  readonly comparisonBasis: string
  readonly finalUrl: string
  readonly fetchedAt: string
  readonly bytes: number
  readonly truncated: boolean
  readonly words: number
  readonly schemaTypes: readonly string[]
  readonly promptCount: number
  readonly findings: readonly GapFinding[]
  readonly coverage: readonly GapCoverage[]
  readonly meanCoverage: number
}

export type GapsResult = { readonly ok: true; readonly report: GapReport } | { readonly ok: false; readonly message: string }

const STATUSES = new Set(['present', 'weak', 'missing'])
const strings = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Shape guard. Both sources are ours; both arrive as untyped JSON. */
export function parseGapReport(value: unknown): GapReport | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['domain'] !== 'string' || !Array.isArray(v['findings']) || !Array.isArray(v['coverage'])) return null
  const findings: GapFinding[] = []
  for (const f of v['findings'] as unknown[]) {
    const x = (f ?? {}) as Record<string, unknown>
    if (typeof x['id'] !== 'string' || typeof x['status'] !== 'string' || !STATUSES.has(x['status'])) continue
    findings.push({
      id: x['id'],
      status: x['status'] as GapFinding['status'],
      what: typeof x['what'] === 'string' ? x['what'] : '',
      why: typeof x['why'] === 'string' ? x['why'] : '',
      evidence: typeof x['evidence'] === 'string' ? x['evidence'] : '',
    })
  }
  const coverage: GapCoverage[] = []
  for (const c of v['coverage'] as unknown[]) {
    const x = (c ?? {}) as Record<string, unknown>
    if (typeof x['prompt'] !== 'string') continue
    const ratio = typeof x['ratio'] === 'number' && Number.isFinite(x['ratio']) ? Math.min(1, Math.max(0, x['ratio'])) : 0
    coverage.push({ prompt: x['prompt'], covered: strings(x['covered']), missing: strings(x['missing']), ratio })
  }
  const num = (k: string) => (typeof v[k] === 'number' && Number.isFinite(v[k] as number) ? (v[k] as number) : 0)
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '')
  return {
    domain: v['domain'],
    category: str('category'),
    day: str('day'),
    comparisonBasis: str('comparisonBasis'),
    finalUrl: str('finalUrl'),
    fetchedAt: str('fetchedAt'),
    bytes: num('bytes'),
    truncated: v['truncated'] === true,
    words: num('words'),
    schemaTypes: strings(v['schemaTypes']),
    promptCount: num('promptCount') || coverage.length,
    findings,
    coverage,
    meanCoverage: Math.min(1, Math.max(0, num('meanCoverage'))),
  }
}

const typed = (d: string) => d.trim().toLowerCase().replace(/^www\./, '')

/**
 * Does this report belong under this result? The domain and the basis must
 * match, exactly as `belongsTo` demands of the answers: a report over a
 * different prompt count is a report about different questions.
 */
export function reportBelongsTo(report: GapReport, scan: ScanResultFile): string | null {
  if (typed(report.domain) !== typed(scan.domain)) return `this report is about ${report.domain}, not ${scan.domain}`
  if (!report.comparisonBasis) return 'this report does not record which measurement it belongs to'
  if (report.comparisonBasis !== scan.comparisonBasis) return 'this report was made against a different set of prompts from the ones behind the numbers above'
  return null
}

/** Membership by identity, as `evidenceUrl` does: a later session cycle of the bundled domain is not the bundled scan. */
export function gapsUrl(scan: ScanResultFile): string {
  if (BUNDLED_SCANS.includes(scan)) return '/gap-report.json'
  const day = runInfoOf(scan).day
  return `/api/gaps?domain=${encodeURIComponent(scan.domain)}${day ? `&day=${day}` : ''}`
}

export async function loadGaps(scan: ScanResultFile, fetchImpl: typeof fetch = fetch): Promise<GapsResult> {
  let raw: unknown
  try {
    const res = await fetchImpl(gapsUrl(scan))
    if (!res.ok) {
      let detail = ''
      try {
        detail = String(((await res.json()) as { message?: unknown }).message ?? '')
      } catch {
        /* no body, or not JSON */
      }
      return {
        ok: false,
        message:
          res.status === 404
            ? 'A gap report for this scan is not available in this build. It is made on the machine that holds the scan, and this deployment does not.'
            : res.status === 429
              ? 'Too many gap reports from this browser in the last hour. Try again later; nothing was fetched.'
              : detail || `The gap report could not be made (the service answered ${res.status}).`,
      }
    }
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      return { ok: false, message: 'A gap report for this scan is not available in this build. It is made on the machine that holds the scan, and this deployment does not.' }
    }
    raw = (await res.json()) as unknown
  } catch (e) {
    return { ok: false, message: `Could not reach the gap report service: ${(e as Error).message}` }
  }
  const report = parseGapReport(raw)
  if (!report) return { ok: false, message: 'The gap report could not be read.' }
  const wrong = reportBelongsTo(report, scan)
  if (wrong) return { ok: false, message: `${wrong}. Nothing is shown rather than a report about the wrong questions.` }
  return { ok: true, report }
}
