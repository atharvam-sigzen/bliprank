import { normaliseHost } from '@bliprank/taxonomy'
import { SCAN_FAILED } from '@/lib/route-errors'
import { join } from 'node:path'
import { ENGINES, headlineSetOf } from '@bliprank/contracts'
import { checkGate, defaultGateConfig, ledgerCapUsd, recordScan, utcDay } from '../../../../../services/grader/src/live-gate.js'
import { bankAuthorConfig } from '../../../../../services/grader/src/bank-author.js'
import { checkDomainCeiling, defaultDomainCeilingConfig, recordDomainCycle, runAllowanceFor } from '../../../../../services/grader/src/domain-ceiling.js'
import { loadApiKey, readFlag } from '../../../../../services/grader/src/load-key.js'
import { allBanks } from '../../../../../services/grader/src/resolve-category.js'
import { basisOf, promptsFor } from '../../../../../services/grader/src/scan.js'
import { runGrader } from '../../../../../services/grader/src/run.js'
import { categoryRecordIn, customPromptsIn, cycleInputOf } from '../../../../../services/grader/src/store/documents.js'
import type { WorkspaceStore } from '../../../../../services/grader/src/store/pg-store.js'
import { measuresCurrentCategory } from '@/lib/scan-result'
import { ROOT } from '@/lib/data-dir'
import { workspaceAccess } from '@/lib/workspace-access'
import {
  checkVisitorThrottle,
  defaultVisitorThrottleConfig,
  extractClientIp,
  recordVisitorScan,
} from '../../../../../services/grader/src/visitor-throttle.js'

/**
 * Live Grader scans, for a demo, over Server-Sent Events.
 *
 * ⚠️ OFF BY DEFAULT AND DELIBERATELY SO. A public form wired to collection is an
 * unauthenticated, unmetered spend trigger, and P3.6 — Turnstile and the per-IP
 * cap — does not exist. This route refuses unless BOTH `COLLECTION_ENABLED` and
 * `GRADER_LIVE_SCAN` are exactly 'true', which is two deliberate acts rather
 * than one forgotten flag. With either unset the page falls back to the
 * committed scan and nothing here can run.
 *
 * ⚠️ DEPLOYED AS A FUNCTION (Vercel, ADR-0002 Amendment 1, 2026-09-10). The
 * `maxDuration` below bounds the whole SSE stream: Vercel's limits page
 * (2026-08-24) counts "streamed responses" inside it. 300s is the Hobby
 * maximum and the Pro default, so it needs no dashboard change on either plan,
 * and G3's p95 ≤ 90s sits inside it. The store behind `writeCycle` is one
 * machine's disk until MVP_PLAN B3, so on the deployment `GRADER_LIVE_SCAN`
 * stays unset and this route refuses before it could write.
 *
 * SSE rather than a request that returns in 90 seconds: G3 allows p95 ≤ 90s
 * domain-to-first-insight, and a browser staring at a pending fetch for that
 * long is indistinguishable from a hung page. Progress is emitted per cell.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO KINDS OF REQUEST, ONE SET OF GATES (ADR-0013).
 *
 *   { domain }                 the first scan of a domain — or, if one exists,
 *                              the cached latest cycle, free, exactly as before.
 *   { domain, cycle: 'new' }   ANOTHER cycle of a domain already scanned: a new
 *                              UTC day, new cells, real spend. Started by a
 *                              person pressing a button; nothing schedules it.
 *
 * A new cycle is exactly as governed as a first scan. It skips the cache and
 * NOTHING ELSE: the two flags, the key, the per-visitor throttle, the per-domain
 * ceiling and the live quota gate all run, in the same order, from the same
 * code. There is no branch below that a second cycle takes and a first does not,
 * because a branch is where a special case would go.
 *
 * And it never re-derives the category. `runGrader` resolves the category
 * through `resolveCategory`, whose rung 0 returns the RECORDED decision before
 * anything can fetch or author; this route additionally refuses a new cycle
 * for a domain that has a stored cycle but no record, because the only way to
 * collect it would be to decide a category today, and two cycles measured
 * under different questions are not a trend.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300


/**
 * The data directory, resolved per request so a test can point this route at a
 * scratch directory through `GRADER_DATA_DIR` instead of writing ledgers and
 * results into the machine's real `data-live`.
 */

