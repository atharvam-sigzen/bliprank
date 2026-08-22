/**
 * Drizzle mirror of migrations/0000_init.sql — application-side types only.
 * The SQL file is the source of truth: partitioning, RLS policies, grants and
 * the immutability rules cannot be expressed here, so migrations are hand-
 * written SQL applied in order, and this file must be kept in step with them.
 *
 * HUMAN-OWNED area (tenancy model) — see the migration header. Authority lives
 * in roles (app_rw / svc_scorer / svc_onboard / auth_verifier) and entitlements,
 * none of which this ORM mirror expresses; the SQL is the source of truth. Nor
 * does it express the two things migration 0001 added: that a tenant context can
 * only be established from a token the database verifies itself, and that the
 * billing gate is a trigger which refuses an INSERT rather than code that tidies
 * up afterwards.
 */

import { boolean, date, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.accountId] })],
)

export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  aliases: jsonb('aliases').notNull().default([]),
  domains: jsonb('domains').notNull().default([]),
})

export const workspaceBrands = pgTable(
  'workspace_brands',
  {
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id').notNull().references(() => brands.id, { onDelete: 'restrict' }),
    relation: text('relation', { enum: ['own', 'competitor'] }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedBy: uuid('granted_by').references(() => accounts.id),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.brandId] })],
)

/**
 * Billing state behind the entitlement gate. Writing a row here is the only way
 * a workspace becomes able to hold an entitlement at all: a BEFORE INSERT
 * trigger on workspace_brands refuses when this row is missing, not active, out
 * of period, or already at brand_limit (migration 0001). Blocked before create —
 * an unpaid entitlement never exists, not even briefly.
 */
export const workspaceSubscriptions = pgTable('workspace_subscriptions', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  plan: text('plan', { enum: ['trial', 'starter', 'growth', 'scale'] }).notNull(),
  status: text('status', { enum: ['active', 'past_due', 'cancelled'] }).notNull(),
  brandLimit: integer('brand_limit').notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * JWT signing keys for set_workspace_jwt(). Deliberately has NO application-role
 * grant: the tenant role cannot read the secret it would need to forge a token,
 * and only the auth_verifier role that owns the verifier function can. Mirrored
 * here for migrations and key rotation tooling, never for application queries.
 */
export const authSigningKeys = pgTable('auth_signing_keys', {
  kid: text('kid').primaryKey(),
  secret: text('secret').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
})

export const promptBanks = pgTable('prompt_banks', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category').notNull(),
  locale: text('locale').notNull(),
  geo: text('geo').notNull(),
  prompts: jsonb('prompts').notNull(),
  version: integer('version').notNull().default(1),
})

/** Partitioned in SQL; immutable (no UPDATE/DELETE grants); rule R5. */
export const scoreRows = pgTable(
  'score_rows',
  {
    cellKey: text('cell_key').notNull(),
    day: date('day').notNull(),
    engine: text('engine').notNull(),
    locale: text('locale').notNull(),
    geo: text('geo').notNull(),
    brandId: uuid('brand_id').notNull().references(() => brands.id),
    algoVersion: text('algo_version').notNull(),
    runs: integer('runs').notNull(),
    mentions: integer('mentions').notNull(),
    citations: integer('citations').notNull(),
    firstPosSum: integer('first_pos_sum'),
    sampled: jsonb('sampled').notNull().default([]),
    scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cellKey, t.brandId, t.algoVersion, t.day] })],
)

export const scoreAggregates = pgTable(
  'score_aggregates',
  {
    brandId: uuid('brand_id').notNull().references(() => brands.id),
    engine: text('engine').notNull(),
    periodStart: date('period_start').notNull(),
    period: text('period', { enum: ['day', 'week'] }).notNull(),
    algoVersion: text('algo_version').notNull(),
    signal: text('signal', { enum: ['mention', 'citation', 'sentiment'] }).notNull(),
    successes: integer('successes').notNull(),
    trials: integer('trials').notNull(),
    sampled: boolean('sampled').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.brandId, t.engine, t.period, t.periodStart, t.algoVersion, t.signal] })],
)
