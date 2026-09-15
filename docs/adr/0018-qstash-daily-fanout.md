# ADR-0018 — The QStash daily fan-out: one signed job per tracked domain, through the loop's per-domain path

**Status:** Proposed (MVP_PLAN C1, 2026-09-15). C2 builds the transport and the route; nothing is registered and nothing is armed until the owner's separate go-ahead · **Date:** 2026-09-15 · **Phase:** P3 closing
**Relates to:** ADR-0017 and its amendments (the loop, the cap, the tick lease and the daily-ledger fold, admission per workspace) · ADR-0002 Amendments 1 and 2 (`apps/public` on Vercel; one store per deployment, the ledgers beside it) · ADR-0006 (topology declaration) · ADR-0013 (cycles; "there is no scheduler") · R3 (nothing spends outside the scheduler) · R6 (the cache key is per UTC day) · PRODUCT_GOAL points 6 and 9 · MVP_PLAN B3c, B3d, B6, C1, C2

## Context

ADR-0017 decision 1 chose the loop's home by where the store was: *beside the
store, now* (an OS scheduler on the machine that holds `data-live`, running
`pnpm grader:tick` once a day), and *hosted, after the store moves* (a
schedule hitting a route that runs the same due list against a store the
deployment can reach). It recommended the first then and the second when the
store moved, "with the due list and the tick unchanged between them".

The store has moved. Since 2026-09-10 workspace state lives in Postgres
scoped by workspace (B3a, B3b), the ledgers live in Upstash on the
deployment (B3b), `apps/public` runs on Vercel as functions (ADR-0002
Amendment 1), the tick lock is a lease in the store's ledger document and
every daily-ledger write folds into the stored value (B3c item 3), and
admission is per workspace (B3d item 1). The precondition of the hosted path
is met, and it is the only path that reaches PRODUCT_GOAL point 6 — the
pricing page says "prompts re-check daily", and the audit's one NOT SATISFIED
verdict is that nothing does.

**What exists, on 2026-09-15.**

