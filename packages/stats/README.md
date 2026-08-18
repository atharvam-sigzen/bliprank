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

## Interval width by n (95%, Wilson)

For choosing runs per cell. Wilson intervals are **asymmetric about p̂** — the
lower arm is shorter than the upper arm below 0.5 — so they are printed as
`[low, high]`, never as `±`. Half-width `(high − low)/2` is shown only for
comparison with documents that quote one number.

| n | p̂ = 0.25 → [low, high] | half-width | p̂ = 0.05 → [low, high] |
|---|---|---|---|
| 3 | [0.037, 0.744] | 0.354 | [0.002, 0.604] |
| 5 | [0.053, 0.664] | 0.305 | [0.003, 0.488] |
| 10 | [0.081, 0.558] | 0.238 | [0.005, 0.345] |
| 20 | [0.112, 0.469] | 0.178 | [0.009, 0.236] |
| 30 | [0.130, 0.427] | 0.149 | [0.012, 0.191] |
| 50 | [0.151, 0.385] | 0.117 | [0.016, 0.149] |
| 100 | [0.175, 0.343] | 0.084 | [0.022, 0.112] |
| 150 | [0.188, 0.325] | 0.069 | [0.025, 0.097] |
| 200 | [0.195, 0.314] | 0.060 | [0.027, 0.090] |
| 500 | [0.214, 0.290] | 0.038 | [0.034, 0.073] |

> **Resolved 2026-08-18.** The earlier "Choosing n" table in
> `.claude/skills/measurement-methodology` (n=5 → ±0.19) and gate G0's "n=5 yields
> CI half-width ≤ ±0.20 at p̂≈0.25" were arithmetically unattainable (a 5-run cell
> at p̂=0.25 is [0.053, 0.664]; the narrowest n=5 can be at any p̂ is 0.217) and,
> being a deterministic function of (n, p̂), could not be tested by a pilot. Both
> are now restated in terms of the design effect: G0 gates on DEFF = 1 + 4ρ̂ ≤ 1.5
> at 5 runs/cell and on n_eff = n / DEFF ≥ 100 at the Starter unit; the skill's
> table is by n_eff and printed as [low, high]. This table is the source for both.

## Assumptions to carry into the methodology page

- `wilson()` assumes independent, identically distributed trials. Repeated runs
  of one prompt on one day against a caching engine are correlated; prompts
  within a brand are clustered. Until the design effect is measured (G0), an
  aggregate n overstates precision.
- Nominal 95% is not the worst-case coverage at small n: minimum exact coverage
  over p is roughly 83% at n=5 and 89% at n=30 (still far better than Wald's ~1%
  minimum). Worth stating publicly.
- Movements must be tested with an interval **on the difference** (Newcombe's
  score method), not by checking whether two Wilson intervals overlap. That
  helper does not exist yet; no delta should be rendered until it does.
