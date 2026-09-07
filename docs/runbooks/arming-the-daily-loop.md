# Runbook — arming the daily loop

**Status:** PREPARATION ONLY, with one exception recorded in §8 — the runner
ledger's cap was raised from `$5.00` to `$300.00` on 2026-09-07 at the owner's
instruction. Nothing else here has been executed.
**Written:** 2026-09-07 · **For:** the owner, to run personally
**Relates to:** ADR-0017 (daily scheduler) · ADR-0013 (cycles) · R3 (spend control)

Nothing is armed. No task is registered. No ceiling has been set by anyone but
you. This is the checklist and the reasoning behind the one number you have to
choose.

---

## 0. What is true right now

Checked on 2026-09-07, read-only:

| | |
|---|---|
| `GRADER_DAILY_LOOP` | **not set** — not in the shell, not in `.env`, not in `.env.local` |
| Scheduled task `BlipRank daily tick` | **does not exist** (`schtasks /Query` → not found) |
| Tracked domains | **0** — there is no `tracked.json`, so the formula cap is `$0.000` and a tick collects nothing even if armed |
| Runner ledger | `$300.00` cap, `$2.140` spent, **`$297.860` left** — raised from `$5.00` on 2026-09-07, see §2 |
| `COLLECTION_BUDGET_USD_DAILY` in `.env` | `25` — **and it is not in force.** See §1. |
| `OPENWEBNINJA_PLAN` in `.env` | `payg` — also not in force, same reason |

---

## 1. ⚠️ The `.env` files do NOT arm anything

This is the thing most likely to produce a confusing evening.

`daily-loop.ts` reads every flag from **`process.env` only**. The dotenv files
are consulted for exactly one thing — the provider API key, via `loadApiKey`.
So `COLLECTION_BUDGET_USD_DAILY=25` sitting in `.env` today satisfies no gate,
and a task that merely runs `pnpm grader:tick --apply --live` in a directory
containing that file will refuse with *"COLLECTION_BUDGET_USD_DAILY is
undefined"*.

Every flag has to be in the **task's own environment**, which is why the command
in §4 sets them inline. That separation is also the right one: the flags and the
budget are visible in Task Scheduler where an operator can audit them; the API
key never appears there and keeps coming from `.env.local`.

**ADR-0017's documented command omits these.** It says the variables should be
"set in that task's environment" without saying how, and `schtasks` has no
mechanism for it. §4 is the corrected form.

---

## 2. The number: what `COLLECTION_BUDGET_USD_DAILY` should be

### How it is used

```
today's cap = min( Σ(each tracked domain's expected cycle cost) × 1.2 ,
                   COLLECTION_BUDGET_USD_DAILY )
```

The left side already scales with what you track. **The hard ceiling is a
runaway guard, not the operating budget.** It answers one question: *what is the
most I am willing to spend in a day, ever, whatever the tracked list says?*

Two ways to get it wrong:

- **Set it too low** and it binds every day. The loop silently collects fewer
  domains than you tracked, and the reason is a number in a scheduled task
  nobody is looking at.
- **Set it too high** and it never binds, which is where `25` is today: at payg
  that is 43 domains a day, about **$750 a month**. It is not a ceiling, it is a
  formality.

### The arithmetic, at real prices

One cycle = prompts × 5 engines. Measured from `PRICE_USD_PER_CALL`:

| prompts | payg | mega |
|---|---|---|
| 10 | $0.340 | $0.090 |
| 17 | **$0.578** | $0.153 |

At 17 prompts on payg, the formula cap and what it costs over 30 days:

| tracked domains | formula cap / day | 30 days |
|---|---|---|
| 1 | $0.694 | $20.81 |
| 2 | $1.387 | $41.62 |
| 3 | $2.081 | $62.42 |
| 5 | $3.468 | $104.04 |
| 10 | $6.936 | $208.08 |

**The plan is a 3.8× lever on all of it.** The same ceiling that covers 3 domains
on payg covers 13 on mega. If the plan changes, revisit this number.

### The second ceiling, and why it no longer binds