- `services/grader/src/daily-loop.ts`, `runTick`: the due list, the day's cap
  (`min(Σ tracked expected cost × 1.2, COLLECTION_BUDGET_USD_DAILY)`), the
  live gates in order (armed, both flags, key, plan, hard ceiling, today,
  the runner's ledger), the tick lease, and per domain: admit-and-reserve in
  one exclusive write, the burst-cap-and-quota gate, the per-run allowance,
  `runGrader`, the cycle filed, the reservation settled to the realised
  figure. Verified offline over the collector's in-memory KV double and over
  files (`daily-loop.test.ts`).
- `services/collector/src/qstash.ts` and `qstash-verify.ts`: a hand-rolled
  `QStashClient` (`publish`, `publishCycle`, `schedule`) over `fetch`, and a
  verifier of the `Upstash-Signature` JWT (issuer, subject URL, `exp`, `nbf`,
  the body hash, the current and next keys). Tested, and "never exercised
  against real QStash" (PROGRESS). Built for the per-cell runner of PHASES
  1.1, which nothing calls.
- `apps/public/lib/workspace-access.ts`: the one way a route reaches
  workspace state — the session's one workspace through a minted token on
  the deployment, the file store on a machine, refused on a fleet with
  neither.
- The tracked list: `tracked.json` beside the record store, written by
  `pnpm grader:track`, read by `dueToday`. A file, on one machine.

**The gap, precisely.** There is no trigger on the deployment. The loop is
one process over one store, and the deployment has one store per workspace
and no shared disk: `tracked.json` under `GRADER_DATA_DIR` there is one
instance's `/tmp`, empty on every cold start. And a function invocation is
bounded in time, which the loop was not written for.

## Provider facts this rests on

Fetched 2026-09-15. Vercel's pages carry a `last_updated` date; Upstash's do
not, so the fetch date is the citation and the quoted text is what the page
said that day.

| Fact | Source |
|---|---|
| Maximum duration with fluid compute: "Hobby: 300s default and maximum. Pro and Enterprise: 300s default, 800s maximum, and 1800s extended maximum Beta." "For request handlers, this includes time spent processing the request and sending the response, including streamed responses." Past it, "a 504 error code (`FUNCTION_INVOCATION_TIMEOUT`) is returned." Request and response bodies are capped at 4.5 MB. | Vercel, `/docs/functions/limitations`, last updated 2026-08-24 |
| For the Next.js App Router the duration is set in the route file, `export const maxDuration = N`; `vercel.json`'s `functions` block is the form for other runtimes and for project-wide defaults. Durations above 800 s are per function, beta, Pro and Enterprise only. | Vercel, `/docs/functions/configuring-functions/duration`, last updated 2026-08-24 |
| A schedule is a publish request carrying `Upstash-Cron`. Cron expressions are evaluated in UTC by default; a `CRON_TZ=<IANA zone>` prefix names another zone. "It can take up to 60 seconds for the schedule to be loaded on an active node and triggered for the first time." | Upstash, `/docs/qstash/features/schedules` |
| `POST /v2/schedules/{destination}`. Headers: `Upstash-Cron` (required); `Upstash-Schedule-Id` — "Assign a custom schedule ID to the created schedule", and "If a schedule with the provided ID exists, the settings of the existing schedule will be updated with the new settings"; `Upstash-Retries` (default 3); `Upstash-Timeout`; `Upstash-Method` (default POST); `Upstash-Delay`; `Upstash-Forward-*`; `Upstash-Callback`; `Upstash-Failure-Callback`. The body is delivered as the message. Response `{ "scheduleId": "…" }`. | Upstash, `/docs/qstash/api-reference/schedules/create-a-schedule` |
| `GET /v2/schedules` lists schedules with `scheduleId`, `cron`, `destination`, `createdAt`, `isPaused`, `body`, `header`, `retries`, `lastScheduleTime`, `nextScheduleTime`. `POST /v2/schedules/{scheduleId}/pause`: "the cron trigger will simply be ignored." | Upstash, `/docs/qstash/api-reference/schedules/list-schedules`, `…/pause-a-schedule` |
| Every delivery carries `Upstash-Signature`, `Upstash-Message-Id`, `Upstash-Retried` ("How often the message has been retried so far. Starts with 0."), `Upstash-Schedule-Id` ("if it is related to a schedule"), `Upstash-Caller-Ip`. "The body is passed as is, we do not modify it at all." | Upstash, `/docs/qstash/howto/receiving` |
| The signature is a JWT "signed using `HMAC SHA256` algorithm with your current signing key". Claims: `iss` "is always `Upstash`"; `sub` is "The url of your endpoint, where this request is sent to"; `exp` ("Our JWTs have a lifetime of 5 minutes by default"); `iat`; `nbf`; `jti`; `body` is "a base64 encoded sha256 hash of the request body. We use url encoding as specified in RFC 4648". A receiver verifies `iss`, `sub`, `exp`, `nbf` and hashes "the raw request body using `SHA-256`" to compare with `body`. | Upstash, `/docs/qstash/features/security`, `/docs/qstash/howto/signature` |
| Rolling keys: "the current key will be replaced with the next key and a new next key will be generated"; receivers "should always try to verify with both keys". | Upstash, `/docs/qstash/howto/roll-signing-keys` |
| QStash retries when "your API does not respond with a success status code (2XX)", and aborts a delivery that "does not return within the plan-specific Max HTTP Response Duration". Default 3 retries, exponential backoff `min(86400, e ** (2.5 × n))` seconds (12 s, 2 min 28 s, 30 min 8 s). After the retries "the message will then be forwarded to the Dead Letter Queue". A `489` with `Upstash-NonRetryable-Error: true` is not retried. | Upstash, `/docs/qstash/features/retry` |
| `Upstash-Deduplication-Id`: "The deduplication window is 10 minutes." A duplicate is accepted with the existing message's id and `202 Accepted`; a publish answers `{ messageId, deduplicated }`. | Upstash, `/docs/qstash/features/deduplication`, `/docs/qstash/api-reference/messages/publish` |
| Plans: Free — 1,000 messages a day, max HTTP response duration 15 minutes, 10 active schedules; Pay as you go — unlimited messages, 2 hours, 1,000 schedules. "Each delivery attempt counts as one message." | Upstash, `/docs/qstash/overall/pricing` |

## The structural fact: one invocation cannot run the day

A tick is N cycles in sequence, each a `runGrader` over 85 cells (17 prompts
on five engines) with retries, on a provider that answers in seconds. G3
sizes one hand-started cycle at p95 ≤ 90 s domain-to-first-insight, and the
scan route's `maxDuration` is 300 s for one cycle's stream. At 300 s (the
Hobby maximum and the Pro default) one invocation holds three such cycles
with no margin; at Pro's 800 s about eight; the tracked set is meant to grow
past both, and a function killed at its limit answers QStash a 504, which is
a retry that re-enters collection (R3: a retry can spend). So on a function
host the tick is not one invocation. It is two shapes of invocation, and the
thing that decides which domains run today is separated from the thing that
runs one of them.

## Decision

### D1 — Two jobs, one route, both signed

`POST /api/tick` (`apps/public/app/api/tick/route.ts`, `maxDuration = 300`,
`dynamic = 'force-dynamic'`) accepts two bodies, both published by QStash and
both verified before anything else is read:

```
{ "v": 1, "kind": "fan-out" }
{ "v": 1, "kind": "domain", "day": "2026-09-16", "workspaceId": "<uuid|local>", "host": "acme.example" }
```

The **fan-out** job is the one QStash schedule this deployment has. The
**domain** jobs are what the fan-out publishes: one per due domain, each the
per-domain path of `runTick` (reserve, gate, allowance, collect, file,
settle) for exactly one host in exactly one workspace, in its own
invocation. The route is the transport; the decisions stay in
`services/grader/src/daily-loop.ts`, which the CLI's in-process tick and
the route's jobs share. A branch the route took and the CLI did not would be
where a special case would go, and the loop's own tests would not see it.

### D2 — Verification first, then shape, then everything else

The route reads the raw body as bytes, then `verifyQStashRequest` with the
deployment's current and next signing keys (`QSTASH_CURRENT_SIGNING_KEY`,
`QSTASH_NEXT_SIGNING_KEY`) against the destination `${SITE_URL}/api/tick` —
`SITE_URL` is already the deployment's own origin, never a request header
(CLAUDE.md §7). A request that does not verify is answered `401` and touches
no store, no ledger and no provider. Only then is the body parsed and
matched to one of the two shapes; anything else is `400`. This is the order
`handleCollectJob` established for the per-cell runner and it is kept for
the same reason: an unverified collection endpoint is a public button that
bills us.

