import { describe, expect, it } from 'vitest'
import { blockedReason, fetchSiteHtml, parseIpv4, parseTarget, resolvePublicAddress } from './fetch-site.js'

/**
 * These are the tests for a security boundary, so they are written as a list of
 * things that must NOT be reachable rather than as a list of features. A
 * regression here is not a broken page — it is a stranger issuing requests from
 * inside our network and reading the replies.
 */

const publicDns = async () => ['93.184.216.34']
const html = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } })

describe('address parsing refuses what two parsers would disagree about', () => {
  it('reads a normal dotted quad', () => {
    expect(parseIpv4('127.0.0.1')).toBe(0x7f000001)
    expect(parseIpv4('10.0.0.1')).toBe(0x0a000001)
  })

  it('refuses leading zeros, because they are octal to some resolvers and decimal to others', () => {
    // 0177.0.0.1 is 127.0.0.1 in inet_aton and 177.0.0.1 to a naive parser. A
    // value the checker and the connector disagree about is the whole bug.
    expect(parseIpv4('0177.0.0.1')).toBeNull()
    expect(parseIpv4('010.0.0.1')).toBeNull()
  })

  it('refuses short forms and out-of-range octets', () => {
    expect(parseIpv4('127.1')).toBeNull()
    expect(parseIpv4('256.0.0.1')).toBeNull()
    expect(parseIpv4('1.2.3.4.5')).toBeNull()
  })
})

describe('every range an internal service plausibly sits on is refused', () => {
  const mustBlock = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'the cloud metadata endpoint'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'benchmarking'],
  ] as const
  for (const [address, why] of mustBlock) {
    it(`refuses ${address} (${why})`, () => {
      expect(blockedReason(address)).not.toBeNull()
    })
  }

  it('permits an ordinary public address', () => {
    expect(blockedReason('93.184.216.34')).toBeNull()
    expect(blockedReason('8.8.8.8')).toBeNull()
    // 172.32 is OUTSIDE 172.16.0.0/12 — an off-by-one here blocks real hosts.
    expect(blockedReason('172.32.0.1')).toBeNull()
    expect(blockedReason('11.0.0.1')).toBeNull()
  })

  it('refuses the v6 forms of the same places', () => {
    expect(blockedReason('::1')).not.toBeNull()
    expect(blockedReason('::')).not.toBeNull()
    expect(blockedReason('fc00::1')).not.toBeNull()
    expect(blockedReason('fd12:3456::1')).not.toBeNull()
    expect(blockedReason('fe80::1')).not.toBeNull()
    expect(blockedReason('ff02::1')).not.toBeNull()
    expect(blockedReason('2606:2800:220:1:248:1893:25c8:1946')).toBeNull()
  })

  it('refuses v4-mapped v6 — the classic way past a v4-only check', () => {
    expect(blockedReason('::ffff:127.0.0.1')).not.toBeNull()
    expect(blockedReason('::ffff:169.254.169.254')).not.toBeNull()
    expect(blockedReason('::ffff:10.0.0.1')).not.toBeNull()
    // The same form pointing somewhere public is still fine.
    expect(blockedReason('::ffff:93.184.216.34')).toBeNull()
  })

  it('⚠️ refuses the same places however they are spelt — expanded, hex-mapped, 6to4, NAT64', () => {
    // Every one of these is loopback or link-local under another spelling, and
    // every one passed a check on the literal text (2026-09-09 audit).
    expect(blockedReason('0:0:0:0:0:0:0:1')).not.toBeNull()
    expect(blockedReason('0000:0000:0000:0000:0000:0000:0000:0000')).not.toBeNull()
    expect(blockedReason('::ffff:7f00:1')).not.toBeNull()
    expect(blockedReason('0:0:0:0:0:ffff:a9fe:a9fe')).not.toBeNull()
    expect(blockedReason('::7f00:1')).not.toBeNull()
    expect(blockedReason('2002:7f00:1::')).not.toBeNull()
    expect(blockedReason('2002:a9fe:a9fe::1')).not.toBeNull()
    expect(blockedReason('64:ff9b::7f00:1')).not.toBeNull()
    expect(blockedReason('64:ff9b::0a00:0001')).not.toBeNull()
    expect(blockedReason('FE80:0:0:0:0:0:0:1')).not.toBeNull()
    // And the same forms pointing somewhere public are still fine.
    expect(blockedReason('::ffff:5db8:d822')).toBeNull() // 93.184.216.34
    expect(blockedReason('2002:5db8:d822::')).toBeNull()
    expect(blockedReason('64:ff9b::5db8:d822')).toBeNull()
    expect(blockedReason('2606:2800:0220:0001:0248:1893:25c8:1946')).toBeNull()
    // Malformed is refused, not guessed at.
    expect(blockedReason('1::2::3')).not.toBeNull()
    expect(blockedReason('1:2:3:4:5:6:7:8:9')).not.toBeNull()
    expect(blockedReason('::12345')).not.toBeNull()
  })

  it('strips a zone index before deciding', () => {
    expect(blockedReason('fe80::1%eth0')).not.toBeNull()
  })

  it('refuses a string that is not an address at all', () => {
    expect(blockedReason('localhost')).not.toBeNull()
    expect(blockedReason('')).not.toBeNull()
  })
})