The loop refuses outright when today's cap exceeds what the runner's lifetime
ledger has left (`daily-loop.ts:237`). That ledger was `$5.00` with `$2.860`
left, which capped the loop at **4 tracked domains** before the fifth made every
tick refuse.

**Raised to `$300.00` on 2026-09-07** by a deliberate edit to
`services/grader/data-live/ledger.json` — the only way, since `Budget` throws on
any raise passed in code. `$297.860` remains, which at 17 prompts on payg is
about **3.4 months of 5 domains collecting daily** ($2.890/day). The ledger gate
now binds only above roughly 429 tracked domains, so in practice the hard daily
ceiling in this section is the constraint that matters.

⚠️ **But see §2.5 — that raise can be silently undone.**

### 2.5 ⚠️ `GRADER_CAP_USD` must be set wherever the dev server runs

`Budget` lowers a cap whenever it is opened with a smaller one, and persists
that on the first charged call. Two callers open it:

| caller | cap it passes | effect |
|---|---|---|
| the daily loop (`daily-loop.ts:330`) | `ledgerCap(dataDir)` — the file's own | safe by construction; it reads the cap back so it can never lower it |
| `/api/scan` (`route.ts:362`) | `GRADER_CAP_USD ?? DEFAULT_CAP_USD` = **5** | **silently rewrites the ledger cap to $5 on its first charged call** |

Measured on a copy of the real ledger: constructing the Budget at 5 leaves the
file at 300, and the first `charge()` writes 5 — leaving $2.853. So one
hand-started cycle from the workspace record, on a server without
`GRADER_CAP_USD`, undoes the raise and nobody is told.

**Set `GRADER_CAP_USD=300` in the environment of whatever runs
`pnpm demo:grader`.** Verified: opened at 300, the cap holds through a charge.

⚠️ HUMAN REVIEW: the two callers disagree, and the daily loop already carries
the fix (`ledgerCap`, commented "read back so the runner never lowers it").
Giving `/api/scan` the same treatment is a change to spend-control logic, which
is human-owned, so it is reported rather than made.

### Recommendation

**`COLLECTION_BUDGET_USD_DAILY=2.00`** for a first arming with **1–2 tracked
domains at 17 prompts on payg**.

Why that figure:

- it is **above** the formula for 2 domains ($1.387), so it does not bind and
  does not silently under-collect;
- it sits far below the ledger headroom ($297.860), so the ledger gate cannot
  surprise you on day one — see §2.5 for the one way that headroom can vanish;
- the worst month it permits is **$60**, which is a number you would notice on a
  statement and not a number that hurts;
- and if the tracked list is fat-fingered to 20 domains, the cap holds at $2.00
  instead of following the formula to $13.87 a day.

**Move it when you track more.** The rule of thumb is *one notch above the
formula for the set you intend*: take the table above, read off the row, round
up. Anything much larger than that is not doing the job of a ceiling.

---

## 3. Before you register anything — verify dry

All read-only. None of these can collect.

```bash
# 1. The bill and every gate, with nothing set. Expect: 0 tracked, cap $0.000,
#    armed: no. This is the state today.
pnpm grader:tick

# 2. Track the domains you actually want, with a reason for whoever pays.
pnpm grader:track -- --domain pipedrive.com --on --reason "first armed-loop domain"

# 3. The bill again. Expect the formula cap to be non-zero and to match the
#    table in §2 for the number of domains you tracked.
pnpm grader:tick

# 4. The gates, with the real environment, still without --apply.
#    Expect: armed YES, live flags on, and a cap equal to min(formula, 2.00).
GRADER_DAILY_LOOP=armed COLLECTION_ENABLED=true GRADER_LIVE_SCAN=true \
  OPENWEBNINJA_PLAN=payg COLLECTION_BUDGET_USD_DAILY=2.00 \
  pnpm grader:tick

# 5. Offline end to end. Files real cycles from fixtures; spends nothing.
pnpm grader:tick -- --apply --fixture
```

Step 5 writes cycles to the live store from fixture answers. If you would rather
it did not, point it at a scratch store with `--data`.

---

## 4. Registering the task — the exact command

