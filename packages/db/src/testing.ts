import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'
import type { Db } from './client.js'

/**
 * Test doubles that are not doubles: a real Postgres in-process, with the real
 * migrations applied, behind the same `Db` interface production uses. A test
 * that passes here passed the policies, the triggers and the definer
 * functions, not a mock of them.
 */
export const MIGRATIONS = ['0000_init.sql', '0001_tenancy_identity.sql', '0002_tenancy_context.sql', '0003_accounts_identity.sql'] as const

export const TEST_KEY = { kid: 'k1', secret: 'a-secret-long-enough-to-satisfy-the-constraint', issuer: 'iss', audience: 'aud' } as const

/** A fresh database with every migration applied and one signing key present. */
export async function migratedPglite(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pgcrypto } })
  for (const m of MIGRATIONS) await pg.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), 'utf8'))
  await pg.exec(`INSERT INTO auth_signing_keys (kid, secret, issuer, audience) VALUES ('${TEST_KEY.kid}','${TEST_KEY.secret}','${TEST_KEY.issuer}','${TEST_KEY.audience}')`)
  return pg
}

/**
 * The `Db` interface over PGlite, running as `role` (default: the tenant
 * role, which is what the application tier is). PGlite's session user is a
 * superuser, so the role is set per statement and per transaction — a test
 * that forgot would bypass every policy and prove nothing.
 */
export function pgliteDb(pg: PGlite, role: 'app_rw' | 'svc_onboard' | 'svc_scorer' = 'app_rw'): Db {
  return {
    query: async <T,>(text: string, params: readonly unknown[] = []) =>
      pg.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE ${role}`)
        return (await tx.query(text, [...params])).rows as T[]
      }),
    transaction: async <T,>(fn: (tx: Db) => Promise<T>) =>
      pg.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE ${role}`)
        return fn({
          query: async <U,>(text: string, params: readonly unknown[] = []) => (await tx.query(text, [...params])).rows as U[],
          transaction: () => Promise.reject(new Error('pgliteDb: nested transactions are not modelled')),
        })
      }),
  }
}
