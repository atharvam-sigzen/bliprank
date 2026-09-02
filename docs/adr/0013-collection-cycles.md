# ADR-0013 — A domain has cycles, and a trend is drawn only over collected ones

**Status:** Accepted · **Date:** 2026-09-02 · **Phase:** P3 (pulls the real-data
half of PHASES 4.2 forward)
**Relates to:** R3 (nothing spends outside a budgeted runner) · R5 (rows are
immutable and version-stamped) · R6 (the cache key is sacred) · R8 (no metric
without its interval) · ADR-0003 (the date bucket) · ADR-0009 Amendment 3
(promoted competitors change the basis) · ADR-0010 (depth) · ADR-0011 (the
answers are the evidence) · `docs/METHODOLOGY.md` ("no significant change")

## Context

Until 2026-09-02 a domain could be scanned exactly once. `/api/scan` served the
cached result for any domain it had seen; `results/<domain>.json` was the only
copy of that result; the client registry kept one entry per domain; and the
only trend in the product was `apps/web`'s worked example over six cycles that
were never collected. The methodology page's headline rule, "if a change
between periods falls inside the interval, we report no significant change",
had never run on real data because there had never been two periods.

The positioning assessment of 2026-09-02 named this the single biggest gap:
the product was a one-shot instrument, and every over-time claim it made rested
on fixtures.

Three constraints were set before a line was written, and each is enforced by
a test rather than by a sentence:

1. **The category never re-derives.** A second cycle reuses the recorded
   category exactly as classified the first time.
2. **The spend gates apply unchanged.** A second cycle is exactly as governed
   as a first: no branch around the flags, the key, the per-visitor throttle,
   the per-domain ceiling or the live quota gate.
3. **No live spend during the build.** Everything below was built and verified
   with synthetic data and mocked provider responses.

And one scope boundary: there is **no scheduler**. A cycle is started by a
person. This ADR does not build recurrence and every surface says so.

## Decision

### A cycle is one domain on one UTC day

The cache key already contains the date bucket (ADR-0003), so two scans on one
day read the same cells and are one measurement, and two scans on different
days are different cells, bought separately. That makes the day the identity
of a cycle, and nothing else is used: no cycle numbers, no sequence counters,
nothing a clock skew or a re-run could disagree with.

### The store: the latest file stays, every cycle gets its own

```
results/<domain>.json                  the latest cycle — exactly where it was
results/cycles/<domain>/<day>.json     every cycle, one file per day
```

`services/grader/src/cycles.ts` owns this. `writeCycle` files a finished scan
under its day and as the latest, both from the same bytes. `listCycles` returns
the cycles directory plus the latest file when its day is not already there,
so a domain scanned before this store existed reads as one cycle, its latest,
with no migration. The three results already on disk needed nothing.

**The first new cycle on such a domain would have destroyed the only copy of
its earlier one.** The latest file was that copy, and the second write replaced
it. The test written for exactly this case failed on the first run; `writeCycle`
now files an earlier cycle that lives only in the latest file under its own day,
byte for byte, before replacing the latest. Kept as a test with a failing case.

A subdirectory rather than `<domain>.<day>.json` beside the latest, because
`storedResults` in rescore.ts globs `results/*.json` and a sibling would list as
a domain named `pipedrive.com.2026-09-03`. Audit rows from rescore sit beside
the file they supersede, in whichever directory that is.

### The trigger: a person, pressing a button, through the same route

`POST /api/scan` accepts `{ domain, cycle: 'new' }`. Compared with `{ domain }`
it skips the cache-first branch **and nothing else**. The two flags, the key,
the per-visitor throttle, the per-domain ceiling, the live quota gate, the run
lock, the budget and the bookkeeping after the run are the same lines of code
in the same order. There is no code path a second cycle takes that a first does
not, because a path is where a special case would go; the test file asserts
each gate refuses a second cycle in exactly the words it refuses a first.

Two things refuse a new cycle before any gate, spending nothing:

- **The same UTC day.** A second scan today would read every cell back from the
  store and add a point that is the previous point wearing a new date. Refused
  as `cycle-exists`, with the day it becomes possible.
