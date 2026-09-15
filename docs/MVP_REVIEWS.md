# Reviews of the ⚠️ HUMAN REVIEW rows — the delegated record

> On 2026-09-15 the owner delegated the review of the flagged rows (migrations,
> spend control, the stats formatter) to the oversight session, and asked that
> pushes, merges and other command-line steps be handled by sessions, not by
> hand. This file is the auditable record of that delegation: what was reviewed,
> by which independent pass, what it found, and the verdict. CLAUDE.md §4 still
> names these areas human-owned; the human's act here is the delegation itself,
> recorded once, and every later verdict cites the evidence a person could
> re-check. Rows keep the ⚠️ marker in MVP_PLAN.md until this file says ACCEPTED.

Method for every row: the builder ran its own audit; the oversight session then
ran an independent second pass (tenancy-auditor, cost-sentinel, or
stats-reviewer) that was told not to trust the builder's notes, and confirmed
the material findings first-hand at the cited lines. Where the second pass
found something the first missed, that became a new row, was built, and was
passed again.

| Row | Area | Independent pass | Material findings of the pass | Verdict |
|---|---|---|---|---|
| A2, A3 | spend control | cost-sentinel 2026-09-09 | hook is text matching, ledgers are the bound; accepted as stated in the hook header | ACCEPTED |
| A7 | packages/stats (`formatBounds`) | stats-reviewer 2026-09-09 | bounds round to nearest while `formatFrequency` rounds outward; an interior bound can print as 0.0 from n≈600 | ACCEPTED with one follow-up: adopt outward rounding for bounds (low down, high up) so a printed interval never excludes the true one — row D4 carries it, since it renders metrics |
| B2 | tenancy: 0003 accounts identity, client | tenancy-auditor 2026-09-10 | no leak; 0003 not transactional; `ws_required()` granted to the tenant; the two gates could not see a `USING (true)` table; 0003 numbering clash | ACCEPTED after B3r fixed all four (verified: `0003:71,275`, `0004:255`, `tenant-isolation.test.ts:144-174`, `schema_migrations`) |
| B3a | tenancy: 0004 workspace state, pg store | same pass | store reads name the workspace; writers take the workspace from context; R2/Upstash keys carry no tenant data | ACCEPTED |
| B3r | tenancy: the three fixes | tenancy-auditor 2026-09-15 (as part of the B3b pass) | one MAJOR: the inverse named `app_rw` literally and missed the login role that is a member of it; fixed in 10194fe | ACCEPTED |
| B3b | tenancy + spend: routes through the session token, ledgers off disk | tenancy-auditor + cost-sentinel 2026-09-15 | HIGH: burst-cap refusal listed other tenants' domains; MEDIUM: gaps cap keyed by bare host; spend: tick lock local-disk and daily-ledger write stale on KV; fleet detection marker-only | ACCEPTED after B3c fixed every item (verified: `live-gate.ts:263`, `gaps/route.ts:101`, `daily-loop.ts:164`, `ledger-stores.ts:69`) |
| B4 | tenancy: apply path | same pass | version N+1 checked in the database, 409 on a lost race, no re-derivation; role enforced in the app only | ACCEPTED after B3c item 8 moved the role check into the database |
| B3c | tenancy: 0005 role claim; spend: lease and fold | tenancy-auditor 2026-09-15 (0005 pass) | no leak: mismatched, stale and missing claims refused at verification, stamped role from the membership row; product consequence: a member could not scan an unrecorded domain; derivation holes; member could displace another's filing | ACCEPTED after B3d decided the member's first record and closed the rest |
| B3d | tenancy: 0006, 0007, derivation; spend: per-workspace ceiling | builder's two passes, oversight verification of every cited line, CI green remotely on 57d93c9 | none open; the spend consequence is row B6 (decided) | ACCEPTED |

| C2 | spend control: the fan-out, the tick route, registration, arming | cost-sentinel 2026-09-15 (independent), after the builder's own two passes | arming conditions, retry ordering, fan-out idempotency and token handling verified clean; **one MUST-fix: `kvLedgerDoc.update` (`ledger-doc.ts:141`) writes the document unconditionally after a `setnx` lease, so a holder stalled past 10 s overwrites a newer reservation and a retry in that window collects a second time**; the per-domain allowance at the mean price lets the day exceed the hard cap by up to $0.02 × domains run; a publish failure past the QStash plan is booked on the mark but surfaces nowhere an operator reads | NOT YET ACCEPTED — row C2r must land first; then ACCEPTED on re-verification |

## Open, not yet reviewable
- C2r, C3: reviewed when they land.
- The pull request into `main`: not a fast-forward. `main` carries PR #3 and PR #4 (the tenancy deploy gate) that the branch lacks; six files conflict (`CLAUDE.md`, `check-deploy.sql`, `check-deploy.test.ts`, `tenant-isolation.test.ts`, `crawl.mjs`, `live-gate.ts`) and `main`'s `0003_tenancy_exposure_manifest.sql` collides with the branch's `0003_accounts_identity.sql` under the number index. Row C0 in MVP_PLAN.md.