### D3 — What the fan-out does

After verification: the loop's live gates, as `runTick` applies them
(`GRADER_DAILY_LOOP=armed`, both collection flags, a provider key, a plan,
`COLLECTION_BUDGET_USD_DAILY`, the runner's ledger with room). A deployment
that is not armed answers `200 { ok: false, outcome: "not-armed" }` and does
nothing: a retry would not change the answer, and the schedule fires again
tomorrow. Then, under the **tick lease** of B3c (the `tick-lock.json`
document in the deployment's ledgers, a setnx with a TTL): read the tracked
list (D6), build the due list per workspace through each workspace's store
(the store twin of `dueToday`), compute the day's cap by the formula of
ADR-0017 decision 2, write the day's entry into the daily ledger with that
cap and a **fan-out mark** (`fanOut: { at, published }`) in one fold, publish
one domain job per due domain through `QStashClient` with
`Upstash-Deduplication-Id: tick:<day>:<workspaceId>:<host>`, release the
lease, and answer `200` with the counts. A fan-out that finds the day already
marked publishes nothing and answers `200 { outcome: "already-fanned-out" }`;
a fan-out that finds the lease held answers `503` (nothing spent, nothing
published; a retry is safe and will find the mark or the free lease).

The fan-out itself spends nothing and publishes in seconds, so its
invocation is far inside 300 s at any tracked-set size the QStash free plan
admits (1,000 messages a day). The tick lease covers the fan-out phase only:
what it protected in B3c — two ticks each authorising the full cap from a
stale view — is now protected by the fold the domain jobs reserve through.

### D4 — What a domain job does, and what "refusing a day already booked" means

After verification and shape: the job's `day` must be today in UTC, or the
job is answered `200 { outcome: "day-passed" }` — a job delivered after
midnight would buy cells under another date bucket (R6) and a fresh cap,
which is the re-collection ADR-0017 refuses for `--day`. Then the same live
gates as the fan-out (the owner may have disarmed between the two). Then the
workspace's store for the job's `workspaceId` (D6). Then **reserve** under
the day's cap in one exclusive write against the daily ledger, in the
job-shaped form: the day must already carry the fan-out's entry (no fan-out
today ⇒ `200 { outcome: "no-fan-out" }`; a domain job is only ever valid
after the fan-out booked the day), and **any line for this host today,
running or settled in any status, refuses the job**:
`200 { outcome: "already-booked" }`, nothing collected, nothing charged.
This is the idempotency on retry. QStash retries every non-2xx and every
timeout, and a retry re-enters this route with the same body; the host's
line, written before the first attempt collected and settled after it, is
what a retry meets. The in-process tick keeps its own rule (a host whose
earlier attempt today finished is admitted again, its line becoming the
latest attempt), because there a second tick is a person's second command,
not a transport's retry.

Then, exactly as the loop: the burst-cap-and-quota gate (a refusal gives the
reservation back), the per-run allowance (the smaller of the cycle's cells
with headroom and what the cap has left at the mean price), `runGrader` in
live mode with the workspace's store and the deployment's ledgers, the cycle
filed through `ws_put_cycle`, `recordScan`, and the reservation settled to
the realised figure. The answer is `200` with the outcome
(`scanned`, `no-answers`, `failed: …`, `refused-before-call`). **A collect
that throws is settled at the expected cost with headroom and answered
`200`**, not `5xx`, because the spend may have happened and a retry would
spend again — the R3 shape `qstash.ts` states: a non-2xx must mean "nothing
was spent and trying again is safe". Only three answers are non-2xx, and
each is provably before any spend: `401` (not QStash), `400` (not a job),
`503` (the deployment is not configured for this — no signing key, no store,
no ledgers, no QStash token — or a ledger lock could not be taken).

A job Vercel kills at `maxDuration` answers QStash a 504; the retry meets the
host's `running` line and books nothing; the reservation stands at the
expected cost with headroom, the over-booking direction, for a person to
repair — the same state a tick that died leaves (B3c). Nothing here reads the
`Upstash-Retried` header to decide: idempotency comes from the ledger, not
from trusting a header.

### D5 — Whose cap, and where it is read

The cap is the fan-out's decision for the day, stored in the day's ledger
entry (`capUsd`), and a domain job reads it there rather than recomputing
the formula. Recomputing would mean every job opening every workspace's
store (N² reads for N domains) and could yield a different cap mid-day when
tracking changes; the fan-out's figure is the day's, as `runTick`'s is the
tick's. The hard ceiling `COLLECTION_BUDGET_USD_DAILY` is read from the
environment by the fan-out when it computes the cap; a domain job re-checks
that the ceiling is set (the arming gate) and trusts the stored figure for
its size.

### D6 — Whose store a job opens, and where the tracked list lives

**The tracked list is a document in the deployment's ledgers**:
`tracked.json`, read and written through `ledgers.doc('tracked.json')`,
which on a machine IS the file `tracked.json` the CLI has always written
(the file ledger document is the file), and on the deployment is the
Upstash document beside the daily ledger and the tick lease. It is the
loop's list — which domains the deployment re-checks daily, switched on by
whom and why — and the loop is deployment-wide with one cap, so it lives
with the loop's other state and not inside any one workspace. An entry is
`{ host, workspaceId, by, role, since, reason }`; an entry written before
this ADR has no `workspaceId` and is read as `local`. A corrupt document is
a refusal of the whole fan-out, as a corrupt file is of the tick.

**On a machine** (identity off, `COLLECTOR_TOPOLOGY=single-process`) a job
opens the file store over `GRADER_DATA_DIR`, as every route does; a fleet
runtime with identity off is refused (ADR-0002 Amendment 2).

**On the deployment** (identity on) a domain job opens the workspace the
entry names through a token minted for the account that switched the domain
on, with the role the entry recorded:
`mintWorkspaceToken(key, { sub: entry.by, workspaceId: entry.workspaceId, role: entry.role })`.
The database verifies that token exactly as it verifies a session's — the
key, the lifetime, that the account is a member of that workspace, and that
the role claim agrees with `workspace_members` (migration 0005) — and
refuses it otherwise; the job then answers `200 { outcome: "refused" }`
with the cause in the log and nothing spent. So the daily re-check is the
standing instruction of the person who gave it, it runs with exactly the
rights they had, and it ends when their membership does. `ws_put_cycle` is
not a decision (0005 keeps it open to every member), so any member's
instruction suffices to file a cycle; the fan-out's reads (record, prompt
set, cycles) are every member's too.

