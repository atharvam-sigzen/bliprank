/**
 * Fetch a visitor-supplied domain's homepage, server-side, without becoming a
 * proxy into anything that is not the public web.
 *
 * ⚠️ THIS IS THE SSRF BOUNDARY. `classify-domain.ts` names it as the reason the
 * site-content signal was never built: "a server-side fetch of a user-supplied
 * domain and carries an SSRF surface that needs its own design before it is
 * built." This module is that design. Everything in it is a refusal.
 *
 * The threat is not abstract. This code runs on a host that can reach things a
 * visitor cannot: a cloud metadata endpoint at 169.254.169.254 holding
 * short-lived credentials, a Supabase or Redis instance on a private subnet, a
 * localhost admin port. A naive `fetch(userDomain)` hands a stranger the ability
 * to issue requests from inside that network and read the replies — and this
 * function's whole job is to read the reply.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIVE REFUSALS, AND WHY EACH ONE IS NOT COVERED BY THE OTHERS.
 *
 * 1. SCHEME AND SHAPE. http/https only, no credentials in the URL, no port
 *    other than the scheme's default. `file://`, `gopher://` and
 *    `http://user:pass@host` are all requests the caller never intended.
 *
 * 2. THE ADDRESS, NOT THE NAME. The host is resolved with DNS and every
 *    returned address is checked against the private, loopback, link-local,
 *    CGNAT, multicast and reserved ranges — v4 and v6, including the
 *    v4-mapped-v6 forms that are the classic way past a v4-only check. A
 *    name-based deny-list is not a substitute: `localtest.me` and countless
 *    attacker-controlled names resolve to 127.0.0.1, and a name says nothing
 *    about where it points.
 *
 * 3. THE SAME ADDRESS IS THE ONE CONNECTED TO. Checking DNS and then calling
 *    `fetch(hostname)` is a DNS-rebinding hole: the second lookup can answer
 *    differently. So the connection is made to the VALIDATED LITERAL ADDRESS
 *    with the original hostname carried in the `Host` header and, for TLS, in
 *    the SNI — there is no second resolution to poison.
 *
 * 4. EVERY REDIRECT HOP IS A NEW REQUEST. Redirects are followed manually,
 *    hop-capped, and each `Location` goes through all of the above again. An
 *    automatic redirect is the easiest bypass there is: the first URL is a
 *    perfectly good public host that answers `302 Location: http://169.254.169.254/`.
 *    Cross-origin hops also drop nothing sensitive because nothing sensitive is
 *    ever sent — no cookies, no auth header, no referrer.
 *
 * 5. SIZE AND TIME ARE BOUNDED. The body is read incrementally and abandoned at
 *    a byte ceiling, and the whole operation sits under one abort timer. An
 *    endless response is a memory exhaustion primitive that needs no
 *    vulnerability at all, and this runs on the public Grader path.
 *
 * What is deliberately NOT here: a retry. A homepage that does not answer is a
 * homepage we classify without. Retrying a request whose whole purpose is to
 * touch an arbitrary address multiplies the only thing worth minimising.
 */

import { lookup } from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'

export const DEFAULT_TIMEOUT_MS = 6_000
export const DEFAULT_MAX_BYTES = 512 * 1024
export const DEFAULT_MAX_REDIRECTS = 3

export interface FetchSiteOptions {
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly maxRedirects?: number
  /** Injected in tests. Production passes nothing and gets real DNS. */
  readonly resolve?: (host: string) => Promise<readonly string[]>
  readonly fetchImpl?: typeof fetch
}

export type FetchSiteResult =
  | { readonly ok: true; readonly html: string; readonly finalUrl: string; readonly bytes: number; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: 'blocked' | 'unreachable' | 'not-html' | 'http-error'; readonly message: string }

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDRESS CLASSIFICATION.
 *
 * Written out rather than pulled from a package, because the list IS the
 * security property and a transitive update to it is not something anyone would
 * review. Every range below is one an internal service plausibly sits on.
 */

