import { postgresDb, type Db } from '@bliprank/db/client'
import type { IdentityConfig } from './config'

/**
 * One connection pool per process. A serverless instance is reused across
 * requests under fluid compute, so a pool built per request would open a
 * socket per request against the pooler; a module-level memo does not.
 */
const pools = new Map<string, Db>()

export function appDb(config: IdentityConfig): Db {
  let db = pools.get(config.databaseUrl)
  if (!db) {
    db = postgresDb(config.databaseUrl)
    pools.set(config.databaseUrl, db)
  }
  return db
}
