# ADR-0006 — Collector topology is declared, not inferred

**Status:** Accepted · **Date:** 2026-08-22 · **Phase:** P0 (binds P1 and P5)
**Extends:** ADR-0002 (hosting topology and a phased collection runner)

## Context

ADR-0002 phased the collection runner: Vercel Fluid Compute + QStash through
P3, then a Hetzner CAX (ARM) fleet from ~M18–M20, with the migration triggered
by the **rate budget** rather than by cost. That decision has a consequence it
did not state.

Some collector state has to be **global**, while the number of processes holding
it is **not knowable from inside a process**. Two pieces of state, both
load-bearing:

| State | Global because | What a per-process copy costs |
|---|---|---|
| Spend cap (`SpendLedger`, rule R3) | `COLLECTION_BUDGET_USD_DAILY` is described as a hard ceiling | N containers × the full daily cap. Realised spend bounded only by achievable throughput. |
| Rate budget (`RateBudget`, ADR-0002) | The provider ceiling is 15 req/s **per key** | N containers × the full token bucket, aimed at one shared key. A 429 storm, then a suspended key. |

Both ship with a local implementation that is correct in one process and
silently wrong in N. Neither failure announces itself: the first arrives as an
invoice, the second as someone else's rate limiter.

**The first guard tried to infer the answer and failed open.** It asked "am I in
a fleet?" by scanning PaaS environment markers — `VERCEL`, `AWS_LAMBDA_*`,
`K_SERVICE` and similar. A bare Hetzner CAX VM, which is the actual P5 target,
sets none of them. Absence read as safety, so worker 7 of 12 would have been
handed a full private budget: the exact bug the ledger exists to close,
reinstated on the one topology it was written for. Found in review, recorded in
`docs/PROGRESS.md`, fixed in `47a5e75`.

The generalisable lesson, and the reason this needs an ADR rather than a code
comment: **absence of evidence about your own runtime is not evidence of being
alone.** Every marker list is a list of platforms someone thought of. The
platform we are migrating *to* is the one that sets nothing.

## Decision

**1. A deployment declares its topology.** `COLLECTOR_TOPOLOGY` is set in
deployment config to `single-process` or `fleet`. It is never inferred from what
happens to be in the environment.

**2. Undeclared is refused, not defaulted.** A process that cannot show it is
alone does not get a per-process cap. Fail closed.

**3. Runtime detection survives only as an override-proof veto.** A detected
PaaS marker forces `fleet` and beats any declaration — a process cannot declare
its way out of being on Lambda. It can never grant `single-process`.

**4. One escape hatch, and it leaves a trail.** `overrideUndeclaredTopology`
exists for a runtime that genuinely is one process and cannot set the variable.
It cannot beat a detected marker, and it always alerts.

Where the value gets set:

| Deployment | `COLLECTOR_TOPOLOGY` | Why |
|---|---|---|
| Pilot / local CLI | `single-process` | One process, serialised by `run.lock` |
| Unit tests | `single-process`, injected as an argument | Never read from the ambient environment, so a developer's shell cannot change a test result |
| Vercel Fluid Compute (P1–P3) | `fleet` | The marker already forces it; declaring it too means the config states the truth rather than relying on a veto |
| Hetzner CAX (P5) | `fleet` | No marker exists on a bare VM. The declaration is the **only** signal. |

## Consequences

**Positive.** The failure direction is now stop-collecting rather than
overspend. Deployment config is the correct home for this, because it is the
only layer that knows the instance count. The PaaS veto still catches the
managed-platform case where someone forgets. And the refusal quotes the
deployment's own written reason back at whoever has to judge it.

**Negative.** A new required environment variable: a deployment that forgets it
stops collecting. That is the safe direction, but it *is* an outage, so
`COLLECTOR_TOPOLOGY` belongs in the deploy checklist and in the doctor probe's
preflight — neither of which it is in yet.

**A declaration can also be a lie.** Nothing on a bare Hetzner VM catches
`single-process` set on a machine running twelve workers. The backstops are the
shared high-water mark in `KvSpendLedger` (a stale window key is visible against
the shared counter) and the collection heartbeat. The mitigation is that `fleet`
should be baked into the machine image, not set per deploy.

