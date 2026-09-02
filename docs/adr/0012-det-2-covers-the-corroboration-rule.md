# ADR-0012 — det-2 covers a rule that shipped without a bump, and the bar for ever doing that again

**Status:** Accepted · **Date:** 2026-09-02 · **Phase:** P3
**Relates to:** R5 (score rows are immutable and version-stamped) · R1
(deterministic scoring) · ADR-0009 Amendment 3 (where a generated category's
competitors come from) · `docs/METHODOLOGY.md` changelog

## Context

Two commits changed the scorer on 2026-09-01, twenty-seven minutes apart:

| Commit | Time (UTC) | What | Stamp |
|---|---|---|---|
| `12408cc` | 11:11 | Introduced `domainBrandForms`: for a subject that is not a tracked leader, derive separator-insensitive aliases from the domain label, minus a leading `the/get/try/use/my/go/join/hey/we/app` when **at least five** characters remain, with the site title as corroboration for the display name. Fixed thecosmicbyte.com's false zero. | det-1 → **det-2** |
| `0d4af7f` | 11:38 | Added one branch to the same function: a remainder of **exactly four** characters is held as provisional and admitted only when the site title names it (`getlago` → `lago`; `google` → `ogle` stays refused). | **det-2, no bump** |

The comment on `SCORING_ALGO_VERSION` reads "bumped whenever a rule changes what
an existing answer would score". The second commit met that test and did not
bump. Nothing enforced the comment. This was found on 2026-09-02 while
correcting the methodology page's changelog, and flagged for human review.

The question put was definitive: does `0d4af7f` change what any already-scored
answer would score, compared with det-2 as of `12408cc`? If yes, which stored
results are affected and what does R5 prescribe? If no, prove it with the
boundary case, not an assertion.

## Evidence

Method: `git show 12408cc:services/scorer/src/score.ts` was extracted beside the
current `score.ts`, and one script imported both modules and ran identical
inputs through each version's `domainBrandForms` and `scoreAnswer`. Reads only;
no network; no provider; nothing written. Appendix A gives the script so the
check can be repeated.

### 1. The two versions disagree on exactly one shape of input

Seven synthetic cases. One differs.

| Host | Title | 12408cc forms | HEAD forms | Answer text | 12408cc | HEAD |
|---|---|---|---|---|---|---|
| getlago.com | "Lago - Open Source Usage Based Billing" | `getlago` only | `getlago`, `Lago`, squashed `lago` | "For usage-based billing, Lago is the one people self-host." | **not mentioned** | **mentioned, position 1** |
| getlago.com | none | `getlago` only | same | same | not mentioned | not mentioned |
| getlago.com | "Alternatives to Stripe Billing and Chargebee" | `getlago` only | same | same | not mentioned | not mentioned |
| google.com | "Google" | `google`, `Google` | same | "People ogle at their phones all day on the train." | not mentioned | not mentioned |
| thecosmicbyte.com | none | `thecosmicbyte`, squashed `cosmicbyte` | same | "Cosmic Byte makes budget headsets." | mentioned | mentioned |
| usebubbles.com | none | `usebubbles`, squashed `bubbles` | same | "Bubbles is a decent async video tool." | mentioned | mentioned |
| getlago.com | "Lago - Open Source Usage Based Billing" | `getlago` only | `getlago`, `Lago`, `lago` | "Stripe and Chargebee dominate; nobody mentions the self-hosted option." | not mentioned | not mentioned |

So the answer to the first question is **yes, in principle**: for a domain whose
label is one of the ten prefixes followed by exactly four characters, with a
recorded title that names those four, an answer naming the brand scores as a
mention under HEAD and as a miss under `12408cc`. Same stamp on both. The
squashed-alias mechanism alone cannot admit it under either version, because four
is below its floor of five; only the corroboration branch does.

### 2. The full corpus, both versions: zero differing rows

Not a sample. The answer store held **360 texts in 360 blob files** from the
three live scans. Every text was scored against every domain-label subject in the
project, under both versions, using the titles on the category records.