- **No category record.** The category must be the one the last cycle ran
  under, and the record is the only thing that guarantees it. Without one,
  collecting would mean deciding a category today. Refused as `no-record`
  rather than re-derived: two cycles measured under different questions are not
  a trend. A recorded slug with no bank in the build is refused the same way,
  as `no-bank`.
- **A basis the trend could not use.** The prompt count and the engine set are
  the two parts of the basis the environment controls, and a cycle bought at
  10 prompts beside one bought at 17 is a point `compare()` refuses and the
  chart breaks at: a whole cycle's spend for a point nothing can be drawn
  through. Both September scans on disk were bought at 10 while the reference
  cycle is 17. Refused as `basis-mismatch`, naming the setting to change. The
  bank version is deliberately not checked: a promoted competitor set is a
  deliberate act, and refusing every cycle after it would freeze the domain.
- **A prompt count that cannot size a scan.** `GRADER_PROMPTS_PER_SCAN=0` or a
  non-number passed both gates (needing nothing) and then ran the whole bank,
  because the runner drops a falsy limit. Refused as `config`, on both paths.

With a record, `runGrader` resolves the category through `resolveCategory`,
whose rung 0 returns the recorded decision before anything can fetch or author,
and `recordCategory` refuses to overwrite. The recorded `brandName`, which is
the subject's alias source, travels the same way. The basis can still differ
between cycles by one deliberate act, a competitor promotion (ADR-0009
Amendment 3): `compare()` then refuses the pair as *not comparable* and the
chart breaks its line at the boundary, which is the correct reading of a
changed question.

The route reads its data directory from `GRADER_DATA_DIR` when set, so its
tests run against a scratch directory instead of the machine's real store.

### The client: one entry per day, the latest leads, the trend is all of them

`rememberScan` keeps one entry per (domain, day) instead of one per domain.
`scanFor` returns the latest by the day its answers were bought; on the same
day the earlier entry wins, so a session copy of the bundled reference cycle
never shadows the committed file. `cyclesFor` in `apps/public/lib/cycles.ts`
orders every cycle oldest first, `trendOf` maps them to the subject's mention
rate with its interval, and `latestMovement` is `compare()` between the two
newest. Nothing here is invented: one cycle is one point, and the record keeps
refusing a trend in words until a second cycle exists.

### The surface

The workspace record gains three things, all conditional on collected data:

- **Mention rate over cycles**, when two or more cycles exist: the same
  `CiTrendChart` the worked example uses, now byte-identical across the two
  apps and pinned by `theme.test.ts`, with the latest movement beside it in the
  same voice as every other verdict (no arrow, no colour, no emphasis inside
  the interval; ≠ for not comparable).
- **Cycles**, always: the count, the latest day, and the button that starts
  another one, with `SCHEDULE_FACT` printed beside it. When today's cycle
  already exists the button is replaced by the day the next one is possible.
- The cycle note in the letterhead counts cycles instead of asserting one.

Evidence follows the cycle: `/api/answers?domain=&day=` reads that day's file,
and `evidenceUrl` names the day for any session scan. Membership in the bundled
set is now by identity, so a later session cycle of the bundled domain reads its
own evidence rather than the committed file for the earlier day.

### Rescore covers every cycle

A re-score exists to move a history forward under a new derivation. Leaving
earlier cycles on the old stamp would draw a version boundary through the trend
that R5 never asked for, so `rescore.ts` plans every cycle's own file once,
files each audit row beside the file it supersedes, and re-mirrors the newest
cycle into the latest file after re-deriving it.

## What is not done, stated

- **No scheduler.** `SCHEDULE_FACT` now reads "daily (intended); nothing
  schedules a cycle yet, a person starts each one from the workspace record",
  identically in both apps. A cycle recurs when someone presses the button.
- **The client registry syncs from the server once, on load.** `/api/cycles`
  lists every cycle the machine holds for a domain and the record remembers
  what it lacks, so a run that finished after the tab closed, another browser,
  or cleared site data all recover. On the static deployment the route does
  not exist and nothing is added or claimed, so there the registry is still
  per browser plus the bundled cycle.
- **The static deployment collects nothing.** On Cloudflare Pages there is no
  route, the button's request 404s, and the record says so in words.
- **The prompt breakdown and head-to-head show the latest cycle only.** Earlier
  cycles are on the trend with their intervals and in their own evidence files;
  a per-cycle breakdown is not drawn.
