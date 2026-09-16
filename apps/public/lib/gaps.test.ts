import { describe, expect, it } from 'vitest'
import { gapsUrl, loadGaps, parseGapReport, reportBelongsTo } from './gaps'
import { SCAN, type ScanResultFile } from './scan-result'
import { NO_RUN_BLOCK_SCAN } from './__fixtures__/no-run-block-scan'

const report = (over: Record<string, unknown> = {}) => ({
  domain: 'pipedrive.com',
  category: 'crm-software',
  day: '2026-08-25',
  comparisonBasis: SCAN.comparisonBasis,
  finalUrl: 'https://www.pipedrive.com/',
  fetchedAt: '2026-09-02T12:00:00.000Z',
  bytes: 406194,
  truncated: false,
  words: 2341,
  schemaTypes: ['Organization', 'FAQPage'],
  promptCount: 2,
  meanCoverage: 0.71,
  findings: [
    { id: 'json-ld', status: 'present', what: '2 blocks', why: '', evidence: 'Organization' },
    { id: 'meta-description', status: 'weak', what: 'Description is 505 characters', why: 'Hedged: the band is a convention, not a measurement.', evidence: 'Sales CRM…' },
    { id: 'bogus', status: 'made-up', what: '', why: '', evidence: '' },
  ],
  coverage: [
    { prompt: 'Which CRM is easiest?', covered: ['crm'], missing: ['easiest'], ratio: 0.5 },
    { prompt: 'Best CRM in the UK', covered: ['crm', 'uk'], missing: [], ratio: 1 },
    { notAPrompt: true },
  ],
  ...over,
})

describe('the report is checked before a line of it is shown', () => {
  it('parses defensively: bad findings and bad coverage rows are dropped, numbers are clamped', () => {
    const r = parseGapReport(report({ meanCoverage: 1.7 }))!
    expect(r.findings.map((f) => f.id)).toEqual(['json-ld', 'meta-description'])
    expect(r.coverage).toHaveLength(2)
    expect(r.meanCoverage).toBe(1)
    expect(r.promptCount).toBe(2)
    expect(parseGapReport({ domain: 'x' })).toBeNull()
    expect(parseGapReport(null)).toBeNull()
  })

  it('belongs only to the result with the same domain and the same basis', () => {
    const r = parseGapReport(report())!
    expect(reportBelongsTo(r, SCAN)).toBeNull()
    expect(reportBelongsTo(parseGapReport(report({ domain: 'other.com' }))!, SCAN)).toContain('not pipedrive.com')
    expect(reportBelongsTo(parseGapReport(report({ comparisonBasis: 'b|unprompted=10' }))!, SCAN)).toContain('different set of prompts')
    expect(reportBelongsTo(parseGapReport(report({ comparisonBasis: '' }))!, SCAN)).toContain('does not record')
  })

  it('the bundled scan reads a static file; a session scan asks the route, naming its day', () => {
    expect(gapsUrl(SCAN)).toBe('/gap-report.json')
    const session: ScanResultFile = { ...NO_RUN_BLOCK_SCAN, domain: 'acme.example' }
    expect(gapsUrl(session)).toBe('/api/gaps?domain=acme.example&day=2026-08-25')
    // A later cycle of the bundled domain is a session scan, not the bundled file.
    const later: ScanResultFile = { ...SCAN, collectedAt: '2026-09-20T00:00:00.000Z', run: { ...SCAN.run, day: '2026-09-20' } }
    expect(gapsUrl(later)).toBe('/api/gaps?domain=pipedrive.com&day=2026-09-20')
  })

  it('loadGaps turns every failure into a sentence, and refuses a report for the wrong questions', async () => {
    const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    expect((await loadGaps(SCAN, respond(404, { message: 'nope' })) as { message: string }).message).toContain('not available in this build')
    expect((await loadGaps(SCAN, respond(429, { message: 'slow down' })) as { message: string }).message).toContain('Too many gap reports')
    expect((await loadGaps(SCAN, respond(422, { message: 'could not read the homepage' })) as { message: string }).message).toContain('could not read the homepage')
    expect((await loadGaps(SCAN, respond(200, report({ comparisonBasis: 'other' }))) as { message: string }).message).toContain('different set of prompts')
    // A static host answering the route's path with its own HTML page and a 200.
    const html = (async () => new Response('<!doctype html><h1>Not found</h1>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    expect((await loadGaps(SCAN, html) as { message: string }).message).toContain('not available in this build')
    const ok = await loadGaps(SCAN, respond(200, report()))
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.report.findings).toHaveLength(2)
  })
})
