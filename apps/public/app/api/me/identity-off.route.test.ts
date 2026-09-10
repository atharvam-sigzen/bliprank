import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY_ENV, IDENTITY_OFF } from '@/lib/auth/config'
import { GET as me } from './route'
import { POST as signIn } from '../auth/sign-in/route'
import { POST as workspaces } from '../workspaces/route'

/**
 * Identity is off in every test and on the reference deployment. Off has to
 * be one fixed sentence on every identity route — not a stack trace, not a
 * half-working flow — and it must stay off when the configuration is partial.
 */
const originalEnv = { ...process.env }
beforeEach(() => {
  for (const k of IDENTITY_ENV) delete process.env[k]
})
afterEach(() => {
  process.env = { ...originalEnv }
})

const post = (path: string, body: unknown) => new Request(`http://localhost:3001${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('identity off', () => {
  it('every identity route answers 503 with the one sentence', async () => {
    for (const res of [await me(), await signIn(post('/api/auth/sign-in', { email: 'a@b.test', kind: 'brand' })), await workspaces(post('/api/workspaces', { name: 'x' }))]) {
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ message: IDENTITY_OFF })
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
  })

  it('a partial configuration is still off', async () => {
    process.env['SUPABASE_URL'] = 'https://example.supabase.co'
    process.env['SUPABASE_PUBLISHABLE_KEY'] = 'sb_publishable_x'
    const res = await me()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ message: IDENTITY_OFF })
  })

  it('a SITE_URL that is not an absolute http(s) origin keeps identity off, and the origin is what is kept', async () => {
    const { identityConfig } = await import('@/lib/auth/config')
    const full = { NODE_ENV: 'test' as const, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'k', DATABASE_URL: 'postgresql://u:p@h/db', AUTH_SIGNING_KID: 'k1', AUTH_SIGNING_SECRET: 's', AUTH_ISSUER: 'i', AUTH_AUDIENCE: 'a' }
    expect(identityConfig({ ...full, SITE_URL: 'bliprank.com' }).on).toBe(false)
    expect(identityConfig({ ...full, SITE_URL: 'javascript:alert(1)' }).on).toBe(false)
    const on = identityConfig({ ...full, SITE_URL: 'https://bliprank.com/some/path?x=1' })
    expect(on.on && on.config.siteUrl).toBe('https://bliprank.com')
  })
})
