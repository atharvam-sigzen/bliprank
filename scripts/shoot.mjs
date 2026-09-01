/**
 * Screenshot harness for the Grader and pricing pages.
 *
 * ⚠️ IT CANNOT SPEND. Two independent guards, because this drives a real browser
 * against a build where live scanning is now ON and the account has roughly one
 * full scan of quota left:
 *
 *   1. every request to the provider is aborted at the browser level;
 *   2. every request to /api/scan is aborted too, so even a mistyped domain in
 *      this script cannot reach the runner.
 *
 * The one domain it does type is `pipedrive.com`, which `scanFor` answers from
 * the committed scan on the client and returns before any fetch is made. The
 * guards are there for what this script might become, not for what it does now.
 *
 * Usage: node scripts/shoot.mjs [outDir]
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? 'shots'
const BASE = process.env['SHOOT_BASE'] ?? 'http://localhost:3001'

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
}

/** Requests that must never leave the browser. */
const FORBIDDEN = [/openwebninja\.com/i, /\/api\/scan/i]

async function shoot(browser, { name, path, viewport, theme, prepare, seed }) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    colorScheme: theme,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce', // deterministic captures; motion is asserted by tests
  })

  /*
   * Seed the demo's session state BEFORE the first script runs.
   *
   * The brand dashboard reads its active workspace from localStorage, so its two
   * states — a domain with data and a domain without — are not reachable by
   * navigation alone. addInitScript lands before any page script, which is the
   * only way to avoid photographing the pre-hydration shell instead of the state
   * under test.
   */
  if (seed) {
    await context.addInitScript((entries) => {
      try {
        for (const [k, v] of entries) {
          window.localStorage.setItem(k, v)
          window.sessionStorage?.setItem(k, v)
        }
      } catch {
        /* private window; the page must cope, and the capture will show whether it does */
      }
    }, Object.entries(seed))
  }

  const blocked = []
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (FORBIDDEN.some((re) => re.test(url))) {
      blocked.push(url)
      return route.abort()
    }
    return route.continue()
  })

  // page.route is consulted before context.route, so `refuse` can answer
  // /api/scan with a synthetic frame while the context guard still blocks
  // everything else — including any request to the provider.
  const page = await context.newPage()
  const problems = []
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 160)}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 160)}`))

  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  // The theme boot script reads localStorage; colorScheme drives the media query.
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  if (prepare) await prepare(page)
  await page.waitForTimeout(250)

  const file = join(OUT, `${name}-${viewport}-${theme}.png`)
  await page.screenshot({ path: file, fullPage: true })

  /*
   * THE CHECK A SCREENSHOT CANNOT MAKE FOR YOU. A capture looks fine when the
   * page scrolls sideways; the defect only shows on a real phone. Measured here
   * instead, on the same load that produced the image.
   */
  const overflow = await page.evaluate(() => {
    const d = document.documentElement
    const offenders = []
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && (r.right > d.clientWidth + 1 || r.left < -1)) {
        offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0] || '?'} [${Math.round(r.left)}..${Math.round(r.right)}]`)
      }
    }
    return { scrollW: d.scrollWidth, clientW: d.clientWidth, offenders: [...new Set(offenders)].slice(0, 6) }
  })

  /*
   * COMPUTED STYLE, NOT DECLARED STYLE. The CSS tests read the stylesheet and
   * cannot see the cascade resolve — `.panel__title` lost to `.card h2` on
   * specificity and rendered the refusal's headline as an 11px uppercase field
   * label. Only the browser knows who won, so the browser is asked.
   */
  const typography = await page.evaluate(() => {
    const out = []
    // A headline on the paper is the SERIF at headline size. Both halves matter:
    // the size catches the (0,1,1) label rules that once won this cascade, and
    // the family catches the record being set in chassis lettering.
    for (const el of document.querySelectorAll('.record__title')) {
      const c = getComputedStyle(el)
      const px = Number.parseFloat(c.fontSize)
      if (px < 18 || c.textTransform === 'uppercase') {
        out.push(`.record__title renders ${c.fontSize}/${c.textTransform} — losing the cascade to a label rule`)
      }
      if (!/Newsreader|serif/i.test(c.fontFamily)) out.push(`.record__title is not the serif voice: ${c.fontFamily.slice(0, 40)}`)
    }
    /*
     * `.record__domain` IS A CLAIM, NOT A SIZE. It means "this is the subject
     * of an actual measurement", so it may only appear on a page that also drew
     * a rail. Two pre-collection sheets wore it and nothing caught them: the
     * `.record__title` sweep above cannot see a headline that is not one, and
     * on the dashboard `.masthead h1` masked the size difference entirely.
     */
    if (document.querySelector('.record__domain') && !document.querySelector('.rail')) {
      out.push('.record__domain on a page with no rail — that headline claims a measurement this page does not have')
    }
    for (const el of document.querySelectorAll('.prose')) {
      const c = getComputedStyle(el)
      if (!/Newsreader|serif/i.test(c.fontFamily)) out.push(`.prose is not the serif voice: ${c.fontFamily.slice(0, 40)}`)
    }
    /*
     * NOTHING ON THE PAPER MAY WEAR THE CHASSIS. A record that picks up a
     * border, a card background or a shadow has quietly become a panel again —
     * which is the exact regression this whole conversion undoes, and it would
     * look merely "tidy" in a screenshot rather than wrong.
     */
    for (const el of document.querySelectorAll('.record')) {
      const c = getComputedStyle(el)
      if (c.boxShadow !== 'none') out.push(`.record has a shadow — that is chassis material: ${c.boxShadow.slice(0, 40)}`)
      if (Number.parseFloat(c.borderTopWidth) > 0 || Number.parseFloat(c.borderLeftWidth) > 0) {
        out.push('.record has a border — that is chassis material')
      }
    }
    return [...new Set(out)]
  })

  /*
   * THE R8 SWEEP, RUN ON THE RENDERED DOM.
   *
   * A screenshot of a pre-flight dashboard showing a percentage looks like a
   * working product; it is the single worst defect this codebase can ship. Every
   * capture whose name says it has no data is checked for anything shaped like a
   * measurement — a percentage, a score, an interval, a grade badge.
   */
  const figures = await page.evaluate(() => {
    /*
     * The prompt list is taken out first. Those are questions from the
     * committed bank, printed verbatim — and one of them is "Our organic
     * traffic dropped 40% after a core update, how do we diagnose it?"
     * (packages/taxonomy/src/banks/seo-tools.ts). A percentage inside a
     * quoted question is not a measurement the page is asserting, so seeding
     * any SEO-tools domain into a pre-flight capture would fail this sweep on
     * the one page that is behaving. The fix belongs here rather than in the
     * bank: the bank is right and the harness was reading it wrong.
     */
    const body = document.body.cloneNode(true)
    for (const el of body.querySelectorAll('.promptlist__text')) el.remove()
    const text = body.innerText ?? body.textContent ?? ''
    const hits = []
    // Percentages and x/100 scores, excluding the fixed 0/100 scale endpoints
    // the rail always prints and the engine/prompt counts in settings.
    for (const m of text.matchAll(/\d+(\.\d+)?\s?%/g)) hits.push(m[0])
    for (const el of document.querySelectorAll('.score__value, .portfolio__grade, .gradebadge, .rail__value')) {
      hits.push(`${el.className.split(' ')[0]}:${el.textContent?.trim().slice(0, 12)}`)
    }
    return [...new Set(hits)].slice(0, 12)
  })

  await context.close()
  return { file, blocked, problems, overflow, typography, figures }
}