- **Bundling more than one cycle** of the reference domain into the build is
  possible (`BUNDLED_SCANS` is a list) and not done.

## How it was verified without spending

- **Unit, server:** `cycles.test.ts`, 10 cases including the legacy-overwrite
  case that failed first.
- **Route, integration:** `cycles.route.test.ts` runs the real `POST` with
  exactly two modules mocked, the runner and the live quota read, against a
  scratch data directory: a plain request is still the free cached latest; a
  new cycle files today beside the earlier day, the latest follows, the first
  cycle's bytes are unchanged, the record did not move; a third cycle joins;
  same-day and no-record refuse before the runner is asked; the flags, the
  per-domain ceiling and the quota gate refuse a second cycle exactly as a
  first; the ceiling and burst cap are booked afterwards.
- **Unit, client:** `apps/public/lib/cycles.test.ts`, 13 cases over synthetic
  Wilson cycles: ordering, same-day replacement, the bundled domain's later
  session cycle leading while the bundled one stays as history, no movement
  from one cycle, overlap reading as no significant change, separation reading
  as a move, a scoring bump and a changed basis both refusing.
- **Rendered:** the workspace record with two synthetic cycles seeded beside
  the real reference cycle, at both depths, on desktop and mobile, with the
  provider and the scan route aborted in the browser. Screenshots are in the
  session record. The full screenshot harness and the click crawl were re-run.
- **Whole suite:** 72 files, 1,268 tests. Root typecheck and both app
  typechecks clean, apart from one pre-existing error in
  `prompt-breakdown.test.ts` that predates this change.

Nothing here reached a provider. The one real verification run is a human
decision, as every live spend is.

## The hostile review, and what it changed

A reviewer with no stake in the design attacked the seven constraints above
before anything was committed. Three findings stood up as MAJOR and were fixed;
the rest were minor or notes. Recorded here because each one is the kind of
defect that looks like a feature until it is named.

| Finding | What could happen | What changed |
|---|---|---|
| A category change is a second cycle in disguise | `/api/scan`'s plain path re-scans when the record's slug differs from the stored cycle's category (the sigzen shape), and with cycles in place it now files that beside the old one — the client would have drawn a two-category "trend" and called it "the same recorded prompts". | The trend spans the latest cycle's category only (`cyclesFor`); earlier cycles under another category are counted and named on the record, never drawn. The copy says what breaks a line. |
| Evidence for an old cycle read with today's bank | `readScanAnswers` built cells from the current record's slug, so `/api/answers?day=` for a cycle collected before a category change fetched the wrong bank's cells — empty or wrong evidence under a basis check the client still passed. | The reader uses the stored cycle's own `category`; the record is consulted only for a file too old to name one. Pinned in `answers.test.ts`. |
| The route test proved the category "by construction" | With the runner mocked, "asked under the record's slug" was asserted by a mock that returned the slug unconditionally. | The test states exactly what it proves and does not; it now asserts the runner was asked with the same data directory, mode and authoring config a first scan passes, and a new refusal covers the recorded-slug-without-a-bank case. The resolver's rung 0 stays proven in its own tests, with a fetch that throws. |
| A recorded slug with no bank | `resolveCategory` would leave the record alone and scan the general bank — a second cycle against different prompts, filed on the same trend. | `/api/scan` refuses a new cycle as `no-bank`. |
| A directory is not an identity | Two hosts can share a `safeName`; a hand-placed file for another domain would list as this domain's cycle, and the legacy migration would move it. | `listCycles` and the migration check `result.domain`. |
| Rescore planned the latest twice | The latest file and its same-day cycle file were two plans, two runs, two audit rows. | Cycle files are planned once each; the latest file mirrors the newest cycle after it is re-derived. |
| An invisible rectangle scrolled the phone | The chart's hit target for the last point hung past the drawing and, with `overflow: visible`, was the one element wider than a 390px viewport. Latent in the worked example too. | Hit targets are clamped to the plot in both pinned copies. Measured: no overflow at 390 wide. |

Two notes were accepted as trade-offs rather than fixed: the button renders on
a static deployment and the refusal appears only after a press (the docblock
says so, and probing for the route before render would add a request to every
page load); and the client registry's growth of roughly 33 KB per cycle with
prompt rows, which the answers module already documents as the reason evidence
is fetched rather than stored.

