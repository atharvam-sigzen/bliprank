# ADR-0003 — Cache key schema

**Status:** Accepted · **Date:** 2026-08-18 · **Phase:** P0

## Context

CLAUDE.md rule R6: `hash(normalised_prompt, engine, locale, geo, date_bucket)` is
the primary key of the answer store, the Redis lookup key, the R2 object identity
and the unit of the benchmark corpus. It cannot be retrofitted, so its exact shape
is fixed here before the first answer is stored. Implementation:
`packages/contracts/src/cache-key.ts`.

## Decision

```
key = sha256( JSON.stringify([normalised_prompt, engine, locale, geo, date_bucket]) )   → 64 hex chars
```

| Part | Canonical form | Why this form |
|---|---|---|
| `normalised_prompt` | NFKC → lowercase → collapse whitespace → strip terminal `.!?…,;:` | Folds the variants humans type for the same question. NFKC catches full-width and compatibility characters that would otherwise split cells invisibly. |
| `engine` | one of `chatgpt` `gemini` `copilot` `google-ai-mode` `google-ai-overviews` | Closed set, append-only, never renamed. |
| `locale` | canonical BCP-47 via `Intl.getCanonicalLocales` (`en-IN`) | Stdlib validation and casing; `EN-in` and `en-IN` are one cell. |
| `geo` | upper-case ISO 3166-1 alpha-2 (`IN`) | Country is what the provider accepts and what we disclose. |
| `date_bucket` | `YYYY-MM-DD` UTC, **the collection cycle's date, assigned by the scheduler** | Day granularity matches the R2 layout (one object per prompt × engine × day) and the "collect once per cycle" cache semantics. Using the cycle date, not the call timestamp, keeps a cycle that spans midnight in one cell. |

Serialisation is a JSON array: canonical, delimiter-safe (a prompt containing `|`
or newlines cannot collide), and the field order *is* the schema. Full SHA-256 hex
rather than a truncation: boring, collision-proof, and 64 bytes per row is not
where the storage bill is.

`cacheCell()` returns the key **and** every canonicalised part plus
`normalisationVersion`; that object is stored with the answer, so any stored key
can be recomputed from its parts a year later. Reproducibility is the product.

## Trade-offs considered

**Day vs week bucket.** A weekly bucket would roughly double cache hits and halve
collection spend, at the cost of a week-stale answer whenever a cell is re-asked.
Freshness is what customers are paying for and weekly rollups are computed
downstream from sufficient statistics (ARCHITECTURE §3.3), so the *cell* stays
daily. Coarsen with an ADR if hit rate misses the model (ARCHITECTURE §7).

**Normalisation version: hashed or stored?** Hashing it means every normaliser bump
invalidates 100% of the cache, including prompts whose normalised form did not
change — a pure cost hit. Excluding it means an unchanged prompt keeps hitting the
same cell across a bump, which is correct: the key is over the normalised *string*.
So the version is **stored beside the row, not hashed**. Every stored answer still
says which normaliser produced its key. Consequence: two prompts that normalise
differently under v1 but identically under v2 will merge into one cell after the
bump — intended (that is what dedupe is for).

**Provider / collection path: excluded on purpose.** The cell identifies *what was
asked, where, when* — not who fetched it. Including the provider would make the
same question via two paths two cells, which breaks the cross-path agreement
monitor (ADR-0001 §5), reconciliation and the shared corpus. Provider and
`collectionPath` are recorded per run on `RawAnswer` instead. Consequence: the
runner must qualify the "already collected?" lookup by adapter when it deliberately
re-collects a cell through the alternate path.

**Run index: excluded.** A cell holds n runs; the interval is computed across them.
The run is stored per answer, not keyed.

**Path-qualified lookups.** When the runner needs "has *this adapter* collected
this cell?" (alternate-path re-collection for the agreement monitor), the
convention is `${cell.key}:${adapter.id}` — the cell key stays provider-agnostic
and the qualifier is appended, never mixed into the hash. P1.4 implements it next
to `cacheCell()`.

**R2 object unit.** The docs' shorthand "one object per `prompt × engine × day`"
elides locale and geo. The object unit is the **cell** — one object per cache
key, holding all n runs. Two cells that differ only in locale or geo are two
objects; the shorthand must never be reimplemented literally.

**Raw vs normalised prompt sent to the engine.** The engine receives the raw
authored prompt; the key uses the normalised form; `RawAnswer` records both. Two
raw prompts in one cell are the same measurement by construction — if that ever
proves false for a class of prompts, tighten normalisation, do not widen the key.

**Geo granularity.** Alpha-2 only. Sub-national codes (`IN-MH`) are rejected today;
adding them later is additive (existing `IN` cells are unchanged) but must go
through an ADR because it changes what "same cell" means.

**Locale/geo redundancy.** `en-GB` from `IN` is a legitimate, distinct cell (UK
English settings, Indian egress). Both stay.

## Consequences

- Cache hit rate is bounded by day granularity; the model in `docs/COST-MODEL.md`
  assumes it.
- Alias resolution (P2.2) ships as `NORMALISATION_VERSION = 2`; expect a partial
  cache miss on the bump, only for prompts containing aliased brand names.
- Any change to field set, order, canonicalisation or hash is a new ADR and a
  migration plan, and the golden keys in `cache-key.test.ts` will fail first.
