# @bliprank/stats

Pure statistical functions. **Human-owned** (CLAUDE.md §4): every method here is
the product claim, so nothing merges without a human and `stats-reviewer` signing
off. No side effects, no I/O, no dependencies at runtime.

| Export | Status | Reference |
|---|---|---|
| `wilson(successes, trials, z?)` | P0 — verified | `statsmodels proportion_confint(method='wilson')`, 341 cases, ≤ 1e-9 |
| difference-in-differences | P7 | — |
| sampling design | P2 | — |

## Verification

```bash
pnpm --filter @bliprank/stats test              # reference agreement + property tests, no Python needed
pnpm --filter @bliprank/stats reference:wilson  # regenerate reference/wilson.reference.json (needs uv)
```

`reference/wilson-reference.py` declares its own dependencies (PEP 723) and runs
under `uv run`. The JSON it writes is committed, so CI and gate checks run the
comparison from the fixture alone. Regenerate whenever the grid or the statsmodels
pin changes, and commit the result.

## Interval width at p̂ = 0.25 (95%, Wilson)

Half-widths from the implementation, for choosing runs per cell:

| n | ±half-width at p̂=0.25 | at p̂=0.05 |
|---|---|---|
| 3 | 0.354 | 0.301 |
| 5 | 0.305 | 0.243 |
| 10 | 0.238 | 0.170 |
| 20 | 0.178 | 0.114 |
| 30 | 0.149 | 0.089 |
| 50 | 0.117 | 0.066 |
| 100 | 0.084 | 0.045 |
| 150 | 0.069 | 0.036 |
| 200 | 0.060 | 0.031 |
| 500 | 0.038 | 0.019 |

> ⚠️ These differ from the table in `.claude/skills/measurement-methodology`
> (n=5 → ±0.19, n=150 → ±0.04) and from gate G0's "n=5 yields half-width ≤ ±0.20
> at p̂≈0.25". A single cell of 5 runs at p̂=0.25 has half-width 0.305 by
> construction; ±0.19 is n≈20 (or n=5 at p̂≈0.02). The G0 half-width criterion
> should probably be restated in terms of *aggregate* n (prompts × runs), or as an
> overdispersion check (do repeated runs behave like independent Bernoulli draws?),
> which is the thing the pilot can actually falsify. Human decision.
