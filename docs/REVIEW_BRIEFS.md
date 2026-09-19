# Review briefs — what a row's own review must answer before it commits

> Written by the oversight session on 2026-09-19. Every row since Stage B went
> build → builder's review → oversight's independent review → a fix row,
> because the second review asked harder questions than the first. These are
> those questions. A builder hands the matching brief to the reviewer agent
> **verbatim, with the changed files listed**, tells it not to trust the
> builder's notes, commit messages, ADRs or comments, and fixes what comes back
> before committing. The oversight session then confirms rather than rediscovers.
> A finding is closed by a test that fails before the fix, never by a sentence.

## 0. The gate (every row, no reviewer needed)

Run each with its own exit code (`cmd > log 2>&1; echo $?`), never through a
pipe: `pnpm typecheck`, `pnpm test`, `pnpm --filter @bliprank/public build`.
C3 landed with the first two and CI green and the third broken. After pushing,
confirm the CI run for that commit is green through the public runs API.
**Poll CI sparingly:** the unauthenticated API allows 60 requests an hour for the whole
machine, shared by every session and track (exhausted on 2026-09-19 with three tracks
polling every 25 s). A run takes about six minutes: make the first check five minutes
after the push, then at most one a minute, and if the response carries a rate-limit
message, read the reset time from `https://api.github.com/rate_limit` and wait for it
rather than looping.
Nothing a test needs may come from this machine: no live data directory, no
key in a dotenv file reaching a network call. If a test passes here and would
fail on a clean checkout, it is broken.

## 1. Tenancy (`tenancy-auditor`) — any change under `packages/db`, any route, anything reading or writing workspace state

1. For every table touched: RLS enabled AND forced? Policies per command? Any `USING (true)`? Any tenant-readable relation with no disjointness case in `tenant-isolation.test.ts`?
2. List every value the change reads from a request (body, query, headers, cookies). Can any of them select a workspace, an account or a role? The answer must be no, proven by a test that sends them and shows they are ignored.
3. Every SECURITY DEFINER function: owner, `search_path` pin, grants, and whether it takes its workspace from the verified context or trusts an argument.
4. Every refusal and error string a caller can see: does it carry another tenant's host, count, or existence? Is any cap or ledger keyed by bare host across workspaces, making a refusal an oracle?
5. Where is each authorisation rule enforced: the database, or one line of TypeScript? If one line, say so as a finding.
6. Shared documents outside the database (ledger documents in Upstash or files): who can read, overwrite or remove another workspace's entry, and what is the only thing preventing it?
7. Migrations: transactional, recorded in `schema_migrations` first, picked up by the ordered runner, deploy check and the 0008 manifest still green with it applied.
8. What do the tests NOT cover? List it.

## 2. Cost (`cost-sentinel`) — anything in `services/collector`, the runner, the loop, a ledger, a route that can start a collection, or any new network call

1. Trace from the entry point to the provider call and list every gate in order. Is there any path to a paid call that skips the Budget, the per-run allowance, or the daily cap?
2. Is every charge made BEFORE its attempt, retries included? Is every read-modify-write on a shared ledger atomic or fenced to its lease? Construct the interleaving where two holders both pass a check, and say whether it can spend twice.
3. For every throw or non-2xx: before or after a reservation or a spend? Can a retry spend again?
4. Every user-supplied number that sizes a spend (prompt count, days, runs, hosts): maximum, where enforced (client, route, or the pure decision), and behaviour on 0, negative, fraction, huge, non-number. Give the dollar cost at the maximum.
5. Is expected cost computed from the real size at collection time, or a default? Find any place that still assumes the default.
6. Can one bound be bypassed through a sibling path (a CLI twin, a second route, toggling off and on)? One guard belongs in the shared function, not in one caller.
7. Any test that reaches the network when a key exists in the environment? Grep for un-stubbed `fetch` and for code paths that read a key from a dotenv file.
8. Give a dollar figure for every finding, and list what no test covers.

## 3. Statistics and rendered metrics (`stats-reviewer`) — `packages/stats`, anything that computes or renders a `Metric`, the basis, a comparison, a trend

1. What exactly is the sample behind each number: which prompts, engines, runs, and is `n` the count of THAT sample only? Any pooling of two samples into one rate?
2. Does the basis string identify the sample? Can two different samples ever carry the same basis, or one sample two bases?
3. Every consumer that puts two `Metric`s side by side: does it go through `compare()`? What does it do at different basis, different algo version, n below the floor, precision divergence?
4. What does a client see at n = 5 with 0 mentions, n = 5 with 5 mentions, and at zero overall? Is any of it confidently wrong, or a bare number with no sentence?
5. Does every rendered number carry value, interval, n, algo version and collection path, through `packages/stats/format`, with no inline `toFixed`, `Math.round` or `%`?
6. R5: did any scoring rule change? If so, was the version bumped with the full flip list? Can a re-score change which answers a historical cycle counts?
7. **The client standard (owner, 2026-09-19):** can a non-technical client say what each number means for them from the page alone, at simple depth? Hiding a metric is not explaining it. The interval is spoken as a range, never dropped, never called a margin of error.
8. List what no test covers.

## 4. Interface (`frontend-designer` builds; the reviewer reads as the client)

1. At simple depth, every metric has one plain sentence built only from numbers on the page. At detailed depth, the technical client still gets provenance, n, version and the tables.
2. No green arrow or emphasis inside the interval: "no real change" is the verdict when the movement is inside the range (R8).
3. Browser-side code imports package subpaths (`@bliprank/contracts/basis`), never a package root that carries a Node-only module; `build-env.test.ts` enforces it and the build proves it.
4. British-neutral English, no em-dashes in UI strings, keyboard reachable, labelled controls, contrast in both themes.
5. No invented data on any production surface: an empty state says nothing has been measured.