⚠️ HUMAN REVIEW REQUIRED: tenancy. A scheduled job presenting a token minted
in a person's name, with no session behind it, is a new use of the token
minter. The alternative is a service identity for the loop — a `role: 'loop'`
claim `set_workspace_jwt` understands, or a definer path that enters a named
workspace for the loop alone — which is a change to the verifier and the
tenancy model, a human's to design (CLAUDE.md §4). This ADR chooses the
instruction-of-the-tracker model for the MVP because it needs no new
definer function and the database re-checks membership on every
presentation; the owner may replace it.

**The write path on the deployment is not in C2.** `pnpm grader:track`
writes the file with `workspaceId: local` and stays a machine's CLI. On the
deployment nothing writes `tracked.json` yet, so a fan-out there finds
nobody tracked and publishes nothing — safe, and honest about what point 6
still needs: **C3**, tracking as a workspace action (a `POST /api/tracked`
an owner or admin makes from the record, writing the entry with the
session's account, workspace and role after checking the record exists in
the store), and later D2, where a plan's tracked-host count gates it (B6).

### D7 — The mode comes from the environment, never from the body

`GRADER_DAILY_LOOP=armed` is live: the jobs spend, under every gate above.
`GRADER_DAILY_LOOP=fixture` runs the same two jobs offline through the
fixture adapter — the proof of the whole route path without a provider — and
is honoured **only with identity off**: a fixture cycle is a stored cycle
carrying `run.mode: "fixture"`, the record does not yet label it, and a
deployment holding customers' workspaces must never be able to file one. Any
other value, or none, is off: both jobs answer `200 not-armed` and touch
nothing. The body carries no mode and no flag; a field there is a field
nothing reads, as with a workspace named in a request body (ADR-0002
Amendment 2).

