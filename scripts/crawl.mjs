/**
 * Click-reachability audit: can a person CLICK their way to every page?
 *
 * Anything reachable only by typing a URL is a navigation bug. This crawls the
 * way a person browses — following anchors, opening the workspace switcher to
 * harvest the links inside it, and running the scan flow to reach the states
 * that only exist after a result — and then diffs what was REACHED against what
 * is SERVED.
 *
 * State-aware, because the nav is: the same chrome shows different links for a
 * brand, an agency and a first-time visitor, so each persona crawls separately
 * from its own seeded storage.
 *
 * ⚠️ CANNOT SPEND: every request to the provider or /api/scan is aborted at the
 * browser level. The one scan it performs is pipedrive.com, answered from the
 * committed result client-side before any fetch.
 *
 * Usage: node scripts/crawl.mjs
 */

import { chromium } from 'playwright'

const PUB = 'http://localhost:3001'
const WEB = 'http://localhost:3000'

/** Every route both servers actually serve. The target set. */
const SERVED = [
  `${PUB}/`,
  `${PUB}/dashboard`,
  // Manage Prompts and the per-client record: reachable only through clicks
  // (dashboard facts link; a portfolio row anchor), which is exactly what this
  // gate exists to force. The client instance is the seeded agency persona's
  // zendesk.com, since a dynamic route is only clickable as a concrete URL.
  `${PUB}/dashboard/prompts`,
  `${PUB}/agency`,
  `${PUB}/agency/add`,
  `${PUB}/agency/client/zendesk.com`,
  `${PUB}/agency/client/zendesk.com/prompts`,
  `${PUB}/agency/pricing`,
  `${PUB}/agency/lifecycle`,
  `${PUB}/pricing`,
  `${WEB}/`,
]

const PERSONAS = {
  'fresh-visitor': {},
  'brand': { 'bliprank-role': 'brand', 'bliprank-active-domain': 'pipedrive.com' },
  'agency': { 'bliprank-role': 'agency', 'bliprank-agency-domains': JSON.stringify(['pipedrive.com', 'zendesk.com']) },
}

const normalise = (u) => {
  try {
    const url = new URL(u)
    if (!/localhost:300[01]/.test(url.host)) return null
    url.hash = ''
    url.search = ''
    let p = url.pathname.replace(/\/$/, '')
    return `${url.protocol}//${url.host}${p || '/'}`
  } catch {
    return null
  }
}

async function crawlPersona(browser, name, seed) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript((entries) => {
    try {
      for (const [k, v] of entries) window.localStorage.setItem(k, v)
    } catch {}
  }, Object.entries(seed))
  await context.route('**/*', (r) => (/openwebninja|\/api\/scan/i.test(r.request().url()) ? r.abort() : r.continue()))

  const page = await context.newPage()
  const reached = new Set()
  const edges = []
  const queue = [`${PUB}/`]

  while (queue.length) {
    const url = queue.shift()
    const key = normalise(url)
    if (!key || reached.has(key)) continue
    reached.add(key)

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
    } catch {
      edges.push({ from: '(goto failed)', to: key })
      continue
    }
    await page.waitForTimeout(300)

    // Open the workspace switcher if present, so its links are harvested too —
    // a person can click those, so the crawl must.
    const switcher = await page.$('.navbar__wsbtn')
    if (switcher) await switcher.click().catch(() => {})
    await page.waitForTimeout(150)

    const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href))
    for (const h of hrefs) {
      const k = normalise(h)
      if (k) {
        edges.push({ from: key, to: k })
        if (!reached.has(k)) queue.push(k)
      }
    }

    // The Grader's result state exists only after a scan; its links (Open in
    // dashboard) are part of what a person can click. Run it once, on the page
    // where it lives.
    if (key === `${PUB}/`) {
      const input = await page.$('#domain')
      if (input) {
        await input.fill('pipedrive.com')
        await page.click('button[type=submit]').catch(() => {})
        await page.waitForSelector('.record__domain, [role=alert]', { timeout: 8000 }).catch(() => {})
        const resultHrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href))
        for (const h of resultHrefs) {
          const k = normalise(h)
          if (k) {
            edges.push({ from: `${key} (result state)`, to: k })
            if (!reached.has(k)) queue.push(k)
          }
        }
        // Buttons that navigate (the handoff) count as clickable too.
        const buttons = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? ''))
        if (buttons.some((b) => /open in dashboard/i.test(b))) {
          edges.push({ from: `${key} (result state)`, to: `${PUB}/dashboard` })
          if (!reached.has(`${PUB}/dashboard`)) queue.push(`${PUB}/dashboard`)
        }
      }
    }
  }

  await context.close()
  return { reached, edges }
}

const browser = await chromium.launch()
const results = {}
for (const [name, seed] of Object.entries(PERSONAS)) {
  results[name] = await crawlPersona(browser, name, seed)
  const missing = SERVED.filter((s) => !results[name].reached.has(normalise(s)))
  console.log(`\n=== ${name} ===`)
  console.log(`reached ${results[name].reached.size} pages: ${[...results[name].reached].map((r) => r.replace('http://localhost', '')).join('  ')}`)
  console.log(missing.length ? `UNREACHABLE BY CLICK: ${missing.map((m) => m.replace('http://localhost', '')).join('  ')}` : 'all served routes reachable')
}
await browser.close()

// The union: a route no persona can reach is dead to every visitor.
const union = new Set()
for (const r of Object.values(results)) for (const k of r.reached) union.add(k)
const dead = SERVED.filter((s) => !union.has(normalise(s)))
console.log(`\n=== UNION ===`)
console.log(dead.length ? `ROUTES NO PERSONA CAN CLICK TO: ${dead.map((m) => m.replace('http://localhost', '')).join('  ')}` : 'every served route is clickable by at least one persona')

// A gate, not a report: an unreachable route must fail the run, so this can sit
// in front of a deploy and refuse it the way the test suite does.
process.exit(dead.length ? 1 : 0)
