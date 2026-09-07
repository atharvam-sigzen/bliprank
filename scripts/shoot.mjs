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
 * ⚠️ RUN THE SERVER WITH A SHORT PREVIEW WINDOW, or this gate fails itself.
 *
 *   next start -p 3001                          # normal
 *   GRADER_VISITOR_WINDOW_MS=1000 next start …  # for THIS harness
 *
 * /api/preview throttles a visitor over a ONE-HOUR window, ledgered to disk at
 * services/grader/data-live/preview-throttle.json. This harness loads the
 * Grader twelve times in a couple of minutes from one address, so from the
 * second run onwards it trips its own throttle and reports 429s on every grader
 * capture. Those are the limiter working, and unlike the 404s below they are
 * NOT given an allowance: a 429 in ordinary use is a real problem and must stay
 * loud. The window is shortened for the harness instead.
 *
 * Usage: GRADER_VISITOR_WINDOW_MS=1000 node scripts/shoot.mjs [outDir]
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
  /*
   * THE 404s ARE COLLECTED BY URL, NOT BY THEIR CONSOLE LINE.
   *
   * The browser logs a failed request as "Failed to load resource: the server
   * responded with a status of 404 (Not Found)" and NAMES NOTHING. An allowance
   * matched against that string would suppress every 404 on the page, including
   * the next real one. So the responses are recorded here and the allowance is
   * matched against the URL; the console line is only ever silenced once every
   * 404 on that capture is accounted for.
   */
  const notFound = []
  page.on('response', (r) => {
    if (r.status() === 404) notFound.push(r.url())
  })
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
    for (const m of text.matchAll(/\b\d+(\.\d+)?\s?%/g)) hits.push(m[0])
    for (const el of document.querySelectorAll('.score__value, .portfolio__grade, .gradebadge, .rail__value')) {
      hits.push(`${el.className.split(' ')[0]}:${el.textContent?.trim().slice(0, 12)}`)
    }
    return [...new Set(hits)].slice(0, 12)
  })

  const refused = (await page.$('section.record--refused')) !== null

  await context.close()
  return { file, blocked, problems, notFound, overflow, typography, figures, refused }
}

const browser = await chromium.launch()
mkdirSync(OUT, { recursive: true })

/*
 * THE WAIT IS ON THE SETTLED STATE, NOT ON THE FIRST THING THAT APPEARS.
 *
 * This used to wait for `.record__domain`. The pre-scan preview wears that
 * class too (prompt-preview.tsx), so the wait resolved on the preview, the
 * capture showed "Working out your category...", and a masthead regression
 * that only shows once a result is on the page sat in the committed shots
 * unphotographed for a whole commit. And `[role=alert]` was worse: the domain
 * field's error slot carries that role whether or not it has an error in it,
 * so the old wait resolved on the still-submitting form every time.
 *
 * A scan settles in exactly three states and this waits for those: a result
 * (a rail, which only a real metric draws), a refusal (the refused record), or
 * the preview's confirm button — which is then pressed, and the wait repeats
 * for the first two.
 */
const SETTLED = 'section.record .rail, section.record--refused'
const scanFlow = (domain) => async (page) => {
  await page.fill('#domain', domain)
  await page.click('button[type=submit]')
  await page.waitForSelector(`${SETTLED}, .record__action.btn--primary`, { timeout: 15000 })
  if (!(await page.$(SETTLED))) {
    await page.click('.record__action.btn--primary')
    await page.waitForSelector(SETTLED, { timeout: 15000 })
  }
}

const typeDomain = scanFlow('pipedrive.com')

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

const typeSigzen = scanFlow('sigzen.com')

