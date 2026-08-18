# BlipRank — Claude Code Plugin & Harness Strategy

Verified 17 Aug 2026. Marketplace slugs move — confirm with `/plugin` before relying on any command here.

---

## The constraint nobody mentions

Every installed plugin adds tokens to your context window **on every turn**.
Claude Code's plugin browser shows a "Context cost estimate" per plugin for exactly
this reason. Installing five plugins plus a 35-plugin harness with 300+ MCP tools
consumes the context window before any BlipRank work begins.

There is also a live contradiction in the requested set: **Headroom exists to
reduce context; Ruflo's full install adds a very large tool surface.** Running both
without measuring is paying for a compressor to fight an expander.

**Rule: install in tiers, measure `/context` after each tier, and keep what earns its place.**

---

## Tier 1 — install now

### 1. claude-mem — cross-session memory
```
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem@thedotmack
```
Apache-2.0. Captures session context, compresses it, injects relevant history into
later sessions. SQLite-backed.

**Why it earns its place here:** BlipRank is a 16-week build across many sessions
with a small team. Re-explaining the cache key design or why scoring is
deterministic-first, every morning, is pure waste.

**Configure it deliberately:** it should remember *decisions and rationale*, not
raw code. The eight rules in `CLAUDE.md` are already permanent context — memory
should hold what is not written down: why an ADR went the way it did, which
approaches were tried and rejected, what the pilot data actually showed.

**Caution:** memory that drifts from `CLAUDE.md` is worse than no memory. If they
ever disagree, `CLAUDE.md` wins. Re-read it at the start of each phase.

### 2. frontend-design (official)
```
/plugin install frontend-design@claude-plugins-official
```
Anthropic-maintained. Design-lead guidance that avoids templated defaults. This is
the concrete, available answer to the "UI/UX pro max" requirement — the
`frontend-designer` subagent in `.claude/agents/` is written to compose with it.

**Why:** the dashboard is an instrument panel, not a marketing site, and the CI-band
chart primitives are custom work. Generic AI-startup gradients would actively
undermine a product selling rigour.

### 3. The setup-analysis plugin (official marketplace)
Anthropic ships a plugin that audits a codebase and recommends hooks, skills,
subagents and MCP servers. The official marketplace is added automatically on first
interactive start; browse `/plugin` and install the current setup/analysis plugin
from `claude-plugins-official`.

**Why:** run it **after** P0 lands, not before. It works from a real codebase. Use
its output to *challenge* the scaffold in `.claude/`, not to replace it — the six
subagents encode domain rules an analyser cannot infer.

---

## Tier 2 — install, then measure

### 4. Headroom — context compression
Verify the current slug via `/plugin` (search "headroom" or "context").

**Measure it properly:** record `/context` usage on three representative tasks
before and after. Keep it only if the reduction is real *and* nothing degrades.

**The specific risk for BlipRank:** compression that drops the detail in
`.claude/skills/measurement-methodology/SKILL.md` will produce statistically wrong
code that looks right. If you run Headroom, the `stats-reviewer` subagent becomes
non-optional on every statistics change — it is the check that catches a
compression-induced error.

### 5. Task Observer — workflow learning
Verify the slug via `/plugin`.

Learns from working patterns and improves skills/workflows in the background.

**Where it genuinely helps:** the repeated bounded tasks — competitor CSV parsers,
category prompt banks, engine adapters. That is exactly the shape of work that
benefits from an observer noticing what you correct each time.

**Where to be careful:** it should not be allowed to rewrite the rules in
`CLAUDE.md` or the subagent definitions. Those encode deliberate commercial
decisions, not habits. Keep `.claude/agents/` and `CLAUDE.md` under human review.

---

## Tier 3 — Ruflo, selectively

`github.com/ruvnet/ruflo` · MIT · ~68k stars · formerly Claude Flow.
An agent meta-harness: 98 agents, 35 plugins, 300+ MCP tools, 27 hooks, 12
background workers, HNSW vector memory, swarm coordination.

### Two install paths — and only one is right for BlipRank

| | Plugin path (recommended) | CLI path (`npx ruflo init`) |
|---|---|---|
| Files written to your repo | **Zero** | `.claude/`, `.claude-flow/`, **its own `CLAUDE.md`**, helpers, settings |
| Surface | Slash commands + agent definitions per plugin | Full loop: 98 agents, 60+ commands, 30 skills, MCP, hooks, daemon |
| Risk to your scaffold | None | **Overwrites or conflicts with the `CLAUDE.md` and `.claude/` you just authored** |

> **Use the plugin path.** `npx ruflo init` writes its own `CLAUDE.md`. Your
> `CLAUDE.md` is the single source of truth for eight rules that protect real
> money and the product's core claim. Do not let a harness overwrite it. If you
> ever do run the CLI init, run it in a scratch clone first and merge deliberately.

```
/plugin marketplace add ruvnet/ruflo
```

### The five that map to BlipRank

| Plugin | Why it fits |
|---|---|
| `ruflo-testgen` | Finds missing tests and generates them. `packages/stats` needs property tests and the golden-set harness needs breadth — this is real leverage. |
| `ruflo-browser` | Playwright automation. Needed for the Grader end-to-end tests, and the Content OS already uses Playwright. |
| `ruflo-cost-tracker` | Token budgets and cost alerts. Directly aligned with rule R3 and the `cost-sentinel` subagent. |
| `ruflo-adr` | Architecture decision records. Rules R5 and R6 both require ADRs; a living record beats a folder of markdown. |
| `ruflo-swarm` | Parallel agents. The genuine use case: generating eight competitor CSV parsers concurrently in P4, each bounded and independently testable. |

Optional later: `ruflo-migrations` (partition changes are delicate),
`ruflo-security-audit` and `ruflo-aidefence` (before the SOC 2 work in P6),
`ruflo-sparc` (5-phase methodology with quality gates — overlaps `docs/PHASES.md`,
so adopt only if you prefer its structure to ours; do not run both).

### What to skip

`ruflo-federation` (no multi-machine need), `ruflo-neural-trader`,
`ruflo-iot-cognitum`, `ruflo-market-data`, `ruflo-ruvllm` (local models add
operational burden with no benefit here).

### The honest caution

A third-party harness with 27 hooks intercepting tool calls, 12 background workers,
and write access to the repository is real supply-chain surface. BlipRank's entire
commercial position is auditability, and it will need SOC 2 by Month 26.

Before Ruflo touches the production repo:
1. Pin to a specific commit, not `@latest`.
2. Read what the hooks actually do — they intercept every tool call.
3. Run it in a scratch clone for a week first.
4. Confirm no plugin exfiltrates code or prompts off-machine by default.
5. Record the decision as an ADR, because an auditor will ask.

Ruflo also ships `ruflo-metaharness`, which grades an agent setup and scans tool
configs for security risk. If you adopt anything from Ruflo, adopt that first and
point it at your own `.claude/` directory.

---

## Recommended install order

```
Week 0, day 1   — claude-mem, frontend-design.  Measure /context.
Week 0, day 3   — Headroom.  Measure /context again. Keep only if it wins.
Week 1          — Ruflo plugin path: testgen, browser, cost-tracker, adr.
                  Scratch clone only. Metaharness audit of .claude/.
Week 2          — Task Observer, once there are real patterns to learn from.
After P0 gate   — Official setup-analysis plugin against the real codebase.
Week 8 (P4)     — ruflo-swarm, for the parallel parser build. Nothing sooner.
```

Never install more than two new plugins in a week without measuring. If a phase
gate slips and context pressure is a suspect, the first diagnostic is
`/plugin` → disable everything in Tier 2 and 3 → re-measure.