| Subject | Recorded title | Label shape | Texts | Mentioned, 12408cc | Mentioned, HEAD | Differing rows |
|---|---|---|---|---|---|---|
| thecosmicbyte.com | none | `the` + `cosmicbyte` (10) | 360 | 25 | 25 | **0** |
| sigzen.com | "Sigzen" | no prefix match | 360 | 0 | 0 | **0** |
| pipedrive.com | leader, reviewed alias table | never enters `domainBrandForms` | — | untouched | untouched | **0** |

The derived forms are byte-identical for both hosts under both versions.

Two result files were derived inside the twenty-seven-minute window and both were
re-derived after it. The subject rows match exactly:

| File | Derived | Subject row | Re-derived | Subject row |
|---|---|---|---|---|
| `thecosmicbyte.com.det-2.audit.json` | 2026-09-01 11:36Z | 25 / 50 = 0.50 | 2026-09-02 06:15Z | 25 / 50 = 0.50 |
| `sigzen.com.det-2.audit.json` | 2026-09-01 11:29Z (live) | 0 / 50 = 0.00 | 2026-09-02 06:15Z | 0 / 50 = 0.00 |

The sigzen re-derivation added six promoted competitors; that is the basis
moving from `erp-software@1` to `@2` (ADR-0009 Amendment 3), not the scorer, and
the subject row is unchanged. Commit timestamps cannot say which code the 11:36Z
derivation ran, because a commit is dated when committed, not when written. It
does not matter: both versions produce the same row.

### 3. Why zero is structural, and why no past or future record can reach the differing case

Three closures, each independent of the others.

**Length.** `cosmicbyte` is ten characters and was trusted on length alone under
both versions. `sigzen` starts with none of the ten prefixes, so it has no
remainder at all. Neither can enter the provisional branch, whatever the title.

**The carrier.** The corroborating title reaches the scorer only through
`brandName` on the category record, which is written once at classification
(`resolve-category.ts`, via `domainBrandForms(host, title + description)`) and
never re-fetched (`scan.ts`, `subjectFor`). Under `12408cc` a four-character
remainder was not a candidate, so the title could not corroborate it, so
`derived.name` stayed equal to the label, so **no `brandName` was recorded** for
such a domain. A record written before `0d4af7f` for a getlago-shaped domain
therefore carries no name, and HEAD scoring it finds nothing to corroborate and
derives exactly what `12408cc` did. The old rules and the new rules produce the
same forms for every record the old rules could have written.

**The store.** No record in `domain-categories.json` has a four-character
remainder: thecosmicbyte (10), sigzen (none), pipedrive (leader), kreo-tech
(none), example (none).

Together: no stored answer, no stored result, and no record that could ever have
been written under the pre-`0d4af7f` rules can score differently under HEAD.

## Decision

**det-2 is defined as the rules at HEAD, including the four-character
corroboration branch. There is no det-3.**

Two fixes were correct. A mechanical bump to det-3 would have re-derived three
results that are provably identical and then, by `compare()`'s own refusal to
compare across versions, marked them *not comparable* with everything stamped
det-2 — a false signal of the same class as a false zero, delivered through
version bookkeeping instead of a scoring bug. The evidence above clears the bar
for the alternative: every det-2 row in existence is reproducible from its record
under one rule set, the HEAD one, and no row was ever produced that this
definition contradicts.

Three conditions ship with it:

1. **The guard.** `services/scorer/src/algo-version-pin.test.ts` pins a table of
   (host, title) inputs to the exact forms the current version derives, keyed by
   `SCORING_ALGO_VERSION`. A change to the derivation fails a row; a bump fails
   the lookup until a table for the new version is written. The derivation can
   no longer change silently in either direction.
2. **The changelog documents the lapse**, in `docs/METHODOLOGY.md`, and points
   here for the evidence rather than summarising it.
