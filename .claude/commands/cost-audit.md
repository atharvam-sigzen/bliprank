---
description: Reconcile projected against actual spend across all providers
argument-hint: [week|month]
allowed-tools: Read, Glob, Grep, Bash
---

Run the spend reconciliation for the last **$1** (default: week).

1. Pull actual spend per provider: OpenWeb Ninja, Anthropic API, Cloudflare R2,
   Hetzner, Supabase, Upstash, Vercel.
2. Compute what the model in `docs/COST-MODEL.md` predicted for the same period at
   the actual customer count and query volume.
3. Report per line: predicted, actual, variance %, and a one-line explanation.
4. **Flag any line more than 15% over model** as an action item with an owner.
5. Report the two governing metrics explicitly:
   - **cache hit rate** — model says 25% (Y1) / 45% (Y2) / 60% (Y3)
   - **tech cost per customer per month** — model says ~$27
6. Then invoke the `cost-sentinel` subagent on any code merged in the period, to
   find regressions the invoice has not surfaced yet.

If cache hit rate is below model for two consecutive runs, escalate — that is a
strategic problem, not an ops one.
