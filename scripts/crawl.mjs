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
  // Item 6a: Workspace stopped being a scroll-anchor and became a page; the
  // gate now fails if the nav's Workspace link ever stops resolving to it.
  `${PUB}/dashboard/workspace`,
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

/**
 * What the preview endpoint answers during a crawl.
 *
 * Shaped like a real authored category — the case with no competitors, which is
 * the branch the preview screen has the most to say about. Fixed, so the gate's
 * result does not depend on what a live site happens to say today.
 */
const CANNED_PREVIEW = {
  domain: 'acme-example.test',
  category: 'gaming-peripherals',
  categoryName: 'Gaming peripherals',
  categoryDescription: 'Keyboards, mice and headsets built for gaming.',
  source: 'generated',
  evidence: 'authored from the acme-example.test homepage',
  previouslyDecided: false,
  verified: false,
  generated: true,
  decidedAt: '2026-09-01T00:00:00.000Z',
  prompts: Array.from({ length: 17 }, (_, i) => ({ text: `Best gaming keyboard for a small desk, option ${i + 1}`, intent: i < 10 ? 'discovery' : 'problem-led' })),
  engines: ['chatgpt', 'gemini', 'copilot', 'google-ai-mode', 'google-ai-overviews'],
  competitors: [],
}

/**
 * Submit a domain on the Grader and harvest what the resulting screen offers.
 *
 * ⚠️ THE WAIT IS ON THE CONDITION, NOT ON A SELECTOR APPEARING.
 *
 * This used to be `waitForSelector('.record__domain, [role=alert]')` followed
 * immediately by reading the DOM, and it resolved while NEITHER was present —
 * so every run harvested the still-submitting form instead of the screen after
 * it. /dashboard, /dashboard/prompts and /dashboard/workspace were reported
 * UNREACHABLE BY CLICK on every persona, for months, and they are all reachable:
 * one extra second and the "Open in dashboard" button is there. A gate that
 * reports phantom failures gets its failures ignored, which is worse than not
 * having the gate.
 */
/**
 * Submit a domain on the Grader and harvest every screen the flow reaches.
 *
 * ⚠️ THE FLOW IS TWO STEPS NOW, AND THIS GATE WENT RED WHEN IT BECAME TWO.
 *
 * `2179a54` made EVERY domain preview first, including the ones this build ships
 * a record for. Before it, a bundled domain went straight from the form to its
 * result; this function submitted, harvested, and found "Open in dashboard"
 * there. After it, submitting lands on the PREVIEW — which offers "Run this
 * scan", not "Open in dashboard" — so the harvest stopped one screen short and
 * /dashboard, /dashboard/prompts and /dashboard/workspace were reported
 * unreachable by every persona. Nothing was wrong with the product: the crawl
 * was one product change behind, which is the second time this gate has cried
 * wolf and the second reason to distrust a gate that reports phantom failures.
 *
 * So: harvest the preview, then CONFIRM, then harvest the result. Both are real
 * screens a person sees and both carry links, so both are audited rather than
 * the second one being treated as the only one that counts.
 *
 * ⚠️ CONFIRMING STILL SPENDS NOTHING. `startScan` serves a committed record from
 * the build for a bundled domain and never calls /api/scan; for anything else
 * /api/scan is aborted at the browser level a few lines above. The confirm click
 * is safe for both, and for the unbundled case it simply lands on the refusal,
 * which is itself a state worth knowing renders.
 */