3. **The bar is written into R5** in `CLAUDE.md`, so this exception cannot
   become a habit: a rule change may ship without a bump only when backed by a
   full-corpus check *and* a structural closure argument. Anything less bumps.

## Consequences

- The det-2 row in the methodology changelog describes the HEAD rules and is
  correct as written. Nothing is re-derived.
- `0d4af7f`'s own five test cases and the pin table together fix det-2's
  behaviour on the four-character branch; a future change to it is a det-3 by
  construction.
- **Known gap, not urgent (tracked, not fixed here).** `/score-version`, which
  R5 names as the way to bump, does not work as written: it points at
  `services/scorer/version.ts`, which does not exist (the constant is
  `SCORING_ALGO_VERSION` in `services/scorer/src/score.ts`), and it gates on a
  golden set of 300–500 hand-labelled answers that holds 7 seed cases and reports
  `NOT_RUN`. Nothing blocks on it while G0 and G3 are unrun. It must be repaired
  before the first real bump, or that bump will be done by hand and the process
  R5 relies on will be untested at the moment it matters.

## Appendix A — reproducing the check

```sh
git show 12408cc:services/scorer/src/score.ts > services/scorer/src/_score_12408cc.ts
npx tsx services/scorer/src/_r5-probe.ts   # the script below
rm services/scorer/src/_score_12408cc.ts services/scorer/src/_r5-probe.ts
```

```ts
// services/scorer/src/_r5-probe.ts — reads only; no network.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as OLD from './_score_12408cc.js'
import * as NEW from './score.js'

type Mod = typeof NEW
const spec = (m: Mod, host: string, title?: string) => {
  const f = m.domainBrandForms(host, title)
  return { id: `domain:${host}`, name: f.name, aliases: f.aliases, squashedAliases: f.squashedAliases, domains: [host] }
}
const row = (m: Mod, host: string, title: string | undefined, text: string) => {
  const r = m.scoreAnswer({ answer: { text, citations: [] }, brand: spec(m, host, title) })
  return JSON.stringify({ mentioned: r.mentioned, mentionCount: r.mentionCount, position: r.position, brandsDetected: r.brandsDetected })
}

// 1. Synthetic cases: print forms and score under each version.
const LAGO = 'For usage-based billing, Lago is the one people self-host.'
for (const [host, title, text] of [
  ['getlago.com', 'Lago - Open Source Usage Based Billing', LAGO],
  ['getlago.com', undefined, LAGO],
  ['getlago.com', 'Alternatives to Stripe Billing and Chargebee', LAGO],
  ['google.com', 'Google', 'People ogle at their phones all day on the train.'],
  ['thecosmicbyte.com', undefined, 'Cosmic Byte makes budget headsets.'],
  ['usebubbles.com', undefined, 'Bubbles is a decent async video tool.'],
] as const) {
  const same = row(OLD, host, title, text) === row(NEW, host, title, text)
  console.log(same ? 'SAME' : 'DIFF', host, title, row(OLD, host, title, text), row(NEW, host, title, text))
}

// 2. Every stored answer against every domain-label subject, both versions.
const root = join(import.meta.dirname, '..', '..', 'grader', 'data-live', 'answers')
const texts: string[] = []
const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') && texts.push(...(JSON.parse(readFileSync(p, 'utf8')).runs ?? []).map((r: { text?: string }) => r.text).filter((t: unknown): t is string => typeof t === 'string')) } }
walk(root)
for (const [host, title] of [['thecosmicbyte.com', undefined], ['sigzen.com', 'Sigzen']] as const) {
  const diffs = texts.filter((t) => row(OLD, host, title, t) !== row(NEW, host, title, t)).length
  console.log(diffs === 0 ? 'SAME' : 'DIFF', host, title, `${texts.length} texts, ${diffs} differing rows`)
}
```

Expected output on the 2026-09-02 store: `DIFF` on the first synthetic line
only, `SAME` on every other line, and `360 texts, 0 differing rows` for both
subjects.