describe('the URL itself is checked before the network is touched', () => {
  it('assumes https for a bare domain', () => {
    const r = parseTarget('example.com')
    expect(r.ok && r.url.protocol).toBe('https:')
  })

  it('refuses a scheme that is not http or https', () => {
    for (const input of ['file:///etc/passwd', 'gopher://example.com', 'ftp://example.com']) {
      expect(parseTarget(input).ok).toBe(false)
    }
  })

  it('refuses credentials in the URL', () => {
    expect(parseTarget('https://user:pass@example.com').ok).toBe(false)
  })

  it('refuses a non-default port, which is how an internal service is usually addressed', () => {
    expect(parseTarget('http://example.com:8080').ok).toBe(false)
    expect(parseTarget('http://example.com:6379').ok).toBe(false)
    expect(parseTarget('https://example.com:443').ok).toBe(true)
    expect(parseTarget('http://example.com:80').ok).toBe(true)
  })
})

describe('a name resolving anywhere internal is refused outright', () => {
  it('refuses when ANY answer is internal, not merely when the first one is', () => {
    // The rebinding setup: one public answer to pass a naive check, one internal
    // answer for a later resolution to pick. Picking the good one is not safe.
    return resolvePublicAddress('rebind.example', async () => ['93.184.216.34', '127.0.0.1']).then((r) => {
      expect(r.ok).toBe(false)
    })
  })

  it('refuses a name that resolves to nothing', async () => {
    expect((await resolvePublicAddress('nx.example', async () => [])).ok).toBe(false)
  })

  it('refuses a name whose lookup throws rather than treating it as permitted', async () => {
    const r = await resolvePublicAddress('nx.example', async () => {
      throw new Error('ENOTFOUND')
    })
    expect(r.ok).toBe(false)
  })
})