Run this in an **elevated** Command Prompt or PowerShell, from anywhere.

```
schtasks /Create /SC DAILY /ST 06:15 /TN "BlipRank daily tick" /TR "cmd /c cd /d D:\bliprank && set GRADER_DAILY_LOOP=armed&& set COLLECTION_ENABLED=true&& set GRADER_LIVE_SCAN=true&& set OPENWEBNINJA_PLAN=payg&& set COLLECTION_BUDGET_USD_DAILY=2.00&& pnpm grader:tick -- --apply --live >> services\grader\data-live\tick.log 2>&1"
```

Three details that will bite if changed:

- **No space before `&&`.** In `cmd`, `set X=armed && ...` puts a trailing space
  *inside the value*, so `GRADER_DAILY_LOOP` becomes `"armed "` and the loop
  refuses as not armed — with a message that looks like a typo you cannot see.
- **No inner double quotes.** The whole `/TR` is one quoted string.
- **`06:15`** is arbitrary. Pick a time the machine is reliably awake; the task
  does not wake it, and a missed day is a missed cycle, not an error.

Verify it registered, and read it back:

```
schtasks /Query /TN "BlipRank daily tick" /V /FO LIST
```

Run it once by hand before trusting the schedule:

```
schtasks /Run /TN "BlipRank daily tick"
type services\grader\data-live\tick.log
```

---

## 5. The final flip

There isn't a separate one. **`GRADER_DAILY_LOOP=armed` is set inside the task
command in §4**, so registering the task *is* the arming, and it takes effect at
the first run after registration.

If you would rather arm and register as two acts — which is the safer order —
register the task in §4 with `set GRADER_DAILY_LOOP=off` first, confirm a run
refuses cleanly and logs why, then edit the task to `armed`:

```
schtasks /Change /TN "BlipRank daily tick" /TR "cmd /c cd /d D:\bliprank && set GRADER_DAILY_LOOP=armed&& set COLLECTION_ENABLED=true&& set GRADER_LIVE_SCAN=true&& set OPENWEBNINJA_PLAN=payg&& set COLLECTION_BUDGET_USD_DAILY=2.00&& pnpm grader:tick -- --apply --live >> services\grader\data-live\tick.log 2>&1"
```

---

## 6. Stopping it

Any one of these stops the loop, in decreasing order of bluntness:

```
schtasks /Delete /TN "BlipRank daily tick" /F     # gone
schtasks /Change /TN "BlipRank daily tick" /DISABLE
```

or edit the task and set `GRADER_DAILY_LOOP` to anything other than `armed`.
Untracking every domain (`pnpm grader:track -- --domain x --off --reason "…"`)
also takes the cap to `$0.000`, which stops collection while leaving the task in
place.

---

## 7. What to check after the first live run

```bash
pnpm grader:tick                                    # the day's ledger and what ran
type services\grader\data-live\tick.log
```

- `daily-spend.json` — the day's booked spend against its cap
- `ledger.json` — the lifetime figure moved by the same amount
- `results/cycles/<domain>/<day>.json` — a real cycle filed
- the workspace record — a second cycle draws the trend

If the day's booked spend is materially below the expected cycle cost, a domain
refused; the tick names which and why.

---

## 8. What has NOT been done

Stated explicitly, because this file could be mistaken for a record of actions:

- ❌ No scheduled task registered
- ❌ `GRADER_DAILY_LOOP` not set, anywhere
- ❌ No ceiling value set by anyone but you — the `25` in `.env` is untouched,
  and is not read by the tick regardless
- ❌ No domain tracked — `tracked.json` does not exist
- ❌ No live tick run, with or without `--apply`
- ✅ **The runner ledger's cap WAS raised**, `$5.00` → `$300.00`, on 2026-09-07
  at the owner's instruction. Only `capUsd` changed; `spentUsd`
  (`2.1399999999999895`), `calls` (399), `byEngine` and `updatedAt` are
  byte-identical. This is the one action in this file that has been taken.

The only commands run while writing this were `pnpm grader:tick` with no flags
(which prints the bill and collects nothing) and read-only `schtasks /Query`.