## The second review, on the whole feature

After the fixes above, a fresh reviewer walked the feature as a system that one
paid run would exercise, from the button to the trend, and read the ADR against
the code. Two findings stood up as MAJOR and both were fixed before anything
was committed further.

| Finding | What could happen | What changed |
|---|---|---|
| A second cycle's basis was never checked before spending | With `GRADER_PROMPTS_PER_SCAN` at 10 on the scan server (as it was for both September scans) and the reference cycle at 17, the run would have bought a whole cycle that `compare()` refuses and the chart breaks at, with a `≠` and a generic gloss that never names the prompt count. | The route refuses `basis-mismatch` before the gates, naming the setting and the value that would make the cycle comparable; the record's gloss now opens the basis string and says which segment differs. Tested with a 10-prompt prior against a 17-prompt server, then with the server set to match. |
| A cycle that finished after the browser disconnected was unreachable from any screen | The server filed it; the client never received the result; on reload the record said one cycle and the button said "already collected today", and the Grader short-circuits bundled domains before the route's cache could serve it. | `/api/cycles` lists the server's cycles and the record syncs from it once on load, remembering what the browser lacks. Same fix covers another browser and cleared site data. A 404 on the static deployment adds nothing. |
| `GRADER_PROMPTS_PER_SCAN=0` ran the whole bank past both gates | The ceiling needed 0, the quota gate compared against 0, and the runner dropped the falsy limit. Pre-existing on the gate. | The route refuses `config` before either path. |
| Rescore planned an earlier-category cycle under the record's bank | The fix applied to the evidence reader had not been mirrored, so such a cycle reported every cell MISSING and was skipped. | `planRescore` uses the cycle's own category; the record must still exist. Tested. |
| The render sweep did not see cycle files | `results/cycles/` was never descended. | It is. |
| Copy: "spends real provider quota for 85 requests, as the latest cycle did" | The reference domain's latest is a rescore row that made no calls, and the next cycle's size is the server's to know. | Reworded: one request per prompt per engine, plus retries. |
| `NewCycle` reported a collection failure as "status no-answers" | Every-request-failed, the shape a quota exhaustion takes part-way, read as a neutral outcome while the calls were booked. | Named as a collection failure, with the booking stated. |
| The integration test's header overstated its fetch stub | The homepage fetcher uses undici's own client, which a global stub does not cover. | The header says what the stub covers and what the category assertion proves instead. |

Held on inspection, with what convinced the reviewer: the record path (rung 0
first, `recordCategory` refuses overwrite, same subject id, engines sorted
identically, so with the prompt count matched the basis is byte-equal);
rescore over cycle files with the latest re-mirrored; R8 on every new surface;
the ceiling arithmetic (119 admitted, 120 refused, 240 at 20 prompts, an
explicit override winning); the integration test's mock being load-bearing
(blobs stamped `fixture:chatgpt`, zero fetch calls; with the mock removed the
same run makes 15 stubbed fetches and ends `no-answers`); every copy sentence
matching the code. Two notes were left as they are: the route defaults the
price plan to `payg` when `OPENWEBNINJA_PLAN` is unset, so a free-tier cycle
prints a pay-as-you-go cost, which predates this feature; and
`PROMPTS_PER_CYCLE` in `apps/public/lib/workspace.ts` is a second copy of the
default prompt count that does not follow the environment.

## The per-domain ceiling, reviewed

`domain-ceiling.ts` has carried a HUMAN REVIEW flag since it was written. This
work builds directly on it, so the two open choices were investigated to the
same standard as ADR-0012.

### The default of 170 forbids the second cycle it says it allows

The constant's own comment: "two full five-engine scans with a wide margin for
retries". At the current 17 prompts a cycle is 85 nominal calls, and
`checkDomainCeiling` refuses when `used + 85 > 170`, so a second cycle in the
same month is refused the moment the first realised **one** retry. The margin
is zero, not wide.

Retries are not hypothetical. The three live scans on disk, realised against
nominal:

