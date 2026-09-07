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

Left as they are, named: an allowance stop leaves the current cell's index
claim held for its lease (up to thirty minutes), so a re-run inside that
window reports the cell as claimed elsewhere and the run as `scanned` with
one cell short (measured 2026-09-07 on a scratch store: 3 of 4 cells, no
provider call, the counts say so and the status does not); the same is true
of a lifetime cap stop, the index has no release, and the fix belongs to the
orchestrator, human-owned. The loop never meets it: its next run is the next
day's bucket. The scan stream reports an
allowance stop as `budget-exhausted`, which is the orchestrator's word for
both. ADR-0013 §"the derived form" is superseded by this section.

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