/** IPv4 dotted-quad → its 32-bit value, or null when it is not one. */
export function parseIpv4(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    // Leading zeros are rejected: `0177.0.0.1` is octal for 127.0.0.1 in some
    // resolvers and decimal 177 in others, and a value two parsers disagree
    // about must never reach a comparison against a range.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

const V4_BLOCKED: readonly { readonly cidr: string; readonly base: number; readonly bits: number; readonly why: string }[] = [
  { cidr: '0.0.0.0/8', base: 0x00000000, bits: 8, why: 'this network' },
  { cidr: '10.0.0.0/8', base: 0x0a000000, bits: 8, why: 'private' },
  { cidr: '100.64.0.0/10', base: 0x64400000, bits: 10, why: 'carrier-grade NAT' },
  { cidr: '127.0.0.0/8', base: 0x7f000000, bits: 8, why: 'loopback' },
  { cidr: '169.254.0.0/16', base: 0xa9fe0000, bits: 16, why: 'link-local, including the cloud metadata endpoint' },
  { cidr: '172.16.0.0/12', base: 0xac100000, bits: 12, why: 'private' },
  { cidr: '192.0.0.0/24', base: 0xc0000000, bits: 24, why: 'IETF protocol assignments' },
  { cidr: '192.0.2.0/24', base: 0xc0000200, bits: 24, why: 'documentation' },
  { cidr: '192.168.0.0/16', base: 0xc0a80000, bits: 16, why: 'private' },
  { cidr: '198.18.0.0/15', base: 0xc6120000, bits: 15, why: 'benchmarking' },
  { cidr: '198.51.100.0/24', base: 0xc6336400, bits: 24, why: 'documentation' },
  { cidr: '203.0.113.0/24', base: 0xcb007100, bits: 24, why: 'documentation' },
  { cidr: '224.0.0.0/4', base: 0xe0000000, bits: 4, why: 'multicast' },
  { cidr: '240.0.0.0/4', base: 0xf0000000, bits: 4, why: 'reserved' },
]

/**
 * Is this address one the public internet can be reached at?
 *
 * Returns the reason it is NOT, or null when it is fine — a shape chosen so the
 * refusal can say which range it hit. "Blocked" with no reason is the kind of
 * message that gets debugged by removing the check.
 */
export function blockedReason(address: string): string | null {
  const raw = address.trim().toLowerCase()
  // Strip a zone index (`fe80::1%eth0`) before anything else looks at it.
  const addr = raw.replace(/%.*$/, '')

  const v4 = parseIpv4(addr)
  if (v4 !== null) {
    for (const range of V4_BLOCKED) {
      // `>>> 0` because a /8 shift of a 32-bit value is signed in JS and
      // 0xf0000000 >> 4 is negative, which compares equal to nothing.
      const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0
      if (((v4 & mask) >>> 0) === range.base) return `${addr} is in ${range.cidr} (${range.why})`
    }
    return null
  }

  if (!addr.includes(':')) return `${addr} is neither an IPv4 nor an IPv6 address`

  // v4-mapped and v4-compatible forms: ::ffff:127.0.0.1 reaches loopback and
  // passes any check that only looked at the colons. Re-check the tail as v4.
  const tail = addr.slice(addr.lastIndexOf(':') + 1)
  if (tail.includes('.')) {
    const mapped = parseIpv4(tail)
    if (mapped === null) return `${addr} has a malformed embedded IPv4 part`
    const inner = blockedReason(tail)
    return inner ? `${addr} embeds ${inner}` : null
  }

  if (addr === '::' || addr === '::1') return `${addr} is the IPv6 unspecified or loopback address`
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast. Compared on
  // the first hextet rather than by expanding the address: these prefixes are
  // all within the first 16 bits, so the leading group is sufficient and
  // expansion is one more thing to get wrong.
  const head = Number.parseInt(addr.split(':')[0] || '0', 16)
  if (Number.isNaN(head)) return `${addr} is not a parseable IPv6 address`
  if ((head & 0xfe00) === 0xfc00) return `${addr} is in fc00::/7 (unique local)`
  if ((head & 0xffc0) === 0xfe80) return `${addr} is in fe80::/10 (link local)`
  if ((head & 0xff00) === 0xff00) return `${addr} is in ff00::/8 (multicast)`
  if ((head & 0xffff) === 0x0064 && addr.startsWith('64:ff9b')) return `${addr} is in 64:ff9b::/96 (NAT64, which can map to a private v4)`
  return null
}

const realResolve = async (host: string): Promise<readonly string[]> => {
  const records = await lookup(host, { all: true, verbatim: true })
  return records.map((r) => r.address)
}

/**
 * Resolve a host and return one address that is safe to connect to.
 *
 * EVERY address must pass, not merely one. A name resolving to both a public
 * address and 127.0.0.1 is a rebinding setup, and picking the public one means
 * some later resolution — a retry, a keep-alive re-dial — can pick the other.
 * If any answer is internal, the name is refused outright.
 */
export async function resolvePublicAddress(
  host: string,
  resolveImpl: (h: string) => Promise<readonly string[]> = realResolve,
): Promise<{ ok: true; address: string } | { ok: false; message: string }> {
  let addresses: readonly string[]
  try {
    addresses = await resolveImpl(host)
  } catch (e) {
    return { ok: false, message: `${host} did not resolve (${(e as Error).message})` }
  }
  if (addresses.length === 0) return { ok: false, message: `${host} resolved to no addresses` }
  for (const address of addresses) {
    const blocked = blockedReason(address)
    if (blocked) return { ok: false, message: `${host} resolves to a non-public address: ${blocked}` }
  }
  return { ok: true, address: addresses[0]! }
}

/**
 * The URL, validated for shape alone. Address checking is separate and later,
 * because it needs the network and this does not.
 */
export function parseTarget(input: string): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
  } catch {
    return { ok: false, message: `${input} is not a URL` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, message: `${url.protocol} is not a scheme this fetches` }
  if (url.username || url.password) return { ok: false, message: 'a URL carrying credentials is refused' }
  // A non-default port is how an internal service is usually addressed, and a
  // homepage is on 80 or 443. Refusing the rest costs nothing real.
  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, message: `port ${url.port} is refused; only the default http and https ports are fetched` }
  return { ok: true, url }
}