const browser = await chromium.launch()
mkdirSync(OUT, { recursive: true })

const typeDomain = async (page) => {
  await page.fill('#domain', 'pipedrive.com')
  await page.click('button[type=submit]')
  await page.waitForSelector('.record__domain, .record, [role=alert]', { timeout: 8000 })
}

/*
 * The refusal state, WITHOUT touching the provider.
 *
 * Reaching it for real needs a server round trip, and live scanning is on with
 * about one scan of quota left — so the request is intercepted in the browser
 * and answered with a synthetic SSE error frame instead. The page cannot tell
 * the difference: it parses the same stream it would have got, and nothing
 * leaves the machine. The message is copied from live-gate's real quota text so
 * what gets photographed is what a visitor would actually read.
 */
const QUOTA_MESSAGE =
  'The provider quota for this cycle is used up: a full scan needs 17 requests per engine and chatgpt has 4 of 50 left. ' +
  'Quota resets 2026-09-21. Nothing was collected and nothing was charged. Domains that have already been scanned are ' +
  'cached and still load instantly.'

const QUOTA_SSE = ['event: error', `data: ${JSON.stringify({ kind: 'quota', message: QUOTA_MESSAGE })}`, '', ''].join('\n')

const typeSigzen = async (page) => {
  await page.fill('#domain', 'sigzen.com')
  await page.click('button[type=submit]')
  await page.waitForSelector('.record__domain, .record, [role=alert]', { timeout: 8000 })
}

const refuse = async (page) => {
  await page.route('**/api/scan', (route) =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: QUOTA_SSE }),
  )
  await page.fill('#domain', 'example.com')
  await page.click('button[type=submit]')
  await page.waitForSelector('[role=alert]', { timeout: 8000 })
}

/*
 * STORAGE KEYS ARE READ OUT OF THE SOURCE, NOT COPIED.
 *
 * This script is plain node against a running server, so it cannot import the
 * app's TypeScript — and the first version simply guessed the three key strings.
 * All three guesses were wrong, which would have seeded nothing, rendered the
 * "no workspace" state on every dashboard capture, and let the R8 sweep pass
 * because there was no data on screen to catch. A green result proving nothing
 * is worse than a red one.
 *
 * So the values are parsed from workspace.ts and the run ABORTS if any is
 * missing. A capture harness that silently tests the wrong state is not a
 * harness.
 */