### D8 — Registration and arming are two acts, both the owner's

`pnpm grader:schedule` (`services/grader/src/schedule.ts`) prints the
schedule it would register — destination `${SITE_URL}/api/tick`, cron
`GRADER_TICK_CRON` (default `15 6 * * *`, 06:15 UTC), schedule id
`bliprank-daily-tick`, body `{ "v": 1, "kind": "fan-out" }`, retries 2 — and
registers it only with `--register`, through the existing
`QStashClient.schedule`, which needs `QSTASH_TOKEN` and `SITE_URL` in the
shell that runs it. The chosen schedule id makes a second `--register` an
update of the one schedule, never a second schedule. `--list` shows what
QStash holds; `--pause` and `--resume` are the reversible stop. Nothing in
a session registers, pauses or arms: the pre-spend hook is not the guard
(registration spends nothing by itself) — the guard is that `--register`
without the token refuses, the token lives only in the owner's shell and the
deployment's environment, and the deployment spends nothing until
`GRADER_DAILY_LOOP=armed` is set there too. Two acts, as ADR-0017 required
of the OS task: the schedule exists, and the loop is armed.

New variables (CLAUDE.md §7): `QSTASH_TOKEN` (the fan-out publishes with it;
the CLI registers with it), `QSTASH_CURRENT_SIGNING_KEY` and
`QSTASH_NEXT_SIGNING_KEY` (the route verifies with them), `GRADER_TICK_CRON`
(optional). `SITE_URL` is reused as the destination.

### D9 — The bounds, stated once

