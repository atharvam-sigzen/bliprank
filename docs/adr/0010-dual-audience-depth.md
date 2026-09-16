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
| `.prose` paragraphs in the result | **5** |
| Margin notes on the result path | **3** in `page.tsx`, plus one per rendering component |
| Body prose typeface | the display serif, at a 62ch measure |

<sub>An earlier draft of this row said "33 margin blocks". That was 33 *lines*
matching `note` or `annotated` in `page.tsx`, not 33 notes — there are three
`<aside class="note">` on the result path. The point stands on the corrected
figure and did not need the inflated one.</sub>

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
- `apps/web` shipped five stacked generations of palette with only the last
  live. Collapsing them to one was a precondition for this work — a sixth pass
  would have been written on top of the five — and is recorded here because it
  is why that commit's diff is large and why it changed nothing on screen.

  ⚠️ **A figure quoted during that work was overstated.** "19% of declarations
  overridden by something further down" is what the counter measured, but it
  counts a `@media` breakpoint override as an override, and a conditional
  override is not dead code. The honest split is **110 genuinely dead token
  declarations (12%)** plus about 7% of legitimate responsive overrides that
  survive the cleanup — the same counter reports 8% against the consolidated
  file. The deletion was correct; the number attached to it was not.

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

## Decided since: the frequency headline ships, gated twice

`formatFrequency` is wired into the record as a plain-language lede, behind two
thresholds. Outside them it prints percentages.

**Gate 1 — resolution.** `MAX_SPOKEN_INFLATION = 1.5`: the spoken range may not
be more than half again wider than the computed interval. n=150 at 17.0–31.2%
speaks (1.17×); n=600 at 21.7–28.6% does not (1.93×), so a paying customer's
larger sample can no longer produce a vaguer headline than the free tier's on
the same brand. 1.5 rather than 1.4 because it is where the n=150 band stays
contiguous — 10, 15, 20 and 25% all speak, 30% and above do not — and a
threshold that admitted 20% and 30% while refusing 25% would look arbitrary.

**Gate 2 — legibility.** `MAX_SPOKEN_DENOMINATOR = 20`. This was missing from
the original option and the analysis says it should not have been: inflation
guards high rates and is blind at the other end, where a brand at 5% on n=150
speaks as "as few as 1 in 42" — faithful (1.13×) and unreadable. Every brand
under about 8.5% at n=150 lands there, which on the free Grader is a large share
of arrivals. An infinite denominator is exempt; it renders "none at all", a word
rather than a number.

Both constants are ⚠️ PROVISIONAL in the sense `MIN_N_FOR_COMPARISON` already
is: measured, not derived.

## The bounded-denominator option is rejected

Option (c) — allowing a numerator, "2 in 9" — was measured rather than argued.
Over a grid of 84 realistic (n, p̂) cells, with the same 1.5 inflation gate and
two independent readability yardsticks (strict = numerator ≤ 3 over a common
denominator; loose = numerator ≤ 3, denominator ≤ 12):

| option | speaks | readable, strict | readable, loose |
|---|---|---|---|
| (b) shipped — 1 in k, k ≤ 20 | 32% | 13% | 23% |
| (c) K = 10 | 50% | **25%** | **46%** |
| (c) K = 12 | 57% | 15% | 44% |
| (c) K = 16 | 69% | 6% | 21% |
| (d) one shared denominator, k ≤ 12 | 52% | 24% | 40% |

Four findings, and the third is the one that settles it.

1. **(c) really does buy coverage** — roughly double the readable share at
   K = 10, consistently under both yardsticks. The "it cannot help" hypothesis
   is simply wrong.
2. **More denominators make it worse.** K = 16 scores 6% strict against
   K = 10's 25%: given more freedom the approximation picks tighter, uglier
   fractions (elevenths, sixteenths). The constraint is what produces idiomatic
   output, not the fidelity — which makes the choice of K load-bearing and
   fragile, a third provisional constant doing all the work.
3. **Most of the coverage it adds is phrases worse than the percentage they
   replace.** Of the four cases (c) at K = 10 adds over (b):
   *"1 in 5 to 3 in 10"* (21.7–28.6%), *"2 in 9 to 2 in 7"* (22.4–27.8%),
   *"1 in 4 to 3 in 7"* (26.3–41.2%) and *"none at all to 1 in 9"* (2.7–10.2%)
   — only the last is clearly easier to read than its percentage. The other
   three demand mental normalising that the percentage does not.
4. **(c) is not a superset of (b).** They fail on complementary cases: a bounded
   denominator cannot represent anything between 0 and 6.1%, so at n=600 and
   p̂=8% (c) refuses while (b) says "1 in 17 to 1 in 9". Adopting (c) would lose
   some of the low-rate cases where frequency framing is most valuable.

Building (c) would therefore widen the set of shapes a headline can take —
percentage, "1 in k", *and* odd fractions — which makes the cross-scan
inconsistency that is already the main objection to two framings worse rather
than better, in exchange for a minority of cases that read no better. Rejected.

## Open

⚠️ **The live question is not (b) versus (c). It is (b) versus percentages
always, and desk analysis cannot settle it.**

The same grid says (b) speaks on 32% of cells and is idiomatic on 13–23%. So
for roughly two scans in three the headline is a percentage regardless, and for
part of the remainder the frequency it produces ("1 in 17 to 1 in 9") is not
obviously better than one. Two provisional constants, an outward-rounding rule,
a containment proof and 22 tests currently serve about one scan in five.

The case for keeping it as shipped: where it does speak idiomatically the
sentence genuinely lands — "as few as 1 in 6, as many as 1 in 3" reaches a
reader that "17.0–31.2%" does not — the gates make the bad cases unreachable,
and the fallback is not a degradation.

The case against: one shape always, and the product's own aesthetic is
restraint.

**This is an empirical question about readers, and every readability judgement
above is a proxy invented for the analysis.** It belongs in G3's usability
dimension with real people, not in another round of arithmetic. Until then the
gated version ships, because it is safe rather than because it is proven.

A second follow-on, smaller: `PromptBreakdown` ("which questions you appear in")
is marked `.detail` on the rule, and that is probably not the last word — it is
nearer a brand owner's world than the by-engine split is, and a one-line plain
version ("you appear in 3 of the 6 questions we asked") likely belongs in the
simple view. Not invented here.
