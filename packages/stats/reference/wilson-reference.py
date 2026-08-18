# /// script
# requires-python = ">=3.11"
# dependencies = ["statsmodels>=0.14", "scipy>=1.11", "numpy>=1.26"]
# ///
"""
Regenerate wilson.reference.json from statsmodels — the reference implementation
BlipRank's Wilson interval must agree with to 1e-9 (PHASES.md gate G0).

    uv run reference/wilson-reference.py        # from packages/stats
    pnpm --filter @bliprank/stats reference:wilson

Commit the regenerated JSON; the TypeScript tests read it, no Python at test time.
"""
import json
import pathlib

import scipy
import statsmodels
from scipy.stats import norm
from statsmodels.stats.proportion import proportion_confint

ALPHAS = [0.20, 0.05, 0.01]  # 0.05 is the product default; the others exist to catch a wrong z
# The n × p̂ grid from .claude/skills/measurement-methodology (n ∈ {1,2,3,5,10,30,100,1000},
# p̂ ∈ {0,0.01,0.5,0.99,1}) plus the extra points that matter for the product's cells.
NS = [1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100, 150, 200, 500, 1000, 10000]
PHATS = [0, 0.01, 0.05, 0.1, 0.2, 0.25, 0.5, 0.75, 0.8, 0.9, 0.95, 0.99, 1]
EXHAUSTIVE_NS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30]  # every integer k for small n


def case(alpha, k, n):
    lo, hi = proportion_confint(k, n, alpha=alpha, method="wilson")
    return {"alpha": alpha, "successes": k, "trials": n, "ci_low": float(lo), "ci_high": float(hi)}


cases = []
for alpha in ALPHAS:
    cases += [case(alpha, p * n, n) for n in NS for p in PHATS]  # fractional k: statsmodels accepts it
    cases += [case(alpha, k, n) for n in EXHAUSTIVE_NS for k in range(n + 1)]

out = {
    "reference": "statsmodels.stats.proportion.proportion_confint(method='wilson')",
    "statsmodels": statsmodels.__version__,
    "scipy": scipy.__version__,
    "z": {str(alpha): float(norm.isf(alpha / 2)) for alpha in ALPHAS},
    "cases": cases,
}
path = pathlib.Path(__file__).with_name("wilson.reference.json")
path.write_text(json.dumps(out, indent=1) + "\n", newline="\n")
print(f"wrote {len(cases)} cases to {path} (statsmodels {statsmodels.__version__}, z={out['z']!r})")