/**
 * Read a response body up to `maxBytes`, then stop.
 *
 * Incremental rather than `res.text()`: `text()` buffers the whole body before
 * returning, so a content-length header of 4 GB is honoured in full and the cap
 * arrives too late to be a cap. Truncation is reported, not hidden — a
 * classification made on half a page should be visible as such.
 */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = res.body
  if (!body) return { text: '', bytes: 0, truncated: false }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  let bytes = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const room = maxBytes - bytes
      if (value.byteLength >= room) {
        out += decoder.decode(value.subarray(0, room))
        bytes += room
        truncated = true
        break
      }
      out += decoder.decode(value, { stream: true })
      bytes += value.byteLength
    }
  } finally {
    // Releases the socket whether the loop finished or hit the cap. Without it
    // a truncated read leaves the connection open until the server gives up.
    await reader.cancel().catch(() => {})
  }
  return { text: out, bytes, truncated }
}

/**
 * Fetch a domain's homepage, or explain why not.
 *
 * Never throws. Every failure is a `reason` the caller can put in front of a
 * person: this sits on the acquisition path, and "the scan failed" is not a
 * thing anyone can act on.
 */
export async function fetchSiteHtml(domain: string, options: FetchSiteOptions = {}): Promise<FetchSiteResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const resolveImpl = options.resolve ?? realResolve
  /*
   * UNDICI'S OWN FETCH, NOT THE GLOBAL — and this is load-bearing, not a style
   * choice.
   *
   * Node's global `fetch` is built on the undici copy bundled INSIDE Node.
   * Handing it a `dispatcher` built from the installed `undici` package pairs
   * two different copies of the library, and the request dies at the transport
   * with `invalid onRequestStart method` — a message that names nothing anyone
   * would connect to DNS pinning. Every fetch failed, for every domain, and it
   * looked exactly like "the network is blocked".
   *
   * Using undici's fetch keeps the dispatcher and the client in one copy. The
   * Response it returns is the same WHATWG shape this file already reads.
   */
  const doFetch = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch)

  const parsed = parseTarget(domain)
  if (!parsed.ok) return { ok: false, reason: 'blocked', message: parsed.message }

  const controller = new AbortController()
  // ONE timer for the WHOLE operation, redirects included. A per-hop timeout
  // multiplies by the hop count, so four hops at six seconds is a
  // twenty-four-second hold on a request path with a 90-second budget.
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  /*
   * The address-pinning dispatcher, and its lifetime.
   *
   * Only built for the REAL fetch: a `dispatcher` option means nothing to an
   * injected test double, and constructing an undici Agent per call that nobody
   * ever closes leaks a socket pool per request — on the public preview path.
   * One agent per hop, replaced as the chain redirects, and the last one closed
   * in the `finally` below whichever way this returns.
   */
  let pin: PinnedDispatcher | undefined

  try {
    let url = parsed.url
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const resolved = await resolvePublicAddress(url.hostname, resolveImpl)
      if (!resolved.ok) return { ok: false, reason: 'blocked', message: resolved.message }

      // Built per hop, and only for the real fetch. See `pinnedAgent`.
      if (!options.fetchImpl) pin = pinnedAgent(url, resolved.address)

      let res: Response
      try {
        res = await doFetch(url.toString(), {
          // MANUAL. An automatic redirect is a request to an address nothing
          // checked — see refusal 4.
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            // Named honestly. A crawler that lies about who it is cannot be
            // blocked by a site that would rather not be read, and being
            // blockable is the correct posture for a fetch we initiate on
            // someone else's behalf.
            'User-Agent': 'BlipRankBot/1.0 (+https://bliprank.com/bot; classification only)',
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en',
          },
          // No credentials of any kind. Nothing here should ever be
          // authenticated, and an ambient cookie jar on a server-side fetch is
          // how one request ends up carrying another tenant's session.
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          // Connect to the address that was VALIDATED, not to a name resolved a
          // second time — refusal 3. The hostname still governs Host and SNI,
          // so virtual hosts and certificates behave normally.
          ...(pin ? { dispatcher: pin } : {}),
          /*
           * The cast, and why it is not laziness. Node's global `RequestInit`
           * types `dispatcher` against the `undici-types` package bundled with
           * @types/node, while the Agent here comes from the `undici` package
           * itself. The two ship structurally identical but nominally distinct
           * `Dispatcher` types, so a correct value is rejected. There is no
           * `any`: `pin` is typed to the two members this file uses.
           */
        } as RequestInit)
      } catch (e) {
        const aborted = controller.signal.aborted
        return { ok: false, reason: 'unreachable', message: aborted ? `${url.hostname} did not answer within ${timeoutMs}ms` : `${url.hostname} could not be reached (${(e as Error).message})` }
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => {})
        if (!location) return { ok: false, reason: 'http-error', message: `${url.hostname} answered ${res.status} with no Location` }
        if (hop === maxRedirects) return { ok: false, reason: 'blocked', message: `more than ${maxRedirects} redirects` }
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          return { ok: false, reason: 'blocked', message: `the redirect target ${location} is not a URL` }
        }
        const checked = parseTarget(next.toString())
        if (!checked.ok) return { ok: false, reason: 'blocked', message: `the redirect to ${next.protocol}//${next.host} is refused: ${checked.message}` }
        url = checked.url
        continue
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return { ok: false, reason: 'http-error', message: `${url.hostname} answered ${res.status}` }
      }

      const type = res.headers.get('content-type') ?? ''
      if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
        await res.body?.cancel().catch(() => {})
        return { ok: false, reason: 'not-html', message: `${url.hostname} served ${type.split(';')[0]}, which carries no page text to classify` }
      }

      const { text, bytes, truncated } = await readCapped(res, maxBytes)
      return { ok: true, html: text, finalUrl: url.toString(), bytes, truncated }
    }
    return { ok: false, reason: 'blocked', message: `more than ${maxRedirects} redirects` }
  } finally {
    clearTimeout(timer)
    // `close` waits for in-flight requests; `destroy` does not. The body has
    // either been read to completion or cancelled by here, so close is right and
    // a rejection means the pool was already gone.
    await pin?.close().catch(() => {})
  }
}

