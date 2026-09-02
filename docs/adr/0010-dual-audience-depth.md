# ADR-0010 — One dataset at two reading depths

**Status:** Accepted · **Date:** 2026-09-02 · **Phase:** P3
**Relates to:** R8 (provenance travels with the number) · ADR-0002 (hosting
topology, and therefore the deploy boundary) · G3 (activation) · CLAUDE.md §8
(numbers formatted through `packages/stats/format`)

## Context

The MVP was presented to a real audience. The feedback was that the interface
"reads like an essay or a blog" — too dense and too technical for a
non-technical brand owner.

That is a design complaint with an architectural cause, and the cause is not
that the copy is long. Reading the Grader result path as shipped:

| | |
|---|---|
| Competing headline numbers | **3** — mention rate, Visibility /100, Precision A–D |
| Body paragraphs before the first chart | **5** |
| `.note` / `.annotated` margin blocks in one file | **33** |
| Body prose typeface | the display serif, at a 62ch measure |

None of it is wrong. Every number carries its interval, every refusal is honest,
every caveat is derived rather than asserted. The problem is that **nothing is
foreground**. Provenance-beside-the-number is a good idea applied to everything,
so the reader is handed three verdicts and five arguments and no answer to the
question they arrived with, which is "am I doing well".

The typography compounds it independently of the copy. Newsreader at a 62ch
measure *is* magazine typography; shortening the paragraphs does not change what
it signals.

And the product genuinely has two audiences, both real and both paying:

- a **brand owner**, who wants one clear signal and plain language;
- an **agency user**, who is reading someone else's numbers, has to defend them
  to a client, and wants the intervals, the precision grade and the methodology.

The failure mode to avoid is obvious and common: ship a "simple mode" that is a
second, shallower product, and then maintain two designs that drift until the
simple one is quietly the dishonest one.

## Decision

**One attribute on `<html>`, `data-depth`, with two values, and the simple view
is a strict CSS subset of the detailed one.**

`simple` is plain language and one headline signal. `detailed` is the full
record, unchanged from what shipped. Both render **the same components from the
same scan**; the simple depth shows fewer of them and re-typesets the prose.
Nothing exists at one depth and not the other, and nothing is recomputed.

### It lives in `theme.tsx`, not in a new module

Depth is the same mechanism as theme, a second time: a value stamped on `<html>`
before first paint, stored per origin, mirrored across tabs, and carried over the
deploy boundary by a URL parameter that is spent on arrival. A separate module
would have duplicated the boot script, the storage listener and the
param-stripping regex — three more places for one class of bug to reappear, in a
file whose header exists because that class of bug already happened once.

`theme.tsx` remains byte-identical across both apps, still pinned by a test,
because ADR-0002 puts them on separate deploys and they cannot share an import.

### The default follows the role, and the role is already in the route

`chrome.tsx` already forks neutral / brand / agency by surface. An agency user is
the technical audience *by definition* — they are reading someone else's numbers
and have to defend them — so `/agency*` opens on the full record and every other
surface opens plain.

No new mechanism, and specifically **no role read from storage**: a bar whose
contents depend on storage ships the wrong links in the prerender and swaps them
after mount, which is the exact flash the chrome fork was built to remove. A
stored choice always beats the route; the route decides only the first view.

### Absent means detailed — the fallback fails open, structurally

Every rule in the stylesheet is written as `[data-depth='simple']` and **never as
its negation**. The boot script always stamps a value, so the absent case is a
reader whose JavaScript never ran.

Showing that reader everything is strictly better than hiding two thirds of the
page behind a class they can never reveal — the control that would reveal it
being the JavaScript that did not run. This is a safety property, not a
preference, so it is asserted rather than remembered:
`apps/public/lib/depth.test.ts` fails the build on any rule keyed to `detailed`
or to `:not([data-depth…])`.

### The rule for what becomes `.detail`

> A block is `.detail` **if and only if hiding it removes no MARK from the
> page.** Prose explaining something still drawn stays at both depths; prose
> explaining something itself hidden goes with it.

This is what keeps the dashed rows on the head-to-head chart explained in the
simple view. It is also why the fixture stamp, the short-sample caveat and the
fallback-bank caveat are **not** `.detail`: each changes how a visible number
must be read. Hiding a disclosure to make a page calmer makes it calmer by making
it untrue, and a test refuses any element carrying both a disclosure class and
`.detail`.

### Three invariants the simple view cannot break

1. **The interval is never dropped, only re-typeset.** At simple depth it is
   rendered as language ("about 1 in 4, and it could be as few as 1 in 6")
   rather than as a figure and a rail. R8 holds at both depths — value, bounds,
   `n` and provenance are all still reachable, and a screen reader gets the
   bounds in the same sentence a sighted reader does. A tooltip would not
   qualify: it fails on touch, in print, and in the screenshot a customer sends
   their board.
2. **`n` and the engine count stay visible at both depths.** A number from this
   product must never be screenshottable without the size of the sample beside
   it. The rail prints its own `n`, so hiding the margin cannot take it away —
   asserted, because if the rail ever stopped doing that the invariant would
   fail silently.
3. **The control says "Full detail" in both states.** `role="switch"` with
   `aria-checked` carrying on/off. Labelling it by state would show the simple
   view a control reading "Simple", which advertises nothing — and the evaluator
   most likely to screenshot this page and file the product as another vibes
   tool is the one who never learns the other depth exists.

### The headline is the mention rate

The simple view gets exactly one headline number, which forces a choice between
the three that were competing. This is the one place the depth split changes what
the product *asserts* rather than only how much of it is shown.