| Scan | Cells collected | Provider calls | Ratio |
|---|---|---|---|
| pipedrive.com, 2026-08-25 | 19 (66 cached) | 22 | 1.16 |
| thecosmicbyte.com, 2026-09-01 | 50 | 51 | 1.02 |
| sigzen.com, 2026-09-01 | 50 | 51 | 1.02 |

Every live scan so far has retried. Under the default, none of these domains
could take a second full cycle this month: the September ledger holds 51 for
thecosmicbyte and 51 for sigzen against a 50-cell scan, so a second 50-cell
cycle needs `51 + 50 = 101 ≤ 170`, which passes only because those scans were
10 prompts. At the committed 17 prompts, `87 + 85 = 172 > 170` refuses.

The constant is also silently tied to the prompt count. `GRADER_PROMPTS_PER_SCAN`
is an environment setting; at 20 prompts a cycle is 100 calls and 170 admits
one cycle a month with no retry margin at all.

### The two choices, and a recommendation

**Fail closed on a corrupt ledger: keep.** The sentinel refuses only the domain
asked about, for this request, and the next write repairs the file. That is
narrower than `live-gate`'s "treat the day as spent" and correct for a per-key
ledger: one bad byte must not take every domain down for the month. Nothing to
change.

**Book realised calls, retries included: keep.** A retry storm is the scenario
the ceiling exists for, and it is invisible to a ceiling that books the plan.

**The default: derive it from cycles, do not fix it as a number.**

```
maxCallsPerMonth = cyclesPerMonth × cellsPerCycle × retryHeadroom
                 = 2 × (prompts × engines) × 1.2
                 = 2 × 85 × 1.2 = 204 at today's settings
```

with `GRADER_MAX_CYCLES_PER_DOMAIN_PER_MONTH` (default 2) and the headroom as
the two named inputs, and the existing `GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH`
kept as an absolute override. This says what the ceiling is for in its own
terms, moves with the prompt count instead of silently shrinking to one cycle,
and keeps the property the current test pins: 204 over five engines is 40.8 per
engine, below the free tier's 50. A headroom of 1.2 covers the worst retry ratio
observed (1.16) with a small margin; it is a starting value to be re-derived
from the ledger once more cycles have run, not a constant to trust.

If a plain number is preferred, 200 has the same properties at 17 prompts and
none of them at 20.

**Decided 2026-09-02, by the owner: the derived form.** `domain-ceiling.ts`
now exports `CYCLES_PER_MONTH = 2`, `RETRY_HEADROOM = 1.2` and
`ceilingFor(cellsPerCycle)`, and the default is `ceilingFor(17 × 5) = 204`.
`defaultDomainCeilingConfig` derives from `GRADER_PROMPTS_PER_SCAN` when it is
set, so the margin holds at any prompt count; an explicit
`GRADER_MAX_CALLS_PER_DOMAIN_PER_MONTH` stays absolute. The constant's comment
now states the margin that exists: the second cycle goes ahead if the first
realised no more than 119 calls (ratio 1.40), or both run at up to 1.20; a
third full cycle is refused. Tests pin the formula, the survival of a second
cycle after a first at the worst observed ratio, and the old default's failure
on the same input.

### One more thing the review found, about the provider and not the ceiling

The account is on the provider's free tier, 50 requests per engine per month.
Two 17-prompt cycles are 34 per engine; three are 51. So the provider quota
itself, independent of any ceiling, allows at most two full cycles a month
across **all** domains on this key. The gate's own refusal text from
2026-09-01 read "chatgpt has 4 of 50 left, quota resets 2026-09-21". A real
second-cycle verification run before the 21st will most likely be refused by
the quota gate, correctly, before anything else.

## Consequences

- The methodology page's "no significant change" rule now has a surface that
  exercises it on real data as soon as a domain has two cycles.
- Every earlier reader of `results/<domain>.json` is unchanged.
- `rescore` now touches more files per domain and is correspondingly slower.
- The two things left open above, `/api/cycles` and a scheduler, are separate
  pieces of work with their own gates; neither is implied by anything on screen.

⚠️ **HUMAN REVIEW REQUIRED: spend control.** `/api/scan` is on the spend path.
The change adds two refusals before the gates and removes nothing; the gate
chain is line-for-line the previous one. Check the ordering in `route.ts` and
the assertions in `cycles.route.test.ts`.
