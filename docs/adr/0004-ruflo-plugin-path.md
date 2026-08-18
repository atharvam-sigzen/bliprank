# ADR-0004 — Ruflo: plugin path only, five approved plugins, cost-tracker permanently disabled

**Status:** Accepted · **Date:** 2026-08-18 · **Phase:** P0

## Context

`docs/PLUGINS.md` (Tier 3) allows Ruflo selectively and requires the decision to
be recorded before it touches the production repo: pin, read the hooks, run in a
scratch clone, confirm nothing exfiltrates, write the ADR.

An earlier `npx ruflo init` (the CLI path) had written `.claude-flow/`, `.swarm/`,
`.claude/helpers/`, ~60 agent/command/skill folders under `.claude/`, settings
entries and a block in the global `~/.claude/CLAUDE.md`. That residue was removed
on 2026-08-18; nothing tracked by git changed.

## Decision

1. **Plugin path only.** Ruflo is consumed through the Claude Code plugin system
   (`extraKnownMarketplaces.ruflo` → `github:ruvnet/ruflo`, marketplace clone
   `fa13ee4`, 2026-08-15). `npx ruflo init` is never run against this repository:
   it writes its own `CLAUDE.md` and `.claude/` tree over ours, and `CLAUDE.md` is
   the single source of truth for rules R1–R8.
2. **Five approved plugins, project scope** (`.claude/settings.json → enabledPlugins`):
   `ruflo-testgen`, `ruflo-browser`, `ruflo-adr`, `ruflo-metaharness` enabled;
   `ruflo-cost-tracker` installed and **disabled — permanently, not pending**.
3. **`ruflo-swarm` is deferred to P4** (Week 8, the parallel parser build). Not
   installed before then.
4. **`ruflo-cost-tracker` stays disabled** because it is the only one of the five
   that ships a hook, and that hook (`Stop`, i.e. every turn) reads the session
   transcripts under `~/.claude/projects/<cwd>/*.jsonl` and writes a digest of them
   into a local memory store by spawning `npx -y @claude-flow/cli@latest memory
   store` — an unpinned package executed automatically, with no way to scope or
   review what is written. Cost visibility is already the `cost-sentinel`
   subagent's job (and `/cost-audit`'s), against the actual provider invoices, so
   the plugin adds surface without adding information we need.
5. **What the approved plugins may do to the repo.** `ruflo-adr` (and the CLI it
   shells out to) writes `.swarm/memory.db` relative to the project; `.swarm/` is
   gitignored for that reason. `ruflo-testgen`'s skills instruct the agent to run
   `npx @claude-flow/cli@latest …` directly, so `Bash(npx @claude-flow*)` remains in
   the settings allow list; every other `CLAUDE_FLOW_*` / `mcp__claude-flow__*`
   entry was removed as unreferenced residue.
6. **`ruflo-metaharness` is a smoke test, not an audit.** Its 2026-08-18 run on this
   repo scored harnessFit 67 / toolSafety 100 / `threat-model: clean`, but it does
   not read `.mcp.json` or the semantics of `Bash(...)` permissions and reports
   `shellAccess: false` for a settings file that allows `Bash(pnpm *)`. Its output
   informs; it does not gate.

## Consequences

- Zero Ruflo files in the repo except the `enabledPlugins` / `extraKnownMarketplaces`
  entries in `.claude/settings.json`, which are versioned and reviewable.
- A fresh clone resolves the `@ruflo` ids from the declared marketplace; the
  marketplace is not pinned by the plugin system itself, so a `claude plugin
  update` is a deliberate act, and the clone commit is recorded here.
- Re-enabling `ruflo-cost-tracker`, or installing `ruflo-swarm` before P4, requires
  a new ADR that supersedes this one.
- Baseline context after cleanup, measured in a fresh session: 38.2k tokens, of
  which the four enabled plugins cost ≈ 3k (skills + agent briefs).