describe('fetchSiteHtml, end to end', () => {
  it('returns the page for a public host', async () => {
    const r = await fetchSiteHtml('example.com', {
      resolve: publicDns,
      fetchImpl: async () => html('<title>Hello</title>'),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.html).toContain('Hello')
  })

  it('never issues a request at all for a blocked host', async () => {
    let called = 0
    const r = await fetchSiteHtml('internal.example', {
      resolve: async () => ['10.0.0.5'],
      fetchImpl: async () => {
        called += 1
        return html('secret')
      },
    })
    expect(called).toBe(0)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('blocked')
  })

  it('RE-CHECKS the redirect target — the easiest bypass there is', async () => {
    // A perfectly good public host that answers 302 to the metadata endpoint.
    // Automatic redirect following would fetch it and hand back the credentials.
    const seen: string[] = []
    const r = await fetchSiteHtml('example.com', {
      resolve: async (host) => (host === 'example.com' ? ['93.184.216.34'] : ['169.254.169.254']),
      fetchImpl: async (url) => {
        seen.push(String(url))
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('blocked')
    // The first hop was made; the second never was.
    expect(seen).toHaveLength(1)
  })

  it('closes each hop’s pinned agent before the next is built, and the last on return', async () => {
    // One socket pool per hop, with only the last ever closed, was a leak per
    // redirect on the public preview path (2026-09-09 audit).
    const events: string[] = []
    let n = 0
    const r = await fetchSiteHtml('example.com', {
      resolve: publicDns,
      pinFactory: () => {
        const id = (n += 1)
        events.push(`open:${id}`)
        return { close: async () => void events.push(`close:${id}`) }
      },
      fetchImpl: async (url) =>
        String(url).endsWith('/two') ? html('<title>Two</title>') : new Response(null, { status: 302, headers: { location: 'https://example.com/two' } }),
    })
    expect(r.ok).toBe(true)
    expect(events).toEqual(['open:1', 'close:1', 'open:2', 'close:2'])
  })

  it('refuses a redirect to a non-http scheme', async () => {
    const r = await fetchSiteHtml('example.com', {
      resolve: publicDns,
      fetchImpl: async () => new Response(null, { status: 301, headers: { location: 'file:///etc/passwd' } }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('blocked')
  })

  it('caps the redirect chain', async () => {
    let hops = 0
    const r = await fetchSiteHtml('example.com', {
      maxRedirects: 2,
      resolve: publicDns,
      fetchImpl: async () => {
        hops += 1
        return new Response(null, { status: 302, headers: { location: `https://example.com/${hops}` } })
      },
    })
    expect(r.ok).toBe(false)
    expect(hops).toBeLessThanOrEqual(3)
  })

  it('follows a legitimate redirect and reports where it ended up', async () => {
    const r = await fetchSiteHtml('example.com', {
      resolve: publicDns,
      fetchImpl: async (url) =>
        String(url).endsWith('/en')
          ? html('<title>Localised</title>')
          : new Response(null, { status: 302, headers: { location: 'https://example.com/en' } }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.finalUrl).toBe('https://example.com/en')
  })

  it('stops reading at the byte ceiling instead of buffering the whole body', async () => {
    // An endless response is a memory-exhaustion primitive that needs no
    // vulnerability at all, and this route is public.
    const chunk = new TextEncoder().encode('a'.repeat(1024))
    const r = await fetchSiteHtml('example.com', {
      maxBytes: 4096,
      resolve: publicDns,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(chunk)
            },
          }),
          { headers: { 'content-type': 'text/html' } },
        ),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bytes).toBe(4096)
    expect(r.truncated).toBe(true)
  })

  it('refuses a response that is not text', async () => {
    const r = await fetchSiteHtml('example.com', {
      resolve: publicDns,
      fetchImpl: async () => html('binary', { 'content-type': 'application/pdf' }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('not-html')
  })

  it('reports an HTTP error rather than throwing', async () => {
    const r = await fetchSiteHtml('example.com', {
      resolve: publicDns,
      fetchImpl: async () => new Response('nope', { status: 503 }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('http-error')
  })

  it('gives up on a slow host and says so', async () => {
    const r = await fetchSiteHtml('example.com', {
      timeoutMs: 20,
      resolve: publicDns,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('unreachable')
    expect(r.message).toContain('20ms')
  })

  it('never throws, whatever the transport does', async () => {
    const r = await fetchSiteHtml('example.com', {
      resolve: publicDns,
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
    })
    expect(r.ok).toBe(false)
  })

  it('sends no cookies, no referrer and an honestly named agent', async () => {
    let init: RequestInit | undefined
    await fetchSiteHtml('example.com', {
      resolve: publicDns,
      fetchImpl: async (_url, i) => {
        init = i
        return html('ok')
      },
    })
    expect(init?.credentials).toBe('omit')
    expect(init?.referrerPolicy).toBe('no-referrer')
    expect((init?.headers as Record<string, string>)['User-Agent']).toContain('BlipRankBot')
  })
})
