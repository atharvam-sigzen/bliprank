---
description: Build and publish a Category Benchmark Index from the corpus
argument-hint: <category-slug> [geo]
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

Generate the Category Benchmark Index for **$1** (geo **$2**).

1. Query the shared corpus for the category. **Refuse to proceed if any cell has
   n < 30** — publishing an index on thin data is exactly the failure we sell against.
2. Compute per-brand visibility with Wilson intervals, category median, top-decile
   threshold, and per-engine breakdown.
3. Generate the public report page under `apps/public/indices/$1/` — indexable,
   citable, with the methodology linked from the top of the page.
4. Include a plain-language methodology block: prompt count, engine mix, run count,
   geo, collection window, algorithm version. Every one of these, every time.
5. Export the dataset for the Content OS repurposing pipeline.
6. State clearly which brands were measured and which were not, and why.

Never publish a customer's private workspace data. The index draws only on the
shared category corpus.
