import postgres from 'postgres'

/**
 * The smallest database surface the application tier needs: a parameterised
 * query and a transaction. One interface so a test can run the same code
 * against PGlite (`./testing`) and production runs it against Postgres.
 *
 * TENANCY LIVES IN THE DATABASE, NOT HERE. `withWorkspace` opens a transaction
 * and presents the token; every row the callback then reads is what the
 * policies of migrations 0000–0002 allow for that verified context, and the
 * context ends with the transaction (the 0002 design: keyed on backend pid
 * and transaction id). Nothing in this file filters rows.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

/** Run `fn` inside a transaction whose tenant context is the verified token. */
export async function withWorkspace<T>(db: Db, token: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT set_workspace_jwt($1)', [token])
    return fn(tx)
  })
}

/**
 * Postgres over the `postgres` driver, for the tenant login role (a member of
 * `app_rw`). `prepare: false` because Supabase's transaction-mode pooler does
 * not support named prepared statements; `max` small because a serverless
 * instance serves few requests at once and the pooler is the real pool.
 */
export function postgresDb(url: string, opts: { max?: number } = {}): Db & { end(): Promise<void> } {
  const sql = postgres(url, { prepare: false, max: opts.max ?? 4, ssl: 'require' })
  const query = (s: postgres.Sql | postgres.TransactionSql) => async <T,>(text: string, params: readonly unknown[] = []) =>
    (await s.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[]
  return {
    query: query(sql),
    // One level: a transaction inside a transaction is a design question this
    // interface does not answer, so it refuses rather than opening a savepoint quietly.
    transaction: <T,>(fn: (tx: Db) => Promise<T>) =>
      sql.begin((tx) => fn({ query: query(tx), transaction: () => Promise.reject(new Error('postgresDb: nested transactions are not modelled')) })) as Promise<T>,
    end: () => sql.end(),
  }
}
