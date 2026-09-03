# ADR-0017 — The daily scheduler: what exists, what is missing, and the three decisions before a loop runs

**Status:** Proposed · **Date:** 2026-09-03 · **Phase:** P3 closing, looking at P4
**Relates to:** R3 (nothing spends outside the scheduler) · R5 · ADR-0002
(hosting topology: Fluid Compute + QStash through P3, a worker fleet after)
· ADR-0003 (cache key and R2 object unit) · ADR-0013 (cycles; "there is no
scheduler") · ADR-0016 (correctable context, which a cycle now carries) ·
PHASES 1.1 (the QStash runner, built and never exercised against real QStash)

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
absence of success. All of it tested, none of it ever called by anything:
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

`pnpm grader:tick` prints that list and refuses `--apply`: it is the bill,
printed before anything is incurred, and a person still starts each due cycle
from the record. `pnpm grader:track -- --domain x --on --reason "…"` is the
opt-in: a category record exists for every domain anyone ever previewed, demo
lookups included, and collecting all of them daily would bill for curiosity.
Tracking is a file beside the record store, written by a person with a
reason.

## The three decisions, which are the owner's

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
   pure due list is for.

2. **What it may spend, per day and per domain.** The per-domain ceiling
   (ADR-0013) was derived for two cycles a month with retry headroom: 204
   calls at 17 prompts. A daily loop is thirty cycles a month, fifteen times
   that. The ceiling must be re-derived from the cycle count the product
   sells (`CYCLES_PER_MONTH` becomes a daily-loop figure, or the ceiling
   becomes a per-day figure) and a global daily budget set in the environment
   (`COLLECTION_BUDGET_USD_DAILY` already exists for the collector). The
   tick prints the arithmetic: at pay-as-you-go a 17-prompt domain is about
   $0.58 a cycle, so $17 a month per domain, before retries and before any
   custom prompts. Nothing here can be built without the owner naming the
   figures.

3. **Which domains are on.** Opt-in by a person, per domain, with a reason,
   as built. Whether a paying workspace is switched on automatically when a
   plan is attached is a billing question, and no billing exists.

## What is deliberately not done

- No loop, no timer, no `--apply`. A tick that collects is the decision.
- No change to `SCHEDULE_FACT`. It is still true.
- No move of the store. That is P4.

## Verification, without spending

`due.test.ts`: nothing tracked means nothing due; a tracked domain is due
with its cells and cost, a custom set adds to them; not due for a cycle
today, for a prior cycle on another basis, for a domain over its ceiling,
for a domain whose bank is gone. `pnpm grader:track` and `pnpm grader:tick`
run on a scratch store; `--apply` refused. The live store was not written.
