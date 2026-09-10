# BlipRank

**AI Search Visibility Assurance** — bliprank.com

Measuring how brands appear inside AI answers (ChatGPT, Gemini, Copilot, Google AI
Mode, AI Overviews), to a standard that survives audit.

The category has ~72 competing tools. Our differentiation is that our numbers can
be **reproduced** and **reconciled against the tools you already use**.

## Start here

| File | What it is |
|---|---|
| `CLAUDE.md` | Project instructions. Read fully before your first tool call. |
| `docs/PHASES.md` | Eight phases with executable exit gates |
| `docs/ARCHITECTURE.md` | System design, data model, scaling triggers |
| `docs/METHODOLOGY.md` | Public, citable measurement methodology |
| `docs/COST-MODEL.md` | Cost reference used by `/cost-audit` |
| `docs/PLUGINS.md` | Claude Code plugin + Ruflo strategy |
| `docs/adr/` | Architecture decision records — 0001 adapter abstraction, 0002 hosting topology |

## Hosting

`apps/public` on Vercel (ADR-0002 Amendment 1, 2026-09-10) · `apps/web` (the paid product, planned for P4,
not created yet) on Vercel · collection on Vercel
Fluid Compute + QStash until ~M18, then a Hetzner CAX (ARM) fleet. Rationale and
the migration trigger are in `docs/adr/0002-hosting-topology.md`.

## Setup

```bash
pnpm install
cp .env.example .env.local     # fill in keys; COLLECTION_ENABLED stays false
pnpm typecheck && pnpm test
```

`COLLECTION_ENABLED=false` by default. Turning it on spends real money and is a
deliberate, logged act — the `pre-spend` hook enforces this.

## Claude Code

The `.claude/` directory ships 6 subagents, 8 slash commands, 3 skills and 3 hooks.
See `docs/PLUGINS.md` for which external plugins to install and in what order.

Run `/gate-check` to see where the current phase stands.