/**
 * Pin one request to an already-validated address.
 *
 * undici's `connect.lookup` replaces the socket's DNS step, so the TCP
 * connection goes to `address` while the URL — and therefore the Host header and
 * the TLS SNI — stays the real hostname. That is what closes the rebinding
 * window in refusal 3: there is no second resolution for an attacker's short TTL
 * to answer differently.
 *
 * Built per hop and closed by the caller. A test that injects `fetchImpl` never
 * gets one, because a `dispatcher` option is meaningless to anything that is not
 * undici's fetch — the pre-flight address check still applies there, and only
 * the rebinding window (a production-path concern) reopens.
 */
/** The two members this file uses of an undici dispatcher. See the cast below. */
interface PinnedDispatcher {
  close(): Promise<void>
}

function pinnedAgent(url: URL, address: string): PinnedDispatcher {
  return new Agent({
    connect: {
      /*
       * undici calls this instead of dns.lookup when opening the socket, and it
       * calls it with `{ all: true }`, expecting an ARRAY back. The single-answer
       * `cb(err, address, family)` form is what `net.connect` documents and what
       * everyone writes first; undici 8 answers it with `Invalid IP address:
       * undefined`. Both contracts are honoured here so this cannot silently
       * break again from either direction.
       */
      lookup: (_hostname: string, opts: { all?: boolean | undefined } | undefined, cb: (err: Error | null, addr: string | { address: string; family: number }[], family?: number) => void) => {
        const family = address.includes(':') ? 6 : 4
        if (opts?.all) cb(null, [{ address, family }])
        else cb(null, address, family)
      },
      servername: url.hostname,
    },
    // One request, then done. A pooled connection outliving the validation that
    // permitted it is the same rebinding problem wearing a keep-alive.
    pipelining: 0,
  })
}
