/**
 * `pnpm grader:aeo` — the gap report for one domain.
 *
 *   pnpm grader:aeo -- --domain sigzen.com
 *   pnpm grader:aeo -- --domain sigzen.com --draft
 *
 * It resolves the domain's category the same way a scan does, fetches the
 * homepage through the SSRF boundary the classifier already uses, and reports
 * what the page has and has not got against the questions that category's bank
 * actually asks.
 *
 * ⚠️ WHAT IT COSTS. One outbound GET to the domain's own homepage — the same one
 * `/api/preview` makes — and, with `--draft`, one call to the bank-author model.
 * Zero provider quota: nothing here touches OpenWeb Ninja, so no scan is spent
 * and `COLLECTION_ENABLED` does not gate it (R3 governs COLLECTION, and this
 * collects nothing).
 *
 * ⚠️ IT DIAGNOSES AND IT NEVER PUBLISHES. `--draft` prints markdown to stdout for
 * a person to read, edit and paste. There is no flag that writes to a site, no
 * CMS credential is read, and no code path from this file reaches anything the
 * customer owns.
 *
 * ⚠️ AND IT DOES NOT CLAIM CAUSATION. Every finding is a fact about a document.
 * None of them has been shown to move a mention rate, because that needs a
 * holdout and a difference-in-differences (PHASES 7) and we have not run one.
 * The report says so on its own face rather than in a methodology page nobody
 * opens.
 */

import { join } from 'node:path'
import { auditSite, draftGapContent, widestGap, type AeoReport, type Finding } from './aeo-audit.js'
import { bankAuthorConfig } from './bank-author.js'
import { fetchSiteHtml } from './fetch-site.js'
import { loadApiKey } from './load-key.js'
import { extractSiteText } from '@bliprank/taxonomy'
import { resolveCategory } from './resolve-category.js'
import { UNPROMPTED_INTENTS } from './scan.js'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

export interface AeoOptions {
  readonly domain: string
  readonly dataDir: string
  readonly draft: boolean
  readonly maxPrompts: number
}

export function parseAeoArgs(argv: readonly string[]): AeoOptions | { readonly refuse: string } {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i]! : 'true'
    args.set(k, v)
  }
  const domain = args.get('domain')
  if (!domain) return { refuse: 'no --domain given' }
  const maxPrompts = Number(args.get('max-prompts') ?? 10)
  if (!Number.isFinite(maxPrompts) || maxPrompts < 1) return { refuse: `--max-prompts must be > 0, got ${args.get('max-prompts')}` }
  return {
    domain,
    dataDir: args.get('data') ?? join(here, '..', 'data-live'),
    draft: args.has('draft'),
    maxPrompts,
  }
}

const GLYPH: Record<Finding['status'], string> = { present: '  ok  ', weak: ' weak ', missing: 'MISSING' }

export function renderReport(report: AeoReport): string {
  const out: string[] = []
  out.push(`\nSTRUCTURE AND SELF-DESCRIPTION`)
  for (const f of report.findings) {
    out.push(`  [${GLYPH[f.status]}] ${f.id.padEnd(17)} ${f.what}`)
    out.push(`${' '.repeat(30)}${f.evidence.slice(0, 110)}`)
    if (f.status !== 'present') out.push(`${' '.repeat(30)}why: ${f.why}`)
  }

  out.push(`\nDOES THE PAGE ADDRESS THE QUESTIONS BEING ASKED ABOUT IT?`)
  out.push(`  Mean term coverage ${(report.meanCoverage * 100).toFixed(0)}% across ${report.coverage.length} prompts.`)
  out.push(`  This is a word check, not a relevance score: these are the terms in the questions`)
  out.push(`  we send the engines, and whether your page's own text uses them anywhere.`)
  /*
   * ⚠️ A TRUNCATED PAGE WEAKENS THE CLAIM, AND THE WORDING MOVES WITH IT.
   *
   * "Never on the page" is not a thing anyone can say about a document that was
   * abandoned at the fetch ceiling, only "not in the part we read". A FALSE GAP
   * is the worst output this report can produce -- it is advice to write copy
   * that already exists -- and sigzen.com is the specimen: 524 KB of homepage
   * against a 512 KB ceiling, so eight of its own words were reportable as
   * absent from a page that may well use them.
   */
  const absent = report.truncated ? 'not in the part of the page we read' : 'never on the page'
  if (report.truncated) {
    out.push(`  ⚠️ This page is larger than the 512 KB fetch ceiling and was cut off, so a term`)
    out.push(`     below is absent from what we READ, not necessarily from the page.`)
  }
  out.push('')
  for (const c of [...report.coverage].sort((a, b) => a.ratio - b.ratio)) {
    out.push(`  ${String(Math.round(c.ratio * 100)).padStart(3)}%  ${c.prompt}`)
    if (c.missing.length) out.push(`        ${absent}: ${c.missing.join(', ')}`)
  }
  return out.join('\n')
}

