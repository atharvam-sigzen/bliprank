/**
 * THE EVIDENCE ROUTE — what a caller may ask for, and what it may not.
 *
 * This is the only surface in the app that returns file contents in response to
 * a caller-supplied string, so the shape of that string is the whole security
 * question. It is not a file path — it is a domain, used to look up a stored
 * result, whose recorded category yields a bank, whose cells yield cache keys.
 * Nothing from the request reaches a path segment. These tests hold that line at
 * the door anyway, because a defence that depends on a downstream function is a
 * defence somebody can move.
 */

import { describe, expect, it } from 'vitest'
import { GET } from './route'

const ask = (q: string) => GET(new Request(`http://localhost/api/answers${q}`))

describe('what the route refuses', () => {
  it('refuses an empty or absent domain', async () => {
    expect((await ask('')).status).toBe(400)
    expect((await ask('?domain=')).status).toBe(400)
    expect((await ask('?domain=%20%20')).status).toBe(400)
  })

  it('⚠️ refuses anything with a path separator in it', async () => {
    for (const bad of [
      '../../../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      'a/../../secrets',
      String.raw`..\..\windows\win.ini`,
      '/etc/passwd',
    ]) {
      const res = await ask(`?domain=${encodeURIComponent(bad)}`)
      expect([400, 404], bad).toContain(res.status)
      const body = (await res.json()) as { message?: string }
      // Never an echo of the input into a filesystem error.
      expect(body.message ?? '').not.toContain('passwd')
      expect(body.message ?? '').not.toContain('win.ini')
    }
  })

  it('refuses a string that is not host-shaped', async () => {
    for (const bad of ['localhost', 'acme', 'a.b', 'report.pdf.', '..a', 'a..b']) {
      const res = await ask(`?domain=${encodeURIComponent(bad)}`)
      expect([400, 404], bad).toContain(res.status)
    }
  })

  it('a domain this machine has no result for is an absence, not a fault', async () => {
    // 404 rather than 500: the client renders "not available in this build"
    // differently from "the store broke", and only one of those is true here.
    const res = await ask('?domain=nobody-has-ever-scanned-this.example')
    expect(res.status).toBe(404)
  })

  it('never sets a cache header that would let evidence be served stale', async () => {
    const res = await ask('?domain=nobody-has-ever-scanned-this.example')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('what it returns', () => {
  it('serves the committed reference scan’s answers, whole and aligned', async () => {
    // Only meaningful on a machine that holds live results; a clean checkout has no
    // results directory and correctly answers 404, which the refusal tests above
    // already cover.
    const res = await ask('?domain=pipedrive.com')
    if (res.status === 404) return
    expect(res.status).toBe(200)
    const body = (await res.json()) as { domain: string; comparisonBasis: string; answers: { text: string; empty: boolean }[] }
    expect(body.domain).toBe('pipedrive.com')
    expect(body.comparisonBasis).toContain('unprompted=17')
    expect(body.answers.length).toBe(85)
    // The two absent Google overviews, carried rather than dropped.
    expect(body.answers.filter((a) => a.empty)).toHaveLength(2)
  })

  it('normalises the domain the same way every other route does', async () => {
    const plain = await ask('?domain=pipedrive.com')
    if (plain.status === 404) return
    for (const form of ['https://pipedrive.com/', 'WWW.Pipedrive.com', 'pipedrive.com:443']) {
      const res = await ask(`?domain=${encodeURIComponent(form)}`)
      expect(res.status, form).toBe(200)
    }
  })
})
