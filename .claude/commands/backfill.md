---
description: Plan a corpus backfill with cost estimate and explicit approval gate
argument-hint: <scope-description>
allowed-tools: Read, Glob, Grep, Bash
---

Plan a backfill for: **$1**

**You may not execute a backfill.** Produce a plan only.

1. Compute exact scope: prompts × engines × runs × date range.
2. Subtract what the cache already covers. Show the hit rate you are assuming and
   where that number comes from.
3. Cost estimate at $0.002/call, with a stated confidence range.
4. Rate-limit implication: how long at the current req/s budget, and whether it
   collides with scheduled collection.
5. Rollback plan: backfilled rows carry the algorithm version and a backfill batch
   ID so they can be identified and removed.
6. Print the total cost in bold and stop with:
   `⚠️ APPROVAL REQUIRED — backfill will spend $X. Confirm to proceed.`
