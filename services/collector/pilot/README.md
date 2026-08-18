# G0 pilot — how to run it

PHASES.md deliverables 0.5 / 0.6. Everything here runs through the `EngineAdapter`
contract with a hard USD cap; nothing spends unless three things are true at once.

## What it does

`bank.json` — 100 CRM buying-intent prompts, three known brands (HubSpot,
Salesforce, Zoho CRM) plus competitors, alias tables for deterministic mention
detection (rule R1) and owned domains for citation detection.

Per collection day: 100 prompts × 5 engines × 10 runs = **5,000 calls**, runs
interleaved (every cell gets run 0 before any cell gets run 1). The second day
re-collects the same cells; the gate needs both days (see "What the gate measures").

| Plan (per API) | marginal $/call | one day | two days |
|---|---|---|---|
| pay-as-you-go (default when unknown) | 0.007 / 0.008 AI Mode / 0.005 AIO | ≈ $34 | ≈ $68 |
| Pro | 0.005 / 0.003 AIO | ≈ $23 | ≈ $46 |
| Ultra | 0.003 / 0.002 AIO | ≈ $14 | ≈ $28 |
| Mega (CLAUDE.md's $0.002 assumption) | 0.002 / 0.001 AIO | ≈ $9 | ≈ $18 |

Retries are charged like any other attempt; the runner refuses to start if the
projected spend already exceeds the cap.

## Prerequisites

1. `OPENWEBNINJA_API_KEY` in `.env.local` (repo root, gitignored) or in the
   environment. The runner never prints it.
2. `OPENWEBNINJA_PLAN=payg|pro|ultra|mega` in `.env.local` (or `--plan`) so the
   ledger charges the right marginal rate. Default is `payg` — the safe overestimate.
3. `COLLECTION_ENABLED=true` and `COLLECTION_BUDGET_USD=<cap>` **for the run only**.
   `.claude/settings.json` pins `COLLECTION_ENABLED=false` for Claude sessions, so
   from a Claude session it has to be set inline; from a human terminal either
   inline or in `.env.local` works. Set it back to `false` (or just don't export it)
   as soon as the run ends. Inside a Claude Code session the `pre-spend` hook
   additionally blocks any command naming the pilot script (fixture mode included)
   unless the *session's* environment has `COLLECTION_ENABLED=true` — the
   deliberate, logged act rule R3 asks for.

## Day 1

```bash
COLLECTION_ENABLED=true COLLECTION_BUDGET_USD=75 pnpm collector:pilot -- --day 2026-08-19 --plan payg
```

Resumable: re-running the same command skips (cell, run) pairs already stored.
Raw answers land in `pilot/data/<day>/<engine>.jsonl` (verbatim payloads, rule R4 —
gitignored), failures in `failures.jsonl`, the spend ledger in `ledger.json`.
Exit 0 = complete, 2 = refused (gate), 3 = stopped by the cap.

## Day 2 (after 00:00 UTC of the next day — a genuine second cycle)

```bash
COLLECTION_ENABLED=true COLLECTION_BUDGET_USD=75 pnpm collector:pilot -- --day 2026-08-20 --plan payg
```

The ledger is per day; keep the cap at the *total* remaining budget for the pilot.

## Analysis / gate

```bash
pnpm collector:analyse -- --day 2026-08-19 --day2 2026-08-20
```

Writes `pilot/results/<day>-report.md` and `.json` (small; commit them). With only
`--day` the report is produced but the gate is **NOT RUN**.

## What the gate measures — and why it needs the second day

The prompt bank is fixed, so between-prompt heterogeneity is a fixed effect: it
cancels in cycle-to-cycle comparisons and only makes a single-cycle Wilson interval
conservative. What makes Wilson anti-conservative is the **day×cell** component —
runs of a cell within one cycle being more alike than runs of that cell across
cycles (caching, per-day engine state). The day-to-day dispersion ratio of per-cell
counts is a heterogeneity-free estimator of it: `E[D] = 1 + (m−1)·ρ_u`, so
`ρ̂_u = (D − 1)/(m − 1)`, `DEFF₅ = 1 + 4·ρ̂_u`, `n_eff = 150 / DEFF₅`.

Reported alongside: the single-day one-way ANOVA ρ̂ (an **upper bound** — it
includes the fixed cell effect) and the within-day pass-to-pass ratio (a
lower-bound proxy). `--fixture` mode with `FIXTURE_RHO=<ρ>` reproduces all of this
offline: planted ρ_u = 0.05 with heavy prompt heterogeneity gives ρ̂_u ≈ 0.04–0.07
and an ANOVA bound ≈ 0.25 — the reason the gate does not use the ANOVA figure.

## Known limitations of this pilot

- ChatGPT, Gemini and Copilot take no `gl`/`hl`: the cell records `en-US`/`US` as
  what was asked for, but egress is the provider's default. Only the Google
  surfaces are geo-controlled. Disclosed per ADR-0001.
- Copilot is called in `CHAT` mode; AI Overviews returns
  `search_returned_ai_overviews: false` as an empty (parseable) answer.
- The `content_references` field on ChatGPT is not documented in shape; citations
  for ChatGPT/Gemini come from markdown links in the answer text.
- Prompt bank is content-generated (flag for human review, CLAUDE.md §4).