A **loop job** runs under the daily cap (ADR-0017 decision 2), reserved and
settled through the daily-ledger fold (B3c item 3), behind the tick lease on
the fan-out (B3c item 3), with the per-run allowance (ADR-0017), one cycle
per UTC day (ADR-0013), and the burst cap and the provider's quota at the
gate. A **hand-started cycle** from the record runs under none of the first
three — it never reads `daily-spend.json` or takes the lease — and under the
per-workspace monthly ceiling of B3d item 1 (`${workspaceId}:${host}`,
ADR-0017 Amendment 2), the per-visitor throttle, the burst cap, the
provider's quota, the per-run allowance and the lifetime ledger. The two
usage patterns keep their two sets of bounds; this ADR moves the loop's
transport and adds no bound to either. The B6 spend decision (hand-started
spend has no bound that scales with the number of workspaces until D2
gates hosts per workspace by plan; `GRADER_MAX_NEW_SCANS_PER_DAY` is the
operator's lever until then) is recorded in ADR-0017 Amendment 2, where the
per-workspace ceiling already is.

### D10 — Idempotency, the three guards

1. **QStash's own**: the deduplication id `tick:<day>:<workspaceId>:<host>`
   collapses a domain job published twice within ten minutes (a fan-out
   retried after a `503`).
2. **The day's ledger**: the fan-out mark refuses a second fan-out for the
   day after the window; the host's line refuses a second domain job for the
   day at any time.
3. **The store**: `ws_put_cycle` on the same host, day, version and basis is
   an upsert of the same measurement, and `dueToday` lists a host with a
   cycle today as `cycle-today`.

Each holds without the others.

## What this ADR does not decide, and what C2 deliberately does not do

- No schedule is registered, no live tick runs, no credential enters the
  repository or a session's environment, and `SCHEDULE_FACT` on the record
  and the new-cycle panel is unchanged until a live tick has filed a cycle
  (ADR-0017 "what is deliberately not done").
- No write path for the deployment's tracked list (C3), no service identity
  for the loop (the owner's alternative to D6), no entitlement gate (D2).
- No `Upstash-Failure-Callback`, no dead-letter reader: a job that failed
  after spending is a `200` with the outcome in the body and a line in the
  day's ledger, which is where an operator reads the day; the QStash DLQ
  would hold only `503`s.
- No timezone: the cron is UTC because the cache key's day is UTC (R6).
- The Vercel plan is not chosen here. At Hobby, a domain job has 300 s for
  one cycle, which the scan route already relies on; a Pro plan may raise
  the route's `maxDuration` to 800 s in the route file and nowhere else
  (ADR-0002 Amendment 1). The fan-out is unaffected by either.

## Consequences

- Point 6 becomes a matter of two acts by the owner (register, arm) once
  C2 and C3 land, and stays honestly NOT SATISFIED until a live tick has
  filed a cycle on the deployment.
- The loop's decisions are shared between the CLI and the route by
  construction: `daily-loop.ts` exports the per-domain path the CLI's
  in-process tick and the route's domain job both call, and the due list
  has a file twin and a store twin as every module of B3b has.
- Every domain job is its own invocation with its own 300 s, so the
  tracked set can grow without a tick outgrowing its function; the cost is
  one QStash message per due domain per day plus one for the fan-out, which
  the free plan's 1,000 a day covers to about 900 tracked domains.
- The deployment learns four new variables and the record's tracked list
  moves from a file a person edits with a CLI to a ledger document a route
  will write (C3).

## Verification, without spending (C2's tests, all offline)

`schedule.test.ts`: the registration body and headers (destination, cron,
schedule id, retries) through a stubbed `fetch`; refused without the token
or `SITE_URL`; the CLI without `--register` prints and calls nothing.
`apps/public/app/api/tick/route.test.ts`: an unsigned request is `401` and
opens no store; a token for another URL or another key is `401`; a
malformed body is `400`; not armed is `200 not-armed` with nothing
published and nothing booked; over the in-memory KV double, a fan-out
publishes one domain job per due domain with the deduplication id and
books the day's cap, and a second fan-out the same day publishes nothing; a
domain job reserves, gates, collects (the runner mocked), files and settles,
and the same job again is `200 already-booked` with no collect; a job for
yesterday is `day-passed`; a job for a day the fan-out did not book is
`no-fan-out`; a collect that throws is settled at expected and answered
`200`. Over PGlite with identity on: the domain job's store is the entry's
workspace through the minted token, the cycle lands in that workspace and
not in another, and an entry naming an account that is not a member is
refused at the database with nothing collected. Over the file store with
identity off: the fixture-mode fan-out and domain job through the real
route and the real runner file a cycle marked `fixture`, and the next day's
due list says `cycle-today`.
