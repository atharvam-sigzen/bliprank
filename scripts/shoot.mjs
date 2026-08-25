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

import { mkdirSync } from 'node:fs'
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

async function shoot(browser, { name, path, viewport, theme, prepare }) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    colorScheme: theme,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce', // deterministic captures; motion is asserted by tests
  })

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
    for (const el of document.querySelectorAll('.panel__title')) {
      const c = getComputedStyle(el)
      const px = Number.parseFloat(c.fontSize)
      if (px < 15 || c.textTransform === 'uppercase') {
        out.push(`.panel__title renders ${c.fontSize}/${c.textTransform} — losing the cascade to a label rule`)
      }
    }
    for (const el of document.querySelectorAll('.prose')) {
      const c = getComputedStyle(el)
      if (!/Newsreader|serif/i.test(c.fontFamily)) out.push(`.prose is not the serif voice: ${c.fontFamily.slice(0, 40)}`)
    }
    return [...new Set(out)]
  })

  await context.close()
  return { file, blocked, problems, overflow, typography }
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

const refuse = async (page) => {
  await page.route('**/api/scan', (route) =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: QUOTA_SSE }),
  )
  await page.fill('#domain', 'example.com')
  await page.click('button[type=submit]')
  await page.waitForSelector('[role=alert]', { timeout: 8000 })
}

const SHOTS = [
  { name: '1-grader-landing', path: '/' },
  { name: '2-grader-result', path: '/', prepare: typeDomain },
  { name: '3-grader-refusal', path: '/', prepare: refuse },
  { name: '4-pricing', path: '/pricing' },
  { name: '5-agency-concept', path: '/agency' },
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