/**
 * Both flags, resolved the same way the API key is: environment first, then the
 * repo-root `.env.local`.
 *
 * ⚠️ THIS WAS BROKEN AND SILENT. It read `process.env` only, but Next loads env
 * files from the directory it runs in — `apps/public` — and never from the repo
 * root where `.env.local` actually lives. So editing the documented file
 * (CLAUDE.md §7) changed nothing, produced no error, and the page just went on
 * saying live scanning was off. A safety flag that cannot be turned on by the
 * documented method is not a safety property, it is a bug that happens to fail
 * closed.
 *
 * Still TWO flags, still both required, and `sources` records where each came
 * from so "is it on, and why" is answerable without guessing.
 */
const resolveFlags = (env: NodeJS.ProcessEnv) => {
  const collection = readFlag(ROOT, 'COLLECTION_ENABLED', env)
  const live = readFlag(ROOT, 'GRADER_LIVE_SCAN', env)
  return {
    enabled: collection.value === 'true' && live.value === 'true',
    sources: `COLLECTION_ENABLED=${collection.value ?? 'unset'} (${collection.from}), GRADER_LIVE_SCAN=${live.value ?? 'unset'} (${live.from})`,
  }
}


/**
 * A finished scan for this domain, if one was ever produced AND it still
 * measures the same thing.
 *
 * ⚠️ THE CATEGORY IS PART OF THE CACHE KEY, BECAUSE IT IS PART OF THE QUESTION.
 *
 * This used to key on the domain alone, and that is not a cache — it is a
 * promise that a domain has one answer forever. It does not. `resolveCategory`
 * grew a site-content rung and an authoring rung (ADR-0009), so a domain
 * scanned before those existed carries a result measured against a bank nobody
 * would choose for it today. sigzen.com is the specimen: collected under
 * `general-business-software`, recorded since as `erp-software`. The preview
 * showed the ERP prompts, the visitor pressed the button, and this function
 * handed back a general-business-software measurement — the two screens
 * disagreeing about what the number is OF, which is the one thing this product
 * exists not to do.
 *
 * So a result is only served when the category it was collected under is still
 * the category we decide. Otherwise it is a measurement of a different thing,
 * and answering with it is worse than spending again: R5 forbids rebasing a
 * historical score, and serving one under a new category's name is that with
 * extra steps. A miss re-scans and files a new cycle, so this self-heals once.
 *
 * A file recording NO category is kept. It cannot be checked, and invalidating
 * what cannot be checked would re-spend on shape drift alone — refusing to
 * guess in the safe direction, the same rule `runInfoOf` follows for cost.
 */
async function cached(store: WorkspaceStore, domain: string): Promise<unknown | null> {
  const latest = await store.cycles.latest(domain)
  if (!latest) return null
  // The record, not a re-derivation: a first decision is written once, so a
  // record only ever changes by a deliberate act against the store. That makes
  // the comparison stable rather than a source of surprise re-spending.
  //
  // The decision itself is a pure function in lib/scan-result.ts, where it can
  // be tested without a filesystem — this line is the IO around it.
  const record = await categoryRecordIn(store, domain)
  return measuresCurrentCategory(latest.result, record?.slug ?? null) ? latest.result : null
}

