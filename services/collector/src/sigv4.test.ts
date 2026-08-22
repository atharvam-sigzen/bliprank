import { describe, expect, it } from 'vitest'
import { EMPTY_PAYLOAD_SHA256, signRequest, type SigV4Credentials } from './sigv4.js'

/**
 * AWS's published SigV4 test suite (aws-sig-v4-test-suite). These are the
 * canonical vectors every SigV4 implementation is checked against: same
 * credentials, same instant, same expected signature, byte for byte. They are
 * the reason this signer can be trusted without a live bucket to try it on.
 */
const AWS: SigV4Credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
}
const AT = new Date('2015-08-30T12:36:00Z')

describe('SigV4 against the AWS published test suite', () => {
  it('get-vanilla', () => {
    const s = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/' }, AWS, AT)
    expect(s.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  })

  it('post-vanilla', () => {
    const s = signRequest({ method: 'POST', url: 'https://example.amazonaws.com/' }, AWS, AT)
    expect(s.signature).toBe('5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b')
  })

  it('get-vanilla-query-order-key-case — query is sorted on the encoded form', () => {
    const s = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' }, AWS, AT)
    expect(s.signature).toBe('b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500')
  })

  it('builds the canonical request exactly as the spec describes it', () => {
    const s = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/' }, AWS, AT)
    expect(s.canonicalRequest).toBe(
      ['GET', '/', '', 'host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n', 'host;x-amz-date', EMPTY_PAYLOAD_SHA256].join('\n'),
    )
    expect(s.stringToSign.split('\n')[0]).toBe('AWS4-HMAC-SHA256')
    expect(s.stringToSign.split('\n')[2]).toBe('20150830/us-east-1/service/aws4_request')
  })
})

describe('S3/R2 specifics', () => {
  const R2: SigV4Credentials = { accessKeyId: 'ak', secretAccessKey: 'sk', region: 'auto', service: 's3' }

  it('signs the payload hash as a header and hashes the real body', () => {
    const s = signRequest({ method: 'PUT', url: 'https://acct.r2.cloudflarestorage.com/bucket/a.json', body: '{"a":1}', signPayloadHeader: true }, R2, AT)
    expect(s.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(s.headers['x-amz-content-sha256']).not.toBe(EMPTY_PAYLOAD_SHA256)
    expect(s.canonicalRequest).toContain('x-amz-content-sha256')
    expect(s.headers['authorization']).toContain('Credential=ak/20150830/auto/s3/aws4_request')
  })

  it('a different body is a different signature', () => {
    const a = signRequest({ method: 'PUT', url: 'https://h/b/k', body: 'one', signPayloadHeader: true }, R2, AT)
    const b = signRequest({ method: 'PUT', url: 'https://h/b/k', body: 'two', signPayloadHeader: true }, R2, AT)
    expect(a.signature).not.toBe(b.signature)
  })

  it('preserves a doubled slash - `a//b` is a real, distinct key', () => {
    const s = signRequest({ method: 'GET', url: 'https://h/bucket/a//b.json' }, R2, AT)
    expect(s.canonicalRequest.split('\n')[1]).toBe('/bucket/a//b.json')
  })

  it('documents the one thing the signer cannot defend: URL() resolves dot segments upstream', () => {
    // new URL() collapses `..` before the signer sees the path, so such a key
    // would be signed AND sent for a different object - consistently, therefore
    // silently. R2BlobStore rejects those keys instead (assertSafeKey).
    const s = signRequest({ method: 'GET', url: 'https://h/bucket/a/b/../c.json' }, R2, AT)
    expect(s.canonicalRequest.split('\n')[1]).toBe('/bucket/a/c.json')
  })

  it('encodes the characters encodeURIComponent leaves alone', () => {
    const s = signRequest({ method: 'GET', url: "https://h/bucket/a(1)'*!.json" }, R2, AT)
    expect(s.canonicalRequest.split('\n')[1]).toBe('/bucket/a%281%29%27%2A%21.json')
  })

  it('signature is stable for a fixed instant and drifts with the clock', () => {
    const at1 = signRequest({ method: 'GET', url: 'https://h/b/k' }, R2, AT)
    const at1again = signRequest({ method: 'GET', url: 'https://h/b/k' }, R2, new Date('2015-08-30T12:36:00Z'))
    const later = signRequest({ method: 'GET', url: 'https://h/b/k' }, R2, new Date('2015-08-30T12:37:00Z'))
    expect(at1.signature).toBe(at1again.signature)
    expect(later.signature).not.toBe(at1.signature)
  })
})
