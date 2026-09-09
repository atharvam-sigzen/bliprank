import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NAMED_ENGINES, engineName, namedCell } from './engines'
import { SCAN, runInfoOf } from './scan-result'

describe('engineName', () => {
  it('names every engine the product collects from', () => {
    expect(engineName('chatgpt')).toBe('ChatGPT')
    expect(engineName('gemini')).toBe('Gemini')
    expect(engineName('copilot')).toBe('Copilot')
    expect(engineName('google-ai-mode')).toBe('Google AI Mode')
    expect(engineName('google-ai-overviews')).toBe('Google AI Overviews')
  })

  it('THE MAP COVERS THE SHIPPED SCAN, so the gap is caught before a reader sees it', () => {
    /*
     * The point of the map is that a slug never reaches a heading. The way that
     * silently stops being true is a sixth engine arriving with no entry, so the
     * check is against the engines a real collected scan CARRIES rather than
     * against the map's own keys — which would be circular.
     */
    const engines = runInfoOf(SCAN).engines
    expect(engines.length).toBeGreaterThan(1)
    for (const e of engines) {
      expect([e, engineName(e)]).not.toEqual([e, e])
      expect([e, NAMED_ENGINES.includes(e)]).toEqual([e, true])
    }
  })

  it('and the check bites: an unnamed id resolves to itself', () => {
    // Not vacuous — the assertion above is only meaningful because this is how
    // an unmapped engine behaves.
    expect(engineName('perplexity')).toBe('perplexity')
  })

  it('AN UNKNOWN ID SURFACES RATHER THAN HIDING', () => {
    /*
     * The fallback is the id itself, on purpose. Throwing would break a page
     * over a label; returning something generic ("Other engine") or dropping the
     * row would silently misreport which surface a measurement came from, which
     * is the one thing a per-engine view must never do. A visibly unnamed slug
     * beside four proper names is a prompt to add it.
     */
    for (const junk of ['', 'made-up', 'CHATGPT', 'chat gpt']) {
      expect([junk, engineName(junk)]).toEqual([junk, junk])
    }
  })
})

describe('namedCell', () => {
  it('replaces the engine id at the head of a progress line', () => {
    expect(namedCell('google-ai-overviews Best CRM for a small team')).toBe('Google AI Overviews Best CRM for a small team')
    expect(namedCell('chatgpt Which CRM is easiest?')).toBe('ChatGPT Which CRM is easiest?')
  })

  it('leaves a line whose head is not an engine exactly as it was', () => {
    // The failure mode worth having: if the runner's format ever changes, the
    // line degrades to today's behaviour instead of being mangled.
    expect(namedCell('preparing the cells')).toBe('preparing the cells')
    expect(namedCell('')).toBe('')
  })

  it('handles a bare engine id with no prompt after it', () => {
    expect(namedCell('gemini')).toBe('Gemini')
  })

  it('only ever touches the FIRST token', () => {
    // An engine id is a slug and never contains a space, so this is exact
    // rather than heuristic — and a prompt mentioning an engine is untouched.
    expect(namedCell('chatgpt is chatgpt better than gemini?')).toBe('ChatGPT is chatgpt better than gemini?')
  })
})

describe('no surface renders a raw engine id', () => {
  /*
   * The map is only worth having if every site uses it. This is the sweep that
   * keeps a new render site from reintroducing the slug — the defect was five
   * separate places, and a sixth would be just as invisible.
   */
  const sources = () => {
    const out: { path: string; src: string }[] = []
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue
        const child = new URL(`${entry}${entry.includes('.') ? '' : '/'}`, dir)
        if (statSync(child).isDirectory()) walk(new URL(`${entry}/`, dir))
        else if (entry.endsWith('.tsx') && !entry.includes('.test.')) out.push({ path: `${dir.pathname}${entry}`, src: readFileSync(child, 'utf8') })
      }
    }
    walk(new URL('../', import.meta.url))
    return out
  }

  /*
   * MATCHED ON THE RENDER SHAPES, not on the word.
   *
   * The first version flagged any line with `engine` inside braces and caught
   * two things that are not engine ids at all: a COUNT ("across {engines}
   * engines") and a type annotation. A guard that fires on correct code is a
   * guard someone deletes, so it matches the two forms an id is actually
   * printed in — `{cell.engine}` as JSX content and `${cell.engine}` inside a
   * template literal — and nothing else.
   */
  const PRINTED = [/\{\s*(?:[a-z]\w*\.)?engine\s*\}/, /\$\{\s*(?:[a-z]\w*\.)?engine\s*\}/]

  it('every JSX expression printing an engine goes through engineName', () => {
    const offenders: string[] = []
    for (const { path, src } of sources()) {
      for (const line of src.split('\n')) {
        if (!PRINTED.some((re) => re.test(line))) continue
        if (/engineName\(|namedCell\(|key=/.test(line)) continue
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue
        offenders.push(`${path}: ${line.trim().slice(0, 90)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the sweep is not vacuous: it finds the wrapped sites it is meant to allow', () => {
    // If the regexes stopped matching anything, the rule above would pass while
    // checking nothing — the failure mode that reports safety.
    // Counted as CALL SITES, not files: they are concentrated in
    // prompt-breakdown (header, evidence chip, aria label, engine strip), and a
    // per-file threshold would have been satisfied by one of them.
    const wrapped = sources().flatMap(({ src }) => [...src.matchAll(/engineName\(\s*(?:[a-z]\w*\.)?engine\s*\)/g)])
    expect(wrapped.length).toBeGreaterThanOrEqual(3)
  })
})
