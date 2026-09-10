# MVP plan — BlipRank, from the 2026-09-09 audit

> Goal points are `docs/PRODUCT_GOAL.md` numbers; verdicts and gap lines are `docs/MVP_AUDIT_2026-09-09.md`, not re-derived. Update the Status column at the end of every session.

## Context

The audit leaves 9 of 11 goal points PARTIAL or NOT SATISFIED. The owner fixed the stage order and decisions D1–D7. This plan has one row per work item; **Stage A was executed on 2026-09-09** (code-only defects, no decisions; branch `mvp/stage-a`). Stages B–E are planned to the file level so the next session takes the first incomplete stage without re-auditing.

Branch: `mvp/stage-a` off `fix/preview-every-domain` HEAD (`76ffa65`). First commit: the owner's uncommitted `docs/PRODUCT_GOAL.md`, `docs/MVP_AUDIT_2026-09-09.md`, the CLAUDE.md pointer line, and this plan as `docs/MVP_PLAN.md`. One conventional commit per row after that, `[P3]` tag, never on main.

Status values: `TODO` · `DONE` · `DONE ⚠️ HUMAN REVIEW` · `BLOCKED (owner)`.

---

## Stage A — confirmed defects (audit "Ranked defects" 1–7)

| # | Goal | Item | Files | Test that proves it | Status | Human |
|---|---|---|---|---|---|---|
| A1 | 10 | Trusted-proxy allowlist for the client IP | `services/grader/src/visitor-throttle.ts`; the six callers of `extractClientIp` (`api/{category,competitors,custom-prompts,gaps,preview,scan}/route.ts`) pass `env` | `visitor-throttle.test.ts`: under `TRUSTED_PROXY` unset every header is ignored; `cloudflare` reads only `cf-connecting-ip`; `vercel` reads only `x-vercel-forwarded-for`; a non-IP value falls back | DONE | no |
| A2 | 9 | `diagnose.ts` behind `Budget` + the shared `ledger.json`; every model call in `bank-author.ts` behind a `Budget` on `bank-author-ledger.json` | `services/grader/src/diagnose.ts`, `bank-author.ts`, `bank-author.test.ts`, callers of `bankAuthorConfig` (`aeo.ts`, `/api/preview`, `/api/scan`), `CLAUDE.md §7` | new `diagnose.test.ts`: charge precedes fetch, exhausted ledger ⇒ zero fetches; `bank-author.test.ts`: ledger file written per attempt, cap reached ⇒ `null` and no fetch | DONE ⚠️ HUMAN REVIEW | ⚠️ spend control |
| A3 | 9, 10 | `pre-spend.sh` covers grader spend commands and no longer keys on `COLLECTION_ENABLED` | `.claude/hooks/pre-spend.sh`, new `services/grader/src/pre-spend-hook.test.ts` | hook test spawns bash+jq: `pnpm grader:scan` blocked, `-- --fixture` allowed, `grader:tick -- --apply --live` blocked, dry `grader:tick` allowed, `grader:diagnose` and `grader:aeo` blocked, all with `COLLECTION_ENABLED=true` in env | DONE ⚠️ HUMAN REVIEW | ⚠️ spend control |
| A4 | 4, 5 | Raw evidence reachable at simple depth | `apps/public/components/prompt-breakdown.tsx` | `prompt-breakdown.evidence.test.tsx`: the evidence button survives `stripToSimple` (lib/simple-view) | DONE | no |
| A5 | 9 | Same-version rescore guard | `services/grader/src/rescore.ts`, `rescore.test.ts` | a stored result already at `SCORING_ALGO_VERSION` is SKIPPED unless `--same-version` (ADR-0012's additive case) is passed; arg parser test | DONE | no |
| A6 | 10 | Redirect agent leak · raw error leakage · `isHost` on both spending routes · IPv6 forms | `services/grader/src/fetch-site.ts`, `fetch-site.test.ts`, `apps/public/lib/host.ts` (new: `isHost` + the route `normalise`, replacing the copies in six `/api/*/route.ts`; `lib/workspace.ts` already has a `normaliseHost` — reuse it if it is the same function) | `fetch-site.test.ts`: `0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, `2002:7f00:1::`, `64:ff9b::7f00:1`, uncompressed mapped form all blocked; pin closed per hop (spy); `scan/route.test.ts` + `preview/route.test.ts`: a thrown internal error yields a fixed message, and `domain: "not a host"` is a 400/`input` error | DONE | no |
| A7 | 5, 10 | `range-rail` bounds through `packages/stats/format`; CLAUDE.md map and Visx claim corrected | `packages/stats/src/format.ts` (+`formatBounds`), `format.test.ts`, `apps/public/components/range-rail.tsx`, `CLAUDE.md` §2 map, §6 stack | `format.test.ts`: `formatBounds` agrees with `formatInterval`; grep test: no `toFixed(` in `range-rail.tsx` | DONE ⚠️ HUMAN REVIEW | ⚠️ packages/stats (one formatter) |

### Stage A design notes (decisions made, so implementation is mechanical)

**A1.** `extractClientIp(req, env = process.env)`. `TRUSTED_PROXY` ∈ `cloudflare | vercel | unset`. Cloudflare: `cf-connecting-ip` only — its doc: "provides the client IP address connecting to Cloudflare", and recommends it over `X-Forwarded-For`, which Cloudflare *appends* to (developers.cloudflare.com/fundamentals/reference/http-headers, fetched 2026-09-09). Vercel: `x-vercel-forwarded-for` only — its doc: Vercel overwrites `x-forwarded-for` and "do[es] not forward external IPs"; `x-vercel-forwarded-for` "is identical … however `x-forwarded-for` could be overwritten if you're using a proxy on top of Vercel" (vercel.com/docs/headers/request-headers, last updated 2025-12-13). Unset: no header is read; the key is `direct`, so every caller shares one bucket — fail-closed, and the preview route's global cap already carries the real bound. A trusted header whose value is not an IP (reuse `parseIpv4` from fetch-site, or contains `:`) falls back to `direct`. Existing precedence test is replaced, not kept.

**A2.** Diagnose: `new Budget(join(dataDir,'ledger.json'), ledgerCapUsd(dataDir, env), e => PRICE_USD_PER_CALL[plan][e], () => new Date(), engines.length)` and `budget.charge(engine)` before each fetch; also requires `GRADER_LIVE_SCAN=true` like every other live path. Extract `runDiagnose({engines, key, budget, fetchImpl, log})` so the test injects fetch. Bank author: `BankAuthorConfig` gains `ledger: { file, capUsd, usdPerCall }`; `bankAuthorConfig(env, readKey, dataDir)` (third param required; ten test call sites updated). `askText` and `askAnthropic` both open the Budget and `charge(model)` before the network call — one guard where both providers and the AEO drafter route through. `BudgetExceeded` is caught in `authorBank` like any failure ⇒ `null` ⇒ general bank. Env: `BANK_AUTHOR_USD_PER_CALL` (default `0`: the default models are free tiers, the ledger still counts calls), `BANK_AUTHOR_CAP_USD` (default `5`; an existing file's cap wins, same rule as `ledgerCapUsd`).

**A3.** Remove the `COLLECTION_ENABLED` condition entirely: a matching command is blocked in an agent session, full stop; a person runs it from a plain shell. Patterns added: `grader:(diagnose|aeo)`, `grader:scan` unless the same command carries `--fixture` or `--stub`, `grader:tick` only with `--live`, and the `tsx services/grader/src/(run|diagnose|aeo|tick).ts` forms with the same exceptions.

**A4.** Move `<Evidence …/>` from inside the `.detail` wrapper to directly after it. The sentiment caveat stays inside. `depth.test.ts` rules 1–4 are unaffected (no new `.detail`, no prose added to simple).

**A5.** In `main()` after `planRescore`, `if (plan.algoVersion === SCORING_ALGO_VERSION && !o.sameVersion)` ⇒ SKIP line naming R5 and ADR-0012. `parseRescoreArgs` learns `--same-version`.

**A6.** fetch-site: `await pin?.close()` before `pin = pinnedAgent(...)` on each hop. `blockedReason`: add `expandIpv6(addr) → 8 hextets | null`; check unspecified/loopback on the expanded form; `::ffff:a:b` and `::a:b` (hextets 0–5 zero/ffff) ⇒ recheck embedded v4; `2002:` ⇒ v4 from hextets 1–2; `64:ff9b::/96` ⇒ v4 from hextets 6–7; fc00/fe80/ff00 on hextet 0. Routes: `catch (e)` logs `console.error` server-side and returns a fixed message. `isHost` after `normalise` in scan and preview via the new shared `apps/public/lib/host.ts`.

**A7.** `formatBounds(m, dp): { low: string; high: string }` (unit on `high` only, matching `formatInterval`). `BoundsRow` takes the `Metric` and prints `formatInterval` when narrow, `formatBounds` otherwise. CLAUDE.md: repo map adds `services/grader`, `packages/taxonomy`; marks `services/reconcile` "(not created yet; P4)"; scorer line says the sampled sentiment pass is not built; §6 "Visx (CI-aware charts)" → "hand-rolled SVG/CSS charts in `apps/public/components`".

---

## Stage B — foundation (points 1, 2, 7) — next session

| # | Goal | Item | Files | Test | Status | Human |
|---|---|---|---|---|---|---|
| B0 | 10 | CI: a GitHub Actions workflow runs `pnpm typecheck` and `pnpm test` on every push and pull request, offline (no provider key, no `COLLECTION_ENABLED`); the three `eslint-disable` comments that name an uninstalled linter are removed (no linter is added in this stage; strict `tsc` is the gate) | `.github/workflows/ci.yml` (new), `services/collector/src/blob-store.ts:74`, `rate-budget.ts:193`, `spend-ledger.ts:81` | the workflow file is valid and runs the two commands; grep test: no `eslint-disable` in source | DONE | no |
| B1 | 1, 5, 6 | D1: `apps/public` deploys to Vercel for the MVP; amend ADR-0002; `vercel.json` with function `maxDuration` per current Vercel docs; remove every "LOCAL DEMO ONLY / static deploy" comment that is now false | `docs/adr/0002-hosting-topology.md` (amendment), `apps/public/vercel.json`, six `api/*/route.ts` headers, `lib/answers.ts` 404 handling | `build-env.test.ts` extended: route files no longer claim absence on deploy | DONE | no |
| B2 | 1, 2 | D2: Supabase Auth magic link; `accounts` row per auth user; account owns workspaces; brand = one workspace, agency = many | `apps/public/lib/auth/*` (new), `middleware.ts`, `packages/db/migrations/0003_*.sql` (account↔auth uid, workspace kind), `packages/db/src/schema.ts` | RLS suite: an account reads only its workspaces; a brand account cannot create a second | TODO | ⚠️ RLS / tenancy |
| B3 | 1, 7, 9 | D3: records, cycles, competitor overrides, custom prompt sets and requests move to Postgres tables scoped by workspace; raw answers to R2 (R4); `local-store.ts` replaced by a `Store` interface with the file store kept for tests and the CLI | `packages/db/migrations/0003_*.sql`, `schema.ts`, `services/grader/src/store/*` (new), every `services/grader/src/*.ts` that reads `data-live` | RLS tests for each new table; grader suite passes on the file store; one integration test on pglite for the pg store | TODO | ⚠️ RLS; R4 |
| B4 | 7 | Corrections become operator actions inside the workspace (category, competitor set, custom prompts), still versioned, never re-derived; CLIs stay | `apps/public/app/dashboard/*`, `api/category|competitors|custom-prompts/route.ts` POST = apply for a workspace member with role owner/admin | `correctable-context.gate.test.ts` extended: apply path writes version N+1, history intact | TODO | no |

## Stage C — recurring operation (point 6)

| # | Goal | Item | Files | Test | Status | Human |
|---|---|---|---|---|---|---|
| C1 | 6 | D4: ADR-0018 — QStash daily schedule fans out one signed job per tracked domain into `runTick`'s per-domain path under the existing daily cap and allowance; cite Vercel function duration limits and QStash schedule semantics from provider docs | `docs/adr/0018-qstash-daily-fanout.md` | — | TODO | owner reads |
| C2 | 6 | Registration (`pnpm grader:schedule -- --register`) using the existing `QStashClient.schedule(cron, body)` (`services/collector/src/qstash.ts:141`, hand-rolled fetch, no `@upstash/qstash` dependency); arming path = env `GRADER_DAILY_LOOP=armed` on the deploy + schedule exists; **never armed, never spent by a session** | `services/grader/src/schedule.ts` (new), `apps/public/app/api/tick/route.ts` (signature-verified via `qstash-verify.ts`), `package.json` | `schedule.test.ts`: registration body shape; route refuses unsigned; fixture-mode tick through the route | TODO | ⚠️ spend control; owner arms |

## Stage D — personas and sale (points 1, 2, 4, 5)

| # | Goal | Item | Files | Test | Status | Human |
|---|---|---|---|---|---|---|
| D1 | 2 | Agency portfolio from the account's real workspaces; delete `agency-fixture.ts` (`CLIENTS` L62–72, `PORTFOLIO` L74–83) and the `PORTFOLIO.map` block in `agency/page.tsx` L276–336; `readAgencyDomains` (localStorage, `workspace.ts:299`) replaced by the account's workspaces | `apps/public/app/agency/page.tsx`, `lib/agency-fixture.ts` (deleted), `lib/workspace.ts`, `agency/page.test.tsx` | `planned.test.ts`/render tests: no fixture name reaches markup | TODO | no |
| D2 | 1 | D5: Stripe Checkout + webhook writes `workspace_subscriptions` (the entitlement trigger from migration 0001 already refuses unpaid brands) | `apps/public/app/api/billing/checkout/route.ts`, `api/billing/webhook/route.ts`, `packages/db` | webhook test with a signed fixture event; RLS/trigger test: brand insert refused before the row, allowed after | TODO | ⚠️ tenancy |
| D3 | 5 | `/api/answers` served from R2 for any workspace (after B3) | `apps/public/app/api/answers/route.ts`, `services/grader/src/answers.ts` | route test against an in-memory R2 double | TODO | no |
| D4 | 4, 5 | Purpose-built visuals for the three table-only insights: per-prompt grid, cited sources, gap coverage | `apps/public/components/prompt-grid.tsx`, `cited-sources.tsx`, `gap-report.tsx` | render tests; `depth.test.ts` still green; stats-reviewer on any rendered metric | TODO | ⚠️ stats-reviewer |

## Stage E — measurement (points 1, 3, 9)

| # | Goal | Item | Files | Test | Status | Human |
|---|---|---|---|---|---|---|
| E1 | 3, 9 | D6: curated bank `leaders` become a detection dictionary only (still fed to `scoreAnswer` as `competitors` for detection); the ranked/position set comes from `promoted-competitors/<slug>.json` (`promote-competitors.ts:531`) and the head-to-head reads "not yet established" when none exists; `/score-version` bump det-3 → det-4 | `services/grader/src/scan.ts` (`leadersOf` L314, competitor set L577), `services/scorer/src/score.ts` (position L378–381), `packages/taxonomy/src/types.ts`, `docs/METHODOLOGY.md` changelog (L119–129), both pin tables | `pnpm grader:version-diff` flip list; scorer golden agreement; render test for the "not yet established" state | TODO | ⚠️ scoring rule set |
| E2 | 3 | D7a: the 100-domain G3 worklist (`services/grader/labels/worklist.json`, unlabelled) | `label-run.ts` | worklist has 100 distinct real domains | BLOCKED (owner labels) | owner |
| E3 | 1, 9 | D7b: costed G0 pilot plan per PHASES 0.5 using `collector:pilot` | `docs/runbooks/g0-pilot.md` | — | BLOCKED (owner go-ahead; spends) | owner |

---

## Verification (Stage A, this session)

1. `pnpm test` and `pnpm typecheck` green after every row; each row its own commit.
2. Hook test exercises the real `pre-spend.sh` through bash+jq (both present on this machine).
3. `cost-sentinel` agent on the A2/A3 diff; `stats-reviewer` on A7's formatter.
4. Report per goal point with file:line at session end, as instructed.