export async function POST(req: Request): Promise<Response> {
  const env = process.env
  const visitorIp = extractClientIp(req, env)
  const body = (await req.json().catch(() => ({}))) as { domain?: string; cycle?: string }
  const domain = normaliseHost(String(body.domain ?? ''))
  const wantsNewCycle = body.cycle === 'new'

  // A browser that closes the tab mid-scan closes the stream, and every
  // subsequent enqueue throws. Unguarded, that exception unwound the whole scan
  // — discarding answers already PAID FOR and leaving the run lock held, so
  // every later scan was refused with "another scan holds run.lock". The work is
  // bought: it finishes and caches whether or not anyone is still watching.
  let open = true
  const send = (stream: ReadableStreamDefaultController, event: string, data: unknown) => {
    if (!open) return
    try {
      stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    } catch {
      open = false
    }
  }
  const done = (stream: ReadableStreamDefaultController) => {
    if (!open) return
    open = false
    try {
      stream.close()
    } catch {
      /* the client already went away */
    }
  }

  const stream = new ReadableStream({
    async start(c) {
      try {
        if (!domain) {
          send(c, 'error', { kind: 'input', message: 'Enter a domain, for example pipedrive.com' })
          return done(c)
        }

        // THE WORKSPACE IS THE SESSION'S (MVP_PLAN B3b): the cycle this scan
        // files, the record it runs under and the ledgers it books against
        // are the store the session's token scopes. No session, no scan.
        const access = await workspaceAccess(env)
        if (!access.ok) {
          send(c, 'error', { kind: 'access', message: access.message })
          return done(c)
        }
        const { store, ledgers, dataDir: DATA } = access

        const now = new Date()
        const today = utcDay(now)

        // THE SCAN'S SIZE, RESOLVED ONCE, AND REFUSED IF IT CANNOT SIZE A SCAN.
        // `GRADER_PROMPTS_PER_SCAN=0` or a non-number would pass the ceiling
        // (needing 0) and the quota gate (remaining < 0 is never true) and then
        // run the WHOLE bank, because the runner drops a falsy maxPrompts. Found
        // by the ADR-0013 second review. Refused here, where it costs nothing.
        const cfg = defaultGateConfig(DATA, env, ledgers)
        if (!Number.isInteger(cfg.callsPerEngine) || cfg.callsPerEngine <= 0) {
          send(c, 'error', {
            kind: 'config',
            message: `GRADER_PROMPTS_PER_SCAN resolves to ${String(cfg.callsPerEngine)}, which is not a positive whole number, so no scan can be sized. Nothing was collected and nothing was charged.`,
          })
          return done(c)
        }

        if (!wantsNewCycle) {
          // 1. CACHE FIRST. A repeat of the same domain must never re-spend
          //    quota — with 50 requests a month and 17 per engine per scan, one
          //    accidental re-submit is a sixth of the month.
          const hit = await cached(store, domain)
          if (hit) {
            // WHICH QUESTIONS THE SERVED CYCLE ASKED, AND WHICH ARE IN FORCE NOW
            // (C3r item 5). One cycle a day stands; what was silent is that a
            // person who saved version 2 today and pressed the button was shown
            // version 1's number with nothing saying so. The served set is
            // read off the cycle's OWN basis by the shared predicate, the set
            // in force from the store; the page words them (lib/served-set.ts).
            const servedBasis = String((hit as { comparisonBasis?: unknown }).comparisonBasis ?? '')
            const servedDay = String(((hit as { run?: { day?: unknown } }).run?.day ?? '') || String((hit as { collectedAt?: unknown }).collectedAt ?? '').slice(0, 10))
            const inForce = await customPromptsIn(store, domain)
            send(c, 'cached', {
              domain,
              served: {
                servedDay,
                servedVersion: headlineSetOf(servedBasis)?.version ?? null,
                inForceVersion: inForce && inForce.prompts.length > 0 ? inForce.version : null,
                today,
                nextCheckFrom: servedDay === today ? nextDay(today) : today,
              },
            })
            send(c, 'result', hit)
            return done(c)
          }
        } else {
          // 1'. A NEW CYCLE, and the two things that make one impossible.
          //
          //    Same day: the cache key is per UTC day, so a second scan today
          //    would read every cell back from the store and produce the same
          //    measurement again — nothing bought, nothing new, and a second
          //    point on the trend that is the first point wearing a new date.
          //
          //    No record: the category must be the one the last cycle ran
          //    under, and the record is the only thing that guarantees it.
          //    Without one, collecting would mean deciding a category today,
          //    which would make the two cycles measurements of different
          //    things. Refused rather than re-derived.
          const prior = await store.cycles.latest(domain)
          if (prior) {
            const record = await categoryRecordIn(store, domain)
            if (!record) {
              send(c, 'error', {
                kind: 'no-record',
                message: `${domain} has a stored cycle from ${prior.day} but no category record, so a new cycle cannot be collected without deciding a category today. Two cycles measured under different categories are not a trend. Nothing was collected and nothing was charged.`,
              })
              return done(c)
            }
            //    No bank for the recorded slug: `resolveCategory` would fall
            //    back to the general bank for this scan and leave the record
            //    alone — honest for a first scan, and for a second cycle a
            //    measurement against different prompts filed as a point of the
            //    same trend. Refused.
            const bank = allBanks(DATA).find((b) => b.category === record.slug)
            if (!bank) {
              send(c, 'error', {
                kind: 'no-bank',
                message: `${domain}'s recorded category ${record.slug} has no prompt bank in this build, so a new cycle would run against the general bank rather than the prompts the last cycle used. Refused rather than measured against a different question. Nothing was collected and nothing was charged.`,
              })
              return done(c)
            }
            //    A basis the trend cannot use. The prompt count and the engine
            //    set are the two parts of the basis the ENVIRONMENT controls,
            //    and a cycle collected at 10 prompts beside one collected at 17
            //    is a point compare() refuses and the chart breaks at — a whole
            //    cycle's spend for a point nothing can be drawn through. Both
            //    September scans on disk were bought at 10 while the reference
            //    cycle is 17; found by the ADR-0013 second review. The bank
            //    version is deliberately NOT checked: a promoted competitor set
            //    is a deliberate act, and refusing every cycle after it would
            //    freeze the domain.
            const was = basisOf(prior.comparisonBasis)
            const willAsk = promptsFor(bank, cfg.callsPerEngine).length
            const wasEngines = was.engines ? [...was.engines].sort().join(',') : undefined
            const willUse = [...ENGINES].sort().join(',')
            // With the person's own set in force the set is the measurement and a
            // version change is a deliberate change of basis the trend breaks at
            // (ADR-0016 Amendment 1), not a refusal; the bank's count is checked
            // only while the bank is the measurement.
            const setInForce = ((await customPromptsIn(store, domain))?.prompts.length ?? 0) > 0
            const promptsDiffer = !setInForce && was.maxPrompts !== undefined && was.maxPrompts !== willAsk
            const enginesDiffer = wasEngines !== undefined && wasEngines !== willUse
            if (promptsDiffer || enginesDiffer) {
              const detail = [
                promptsDiffer ? `asked ${was.maxPrompts} prompts per engine and this one would ask ${willAsk} (GRADER_PROMPTS_PER_SCAN on the scan server)` : '',
                enginesDiffer ? `ran on ${wasEngines} and this one would run on ${willUse}` : '',
              ]
                .filter(Boolean)
                .join('; it also ')
              send(c, 'error', {
                kind: 'basis-mismatch',
                message: `${domain}'s last cycle (${prior.day}) ${detail}. The two would not be comparable, so the new cycle could not join the trend and its spend would buy a point nothing can be drawn through.${promptsDiffer ? ` Set GRADER_PROMPTS_PER_SCAN=${was.maxPrompts} to collect a comparable cycle.` : ''} Nothing was collected and nothing was charged.`,
              })
              return done(c)
            }
            if (prior.day === today) {
              send(c, 'error', {
                kind: 'cycle-exists',
                message: `${domain} already has its cycle for ${today}. A cycle is one scan per UTC day, because the answer cache is keyed by day: a second scan today would read the same answers back and change nothing. The next cycle can be collected from ${nextDay(today)}. Nothing was collected and nothing was charged.`,
              })
              return done(c)
            }
          }
        }

        // Any member may start a first scan: the category record a first scan
        // writes is a measurement's precondition, not a decision (migration
        // 0006, B3d item 2); corrections stay an owner's or admin's.
        const flags = resolveFlags(env)
        if (!flags.enabled) {
          send(c, 'error', {
            kind: 'disabled',
            // Says WHICH flag is off and where it was read from. The previous
            // message could not distinguish "deliberately off" from "your edit
            // never loaded", which is the failure that actually happened.
            message: `Live scanning is off, so nothing was collected. Resolved: ${flags.sources}. Both must be "true" in the environment or in the repo-root .env.local.`,
          })
          return done(c)
        }

        const found = loadApiKey(ROOT, env)
        if (!found) {
          send(c, 'error', { kind: 'config', message: 'No provider key is configured, so a live scan cannot run.' })
          return done(c)
        }

        // 2. PER-VISITOR THROTTLE. Checked before checkGate so that a throttled
        //    visitor never touches the provider-quota check or the shared daily
        //    burst cap. Rejection here costs nothing and touches no shared state.
        const visitorCfg = defaultVisitorThrottleConfig(DATA, env, ledgers)
        const visitorVerdict = await checkVisitorThrottle(visitorIp, visitorCfg, now)
        if (!visitorVerdict.ok) {
          send(c, 'error', { kind: visitorVerdict.reason, message: visitorVerdict.message })
          return done(c)
        }

        // 3. THE PER-DOMAIN CEILING. Between the visitor throttle and the
        //    gate, because it is cheaper than the gate (no HTTP) and narrower
        //    than the visitor throttle (one subject, not one browser). A retry
        //    storm on one domain is many scans from many IPs over many hours,
        //    which is invisible to both of its neighbours here.
        //    Denominated in hand-started CYCLES (ADR-0017): a change to the
        //    domain's prompt set changes what a cycle costs, never how many it
        //    gets. The cycle's cells size the per-run allowance below instead.
        // The person's set, when one is in force, IS the cycle (ADR-0016 Amendment 1); otherwise the bank's count.
        // Read ONCE here and pinned on the run below, so the gate, the allowance and the runner agree on one version (C3 cost review, MINOR 4).
        const ownSet = await customPromptsIn(store, domain)
        const customCount = ownSet?.prompts.length ?? 0
        const promptsThisCycle = customCount > 0 ? customCount : cfg.callsPerEngine
        const cellsThisCycle = promptsThisCycle * ENGINES.length
        //    Keyed by THIS workspace and the host (B3d item 1): admission is
        //    the workspace's. The money stays bounded for everyone by what a
        //    hand-started scan meets here — the burst cap on new domains, the
        //    provider's live quota below, the per-run allowance, and the
        //    lifetime ledger every attempt is charged to — never by the daily
        //    cap, which is the loop's alone (ADR-0017 Amendment 2).
        const ceilingCfg = defaultDomainCeilingConfig(DATA, env, ledgers)
        const ceilingSubject = { workspaceId: access.workspaceId, host: domain }
        const ceiling = await checkDomainCeiling(ceilingSubject, ceilingCfg, now)
        if (!ceiling.ok) {
          send(c, 'error', { kind: ceiling.reason, message: ceiling.message })
          return done(c)
        }

        // 4. THE GATE. Burst cap and the provider's own remaining quota, both
        //    checked before anything is spent, both failing closed.
        send(c, 'stage', { stage: 'checking quota' })
        // Sized to the WHOLE cycle, custom cells included, or the check passes and the quota runs out part-way.
        const gate = await checkGate(domain, { ...cfg, callsPerEngine: promptsThisCycle }, found.key, now)
        if (!gate.ok) {
          // What the provider said when the quota could not be read is logged
          // here and never sent: it may be a response body (B3c item 6).
          if (gate.reason === 'unreadable') console.error('[scan] quota unreadable', domain, gate.cause)
          send(c, 'error', { kind: gate.reason, message: gate.message })
          return done(c)
        }

        send(c, 'stage', { stage: 'classifying' })

        const total = promptsThisCycle * ENGINES.length
        send(c, 'begin', { domain, total, engines: ENGINES.length, prompts: promptsThisCycle })

        // runGrader, not a hand-rolled orchestrator: it carries the run lock,
        // the spend ledger, the rate budget and the topology declaration. A
        // second wiring of those here would be a second thing to keep correct,
        // and the one most likely to drift is the one that spends money.
        const result = await runGrader({
          domain,
          engines: [...ENGINES],
          day: today,
          plan: (env['OPENWEBNINJA_PLAN'] as 'payg' | 'pro' | 'ultra' | 'mega') ?? 'payg',
          mode: 'live',
          apiKey: found.key,
          // The store's own lifetime cap, never a default. Passing a smaller
          // number here lowers the ledger permanently on the first charge —
          // see `ledgerCapUsd`, which is where that reasoning lives. On the
          // KV backend the instance's disk holds no ledger of the deployment,
          // so the file is not consulted (B3c item 5).
          capUsd: ledgerCapUsd(DATA, env, ledgers),
          maxPrompts: cfg.callsPerEngine,
          // The most attempts this run may make, retries included: the cycle's
          // cells with headroom (ADR-0017). Bounds a retry storm at the
          // allowance rather than discovering it in a ledger afterwards.
          runAllowanceCalls: runAllowanceFor(cellsThisCycle),
          // The set this cycle was sized on, or the bank's when there was none: never whatever the store holds a moment later.
          customPrompts: customCount > 0 ? ownSet!.version : null,
          // Authoring a category, when the taxonomy has none for this domain.
          // Almost always a no-op by the time a scan runs: the preview step has
          // already resolved and RECORDED the category, so `resolveCategory`
          // stops at rung 0 and no model is called. It is passed anyway because
          // a scan reached directly — a client that skips the preview — must not
          // silently get a worse classification than one that did not. For a
          // new cycle it is a no-op by construction: the record exists, or the
          // request was refused above.
          author: bankAuthorConfig(env, (n) => loadApiKey(ROOT, env, n)?.key, DATA, ledgers) ?? undefined,
          dataDir: DATA,
          // The result file is the CLI's; on the deployment the store holds the cycle and the instance's disk is every workspace's.
          ...(access.backend === 'file' ? { outFile: join(DATA, 'latest.json') } : {}),
          // The session's store and the deployment's ledgers, so the record a
          // first scan writes and the cap every attempt is charged to are the
          // workspace's and the deployment's, never one instance's disk.
          store,
          ledgers,
          // Progress is streamed to the client through `onProgress` below, so a
          // second copy on stdout would be noise. The resolver's own log is lost
          // with it, and that is acceptable HERE and only here: by the time a
          // scan runs, the preview has already resolved and recorded the
          // category, so authoring is a no-op on this path. A client that skips
          // the preview loses the diagnostic, not the degradation.
          log: () => {},
          onProgress: (e) => send(c, 'progress', e),
        })

        // 5. Only a scan that actually reached the provider counts against the
        //    burst cap and visitor rate limit. A classification refusal spends
        //    nothing and must not consume allowances.
        //
        //    The domain ceiling books the REALISED call count, not the planned
        //    one — retries included — because under-counting retries is exactly
        //    the failure it exists to catch. It is booked whenever any call was
        //    made, including on a failed scan: a scan that burned 40 requests
        //    and returned nothing still burned 40 requests.
        if (result.status === 'scanned' || result.status === 'no-answers') {
          await recordScan(domain, cfg, now)
          await recordVisitorScan(visitorIp, visitorCfg, now)
        }
        //    A cycle that reached the provider is one hand-started cycle
        //    against the month's count, with the calls it realised beside it.
        if ('counts' in result && result.counts.providerCalls > 0) {
          await recordDomainCycle(ceilingSubject, result.counts.providerCalls, ceilingCfg, now)
        }

        // 6. FILE THE CYCLE. The envelope, not a bare result: what is written
        //    here is read back by the Grader, the dashboard and the agency
        //    portfolio, and it must carry a run block or those pages cannot say
        //    which day, which engines or what it cost. `runGrader` returns one
        //    — mode, plan, day, engines, cap, and the spend its own ledger
        //    recorded, which is the only place that figure exists.
        //
        //    `writeCycle` files it twice: under its day, beside every earlier
        //    cycle of this domain, and as the latest. Nothing is overwritten
        //    except the latest pointer, and the same day written twice is the
        //    same cycle. A result with no day is not filed, and that is
        //    reported rather than silently dropped.
        if (result.status === 'scanned') {
          try {
            await store.cycles.put(cycleInputOf(result))
          } catch (e) {
            send(c, 'stage', { stage: `not filed: ${(e as Error).message}` })
          }
        }

        send(c, 'result', result)
        done(c)
      } catch (e) {
        // Never a blank screen and never a substituted number, and never the
        // raw error either: a provider body, a ledger path or a stack detail is
        // the server's to log, not the visitor's to read (2026-09-09 audit).
        console.error('[scan] failed', domain, e)
        send(c, 'error', { kind: 'failed', message: SCAN_FAILED })
        done(c)
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive' },
  })
}

/** The UTC day after `day`, for a refusal that says when a cycle becomes possible. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