const refuse = async (page) => {
  await page.route('**/api/scan', (route) =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: QUOTA_SSE }),
  )
  await scanFlow('example.com')(page)
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
   * sigzen.com — a real collected scan that is NOT bundled with the build (the
   * shipped registry holds pipedrive.com alone), so on the Grader it goes through
   * the preview to "Run this scan", which calls /api/scan, which this harness
   * aborts by design. What gets photographed is therefore the runner-unreachable
   * refusal: a state a visitor really sees when the scan service is down, and
   * the one screen that must show NO number. The block is the point of the
   * capture, so it is expected here and a problem everywhere else.
   *
   * Before 2026-09-02 the wait resolved on the preview and this shot never got
   * this far; the comment above it still described a bundled scan.
   */
  { name: '10-grader-sigzen', path: '/', prepare: typeSigzen, expectsRefusal: true },
  { name: '11-dashboard-sigzen', path: '/dashboard', seed: { [KEY.role]: 'brand', [KEY.active]: 'sigzen.com' } },
  { name: '12-agency-pricing', path: '/agency/pricing' },
  { name: '13-agency-lifecycle', path: '/agency/lifecycle', seed: { [KEY.role]: 'agency' } },
  /*
   * zendesk.com is classified but has never been SCANNED on this machine, so
   * /api/custom-prompts answers 404 'no-record' — the route stating that there
   * is no cycle for a custom prompt to join yet. The page renders that state
   * correctly; only the browser's anonymous console line made it look like a
   * fault. See the expects404 note in the flag loop.
   */
  { name: '14-manage-prompts', path: '/dashboard/prompts', seed: { [KEY.role]: 'brand', [KEY.active]: 'zendesk.com' }, expects404: [/\/api\/custom-prompts\b/] },
  /*
   * The client page asks /api/category and /api/competitors, NOT
   * /api/custom-prompts — the first version of this allowance guessed the same
   * route as shot 14 and the stale-allowance guard caught it on the first run,
   * which is the guard doing exactly its job. All three answer the same
   * deliberate 404: `no-record`, because zendesk.com is classified but has
   * never been scanned on this machine.
   */
  { name: '15-agency-client', path: '/agency/client/zendesk.com', seed: { [KEY.role]: 'agency', [KEY.agency]: JSON.stringify(['pipedrive.com', 'zendesk.com']) }, expects404: [/\/api\/(category|competitors)\b/] },
  { name: '16-workspace-page', path: '/dashboard/workspace', seed: { [KEY.role]: 'brand', [KEY.active]: 'pipedrive.com' } },
]

let failures = 0
for (const shot of SHOTS) {
  for (const viewport of ['desktop', 'mobile']) {
    for (const theme of ['light', 'dark']) {
      const r = await shoot(browser, { ...shot, viewport, theme })
      const flags = []
      // A shot that must end in the runner refusal: the guard aborting /api/scan
      // IS the state under capture, and the browser logs that abort as a failed
      // resource. Anything else blocked, or any other error, is still a problem —
      // and so is that shot NOT ending in the refusal.
      const blocked = shot.expectsRefusal ? r.blocked.filter((u) => !/\/api\/scan/i.test(u)) : r.blocked
      let problems = shot.expectsRefusal ? r.problems.filter((p) => !/net::ERR_FAILED/.test(p)) : r.problems

      /*
       * EXPECTED 404s, THE SAME BARGAIN AS `expectsRefusal`.
       *
       * A gate that reports a designed condition as a failure gets ignored, and
       * an ignored gate is worse than none: this one flagged eight captures on
       * every run because /api/custom-prompts answers 404 'no-record' for a demo
       * domain that was never scanned on this machine. That is the route working.
       *
       * Two guards keep the allowance from becoming a blanket:
       *   1. it matches the URL, so an unlisted 404 is still a failure and still
       *      names itself;
       *   2. a shot that declares the allowance and produces NO matching 404 is
       *      flagged too. A stale allowance silently covering a route that has
       *      stopped 404ing is how a suppression outlives its reason.
       */
      const allowed = shot.expects404 ?? []
      const unexpected404 = r.notFound.filter((u) => !allowed.some((re) => re.test(u)))
      const matched404 = r.notFound.filter((u) => allowed.some((re) => re.test(u)))
      if (allowed.length && matched404.length === 0) {
        flags.push('expects404 is declared and nothing 404ed: the allowance is stale')
      }
      if (unexpected404.length) flags.push(...[...new Set(unexpected404)].map((u) => `404 ${u}`))
      // Only now is the anonymous console line safe to drop, and only for the
      // 404s actually accounted for.
      if (allowed.length && unexpected404.length === 0) {
        problems = problems.filter((p) => !/status of 404/.test(p))
      }
      if (blocked.length) flags.push(`BLOCKED ${blocked.length} forbidden request(s)`)
      if (problems.length) flags.push(...problems)
      if (shot.expectsRefusal && !r.refused) flags.push('expected the runner refusal and the page did not show one')
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
