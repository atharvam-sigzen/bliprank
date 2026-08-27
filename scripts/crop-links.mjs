/**
 * Targeted crops of the item-4 evidence spots, dark theme, at 3x.
 *
 * The user's review screenshots were three regions, not pages; a full-page
 * capture buries the thing being judged. Each crop is found by the text it
 * contains, padded, and shot against whatever build the server is running —
 * run once before the rebuild and once after, into different directories, and
 * the pair is the before/after.
 *
 * Usage: node scripts/crop-links.mjs <outDir>
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const OUT = process.argv[2]
if (!OUT) throw new Error('usage: node scripts/crop-links.mjs <outDir>')
mkdirSync(OUT, { recursive: true })

const SEED = {
  'bliprank-role': 'brand',
  'bliprank-active-domain': 'pipedrive.com',
  'bliprank-agency-domains': JSON.stringify(['pipedrive.com', 'zendesk.com']),
}

const SPOTS = [
  // The three regions from the user's screenshots, plus the pricing inline link.
  { name: 'worked-example', path: '/dashboard', find: /worked example/i },
  { name: 'workspace-pointer', path: '/dashboard', find: /workspace (page|settings)/i },
  { name: 'add-client', path: '/agency', find: /add a client/i },
  { name: 'backlink', path: '/dashboard/prompts', find: /back to the overview/i },
  { name: 'inline-link', path: '/pricing', find: /agency plans/i },
]

const b = await chromium.launch()
const c = await b.newContext({ viewport: { width: 1000, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 3, reducedMotion: 'reduce' })
await c.addInitScript((e) => { try { for (const [k, v] of e) { localStorage.setItem(k, v); sessionStorage.setItem(k, v); } localStorage.setItem('bliprank-theme', 'dark') } catch {} }, Object.entries(SEED))
await c.route('**/*', (r) => (/openwebninja|\/api\/scan/i.test(r.request().url()) ? r.abort() : r.continue()))
const p = await c.newPage()

for (const spot of SPOTS) {
  await p.goto(`http://localhost:3001${spot.path}`, { waitUntil: 'networkidle' })
  // Client pages mount behind a guard; wait for the CONTENT, not the network.
  await p.waitForFunction((pattern) => new RegExp(pattern.source, pattern.flags).test(document.body.innerText ?? ''), { source: spot.find.source, flags: spot.find.flags }, { timeout: 10000 }).catch(() => {})
  await p.waitForTimeout(300)
  const box = await p.evaluate((pattern) => {
    const re = new RegExp(pattern.source, pattern.flags)
    // The tightest element whose own text matches, then its section-ish ancestor.
    const all = [...document.querySelectorAll('a, p, section, div, dd')]
    const hit = all.reverse().find((el) => re.test(el.textContent ?? '') && (el.textContent ?? '').length < 600)
    if (!hit) return null
    // The clip is viewport-relative, so the target must be IN the viewport
    // before it is measured — the first run died on a below-the-fold section.
    hit.scrollIntoView({ block: 'center' })
    const region = hit.closest('section, .annotated, .preflight, main') ?? hit
    const r = (hit.closest('p, dd, .actionlink, .backlink')?.parentElement ?? region).getBoundingClientRect()
    return { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 12), width: Math.min(960, r.width + 32), height: Math.min(400, r.height + 24) }
  }, { source: spot.find.source, flags: spot.find.flags })
  if (!box) {
    console.log(`x ${spot.name}: text not found on ${spot.path}`)
    continue
  }
  await p.screenshot({ path: join(OUT, `${spot.name}.png`), clip: box })
  console.log(`. ${spot.name}`)
}
await b.close()
