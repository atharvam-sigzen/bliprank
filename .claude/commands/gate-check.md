---
description: Run the current phase's exit gate and report pass/fail per criterion
allowed-tools: Read, Glob, Grep, Bash
---

Read `docs/PHASES.md`, identify the current phase from the "Current state" section
of `CLAUDE.md`, and execute that phase's exit gate.

For each gate criterion report:

- **PASS / FAIL / NOT RUN**
- the actual measured value against the threshold
- if FAIL: the smallest change that would move it to PASS

Cover all four gate dimensions:

1. **Functional** — does it do the thing
2. **Performance** — p50 and p95 against the stated budget
3. **Cost** — measured $/unit against the modelled $/unit, flagged if >10% over
4. **Usability** — the "can a stranger do this unaided" check for the phase

Do not mark a gate as passed on partial evidence. A criterion with no executable
check is `NOT RUN`, not `PASS`. Finish with an explicit
`GATE <id>: PASS` or `GATE <id>: BLOCKED — <criteria>` line.