async function harvestGraderState(page, domain, label, from, reached, queue, edges) {
  const take = async (stage) => {
    for (const h of await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href))) {
      const k = normalise(h)
      if (k) {
        edges.push({ from: `${from} (${label} · ${stage})`, to: k })
        if (!reached.has(k)) queue.push(k)
      }
    }
    // Buttons that navigate (the handoff) count as clickable too.
    const buttons = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? ''))
    if (buttons.some((b) => /open in dashboard/i.test(b))) {
      edges.push({ from: `${from} (${label} · ${stage})`, to: `${PUB}/dashboard` })
      if (!reached.has(`${PUB}/dashboard`)) queue.push(`${PUB}/dashboard`)
    }
    return buttons
  }

  /*
   * Settled means the form is GONE and something that replaces it is on screen.
   *
   * Waiting on a selector appearing was the original bug here: it resolved while
   * neither the record nor an alert was present, so every run harvested the
   * still-submitting form. The condition is the thing to wait for, not a symptom
   * of it.
   */
  const settle = () =>
    page
      .waitForFunction(
        () => {
          const submitting = document.querySelectorAll('button[type=submit]').length > 0
          const arrived =
            document.querySelector('.record__domain') !== null ||
            document.querySelector('[role=alert]') !== null ||
            [...document.querySelectorAll('button')].some((b) =>
              /run this scan|open in dashboard|check a(nother)? different|check another/i.test(b.textContent ?? ''),
            )
          return !submitting && arrived
        },
        { timeout: 15000 },
      )
      .catch(() => {})

  await page.goto(`${PUB}/`, { waitUntil: 'networkidle' }).catch(() => {})
  const input = await page.$('#domain')
  if (!input) return
  await input.fill(domain)
  await page.click('button[type=submit]').catch(() => {})
  await settle()

  const onPreview = await take('preview')

  // STEP TWO. Only when the preview actually offered it — a domain that was
  // refused outright never reaches this, and clicking a button that is not there
  // would fail silently and look like the flow was followed.
  if (!onPreview.some((b) => /run this scan/i.test(b))) return

  await page.click('button:has-text("Run this scan")').catch(() => {})
  // The result is `.record__domain`; a refusal is `[role=alert]`. Either ends
  // the flow, and both are screens worth having crawled.
  await page
    .waitForFunction(
      () =>
        document.querySelector('.record__domain') !== null ||
        document.querySelector('[role=alert]') !== null ||
        [...document.querySelectorAll('button')].some((b) => /open in dashboard|check another/i.test(b.textContent ?? '')),
      { timeout: 20000 },
    )
    .catch(() => {})

  await take('result')
}


async function crawlPersona(browser, name, seed) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript((entries) => {
    try {
      for (const [k, v] of entries) {
        window.localStorage.setItem(k, v)
        window.sessionStorage?.setItem(k, v)
      }
    } catch {}
  }, Object.entries(seed))
  /*
   * NOTHING MAY SPEND, AND THE PREVIEW MUST STILL RENDER.
   *
   * /api/scan and the provider are aborted outright — the one scan this crawl
   * performs is pipedrive.com, answered from the committed result client-side
   * before any fetch reaches here.
   *
   * /api/preview is FULFILLED with a canned body rather than aborted. It spends
   * no provider quota, but it does make an outbound request to whatever domain
   * is typed and may make a model call, and a crawl is not the place for either.
   * Aborting it instead would leave the preview screen — a real state with real
   * links, and the only route to a scan for any domain this build does not
   * already hold — permanently unreachable by this gate.
   */
  await context.route('**/*', (r) => {
    const url = r.request().url()
    if (/openwebninja|\/api\/scan/i.test(url)) return r.abort()
    if (/\/api\/preview/i.test(url)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CANNED_PREVIEW) })
    return r.continue()
  })

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

    // The Grader's states after a submit — the preview, then the result — exist
    // only after interaction, and both carry links a person can click. Run the
    // flow once, on the page where it lives.
    if (key === `${PUB}/`) {
      // A domain this build ALREADY HOLDS goes straight to the record; a domain
      // it does not goes through the preview first. Both paths are crawled,
      // because they are two different screens with two different ways onward.
      await harvestGraderState(page, 'pipedrive.com', 'result state', key, reached, queue, edges)
      await harvestGraderState(page, 'acme-example.test', 'preview state', key, reached, queue, edges)
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
