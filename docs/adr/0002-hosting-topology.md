# ADR-0002 — Hosting topology and a phased collection runner

**Status:** Accepted · **Date:** 2026-08-18 · **Phase:** P0
**Supersedes:** the "ARM workers from day one" position in the Technology Stack &
Cost Roadmap document (v1.0, §3.3)

## Context

BlipRank has three workloads with three different profiles, and an earlier draft
collapsed them into one hosting answer.

1. **App tier** (`apps/web`) — low volume, latency-sensitive, cacheable.
2. **Public tier** (`apps/public`) — the Grader and satellite free tools. This is
   the acquisition engine: indexable, potentially spiky, and served largely from
   cache.
3. **Collection** — scheduled, bursty, IO-bound. 20.4M outbound calls/month at
   target, each waiting 2–20s, with near-zero CPU per call.

The original technology plan asserted that serverless was disqualified for
collection because wall-clock billing would charge for 45,300 GB-hours/month of
pure waiting. **That assertion under-weighted Vercel Fluid Compute**, which:

- bills **active CPU**, pausing while a function waits on I/O;
- uses **optimized concurrency**, running many invocations on one instance —
  precisely the right shape for network-bound work;
- allows **800s max duration** on Pro (1800s in beta for supported runtimes).

On the corrected reading, Vercel is a viable collection runner for a meaningful
part of the roadmap. At M12 the requirement is 1.3 req/s sustained.

## Decision

### Hosting split

| Piece | Host |
|---|---|
| `apps/web` | Vercel |
| `apps/public` (Grader, free tools) | Cloudflare Pages |
| `services/collector` | Vercel Fluid Compute + Upstash QStash → Hetzner CAX (ARM) |
| Postgres / raw payloads / cache | Supabase / Cloudflare R2 / Upstash |

The Grader goes to Cloudflare rather than Vercel because static asset requests are
free and unlimited there, whereas Vercel meters bandwidth ($0.15/GB past 1TB) and
edge requests ($2/M past 10M) — charges that would land on acquisition traffic. It
also isolates a publicly hammerable tool from the product paying customers use.

### The collection runner is phased

**P0–P3 (to ~M18): Vercel Fluid Compute + QStash.** Zero ops burden, adequate
throughput, and it lets a three-person team spend Weeks 2–5 on the measurement
core rather than on infrastructure.

**P4+ (~M18–M20): Hetzner CAX (ARM) worker fleet.**

**Migration trigger: sustained throughput crosses ~4 req/s.**

### Why the migration is necessary — and why it is not about cost

The binding constraint is the **global rate budget**. The provider ceiling is
15 req/s on the Mega tier, and a 12-hour collection window at target volume needs
15.8 req/s before any retry headroom. Staying under that requires one token bucket
across all collection, shardable across API keys.

With auto-scaling ephemeral instances that state cannot live locally. Every one of
20M monthly calls would need a distributed-limiter round-trip, and concurrency
stops being something you can reason about statically. A fixed worker fleet gives
each worker a deterministic slice of the budget and the problem dissolves.

Secondary reasons: a flat monthly line item suits a business whose margin thesis
depends on `/cost-audit` reconciliation, and persistent connection pooling across
hundreds of concurrent sockets is simpler on long-lived processes.

ARM specifically: after the June 2026 Hetzner revision the CAX line rose ~1.3–1.4x
against 2.4–2.75x for CPX and 2.1–2.73x for CCX. For IO-bound work it is now both
cheapest per concurrent socket and least price-volatile.

## Consequences

**Positive.** Weeks 2–5 go to the measurement core instead of infrastructure. The
`EngineAdapter` boundary (ADR-0001) means only the **runner** changes at migration
— adapters, normalisation, cache lookup, retry policy and rate-budget logic are all
portable. Hosting cost stays trivial (~$70/mo Y1) while the product is unproven.

**Negative.** A migration is scheduled work in P4/P5 rather than avoided. The rate
budget must be implemented as a pluggable interface on both runners from day one,
or the migration becomes a rewrite. Two runners means the collector must be
tested under both execution models.

**Rejected alternative.** Self-hosting Next.js on the same Hetzner boxes as the
collectors — one vendor, flat cost, no bandwidth metering. Rejected because it
trades preview deployments, instant rollbacks and zero-config Next.js for ops work,
which is the wrong economy at ~$320/mo with a three-person team.

## Follow-ups

- Region selection is deliberate, not default. Beachhead is India and GCC, then
  UK/EU; US-East by default penalises the primary market on every dashboard load.
- DPA in place before the first EU customer.
- The rate-budget module ships behind an interface in P1, exercised on the Vercel
  runner, so the P4 migration is a swap and not a rebuild.
