/**
 * The migration lineage is one ordered list, and a migration that fails
 * half-way leaves nothing behind (MVP_PLAN B3r, items 1 and 4).
 *
 * WHY STATEMENT BY STATEMENT. psql -f runs a file one statement at a time,
 * each its own transaction unless the file says BEGIN. PGlite's exec() sends
 * the whole text as one simple query, which Postgres runs as ONE implicit
 * transaction: a file with no BEGIN rolls back on failure here and does not
 * in production. So a truncation test through exec() would pass for a reason
 * production does not share. The splitter below reproduces psql's behaviour.
 */

import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, migratedPglite } from './testing.js'

const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')

/** Top-level statements of a SQL file: `;` outside `'…'`, `$tag$…$tag$` and `--` comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  const dollar = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      cur += sql.slice(i, end)
      i = end
    } else if (ch === "'") {
      let j = i + 1
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1
      cur += sql.slice(i, j + 1)
      i = j + 1
    } else if (ch === '$' && ((dollar.lastIndex = i), dollar.test(sql))) {
      const tag = sql.slice(i, dollar.lastIndex)
      const close = sql.indexOf(tag, dollar.lastIndex)
      if (close === -1) throw new Error(`unterminated ${tag}`)
      cur += sql.slice(i, close + tag.length)
      i = close + tag.length
    } else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
    } else {
      cur += ch
      i++
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const membership = (pg: PGlite) =>
  pg.query(`SELECT g.rolname FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles u ON u.oid = am.member
             WHERE u.rolname = current_user AND g.rolname IN ('svc_onboard', 'auth_verifier')`)

describe('the migration lineage is one ordered list', () => {
  it('files are numbered 0000.. consecutively, one file per number, named as the record expects', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(5)
    expect(MIGRATIONS.map((f) => f.slice(0, 4))).toEqual(MIGRATIONS.map((_, i) => String(i).padStart(4, '0')))
    for (const f of MIGRATIONS) expect(f).toMatch(/^[0-9]{4}_[a-z0-9_]+\.sql$/)
  })

  it('a full apply records exactly the files on disk, in order, and the record refuses a second file under a held number', async () => {
    const pg = await migratedPglite()
    try {
      const rows = await pg.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`)
      expect(rows.rows.map((r) => r.name)).toEqual(MIGRATIONS.map((f) => f.replace(/\.sql$/, '')))
      // fix/tenancy-deploy-gate's unmerged file, applied without renumbering: refused before it changes anything.
      await expect(pg.query(`INSERT INTO schema_migrations (name) VALUES ('0003_tenancy_exposure_manifest')`)).rejects.toThrow(
        /schema_migrations_one_per_number/,
      )
      // The record is the owner's: no application role reads or writes it.
      for (const r of ['app_rw', 'svc_scorer', 'svc_onboard']) {
        expect((await pg.query(`SELECT has_any_column_privilege('${r}', 'schema_migrations', 'SELECT') AS x`)).rows).toEqual([{ x: false }])
      }
    } finally {
      await pg.close()
    }
  })

  it('the splitter keeps every dollar-quoted body whole and does not split inside strings', () => {
    const s = splitStatements(`SELECT 'a;b'; DO $$ BEGIN PERFORM 1; PERFORM 2; END $$; -- c;d\nSELECT $x$;$x$`)
    expect(s).toEqual([`SELECT 'a;b'`, `DO $$ BEGIN PERFORM 1; PERFORM 2; END $$`, `-- c;d\nSELECT $x$;$x$`])
  })
})

describe('a migration that fails after granting the owner a writing group leaves no standing membership (B3r item 1)', () => {
  /** Every GRANT of a writing group in the file, not only the first: 0005 joins two groups in turn (B3c tenancy audit, MINOR 3). */
  const grantsIn = (file: string) => {
    const stmts = splitStatements(read(file))
    const at = stmts.map((s, i) => (/GRANT (svc_onboard|auth_verifier) TO %I/.test(s) ? i : -1)).filter((i) => i > 0)
    expect(at.length).toBeGreaterThan(0)
    return { stmts, at }
  }

  /** Every file before `file`, applied whole; then `file`'s statements one at a time up to and including the GRANT. */
  async function cutAfterGrant(file: string, stmts: string[], grantAt: number, from = 0): Promise<PGlite> {
    const pg = new PGlite({ extensions: { pgcrypto } })
    for (const m of MIGRATIONS) {
      if (m === file) break
      await pg.exec(read(m))
    }
    for (const s of stmts.slice(from, grantAt + 1)) await pg.exec(s)
    // The next statement fails, ON_ERROR_STOP ends psql, and the connection's
    // open transaction — if the file opened one — is rolled back.
    await pg.exec('ROLLBACK')
    return pg
  }

  // The files that promise the property: a GRANT and its REVOKE in one file.
  // 0001 grants the owner auth_verifier and 0002 revokes it, deliberately
  // (0002 was the fix to 0001); between the two the membership stands by
  // design, and check-deploy.sql's owner-membership assertion reports a
  // database left there.
  const promises = (f: string) => /GRANT (svc_onboard|auth_verifier) TO %I/.test(read(f)) && /REVOKE (svc_onboard|auth_verifier) FROM %I/.test(read(f))
  const subjects = MIGRATIONS.filter(promises)
  it('covers 0003 and 0004 at least', () => {
    expect(subjects).toEqual(expect.arrayContaining(['0003_accounts_identity.sql', '0004_workspace_state.sql']))
  })
  for (const file of subjects) {
    it(`${file}: cut after each of its GRANTs, the owner is in no writing group`, async () => {
      const { stmts, at } = grantsIn(file)
      // The first statement carries the header comments; what it says is BEGIN.
      expect((stmts[0] ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('--')).join('\n').trim()).toBe('BEGIN')
      for (const grantAt of at) {
        const pg = await cutAfterGrant(file, stmts, grantAt)
        try {
          expect([grantAt, (await membership(pg)).rows]).toEqual([grantAt, []])
        } finally {
          await pg.close()
        }
      }
    })

    it(`${file}: the test bites — without the BEGIN the membership stands`, async () => {
      const { stmts, at } = grantsIn(file)
      const pg = await cutAfterGrant(file, stmts, at[0]!, 1)
      try {
        expect((await membership(pg)).rows.length).toBe(1)
      } finally {
        await pg.close()
      }
    })
  }
})