async function main(): Promise<void> {
  const parsed = parseAeoArgs(process.argv.slice(2))
  if ('refuse' in parsed) {
    process.stderr.write(`refusing: ${parsed.refuse}\n`)
    process.exit(2)
  }
  const o = parsed
  const root = join(here, '..', '..', '..')
  const env = process.env
  const author = bankAuthorConfig(env, (n) => loadApiKey(root, env, n)?.key) ?? undefined

  /*
   * THE CATEGORY, RESOLVED EXACTLY AS A SCAN RESOLVES IT.
   *
   * The report is only worth anything if the questions in it are the questions
   * a scan would actually send — otherwise it is a gap analysis against a
   * market the customer is not in. `resolveCategory` reads the record first, so
   * a domain already previewed or scanned costs nothing here and cannot be
   * placed somewhere new by running this.
   */
  const resolved = await resolveCategory(o.domain, {
    dataDir: o.dataDir,
    ...(author ? { author } : {}),
    log: (m) => process.stdout.write(`  ${m}\n`),
  })
  const prompts = resolved.bank.prompts
    .filter((p) => (UNPROMPTED_INTENTS as readonly string[]).includes(p.intent))
    .slice(0, o.maxPrompts)
    .map((p) => p.text)

  // ONE FETCH, THROUGH THE EXISTING BOUNDARY. `resolveCategory` may have made
  // its own to classify the domain; this is a second GET of the same page and
  // deliberately not shared with it — that function returns a decision, not a
  // document, and threading the HTML out of it would widen its contract for one
  // caller. Two bounded GETs of a public homepage is the cheaper mistake.
  const fetched = await fetchSiteHtml(o.domain)
  if (!fetched.ok) {
    process.stderr.write(`could not read ${o.domain}: ${fetched.reason} — ${fetched.message}\n`)
    process.exit(1)
  }

  const report = auditSite(fetched.html, { domain: o.domain, finalUrl: fetched.finalUrl, prompts, truncated: fetched.truncated })
  process.stdout.write(
    `\naeo gap report · ${o.domain} · ${resolved.bank.displayName} (${resolved.record.source})\n` +
      `  ${fetched.finalUrl} · ${fetched.bytes} bytes${fetched.truncated ? ' (truncated)' : ''}\n` +
      `  spends no provider quota. Nothing here is published anywhere.\n`,
  )
  process.stdout.write(`${renderReport(report)}\n`)

  process.stdout.write(
    `\n⚠️ NONE OF THIS IS A MEASURED CAUSE OF ANYTHING.\n` +
      `   Every line above is a fact about a document. Whether changing one moves a mention\n` +
      `   rate needs a holdout and a difference-in-differences, and we have not run one.\n` +
      `   Treat it as a checklist of things that are missing, not as a list of things that work.\n`,
  )

  if (!o.draft) {
    process.stdout.write(`\nRe-run with --draft to have one gap drafted as suggested copy (one model call, published nowhere).\n`)
    return
  }
  if (!author) {
    process.stdout.write(`\n--draft: no author key configured, so nothing was drafted. Set OPENROUTER_API_KEY (CLAUDE.md §7).\n`)
    return
  }

  const gap = widestGap(report)
  if (!gap || gap.missing.length === 0) {
    process.stdout.write(`\n--draft: no prompt has uncovered terms, so there is no gap to draft for.\n`)
    return
  }

  const site = extractSiteText(fetched.html)
  const draft = await draftGapContent({
    domain: o.domain,
    title: site.title,
    description: site.description,
    headings: site.headings,
    prompt: gap.prompt,
    missingTerms: gap.missing,
    config: author,
    log: (m) => process.stdout.write(`  ${m}\n`),
  })
  if (!draft) {
    process.stdout.write(`\n--draft: no model answered, so nothing was drafted. The report above stands on its own.\n`)
    return
  }
  process.stdout.write(
    `\n─────────────────────────────────────────────────────────────────────────────\n` +
      `DRAFT for: "${gap.prompt}"\n` +
      `covering: ${gap.missing.join(', ')}\n` +
      `⚠️ UNREVIEWED, AND PUBLISHED NOWHERE. Model-written copy about someone else's\n` +
      `   business. Read every claim in it before any of it goes near a live page.\n` +
      `─────────────────────────────────────────────────────────────────────────────\n\n${draft}\n`,
  )
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('aeo.ts')) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  })
}
