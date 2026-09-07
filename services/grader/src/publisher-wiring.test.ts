/**
 * ⚠️ det-3's ENTIRE CONTENT, ASSERTED WHERE IT LIVES.
 *
 * det-3 changes no rule inside the scorer. `classifyCitation` behaves exactly as
 * it did under det-2 — the source-class pin keys both versions to the same case
 * table to say so. What det-3 changes is WHO SUPPLIES THE REGISTRY: det-2 scored
 * every stored answer with the publisher map empty, and det-3 passes ADR-0015's
 * approved 52 entries from the grader's two production call sites.
 *
 * So the bump's whole content is a wiring fact, and this file is the wiring
 * fact's test. It lives in `services/grader` because that is where the wiring
 * is and because checking it needs `@bliprank/taxonomy`, which `services/scorer`
 * deliberately does not depend on.
 *
 * ⚠️ THE FAILURE THIS EXISTS TO CATCH is not "the registry is missing". It is
 * "the registry is in ONE of the two call sites". `scan.ts` writes the stored
 * numbers; `answers.ts` re-scores those same answers for the evidence view and
 * for `grader:version-diff`. Wire one and not the other and the diff measures a
 * classifier the scan does not use — so every future bump's flip list would be
 * wrong, and nothing would say so.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PUBLISHER_REGISTRY } from '@bliprank/taxonomy'
import { scoreAnswer } from '@bliprank/scorer'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('the publisher registry is wired, and wired everywhere', () => {
  it('⚠️ the wiring guard, statically: EVERY production scoreAnswer call passes the registry', () => {
    /*
     * INVERTED AT det-3. Under det-2 this asserted no production module read
     * `PUBLISHER_REGISTRY` at all. It now asserts the opposite and, more
     * usefully, the thing that can actually go wrong from here: there are two
     * production call sites and they must never disagree.
     *
     * `scan.ts` writes the stored numbers; `answers.ts` re-scores those same
     * answers for the evidence view AND for `grader:version-diff`. Wire one and
     * not the other and the diff measures a classifier the scan does not use —
     * a drift that would make every future bump's flip list wrong, silently.
     *
     * `golden.ts` is deliberately NOT in this list: a golden case declares its
     * own registry so the case is self-contained ground truth. See the note in
     * the changelog about what that leaves unexercised.
     */
    const root = join(__dirname, '..', '..', '..')
    const producers = ['services/grader/src/scan.ts', 'services/grader/src/answers.ts']
    const missing = producers.filter((p) => {
      const src = readFileSync(join(root, p), 'utf8')
      return !(src.includes('PUBLISHER_REGISTRY') && /publishers:\s*PUBLISHER_REGISTRY/.test(src))
    })
    expect(missing).toEqual([])

    // And no OTHER production module reads it: a third reader is a third
    // opinion about which sites are publishers.
    const allowed = new Set([...producers, 'packages/taxonomy/src/publishers.ts', 'services/grader/src/publishers.ts'])
    const readers: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next' || name === 'dist' || name.startsWith('.')) continue
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && readFileSync(p, 'utf8').includes('PUBLISHER_REGISTRY')) readers.push(p.slice(root.length + 1).replace(/\\/g, '/'))
      }
    }
    for (const top of ['apps', 'packages', 'services']) walk(join(root, top))
    expect(readers.filter((r) => !allowed.has(r))).toEqual([])
  })

  it('⚠️ scored the way the grader scores, a registry publisher is now earned_media', () => {
    // The bump's entire customer-visible content, in one assertion: the same
    // call that returned `other` under det-2 returns `earned_media` under det-3
    // because the grader supplies the approved list.
    const row = scoreAnswer({
      answer: { text: 'Pipedrive is a CRM.', citations: [{ url: 'https://www.techradar.com/reviews/pipedrive-crm-review', position: 0 }] },
      brand: { id: 'pipedrive', name: 'Pipedrive', aliases: ['Pipedrive'], domains: ['pipedrive.com'] },
      competitors: [],
      publishers: PUBLISHER_REGISTRY,
    })
    expect(row.citations.map((c) => c.sourceClass)).toEqual(['earned_media'])
    expect(row.citations[0]!.detail).toEqual({ publisher: 'TechRadar' })
  })

  it('a recorded refusal stays other, however often the corpus cites it', () => {
    // ADR-0015's four criteria are a boundary, not a wish. PCMag fails
    // criterion 2 (Ziff Davis also owns Moz) and TechnologyAdvice fails
    // criterion 3 (it operates TechRepublic as a directory). Both are cited by
    // the stored corpus and both must stay `other`.
    for (const url of ['https://uk.pcmag.com/crm-software/67398/the-best-crm-software', 'https://technologyadvice.com/blog/crm/easiest-crm-to-use/']) {
      const row = scoreAnswer({
        answer: { text: 'A CRM.', citations: [{ url, position: 0 }] },
        brand: { id: 'x', name: 'X', aliases: ['X'], domains: ['x.com'] },
        competitors: [],
        publishers: PUBLISHER_REGISTRY,
      })
      expect(row.citations[0]!.sourceClass, url).toBe('other')
    }
  })
})