**Both per-process resources are guarded, not just the spend cap.** The draft of
this ADR left `LocalRateBudget`'s constructor public, which meant a fleet could
be assembled with a correct shared spend cap and twelve private token buckets —
the same failure, arriving as a provider 429 storm and a suspended key instead of
an invoice. On sign-off the same guard was extended to it:
`LocalRateBudget.forSingleProcess()` demands a written reason and refuses on
`fleet` and on `undeclared`.

One asymmetry between the two is deliberate. The spend ledger's fleet answer is a
*different implementation* (`KvSpendLedger`), so its refusal points there. The
rate budget's fleet answer is the *same* implementation holding a **static slice**
— rps divided across workers (ADR-0002) — so its refusal says so explicitly, and
a declared fleet gets no override at all: a slice is a different construction,
not this one with a waiver. That construction is not written yet; it belongs with
the P5 runner, and refusing loudly until then is the correct interim state.

The topology guard currently lives in `spend-ledger.ts` and is imported by
`rate-budget.ts`. It is not a spend concept and belongs in its own module; the
move is a one-line change deferred only because `spend-ledger.ts` is under human
review.

## Rejected alternatives

**1. Infer from environment markers.** The original design. Fails open on the
target topology. Rejected on evidence, not on principle.

**2. Default to `fleet` when undeclared.** This is the closest call, and a
reviewer could reasonably choose it: it is also fail-safe, and it needs no new
variable. Rejected because it makes the safe path *silent*. A missing
declaration would then be discovered on the day it starts mattering, rather than
the first time the process runs, and the local pilot and the test suite would
need a shared KV store to run at all. Refusing produces a message that names
what is missing; defaulting produces a mystery.

**3. Count instances at runtime** — a lease or heartbeat in KV answering "how
many processes claim this fleet id?". Rejected twice over: it needs the shared
store the ledger is still deciding whether to use, and it answers "how many are
running right now", which an auto-scaler at zero reports as one.

**4. Delete `LocalSpendLedger` and always use the shared one.** The laziest
resolution, and it would delete this entire guard along with the ADR. Rejected
*for now* only because the pilot and the whole test suite would need live
Upstash or a fake — and a fake shared counter is a `LocalSpendLedger` with extra
steps. **This becomes available the moment free-tier Upstash credentials exist**:
if `MemoryKV` serves the tests and the free tier serves the pilot, then the local
ledger, `resolveTopology`, `forSingleProcess` and this decision can all be
deleted. Worth re-opening at that point rather than defending the guard out of
sunk cost.

## Follow-ups

- ~~Extend the declaration to `RateBudget`~~ — done on sign-off, 2026-08-22.
- ~~Add `COLLECTOR_TOPOLOGY` to `.env.example`~~ — done. **Still open:** the doctor
  probe preflight, so a missing declaration is reported by a probe rather than
  discovered by an outage.
- Move `resolveTopology` out of `spend-ledger.ts` into its own module once that
  file is off review.
- Write the fleet rate budget (static slice per worker) with the P5 runner. Until
  it exists, a declared fleet cannot construct a rate budget at all — deliberate.
- Bake `COLLECTOR_TOPOLOGY=fleet` into the Hetzner machine image rather than
  setting it per deployment.
- **Open, contingent on Upstash credentials:** rejected alternative 4 — deleting
  `LocalSpendLedger` and always using the shared ledger, which would delete
  `resolveTopology`, `forSingleProcess` and this decision along with it. Left
  open deliberately at sign-off rather than closed. Revisit when the free-tier
  credentials land; if `MemoryKV` serves the tests and the free tier serves the
  pilot, the guard is dead weight.

**The pilot runner is the one place that declares on its own behalf.** It takes
an exclusive `run.lock` before constructing anything, so it has machine-checkable
proof it is alone and passes `COLLECTOR_TOPOLOGY=single-process` itself rather
than requiring an operator to export it before a manual G0 run. Nothing else in
the repo may do that.
