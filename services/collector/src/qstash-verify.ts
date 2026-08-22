/**
 * QStash request verification — PHASES.md 1.1, rule R3.
 *
 * The production runner is an HTTP endpoint that QStash calls, and that
 * endpoint spends money. Rule R3 says nothing spends outside the scheduler, so
 * "was this actually the scheduler?" has to be answered cryptographically, not
 * by a shared secret in a query string or by trusting a header. An unverified
 * collection endpoint is a public button that bills us.
 *
 * QStash signs each delivery with a JWT in `Upstash-Signature`, HS256 over the
 * signing key. Claims we check, and why each one matters:
 *
 *   iss  must be "Upstash"            — not some other issuer's token
 *   sub  must be OUR destination URL  — stops a signed message aimed at a
 *                                       different endpoint being replayed here
 *   exp  must be in the future        — bounds replay
 *   nbf  must not be in the future    — rejects pre-dated tokens
 *   body must hash-match the payload  — the signature covers the *body*, so
 *                                       without this a valid token could be
 *                                       reattached to a different job
 *
 * Two keys are accepted because Upstash rotates: current, then next. Rejecting
 * during a rotation would stall collection.
 *
 * Pure and synchronous apart from the clock, which is injected. No network.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export interface VerifyOptions {
  readonly currentSigningKey: string
  readonly nextSigningKey?: string
  /** The absolute URL QStash was told to deliver to. Must equal the `sub` claim. */
  readonly url: string
  /** Raw request body, exactly as received — the hash is over these bytes. */
  readonly body: string
  readonly signature: string
  readonly now?: () => number
  /** Seconds of clock skew tolerated on exp/nbf. */
  readonly toleranceSec?: number
}

export class QStashVerificationError extends Error {
  override readonly name = 'QStashVerificationError'
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** Constant-time compare that does not leak length through an early return. */
function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

interface Claims {
  iss?: string
  sub?: string
  exp?: number
  nbf?: number
  body?: string
}

function verifyWithKey(token: string, key: string): Claims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, payload, sig] = parts as [string, string, string]
  const expected = b64url(createHmac('sha256', key).update(`${head}.${payload}`).digest())
  if (!sameSecret(sig, expected)) return null
  try {
    return JSON.parse(fromB64url(payload).toString('utf8')) as Claims
  } catch {
    return null
  }
}

/**
 * Throws `QStashVerificationError` unless the request provably came from QStash
 * for this exact URL and this exact body. Returns the verified claims.
 */
export function verifyQStashRequest(o: VerifyOptions): Claims {
  const now = Math.floor((o.now?.() ?? Date.now()) / 1000)
  const tol = o.toleranceSec ?? 5

  if (!o.signature) throw new QStashVerificationError('missing Upstash-Signature header')
  if (!o.currentSigningKey) throw new QStashVerificationError('no signing key configured — refusing to accept a collection job')

  const claims = verifyWithKey(o.signature, o.currentSigningKey) ?? (o.nextSigningKey ? verifyWithKey(o.signature, o.nextSigningKey) : null)
  if (!claims) throw new QStashVerificationError('signature does not verify against the current or next signing key')

  if (claims.iss !== 'Upstash') throw new QStashVerificationError(`unexpected issuer ${claims.iss}`)

  // Compare on the normalised URL: a trailing slash difference is not a forgery.
  const norm = (u: string) => u.replace(/\/+$/, '')
  if (!claims.sub || norm(claims.sub) !== norm(o.url)) {
    throw new QStashVerificationError(`token was issued for ${claims.sub}, not ${o.url}`)
  }

  if (typeof claims.exp === 'number' && claims.exp + tol < now) throw new QStashVerificationError('token expired')
  if (typeof claims.nbf === 'number' && claims.nbf - tol > now) throw new QStashVerificationError('token not yet valid')

  // The body hash is what stops a valid token being reattached to a different job.
  const digest = b64url(createHash('sha256').update(o.body).digest())
  if (!claims.body || !sameSecret(claims.body.replace(/=+$/, ''), digest)) {
    throw new QStashVerificationError('body does not match the hash in the signed token')
  }

  return claims
}

/**
 * Produce a QStash-shaped signature. Exists so the verifier can be tested
 * without a live QStash, and so the local dev runner can drive the real
 * handler. Never used in production — QStash signs the real ones.
 */
export function signQStashToken(o: { key: string; url: string; body: string; iat?: number; exp?: number; nbf?: number; iss?: string }): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const iat = o.iat ?? Math.floor(Date.now() / 1000)
  const claims = {
    iss: o.iss ?? 'Upstash',
    sub: o.url,
    iat,
    exp: o.exp ?? iat + 300,
    nbf: o.nbf ?? iat,
    body: b64url(createHash('sha256').update(o.body).digest()),
  }
  const payload = b64url(Buffer.from(JSON.stringify(claims)))
  const sig = b64url(createHmac('sha256', o.key).update(`${head}.${payload}`).digest())
  return `${head}.${payload}.${sig}`
}
