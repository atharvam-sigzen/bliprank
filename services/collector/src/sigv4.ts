/**
 * AWS Signature Version 4 — the signing half of the R2 transport (PHASES 1.5).
 *
 * Cloudflare R2 speaks the S3 REST API, which means SigV4. We sign by hand
 * rather than pulling `@aws-sdk/client-s3`: three verbs (HEAD/GET/PUT) against
 * one bucket does not justify the dependency surface, and a signer we can point
 * at AWS's own published test vectors is easier to trust than an SDK we cannot
 * see into. `node:crypto` supplies both primitives.
 *
 * S3 semantics, deliberately, not the generic ones:
 *   - the path is encoded **once** per segment and never normalised (`a//b` is a
 *     real key, and `..` is a real key fragment — collapsing either signs a
 *     different object than the one being requested);
 *   - `x-amz-content-sha256` is a signed header, not optional.
 *
 * Pure and synchronous. No network, no clock of its own: the caller supplies
 * `now`, so a signature is reproducible in a test.
 */

import { createHash, createHmac } from 'node:crypto'

const sha256hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest()

/** SHA-256 of the empty string — the payload hash of any body-less request. */
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export interface SigV4Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly region: string
  readonly service: string
  /** Temporary credentials only; adds x-amz-security-token to the signature. */
  readonly sessionToken?: string
}

export interface SignInput {
  readonly method: string
  /** Absolute URL. Query string, if any, is canonicalised from it. */
  readonly url: string
  /** Extra headers to sign. `host` and `x-amz-date` are added automatically. */
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  /**
   * Sign `x-amz-content-sha256` (required by S3/R2). Off by default so the
   * generic AWS test vectors, which omit it, can be reproduced exactly.
   */
  readonly signPayloadHeader?: boolean
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` alone and AWS does
 * not, so those are escaped explicitly — a key containing one of them would
 * otherwise sign differently from how it is sent.
 */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Encode each path segment, preserving the separators. Never normalises. */
function canonicalPath(pathname: string): string {
  if (pathname === '') return '/'
  return pathname
    .split('/')
    .map((seg) => rfc3986(decodeURIComponent(seg)))
    .join('/')
}

/** Sorted by encoded key, then encoded value — AWS orders on the encoded form. */
function canonicalQuery(search: URLSearchParams): string {
  const pairs: [string, string][] = []
  for (const [k, v] of search) pairs.push([rfc3986(k), rfc3986(v)])
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

export interface SignedRequest {
  /** Every header to put on the wire, including Authorization. */
  readonly headers: Record<string, string>
  /** Exposed for tests and debugging: the exact strings that were hashed. */
  readonly canonicalRequest: string
  readonly stringToSign: string
  readonly signature: string
}

/**
 * Sign one request. Returns the headers to send; the caller does the fetch.
 * `now` must be the instant the request is made — SigV4 signatures expire.
 */
export function signRequest(input: SignInput, creds: SigV4Credentials, now: Date): SignedRequest {
  const url = new URL(input.url)
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') // 20150830T123600Z
  const dateStamp = amzDate.slice(0, 8)

  const payloadHash = input.body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256hex(input.body)

  // Host carries the port only when it is non-default, matching what fetch sends.
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: url.host,
    'x-amz-date': amzDate,
    ...(input.signPayloadHeader ? { 'x-amz-content-sha256': payloadHash } : {}),
    ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
  }

  const canonicalHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]))
  const canonicalHeaders = canonicalHeaderNames.map((h) => `${h}:${lowered.get(h)}\n`).join('')
  const signedHeaders = canonicalHeaderNames.join(';')

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${creds.region}/${creds.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, creds.region)
  const kService = hmac(kRegion, creds.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign).toString('hex')

  return {
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  }
}
