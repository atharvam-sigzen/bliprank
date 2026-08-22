# ADR-0003 — Cache key schema

**Status:** Accepted · **Date:** 2026-08-18 · **Phase:** P0
**Amended:** 2026-08-20 (`27652c2`), approved 2026-08-22 — Amendment 1, R2 object
identity is per cell **per collection path**. See the Amendments section.

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
| `date_bucket` | `YYYY-MM-DD` UTC, **the collection cycle's date, assigned by the scheduler** | Day granularity matches the R2 layout (one object per cell per day) and the "collect once per cycle" cache semantics. Using the cycle date, not the call timestamp, keeps a cycle that spans midnight in one cell. |

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
elides locale and geo. The object unit is the **cell per collection path** — one
object per cache key per adapter, holding all n runs from that path. Two cells
that differ only in locale or geo are two objects; the shorthand must never be
reimplemented literally.

The R2 object key is **path-qualified the same way the lookup key is**:
`answers/<day>/<engine>/<cell.key>__<adapter.id>.json`. A single-path cell (the
normal case — one provider) has one object. When the agreement monitor
re-collects a cell through an alternate path (ADR-0001 §5), that path writes its
*own* object rather than overwriting the primary's — without the qualifier the
alternate provider's answers would silently replace the primary's and the index
pointer would misattribute, which for an audited-numbers product is unacceptable.
`r2KeyFor(cell, adapterId?)` implements this; the bare form (no adapter) is a
convenience for callers that only ever collect one path.

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

---

## Amendments

### Amendment 1 — R2 object identity is per cell *per collection path*

**Raised:** 2026-08-20 by `measurement-engineer` review of the collection
orchestrator (verified BLOCKER). **Fixed:** `27652c2`. **Approved:** 2026-08-22.

**What was wrong.** The original text fixed the cache key correctly and then let
the *R2 object key* be cell-only, while the Redis index key was already
path-qualified (`${cell.key}:${adapter.id}`). The two identities disagreed. When
the agreement monitor re-collected a cell through the alternate path (ADR-0001
§5), that path wrote to the same object as the primary provider — silently
overwriting the primary’s stored answers, while the index pointer still
attributed them to the primary. Both reads then returned the same wrong object.

**What changed.** The R2 object key is now path-qualified the same way the lookup
key is:

```
answers/<day>/<engine>/<cell.key>__<adapter.id>.json
```

`r2KeyFor(cell, adapterId?)` implements it. A single-path cell — the normal case,
one provider — still has exactly one object; the bare form is a convenience for
callers that only ever collect one path.

**Why this is an R6 amendment and not a bug fix.** The cache key itself is
unchanged: no field was added, removed or recanonicalised, and `cache-key.test.ts`
golden keys still pass. What changed is one of the four things R6 says the key
*is* — "the R2 object identity". The cell remains provider-agnostic, as the
"Provider / collection path: excluded on purpose" trade-off requires; the
qualifier is **appended to the object path, never mixed into the hash**. Those two
statements have to be read together, which is exactly why this is recorded
formally rather than left as a paragraph in the trade-off list.

**Consequences.**

- Storage: unchanged for single-path cells. Cross-path agreement monitoring costs
  one extra object per re-collected cell, which is the point of collecting it.
- A cell’s answers are no longer addressable by cache key alone. Anything
  enumerating a cell’s stored answers must enumerate by prefix, not construct a
  single key.
- CLAUDE.md R4’s shorthand ("one object per cell") was updated in the same change
  to say "per cell per collection path".
- Any future collection path — a second provider, a direct-API fallback — is
  additive: it writes its own object and cannot displace an existing one.

**Second finding from the same review, fixed in the same commit** (recorded here
because it shares the cache semantics, though it does not amend the key): any
under-target collection — a budget stop *or* ordinary retry attrition — marked
the cell collected forever, and the cache check never compared stored runs
against requested runs. The cell would then be served as a hit with a permanently
capped `n`: a silent R8 violation, because the disclosed sample size would be
whatever the failure happened to leave behind. A partial cell now falls through
and completes on a later cycle.