| Candidate | Verdict |
|---|---|
| **Mention rate** | **The headline.** Real, has bounds, has provenance. |
| Visibility **/100** | Detailed only. Labelled `preview`, carries no interval because nobody has derived one, and its own caption says it "is not comparable with anyone else's score — including a later version of this one". |
| Precision **A–D** | The *sentence* stays at both depths; the letter in a box is detailed only. |

A composite score with no interval, not comparable with anyone — including its
own successor — is precisely what every competitor puts at the top of the page.
Putting ours there would trade the only claim this product actually has for a
figure that looks like theirs.

The Precision grade is kept as words because a letter in a box is the
PageSpeed/security-score pattern: it reads as a mark out of ten however it is
captioned, and it is the single most misreadable object on the page for exactly
the audience the simple view exists to serve.

### The type change is the fix, not the cutting

The sheet's standing rule is serif on words, mono on figures. At simple depth the
serif is **demoted to headings**: body prose moves to the interface sans at a
46ch measure. The serif still opens every section, so the record keeps its voice
and stops doing the talking.

This is asserted too. The complaint that started the work has a mechanical cause,
and a test that only counted words would let the cause survive a rewrite.

## Consequences

**Bought.**

- One dataset, two audiences, no second product. A number visible at both depths
  is the same number, with the same interval, from the same pass.
- The reader's depth survives the deploy boundary. `themedUrl` gained an optional
  third argument, so the four cross-origin links carry depth alongside theme;
  without it, opening Full detail on the dashboard and clicking to the Grader
  silently dropped back to simple.
- The safety properties are mechanical, not remembered: fail-open direction,
  no-disclosure-is-detail, `n`-survives, and the type rule are all asserted, and
  the guards were mutation-checked rather than assumed to bite.
- `apps/web` shipped five stacked generations of palette with only the last live
  (19% of its declarations dead). Collapsing them to one was a precondition for
  this work — a sixth pass would have been written on top of the five — and is
  recorded here because it is why the diff for that commit is large and why it
  changed nothing on screen.

**Costs, accepted.**

- **Two states, not three.** Theme has a real "no attribute" state meaning "let
  the media query decide"; depth does not, so the route default is re-resolved on
  every load rather than persisted as a choice. A reader who wants "follow the
  route" after having chosen once cannot ask for it. Adding a third state is
  possible and deliberately not done: nobody will ask for it, and it would put a
  third label on a control whose whole job is to be unambiguous.
- **`useDepth` reads the attribute, `useTheme` reads storage.** They differ, and
  the difference is load-bearing — the attribute is what CSS obeys and already
  folds in the resolved route default, so the control cannot disagree with the
  page. The asymmetry is a papercut for anyone reading both hooks expecting
  symmetry, and it is documented at both.
- **The simple view is unverified against a real reader.** Every guard here is a
  property of the code, not evidence that a brand owner reads the result faster
  or more accurately. G3's usability dimension is where that gets tested, and
  this ADR does not claim it.
- **`apps/web`'s marking is coarser than `apps/public`'s.** The dashboard hides
  two whole sections (by-engine, citation sources) and the metric-card provenance
  footers. That is the right first cut, but the dashboard has not had the
  composition pass the Grader just had, and the split will want revisiting when
  it does.

## Open

**The plain-language headline is not wired in.** `formatFrequency`
(`packages/stats/src/format.ts`) is written and tested but called by nothing, so
the simple view currently shows the mention rate as a percentage on a rail rather
than as the sentence this ADR describes in invariant 1. It is human-owned under
CLAUDE.md §4 and awaiting review.

⚠️ **The rounding trade-off is undecided, and it is a product judgement.**
Rounding the spoken bounds outward guarantees the range a customer reads always
contains the computed interval and can never be tighter than it. The price is the
mirror error: `1 in k` is coarse near small `k`, so at 25% the only speakable
frequencies either side are 1 in 5 (20.0%) and 1 in 3 (33.3%), and *any* interval
inside that gap is spoken as "as few as 1 in 5, as many as 1 in 3".

Measured, on real intervals:

| Sample | Computed | Spoken | Inflation |
|---|---|---|---|
| n=150, p̂≈25% (Starter) | 17.0–31.2% | 1 in 6 – 1 in 3 (16.7–33.3%) | **1.17×** |
| n=150, p̂=10% | 6.0–16.0% | 1 in 17 – 1 in 6 (5.9–16.7%) | 1.08× |
| n=150, p̂=33% | 26.0–41.0% | 1 in 4 – 1 in 2 (25.0–50.0%) | **1.67×** |
| n=600, p̂=25% | 21.7–28.6% | 1 in 5 – 1 in 3 (20.0–33.3%) | **1.93×** |
| ±0.2pt at 25% | 24.8–25.2% | 1 in 5 – 1 in 3 (20.0–33.3%) | 33.3× |

**The inflation is worst where the sample is best.** That is the perverse
direction for a product selling precision, and it is not confined to the extreme
case: a customer paying for four times the sample gets a tighter interval and a
*vaguer* sentence (1.93× against the free tier's 1.17×), on the same brand,
because it was measured more carefully. On an ordinary n=150 scan at 33% the top
bound is spoken as "as many as one answer in two" for a measurement whose upper
bound is 41% — a nine-point overstatement.

Overstating uncertainty is not the safe error when precision is the thing being
sold. Three options are set out in `packages/stats/src/frequency.test.ts`; the
choice belongs to the owner of `packages/stats`. Until it is made, nothing calls
the function and the simple view shows a percentage on a rail.
