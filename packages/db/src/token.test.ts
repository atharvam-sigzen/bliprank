import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { withWorkspace } from './client.js'
import { migratedPglite, pgliteDb, TEST_KEY } from './testing.js'
import { mintWorkspaceToken } from './token.js'

/**
 * The minter is only right if the database accepts what it mints: the round
 * trip through `set_workspace_jwt()` is the test, not the token's shape.
 */
let pg: PGlite
const UID = '22222222-0000-4000-8000-000000000001'

beforeAll(async () => {
  pg = await migratedPglite()
  const app = pgliteDb(pg)
  await app.query(`SELECT ensure_account($1, $2, $3)`, [UID, 'p@brand.test', 'brand'])
  await app.query(`SELECT create_workspace($1, $2)`, [UID, 'Brand'])
})
afterAll(async () => {
  await pg.close()
})

describe('mintWorkspaceToken round-trips through the database verifier', () => {
  it('a token for a member reads exactly that workspace, and the context ends with the transaction', async () => {
    const app = pgliteDb(pg)
    const [me] = await app.query<{ account_id: string; workspace_id: string }>(`SELECT account_id, workspace_id FROM workspaces_of($1)`, [UID])
    const token = mintWorkspaceToken(TEST_KEY, { sub: me!.account_id, workspaceId: me!.workspace_id })
    const seen = await withWorkspace(app, token, (tx) => tx.query<{ id: string }>('SELECT id FROM workspaces'))
    expect(seen).toEqual([{ id: me!.workspace_id }])
    expect(await app.query('SELECT id FROM workspaces')).toEqual([])
  })

  it('the wrong secret, the wrong audience and a lifetime over the key ceiling are all refused by the database', async () => {
    const app = pgliteDb(pg)
    const [me] = await app.query<{ account_id: string; workspace_id: string }>(`SELECT account_id, workspace_id FROM workspaces_of($1)`, [UID])
    const claims = { sub: me!.account_id, workspaceId: me!.workspace_id }
    await expect(withWorkspace(app, mintWorkspaceToken({ ...TEST_KEY, secret: 'other' }, claims), (tx) => tx.query('SELECT 1'))).rejects.toThrow(/bad signature/)
    await expect(withWorkspace(app, mintWorkspaceToken({ ...TEST_KEY, audience: 'elsewhere' }, claims), (tx) => tx.query('SELECT 1'))).rejects.toThrow(/audience mismatch/)
    await expect(withWorkspace(app, mintWorkspaceToken(TEST_KEY, { ...claims, ttlSec: 43260 }), (tx) => tx.query('SELECT 1'))).rejects.toThrow(/lifetime exceeds/)
  })

  it('refuses a non-positive ttl before anything is signed', () => {
    expect(() => mintWorkspaceToken(TEST_KEY, { sub: 'a', workspaceId: 'b', ttlSec: 0 })).toThrow(/positive integer/)
  })
})