const WORKSPACE_SRC = readFileSync(new URL('../apps/public/lib/workspace.ts', import.meta.url), 'utf8')

const keyFrom = (name) => {
  // Line-oriented rather than one clever regex: the escaping in a template
  // literal is exactly what broke the first attempt at this, and a parser that
  // fails by returning the wrong answer is worse than no parser.
  const line = WORKSPACE_SRC.split('\n').find((l) => l.includes(name) && l.includes('='))
  const quoted = line && /'([^']+)'|"([^"]+)"/.exec(line)
  const value = quoted && (quoted[1] ?? quoted[2])
  if (!value) throw new Error(`shoot: could not read ${name} from workspace.ts — seeding would silently do nothing`)
  return value
}

const KEY = {
  role: keyFrom('ROLE_STORAGE_KEY'),
  active: keyFrom('ACTIVE_STORAGE_KEY'),
  agency: keyFrom('AGENCY_STORAGE_KEY'),
}
console.log(`seeding keys: ${KEY.role} | ${KEY.active} | ${KEY.agency}
`)

const SHOTS = [
  { name: '1-grader-landing', path: '/' },
  { name: '2-grader-result', path: '/', prepare: typeDomain },
  { name: '3-grader-refusal', path: '/', prepare: refuse },
  { name: '4-pricing', path: '/pricing' },
  // State A: the one domain with real collected data.
  { name: '5-dashboard-real', path: '/dashboard', seed: { [KEY.role]: 'brand', [KEY.active]: 'pipedrive.com' } },
  // State B: pre-flight. Classified, prompts listed, no metrics anywhere.
  { name: '6-dashboard-preflight', path: '/dashboard', seed: { [KEY.role]: 'brand', [KEY.active]: 'zendesk.com' } },
  // A domain that does not classify, so the fallback disclosure has to show.
  { name: '7-dashboard-fallback', path: '/dashboard', seed: { [KEY.role]: 'brand', [KEY.active]: 'nike.com' } },
  { name: '8-agency-portfolio', path: '/agency', seed: { [KEY.role]: 'agency', [KEY.agency]: JSON.stringify(['pipedrive.com', 'zendesk.com']) } },
  { name: '9-agency-add', path: '/agency/add', seed: { [KEY.role]: 'agency', [KEY.agency]: JSON.stringify(['pipedrive.com']) } },
  /*
   * sigzen.com — the third demo domain, and the one that proves the product's
   * argument hardest. It is a real collected scan of a company AI answers never
   * mention: 0.0% with a real interval, ONE brand, no competitors, because it
   * classified into the fallback bank which has no leaders by design.
   *
   * It is also the file that used to crash the result page, so it is captured in
   * both places that render it.
   */
  { name: '10-grader-sigzen', path: '/', prepare: typeSigzen },
  { name: '11-dashboard-sigzen', path: '/dashboard', seed: { [KEY.role]: 'brand', [KEY.active]: 'sigzen.com' } },
  { name: '12-agency-pricing', path: '/agency/pricing' },
  { name: '13-agency-lifecycle', path: '/agency/lifecycle', seed: { [KEY.role]: 'agency' } },
  { name: '14-manage-prompts', path: '/dashboard/prompts', seed: { [KEY.role]: 'brand', [KEY.active]: 'zendesk.com' } },
  { name: '15-agency-client', path: '/agency/client/zendesk.com', seed: { [KEY.role]: 'agency', [KEY.agency]: JSON.stringify(['pipedrive.com', 'zendesk.com']) } },
  { name: '16-workspace-page', path: '/dashboard/workspace', seed: { [KEY.role]: 'brand', [KEY.active]: 'pipedrive.com' } },
]

let failures = 0
for (const shot of SHOTS) {
  for (const viewport of ['desktop', 'mobile']) {
    for (const theme of ['light', 'dark']) {
      const r = await shoot(browser, { ...shot, viewport, theme })
      const flags = []
      if (r.blocked.length) flags.push(`BLOCKED ${r.blocked.length} forbidden request(s)`)
      if (r.problems.length) flags.push(...r.problems)
      if (r.typography.length) flags.push(...r.typography)
      // Named for what they are: these captures must contain no measurement.
      if (/preflight|fallback|agency-add/.test(shot.name) && r.figures.length) {
        flags.push(`R8: a page with no collected data rendered figures: ${r.figures.join(', ')}`)
      }
      if (r.overflow.scrollW > r.overflow.clientW + 1) {
        flags.push(`H-SCROLL ${r.overflow.scrollW}>${r.overflow.clientW}: ${r.overflow.offenders.join(' | ')}`)
      }
      if (flags.length) failures += 1
      console.log(`${flags.length ? 'x' : '.'} ${r.file}${flags.length ? '\n    ' + flags.join('\n    ') : ''}`)
    }
  }
}

await browser.close()
console.log(failures ? `\n${failures} capture(s) reported a problem.` : '\nAll captures clean.')
