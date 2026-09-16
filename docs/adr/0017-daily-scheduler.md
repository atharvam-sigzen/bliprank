# ADR-0017 — The daily scheduler: what exists, what is missing, and the three decisions before a loop runs

**Status:** Accepted for decisions 1 and 2 on 2026-09-07 (the loop and the cap are built and verified offline; the first live tick waits for a separate, explicit go-ahead); the ceiling question below is open · **Date:** 2026-09-03, amended 2026-09-07 · **Phase:** P3 closing, looking at P4
**Relates to:** R3 (nothing spends outside the scheduler) · R5 · ADR-0002
(hosting topology: Fluid Compute + QStash through P3, a worker fleet after)
· ADR-0003 (cache key and R2 object unit) · ADR-0013 (cycles; "there is no
scheduler") · ADR-0016 (correctable context, which a cycle now carries) ·
PHASES 1.1 and PROGRESS (the QStash runner, built and "never exercised against real QStash")

## Context

The product promise is a daily re-check of every tracked prompt on every
engine. `SCHEDULE_FACT` on every surface says "daily (intended); nothing
schedules a cycle yet, a person starts each one from the workspace record",
and that is still true. This ADR is the audit of what a scheduler needs, what
the repository already holds, and the decisions that are the owner's before a
loop is switched on. It builds the one piece that needs no decision.

## What exists, audited on 2026-09-03

**A per-cell production runner (PHASES 1.1, `services/collector/src/qstash.ts`).**
A `QStashClient` that publishes one `CollectJob` per cell with a deduplication
id derived from the cell's R2 key, and can create a QStash cron schedule; a
handler that verifies each delivery cryptographically (`qstash-verify.ts`:
issuer, destination, expiry, not-before, body hash, two keys for rotation)
and hands the cell to `CollectionOrchestrator`; a status mapping that makes
non-2xx mean "nothing was spent"; a `CollectionHeartbeat` that alarms on the
absence of success. All of it tested in `qstash.test.ts`, none of it ever
called by anything:
"QStash has a handler nothing calls" (PROGRESS). It collects cells; it does
not score them into a cycle.

**A per-domain cycle runner (`services/grader/src/run.ts`, `runGrader`).**
Everything a cycle is: the recorded category (ADR-0009), the competitor
override and the custom prompt set at their versions (ADR-0016), the cells,
the budgeted orchestrator, the scorer, the basis, the result file. The
workspace record's "Collect a new cycle" button runs it through `/api/scan`,
behind the gates: both enable flags, a provider key, the per-visitor throttle,
the per-domain monthly ceiling, the burst cap and the provider's own quota,
the one-cycle-per-UTC-day rule, and the basis-mismatch refusal. `writeCycle`
files the result beside every earlier cycle.

**A local file store.** Records, overrides, prompt sets, requests, the answer
index and blobs, the ledgers and every cycle live under
`services/grader/data-live` on one machine. The public app's routes read and
write it; the static deployment has none of them.

**The gap, precisely.** There is no list of which domains to collect daily,
no trigger, and no place a trigger could run that also holds the store. The
QStash runner runs on a host and collects cells into R2; the cycle runner
runs beside the file store and files results. Joining them means either
moving the store off the machine (the P4 topology in ADR-0002) or running the
trigger on the machine.

## Decision 1 — the due list is built, and it is the bill (landed)

`services/grader/src/due.ts` is the pure function every transport would call:
given the store, the environment and a UTC day, which tracked domains are due
and what they would cost. It applies the refusals a person's click meets: a
record and a bank, no cycle yet today, the prior cycle's prompt count and
engine set unchanged, room under the per-domain ceiling. It prices the cells
at the plan's marginal rate, pay-as-you-go when unset.

The list mirrors the gates that are facts about the store. It does not mirror
the two enable flags, the provider key, the shared burst cap, the provider's
remaining quota, or the per-visitor throttle (a cron has no visitor); a loop
must still meet those at run time, and the tick says so. The bill is an upper
bound on what the store permits, not a promise of what the provider will.

`pnpm grader:tick` prints that list and refuses `--apply`: it is the bill,
printed before anything is incurred, and a person still starts each due cycle
from the record. `pnpm grader:track -- --domain x --on --reason "…"` is the
opt-in: a category record exists for every domain anyone ever previewed, demo
lookups included, and collecting all of them daily would bill for curiosity.
Tracking is a file beside the record store, written by a person with a
reason; a corrupt file is an error, never an empty list. Whether a paying
workspace is switched on automatically when a plan is attached is a billing
question, and no billing exists, so opt-in by a person is the whole of it.

## The two decisions, which are the owner's

1. **Where the loop runs.** Two honest options, and the store decides between
   them.
   - *Beside the store, now:* an OS scheduler (Task Scheduler on this machine,
     or cron wherever the store is copied) running `pnpm grader:tick --apply`
     once a day, which would call `runGrader` for each due domain through the
     same gates as `/api/scan`. Zero new infrastructure; the machine must be
     on; one process, one store, no concurrency question.
   - *Hosted, after the store moves:* a Vercel cron or a QStash schedule
     hitting a route on `apps/web` that runs the same due list against a
     store in R2 and Postgres. This is ADR-0002's P0–P3 shape and it needs
     the P4 work first: the record, override, prompt and cycle stores as
     tables or objects, the index in Redis. The QStash handler already
     built would then take the cells.
   The recommendation is the first now and the second when the store moves,
   with the due list and the tick unchanged between them. That is what a
   pure due list is for. A cron meets the route's gates minus the visitor
   throttle, which has no visitor to key on.

2. **What it may spend, per day and per domain.** The per-domain ceiling
   (ADR-0013) was derived for two cycles a month with retry headroom: 204
   calls at 17 prompts. A daily loop is thirty cycles a month, fifteen times
   that. The ceiling must be re-derived from the cycle count the product
   sells (`CYCLES_PER_MONTH` becomes a daily-loop figure, or the ceiling
   becomes a per-day figure) and a global daily budget. `COLLECTION_BUDGET_USD_DAILY`
   is documented in CLAUDE.md §7 and `.env.example` and nothing reads it; the
   cap the runner actually honours is `GRADER_CAP_USD` per run. Decision 2
   must name where a daily budget is read and enforced. The tick prints the
   arithmetic: at pay-as-you-go a 17-prompt domain is $0.578 a cycle, so
   $17.34 a month per domain at one cycle a day, before retries and before any
   custom prompts. Nothing here can be built without the owner naming the
   figures.

## Amendment, 2026-09-07 — decisions 1 and 2 confirmed and built

The owner confirmed: the loop runs local-first, beside the store, invoked by
the OS scheduler; the daily cap is a formula over the tracked set's real
expected cost with retry headroom, recomputed live, enforced fail-closed; the
hosted path stays a documented migration; and the first live tick needs a
separate, explicit go-ahead. `services/grader/src/daily-loop.ts` is that.

**What one tick does.** The due list; the day's cap; then, only with
`--apply`, each due domain in order through `runGrader` (the record, the
override, the custom set, the budgeted orchestrator, the scorer, the cycle
file), booking realised spend and calls into `daily-spend.json` after each
domain, writing the burst-cap and ceiling ledgers as `/api/scan` does. A
second tick the same day runs nothing: every domain is `cycle-today`.

**The cap, exactly.**
`min( Σ_tracked (curated + custom) × Σ_engines price[plan] × RETRY_HEADROOM ,
COLLECTION_BUDGET_USD_DAILY )`. The formula is the bill the tracked set
implies; the hard ceiling is the owner's figure, and it is the variable
CLAUDE.md §7 documented as "enforced by the collector" while nothing read it.
Now something does: a live tick refuses when it is unset or not a positive
number. Before each domain the loop refuses a cycle whose expected cost with
headroom does not fit in what is left; the check is against the cap
recomputed on this tick, so tracking a domain raises the cap by exactly its
cost and untracking lowers it. Realised spend is the runner's own ledger
delta; a run that reports no figure is booked at the expected cost with
headroom; a run the runner refused before any call (its `run.lock` held) is
booked at zero.

**What the cap does not bound, said plainly.** It gates which domains
start. A run, once started, is bounded by the runner's lifetime ledger
(`ledger.json`, capped per data dir), because passing a smaller per-run cap
lowers that ledger's cap for good and the collector's `Budget` is spend
control a human owns. A retry storm inside one run can therefore spend up to
that ledger's remaining cap and is then booked against a day already closed.
So the tick also refuses to start when that ledger is exhausted or holds
less than the day's cap, which is what stops a loop ticking daily to zero
effect after the eighth pay-as-you-go cycle. A per-run allowance in `Budget`
is the next step, and it is ⚠️ HUMAN REVIEW REQUIRED: spend control.

**Every refusal of a live tick, in order:** the loop not armed
(`GRADER_DAILY_LOOP=armed`), either collection flag off, no provider key, no
plan, no hard ceiling, a `--day` that is not today (a named day would buy
cells under another date bucket and a fresh cap), the runner's ledger
exhausted or short, another tick's lock, and, per domain, the burst cap and
the provider's quota. `--apply` alone is refused: `--fixture` (offline) or
`--live` (spends) must be named on the command line, so an environment that
happens to be armed cannot make a hand-typed apply spend.

**Registering the task, when the go-ahead comes.** Not done by this code
and not done in this session. On this machine:

```
schtasks /Create /SC DAILY /ST 06:15 /TN "BlipRank daily tick" /TR "cmd /c cd /d D:\bliprank && pnpm grader:tick -- --apply --live >> services\grader\data-live\tick.log 2>&1"
```

with `GRADER_DAILY_LOOP=armed`, `COLLECTION_ENABLED=true`,
`GRADER_LIVE_SCAN=true`, `OPENWEBNINJA_PLAN` and
`COLLECTION_BUDGET_USD_DAILY` set in that task's environment and nowhere
else. Unregistering the task, or unsetting `GRADER_DAILY_LOOP`, stops it.

**Verified offline.** `daily-loop.test.ts`: the cap moves with tracking and
custom sets; the hard ceiling bounds it; the loop books realised spend and
calls, files the cycle, and runs nothing on a second tick; the cap refuses a
domain that does not fit after a storm; a missing spend figure books
expected; a thrown collector books expected and the loop continues; a
`run.lock` refusal books zero; the corrupt ledger, the tick lock and every
live gate refuse in order; and the real runner in fixture mode collects a
tracked domain, files it, and honours one cycle per day. `pnpm grader:tick`
run as typed: dry, `--apply` refused, `--apply --live` refused as not armed,
`--apply --fixture` filing two cycles on a scratch store. The live store was
not written.

## The ceiling tension, worked with real numbers

Computed with the real functions (`ceilingFor`, `checkDomainCeiling`,
`recordDomainCalls`) against scratch ledgers on 2026-09-07. Pay-as-you-go:
$0.0068 per call averaged over five engines; 17 prompts = 85 cells = $0.58 a
cycle; 32 prompts = 160 cells = $1.09. The ceiling today is
`ceil(2 × cells-this-cycle × 1.2)`, recomputed from the domain's current
prompt count on every request, while the month's ledger of calls is not.

**A. The set shrinks mid-month: an unfair refusal.**

| Day | Cycle | Ceiling | Verdict |
|---|---|---|---|
| Sep 1 | 17 curated + 15 own, 160 calls | 384 | allowed, used 0 + 160 |
| Sep 8 | same, 160 calls | 384 | allowed, used 160 + 160 |
| Sep 15 | customer clears the set; 85 calls | 204 | **refused**, used 320 + 85 > 204 |
| Sep 22 | 85 calls | 204 | **refused**, used 320 + 85 > 204 |

The domain did exactly the two cycles the ceiling was designed to allow and
is locked out for the rest of the month by its own change of mind.

**B. The set grows mid-month: an over-collection nobody decided.**

| Day | Cycle | Ceiling | Verdict |
|---|---|---|---|
| Sep 1 | 17 curated, 85 calls | 204 | allowed, used 0 + 85 |
| Sep 8 | 85 calls | 204 | allowed, used 85 + 85 |
| Sep 12 | 85 calls | 204 | **refused**, used 170 + 85 > 204: the designed two are spent |
| Sep 15 | customer adds 15 own; 160 calls | 384 | **allowed**, used 170 + 160 ≤ 384 |
| Sep 22 | 160 calls | 384 | refused, used 330 + 160 > 384 |

Designed month at 17 prompts: 2 cycles, 170 calls, $1.16. What B allows:
3 cycles, 330 calls, $2.24, 94% over the designed spend, triggered by a
customer's edit rather than by anyone's budget decision. The daily cap now
bounds the money; the ceiling's *cycle count* is what moves.

**C. A daily loop against the same ceiling, 17 prompts, nothing changed.**

| Day | Verdict |
|---|---|
| Sep 1 | allowed, 0 + 85 ≤ 204 |
| Sep 2 | allowed, 85 + 85 ≤ 204 |
| Sep 3 | **refused**, 170 + 85 > 204 |
| Sep 4 | refused |

A daily loop needs 2,550 calls a month at 17 prompts ($17.34); the ceiling
admits 204. With the loop, every tracked domain is `not due: ceiling` from
the third day of every month.

**The shape of the problem.** The ceiling is a monthly call budget derived
from a cycle count of two, denominated in calls, with a limit that follows
the cycle size and a ledger that does not. Under ADR-0016 the cycle size
became customer-editable, and under this ADR the cycle count became thirty.
Both of its inputs moved and it kept its 2026-09-02 shape.

**Options, for the decision.**

1. *Denominate the ceiling in cycles, not calls.* Count cycles per domain
   per month; allow `CYCLES_PER_MONTH` of them; bound each cycle's realised
   calls at `cells × RETRY_HEADROOM`. A set change alters the cost per cycle
   (the daily cap's business) and never the number of cycles. A and B both
   resolve; C needs `CYCLES_PER_MONTH` raised to 31 for tracked domains.
2. *Retire the monthly ceiling under the loop and keep the two bounds that
   remain true:* one cycle per UTC day (already enforced) and the daily cap
   (now enforced), plus a per-cycle realised-call bound of
   `cells × RETRY_HEADROOM`. Simplest; loses the "one domain cannot use up
   everyone's quota" story for a domain a visitor scans by hand, which the
   per-visitor throttle and the burst cap still cover.
3. *Freeze the ceiling at the month's first cycle size.* Fixes A, not B, and
   not C.

Recommendation: option 1 for hand-started scans and option 2's bounds for
tracked domains, which is one rule stated twice: a domain gets its cycles,
each bounded in calls, and the money is the daily cap's. This is spend
control (CLAUDE.md §4) and is not built until decided.

**Decided 2026-09-07, by the owner: the split, as recommended. Built.**

*Hand-started scans* (`domain-ceiling.ts`): the per-domain ceiling is
re-denominated from calls to cycles. It was always call-denominated (170,
then the derived 204); what is restored is the intent ADR-0013 sized it by,
two occasional manual cycles a month, now enforced as a count.
`CYCLES_PER_MONTH` hand-started cycles a month; a cycle that reached the
provider counts one, with the calls it realised recorded beside it; a cycle
served entirely from cache counts none. A change to the domain's prompt set
changes what a cycle costs and never how many it gets. The environment
override is `GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH`, an integer of cycles;
the old call-denominated override, `GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH`,
is an error when set rather than a silence, naming the new key. A ledger
written before the split, a bare call count per domain, is read as the
nearest whole number of cycles at the prompt count in force, at least one,
so a domain mid-month keeps its history; the mapping is transitional, one
month. A run that burned calls and returned nothing counts as a started
cycle, which is what the ceiling exists for, and the refusal says "started".
The loop never books this ledger.

Two things this section first left as they were, fixed later the same day
(2026-09-07, in the orchestrator, human-owned and flagged for review):

- **The held claim.** An allowance stop, a cap stop, an abort, a dead-lettered
  run or a throw left the current cell's index claim held for its lease (up to
  thirty minutes), so a re-run inside that window reported the cell as claimed
  elsewhere and the run as `scanned` with one cell short (measured on a
  scratch store: 3 of 4 cells, no provider call, the counts said so and the
  status did not). The index had no release. It has one now: the claim is
  released on every exit from the orchestrator, only by its owner, by an
  atomic compare-and-delete, and the lease is once again only the crash
  guard it was described as. The same scenario re-run as a test
  (`ceiling-worked-examples.test.ts`, block D) completes the fourth cell with
  one call. Completing a partial cell was also found to re-buy the runs
  already stored; it now buys only the missing ones (`collect-cell.test.ts`,
  B2).
- **The stream's word for the stop.** The orchestrator said
  `budget-exhausted` for both the run's allowance and the ledger's lifetime
  cap, which are different facts: after the first the store has money and the
  next run starts clean, after the second it does not. An allowance stop is
  now its own outcome, `allowance-exhausted`, on the stream and in the
  counts.

ADR-0013 §"the derived form" is superseded by this section.

*The loop* (`daily-loop.ts`): one cycle per UTC day and the daily cap, as
built, plus the per-run allowance below. The manual ceiling is not consulted.

*The per-run allowance* (`Budget.runAllowanceCalls`, in the collector): the
most attempts one run may make, retries included. Checked before every
attempt and before the lifetime cap, so a refusal is about the run and never
marks the ledger exhausted; the orchestrator stops the run the way it stops
on the lifetime cap. `runAllowanceFor(cells) = ceil(cells × RETRY_HEADROOM)`:
102 at 17 prompts on five engines, 192 at 32. The route passes it for a
hand-started cycle; the loop passes the smaller of it and what is left of the
day's cap divided by the cycle's mean price per attempt, so a single run's
realised spend, retries included, is bounded by the daily cap to within the
retries' price spread (about $0.02 a run at pay-as-you-go: the dearest
engine's price less the mean, over the headroom). The mean and not the
dearest, because at the dearest price the last domain of a day, whose
remaining cap is about its own expected cost with headroom, would get 90
attempts for 85 cells instead of 102 and be truncated on its first retries.
Since the cap gate itself sits at expected cost × headroom, a domain that
starts always has its full allowance paid for at the mean price; the
division is a belt under that brace, tested both ways. The CLI
derives its allowance from its bill unless `--allowance` names one; a
re-derivation passes zero and discards a partial result, so a cell the
pre-flight missed is refused before it is bought.

*The three scenarios, re-run under the split* (`ceiling-worked-examples.test.ts`,
same numbers as above, scratch ledgers, the real `Budget`, the real runner
offline):

| Scenario | Under the old ceiling | Under the split |
|---|---|---|
| A, set shrinks after two cycles | third cycle refused because the set change moved the limit: `320 + 85 > 204` | third cycle refused on the count: `2 of its 2 hand-started cycles`, the same refusal at any set size; October clears it |
| B, set grows after two cycles | a third cycle admitted: `170 + 160 ≤ 384`, 330 calls, $2.24 | the third cycle refused on the count at 85 cells and again at 160; the month is 170 calls, $1.16, as designed |
| B, one big cycle | nothing bounded a run | a 160-cell run that retried every cell is stopped by `Budget` at attempt 192 |
| C, thirty daily ticks | `not due: ceiling` from day 3 | thirty cycles filed, each under that day's cap, each handed an allowance of 102 (offline; live, the last domain of a day is bounded by what the cap has left, tested); the manual ledger never written, the file absent; a hand-started cycle that month still has both of its own |
| C, a storm in one run | discovered in the ledger afterwards | the real runner, offline, given an allowance of 3 for a 4-cell cycle, made 3 attempts and stopped; the next run started clean |

⚠️ HUMAN REVIEW REQUIRED: spend control. `Budget.runAllowanceCalls` is a
change inside the collector's budget class; `domain-ceiling.ts` changed its
denomination; the route and the loop pass allowances derived from
`RETRY_HEADROOM`. Nothing about arming, the hard ceiling's value, or the
scheduled task was touched.

## What is deliberately not done

- No timer in the process, no self-registration with any scheduler, and no
  live tick in this session. The task above is a person's act after the
  go-ahead.
- No change to `SCHEDULE_FACT` until the task is registered and a live tick
  has filed a cycle. It is still true.
- No per-run allowance in `Budget`, and no change to the monthly ceiling.
  Both are the open decisions above.
- No move of the store. That is P4.

## Verification, without spending

`due.test.ts`: nothing tracked means nothing due; a tracked domain is due
with its cells and cost, a custom set adds to them; not due for a cycle
today, for a prior cycle on another basis, for a domain over its ceiling,
for a domain whose bank is gone. `pnpm grader:track` and `pnpm grader:tick`
run on a scratch store; `--apply` refused. The live store was not written.


---

# Amendment 1 — the ledger raised, and the lifetime model flagged for later

**Status:** Accepted · **Date:** 2026-09-07

## The raise

The runner's lifetime ledger for `data-live` went from **`$5.00` to `$300.00`**
at the owner's instruction, by editing
`services/grader/data-live/ledger.json` — which is the only mechanism, because
`Budget`'s constructor throws on any raise passed in code ("raise it deliberately
by editing the ledger"). Only `capUsd` changed; `spentUsd`
(`2.1399999999999895`), `calls` (399), `byEngine` and `updatedAt` are
byte-identical, and `remainingUsd()` read back through `Budget` itself is
**`$297.860`**.

The reasoning is runway, not appetite: at pay-as-you-go worst case, 5 tracked
domains on 17-prompt daily cycles is `$2.890/day`, so `$297.860` is about
**103 days — 3.4 months**. Real runway, and still bounded.

## A raise could be silently undone. Fixed the same day.

`Budget` lowers its cap whenever it is opened with a smaller one, and persists
that on the first **charged** call — not on construction, which is why a first
probe of this looked clean and why the failure would have been invisible until
money moved. Measured on a copy of the real ledger: opened at `$5` the file
stayed `$300`, and the first `charge()` wrote `$5`, leaving `$2.853`.

Two callers open the ledger, and they disagreed:

| caller | cap passed, before | |
|---|---|---|
| the daily loop | `ledgerCap(dataDir)`, a private helper | safe — it read the file's own cap back |
| `/api/scan` | `GRADER_CAP_USD ?? DEFAULT_CAP_USD` = `5` | **rewrote the cap to `$5`** on its first charged call |

One hand-started cycle from the workspace record, on a server where nobody had
exported the variable, undid the `$300` raise and said nothing.

**The root cause was one rule with two implementations, only one of which
protected the ledger** — and the private one was the correct one, so the route
had no way to inherit it. `ledgerCap` moved into `live-gate.ts` as the exported
`ledgerCapUsd(dataDir, env)`, the daily loop's copy was deleted, and the route
now calls the same function. The failure mode is gone by construction rather
than by anyone remembering an environment variable.

`GRADER_CAP_USD` was kept rather than deleted, and narrowed: it names the cap a
**new** ledger is created with, and can no longer lower an existing one.
Deleting it would have been simpler and would have quietly changed what a
documented `.env.example` setting does — a reader setting it to `1` would get
`300` with no explanation.

Pinned by `apps/public/app/api/scan/ledger-cap.integration.test.ts`, which runs
a real scan through the route with the variable unset and asserts the charge
happened **before** asserting the cap survived it — because "the cap is
unchanged" is trivially true of a run that never spent anything, which is
exactly the mistake the first probe of this defect made. Reverting the route to
the old rule makes it fail with `expected 5 to be 300`.

⚠️ **HUMAN REVIEW: spend-control logic.** The change is small and the tests are
above, but this is the layer that decides what may be charged.

## ⚠️ Open, for later — the lifetime model is a testing shape, not an operating budget

`Budget` is a **lifetime total for a data directory that never refills**. Every
call ever made counts against one number until a person edits the file. That is
exactly right for what it has been protecting: a pre-revenue store where the
worst outcome is a retry bug and the best defence is a hard stop that a human
must consciously lift.

It does not survive contact with paying customers. A budget that only ever
decreases means:

- the cap has to be raised by hand on a cadence nobody scheduled, and the raise
  is a file edit rather than an accounting event;
- the number stops meaning anything a finance person recognises — it is neither
  a monthly spend, a per-customer cost, nor a rate;
- there is no natural point at which "we spent X in September" can be read off,
  because September is not a boundary the ledger knows about;
- and the failure mode is the worst kind of quiet: collection stops for everyone
  at once, mid-month, because a counter that started in August finally reached
  its number.

The likely shape is a **recurring budget with a reset boundary** — monthly is
the obvious one because it matches how the provider bills and how a customer
plan is priced — with the lifetime cap kept underneath it as the runaway guard
it is good at being. `daily-spend.json` (ADR-0017) already does this per day and
is the working precedent: a keyed record with a per-period cap, plus the
lifetime ledger behind it. The per-period budget would sit between them.

**Not a task, and deliberately not built now.** It is a billing question before
it is a code question: what the period is, whether it is per-store or
per-workspace, what happens to an in-flight cycle at the boundary, and who is
told when it binds. None of those can be answered before there is a customer and
a plan. Flagged here so the lifetime model is a recorded decision with a known
expiry rather than an assumption nobody revisits.

# Amendment 2 — admission is per workspace, spend bounds are deployment-wide (2026-09-15, MVP_PLAN B3d item 1)

Decided by the oversight session after the B3c tenancy audit (MAJOR 2), the
owner may overrule. The per-domain monthly ceiling on hand-started cycles
(`domain-ceiling.ts`) was keyed by the bare host on the deployment-wide
ledger. On a deployment with more than one workspace that meant one
workspace's two hand-started cycles of a host refused every other workspace
tracking the same host for the rest of the month, and the refusal was a
one-bit oracle that someone else on the deployment scans that host.

**The bound statement, amended.** A host's hand-started cycles per month are
counted PER WORKSPACE: the ledger key is `${workspaceId}:${host}`
(`ceilingKey`), and `checkDomainCeiling` and `recordDomainCycle` take the
workspace and the host together. On a machine with identity off the
workspace is `local` and the key is the bare host, which is what the file
has always held, so a machine's month is unchanged.

What still bounds a hand-started cycle for everyone at once (corrected after
the cost-sentinel review of 2026-09-15, which found the first wording wrong):
NOT the daily cap of decision 2, which only the loop reads and books
(`daily-loop.ts`; `/api/scan` never touches `daily-spend.json`), but four
things a hand-started scan meets on the deployment: the burst cap on NEW
domains a day (`live-gate.ts`, deployment-wide by design), the provider's own
remaining quota read live before every scan (the gate refuses when the
account is short, whoever asks), the per-run allowance that bounds one
cycle's realised calls, and the lifetime spend ledger every attempt is
charged to before it is made (`ledgerCapUsd`, `ledger.json` on a machine,
the `spend:ledger` total in Upstash on the deployment). So N workspaces each
taking their two cycles a month of one host is bounded in dollars, by the
lifetime cap and the provider's quota, and by nothing that scales with the
number of workspaces. ⚠️ FOR THE OWNER: re-keying removed the one bound
that made monthly hand-started spend self-limiting per host across the
deployment; at pay-as-you-go prices a hundred workspaces each taking two
cycles of one host is about $116 a month with no refusal until the lifetime
cap binds. If hand-started spend needs an aggregate ceiling that scales with
workspaces, it is a spend cap (per deployment or per plan), not a per-host
cycle count — the recurring budget this ADR's "open, for later" section
already describes.

**The burst cap's repeat exemption stays keyed by the bare host, and that is
accepted, with one qualification.** `live-gate.ts` lets a host already
scanned today by anyone pass the day's new-domain cap, so a caller at the cap
can learn that a host was scanned today by someone. It only ever ADMITS on
another workspace's activity, never refuses on it. For the curated bank's
cells what it admits is served from the day's cache without a provider call,
because the cache key (R6) is workspace-agnostic; the leak is the existence
of a cache entry, which the cached answer itself reveals. The qualification
(cost-sentinel, 2026-09-15): a workspace's own custom prompts (ADR-0016) are
its own cells, never asked by the first scan, so a repeat with custom prompts
does buy those cells on a day the new-domain cap was full — bounded by the
workspace's ceiling, the per-run allowance and the lifetime ledger, not by
the burst cap. Recorded as accepted rather than re-keyed, because re-keying
would refuse the free, cached re-show; sizing the exemption by whether THIS
cycle's cells are cached, rather than by the host, is the change if that
qualification ever matters.

Verification, without spending: `domain-ceiling.test.ts` (two workspaces on
one ledger take their own two cycles of one host, a machine's ledger keeps its
bare-host history), `session-store.test.ts` (through `/api/scan`: Two's two
cycles of a host do not refuse One, and Two is refused on its own).

**Addendum, 2026-09-15 (MVP_PLAN B6, recorded by C1 / ADR-0018).** The
oversight session's spend decision on the consequence above, which the owner
may overrule: **accepted for the MVP.** Re-keying the ceiling per workspace
(B3d item 1) removed the only per-host bound on hand-started spend across
the deployment, and any member may open first cycles on any number of new
hosts, each with a fresh per-workspace ceiling. That is accepted because the
burst cap on new domains a day (`GRADER_MAX_NEW_SCANS_PER_DAY`,
deployment-wide), the per-visitor throttle, the provider's live quota read
before every scan, and the lifetime ledger every attempt is charged to still
bound the day and the total, and none of them is a per-tenant fairness
device — the real per-workspace bound is entitlement. So D2 must gate hosts
per workspace by plan: `ws_put_cycle` and `ws_file_request` refuse a host
beyond the plan's tracked-host count, the way migration 0001 gates
`score_rows` on `workspace_subscriptions`; and until D2 lands,
`GRADER_MAX_NEW_SCANS_PER_DAY` is the operator's lever on hand-started
spend. The loop's bounds are unchanged by this and by ADR-0018: a loop job
runs under the daily cap, the tick lease and the daily-ledger fold; a
hand-started cycle runs under none of those three and under the bounds this
amendment lists.
