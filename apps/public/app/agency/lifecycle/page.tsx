import { ActionLink } from '@/components/action-link'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { Planned, PLANNED_CAPTION } from '@/lib/planned'
import { PROMPTS_PER_CYCLE } from '@/lib/workspace'
import { ENGINES } from '@bliprank/contracts/engines'

/**
 * THE CLIENT LIFECYCLE — a layout-only mockup of the arc, marked as intent.
 *
 * Exactly one step of this arc runs today: a client can be added, classified
 * and allocated prompts, entirely offline. Everything after it — a cycle being
 * scheduled, collection running, a first result arriving, a second cycle making
 * a comparison possible — needs recurring collection, and there is no scheduler
 * in this build and nothing that calls QStash.
 *
 * The alternative to this page was to leave the arc undrawn, which is how a
 * product ends up implying a capability by omission: the portfolio shows a
 * "queued" row, the reader assumes something dequeues it, and nobody has said
 * otherwise. So the arc is drawn and every stage is labelled with what it is.
 *
 * ⚠️ THE ONE RULE OF THIS FILE. NOT ONE FIGURE THAT DESCRIBES A MEASUREMENT.
 * No example rate, no sample interval, no invented n, no placeholder date, no
 * faded number waiting to fill in. Every stage shows the SHAPE of its screen —
 * which fields exist, what each one would say, what would deliberately stay
 * empty — in words and structure. The only figures on the page are the two real
 * committed constants in stage one (the prompt count and the number of answer
 * surfaces, imported rather than typed) and the stage ordinals.
 *
 * A screenshot of this page must not be mistakeable for a screenshot of a
 * working feature. That is the whole design constraint.
 */

/** Real, committed, and the only arithmetic on the page. */
const ANSWERS_PER_CYCLE = PROMPTS_PER_CYCLE * ENGINES.length

export default function ClientLifecycle() {
  return (
    <main className="shell shell--grader">
      <ProductBar current="agency" />

      <BackLink href="/agency" label="Back to the portfolio" />

      <div className="annotated masthead">
        <div className="annotated__body">
          <h1>Client lifecycle</h1>
          <p className="lede">The full add-and-test arc, with one stage that runs and four that do not.</p>
        </div>
        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">Mostly not built</span>
          <span className="note__line">1 live · 4 planned</span>
          <span className="note__gloss">
            Stage one is live: adding a client classifies a domain and allocates prompts, offline. Stages two to five are intent, not features.
            Nothing on them has been collected, scheduled, queued or spent, and no figure on this page describes a measurement of anything.
          </span>
          <span className="note__gloss">{PLANNED_CAPTION}</span>
        </aside>
      </div>

      <section className="section">
        <h2>How to read this page</h2>
        <p className="prose">
          This is a layout, not a feature. Each stage below shows what its screen would contain: which fields exist, what each field would say, and
          what would be left deliberately empty. None of it is filled in with sample values, because a sample value in a numeric slot is read as a
          measurement, and there is no measurement behind any stage after the first.
        </p>
        <p className="prose prose--flag">
          The gap is a single missing piece: recurring collection. There is no scheduler in this build, nothing enqueues a cycle, and collection
          itself is off by default and permitted only inside a budgeted runner. Every stage after the first waits on that one thing, which is why
          they are drawn together rather than promised separately.
        </p>
      </section>

      <div className="lifecycle">
        <StageAdd />
        <StageSchedule />
        <StageCollecting />
        <StageFirstResult />
        <StageComparison />
      </div>

      <section className="section">
        <h2>What this page is not</h2>
        <p className="prose">
          It is not a roadmap and it carries no dates. A stage marked planned is a description of a screen that has been designed and not built. It
          is not a commitment that it will be built next, or at all, and nothing here should be read as one.
        </p>
      </section>
    </main>
  )
}

/**
 * STAGE ONE — the only one that runs.
 *
 * The figures here are the two committed constants, imported from the same
 * modules the add screen reads, so this page cannot drift out of agreement with
 * the screen it describes.
 */
function StageAdd() {
  return (
    <section className="section" aria-labelledby="stage-add">
      <h2 id="stage-add">
        <span className="lifecycle__ordinal">01</span> Add the client
      </h2>

      <div className="annotated">
        <section className="record annotated__body">
          <p className="prose">
            This runs today. Adding a client takes a domain, classifies it against the committed taxonomy, resolves that category&apos;s prompt
            bank, and shows the prompts a cycle would ask before you commit to anything. All of it resolves with no network call, which is why it
            is free and why it can be shown up front.
          </p>

          <ActionLink href="/agency/add">Add a client</ActionLink>

          <dl className="wsfact">
            <dt className="wsfact__key">What actually happens</dt>
            <dd className="wsfact__val">The domain is classified offline and the category&apos;s prompt bank is resolved</dd>

            <dt className="wsfact__key">Prompts per cycle</dt>
            <dd className="wsfact__val num">{PROMPTS_PER_CYCLE}</dd>

            <dt className="wsfact__key">Answer surfaces</dt>
            <dd className="wsfact__val num">{ENGINES.length}</dd>

            <dt className="wsfact__key">Answers a cycle would ask for</dt>
            <dd className="wsfact__val num">{ANSWERS_PER_CYCLE}</dd>

            <dt className="wsfact__key">What is collected</dt>
            <dd className="wsfact__val">Nothing. No provider is called and no answer is fetched</dd>

            <dt className="wsfact__key">What is spent</dt>
            <dd className="wsfact__val">Nothing</dd>

            <dt className="wsfact__key">Where the client is written</dt>
            <dd className="wsfact__val">This browser&apos;s local storage, and nowhere else</dd>
          </dl>

          <p className="prose">
            The row that appears in the portfolio afterwards carries its category, its prompt allocation and its engine set, because all three are
            true before a single answer exists. It carries no rate, no score and no grade, because none has been collected.
          </p>

          <p className="prose prose--flag">
            The word queued on that row is a description of a state, not a claim about a queue. There is no queue behind it and no runner watching
            one, which is precisely the gap the next four stages describe.
          </p>
        </section>

        <aside className="note">
          <span className="note__cap">Live today</span>
          <span className="note__line">offline classification</span>
          <span className="note__line">
            {PROMPTS_PER_CYCLE} prompts × {ENGINES.length} surfaces
          </span>
          <span className="note__gloss">
            Classification and the prompt banks are committed data in this repository. The two figures above are read from those modules rather than
            written into this page, so the description cannot drift from the screen it describes.
          </span>
        </aside>
      </div>
    </section>
  )
}

/**
 * STAGE TWO — the schedule. Planned.
 *
 * The temptation here is a plausible next-run timestamp, which is the single
 * most convincing fabrication available on this page: a date looks like a fact
 * and nobody checks it. The row therefore describes what the status line would
 * NAME, and names no hour, no zone and no day.
 */
function StageSchedule() {
  return (
    <section className="section" aria-labelledby="stage-schedule">
      <h2 id="stage-schedule">
        <span className="lifecycle__ordinal">02</span> First cycle scheduled <Planned />
      </h2>

      <div className="annotated">
        <section className="record annotated__body">
          <p className="prose">
            The client stops being a list entry and becomes a recurring job. Nothing about the row&apos;s facts changes: the same category, the same
            prompt allocation, the same engine set. One line changes, and it is the status line.
          </p>

          <dl className="wsfact">
            <dt className="wsfact__key">The row&apos;s status line</dt>
            <dd className="wsfact__val">
              Names the hour the next cycle is due and the time zone that hour is fixed in, in place of the words saying no cycle has run
            </dd>

            <dt className="wsfact__key">The marks column</dt>
            <dd className="wsfact__val">Unchanged: a status, and still no rate, no score and no grade, because still nothing is collected</dd>

            <dt className="wsfact__key">What the operator sets</dt>
            <dd className="wsfact__val">The hour, and nothing else. The prompt set is the category&apos;s bank and is not edited per client</dd>

            <dt className="wsfact__key">What daily at a fixed hour means</dt>
            <dd className="wsfact__val">
              One cycle per client per calendar day at a stable hour, so the day bucket in the cache key is unambiguous and two cycles cannot land
              in the same bucket
            </dd>

            <dt className="wsfact__key">Why the hour is stable</dt>
            <dd className="wsfact__val">
              An answer surface drifts across a day. Comparing a morning cycle against an evening one adds a difference nobody asked for
            </dd>

            <dt className="wsfact__key">What is spent at this stage</dt>
            <dd className="wsfact__val">Nothing. A schedule is a row and a due time. Spend begins at stage three</dd>
          </dl>

          <p className="prose prose--flag">
            None of this exists. There is no scheduler in this build, nothing enqueues a job, and collection is off by default and permitted only
            inside a budgeted runner. Pressing a button on the current screens schedules nothing.
          </p>
        </section>

        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">Planned</span>
          <span className="note__line">no scheduler · no queue</span>
          <span className="note__line">nothing scheduled</span>
          <span className="note__gloss">
            A schedule is the first thing on this arc that would cost money on a recurring basis, so it is also the first thing that needs a budget
            ceiling in front of it rather than behind it.
          </span>
        </aside>
      </div>
    </section>
  )
}

/**
 * STAGE THREE — collection in progress. Planned.
 *
 * The progress readout is the one component on this arc that already exists,
 * built for a Grader scan the reader starts and watches. A scheduled run
 * inverts almost every assumption in it, and the honest thing is to say which.
 */
function StageCollecting() {
  return (
    <section className="section" aria-labelledby="stage-collecting">
      <h2 id="stage-collecting">
        <span className="lifecycle__ordinal">03</span> Collecting <Planned />
      </h2>

      <div className="annotated">
        <section className="record annotated__body">
          <p className="prose">
            A progress readout already exists in this app, and it is built for a different situation: a scan the reader started, is watching, and
            will see finish. A scheduled cycle runs with nobody in front of it. The component would be reused, and most of what it assumes would
            not.
          </p>

          <dl className="wsfact">
            <dt className="wsfact__key">Who is watching</dt>
            <dd className="wsfact__val">
              Nobody at the moment it starts. The readout is read afterwards, so it reports a run already under way or already finished, not a
              request the reader is waiting on
            </dd>

            <dt className="wsfact__key">What the counter counts</dt>
            <dd className="wsfact__val">Answers completed against this cycle&apos;s own total, which is the prompt set times the answer surfaces</dd>

            <dt className="wsfact__key">The last cell line</dt>
            <dd className="wsfact__val">Names the cache cell most recently written, so a stalled surface is identifiable without opening a log</dd>

            <dt className="wsfact__key">The spend line</dt>
            <dd className="wsfact__val">
              Reports the budget this cycle drew against, not a visitor&apos;s free quota, because a scheduled run spends the account&apos;s ceiling
              rather than an allowance the reader can see being used
            </dd>

            <dt className="wsfact__key">A partial cycle</dt>
            <dd className="wsfact__val">
              Stays partial and says so. The sample it produced is the sample its result carries, and it is not topped up to look complete
            </dd>

            <dt className="wsfact__key">A failed cycle</dt>
            <dd className="wsfact__val">
              Has to be visible the next morning on the row itself, not in a notification nobody was present to receive
            </dd>
          </dl>

          <p className="prose">
            The bar keeps the plain fill the existing readout already uses for a run in progress. The settling motion the results use means an
            interval opening around an estimate, and a progress bar is neither of those things, so it does not borrow that motion.
          </p>

          <p className="prose prose--flag">
            No cycle has ever run for a scheduled client, because no cycle has ever been scheduled. There is no screenshot behind this stage.
          </p>
        </section>

        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">Planned</span>
          <span className="note__line">no run · no spend</span>
          <span className="note__gloss">
            Reusing the existing readout is the cheap part. The expensive part is everything a run without a spectator needs: durable state, a
            failure that stays visible, and a budget that can stop it.
          </span>
        </aside>
      </div>
    </section>
  )
}

/**
 * STAGE FOUR — the first reading. Planned.
 *
 * The stage most likely to be filled with a plausible-looking rate. It is not.
 * What is described is which slots exist and what travels with the number, and
 * the most important content of the stage is the list of things that stay empty
 * after a first result arrives.
 */
function StageFirstResult() {
  return (
    <section className="section" aria-labelledby="stage-first-result">
      <h2 id="stage-first-result">
        <span className="lifecycle__ordinal">04</span> First result <Planned />
      </h2>

      <div className="annotated">
        <section className="record annotated__body">
          <p className="prose">
            One cycle has landed. The row gains the interval rail every collected row in this product already draws, and it gains nothing else. A
            single reading is a reading, and this is the moment a tool is most tempted to dress one up as a trend.
          </p>

          <dl className="wsfact">
            <dt className="wsfact__key">What arrives</dt>
            <dd className="wsfact__val">A mention rate for the client across that cycle&apos;s answers</dd>

            <dt className="wsfact__key">How it is drawn</dt>
            <dd className="wsfact__val">
              On the fixed scale rail, as a band with the estimate marked inside it, so the width of what is not known is visible before the estimate
              is read
            </dd>

            <dt className="wsfact__key">What travels with it</dt>
            <dd className="wsfact__val">
              The interval bounds, the sample size the cycle actually produced, the scoring algorithm version, and the collection path that fetched
              the answers
            </dd>

            <dt className="wsfact__key">Where that provenance sits</dt>
            <dd className="wsfact__val">On the row, beside the figure, not on a methodology page the reader may never open</dd>

            <dt className="wsfact__key">The comparison slot</dt>
            <dd className="wsfact__val">Empty, and it says why in words: there is one cycle, so there is nothing to compare it against</dd>

            <dt className="wsfact__key">What does not appear</dt>
            <dd className="wsfact__val">
              No change indicator, no arrow, no movement figure, no since last week. Not one of those has a second reading behind it
            </dd>
          </dl>

          <p className="prose">
            If the cycle comes back thin, the rail shows a wide band and the row says so, rather than reporting the estimate as though the width
            were a detail. A wide interval is a small sample, not a weak brand, and the reader is told which of the two they are looking at.
          </p>

          <p className="prose prose--flag">
            One cycle is not a trend, and this screen is where that sentence has to be printed, because it is the moment the reader most wants it
            not to be true.
          </p>
        </section>

        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">Planned</span>
          <span className="note__line">no result exists</span>
          <span className="note__gloss">
            No rate, interval or sample size is shown anywhere on this page. Any figure here would be invented, and an invented first reading is the
            exact failure this product exists to refuse.
          </span>
        </aside>
      </div>
    </section>
  )
}

/**
 * STAGE FIVE — two readings, and the first thing the significance rule can say.
 *
 * The verdict vocabulary named here is the real one the comparison code
 * produces, not a set of labels written for this screen.
 */
function StageComparison() {
  return (
    <section className="section" aria-labelledby="stage-comparison">
      <h2 id="stage-comparison">
        <span className="lifecycle__ordinal">05</span> Second cycle, and the first comparison <Planned />
      </h2>

      <div className="annotated">
        <section className="record annotated__body">
          <p className="prose">
            Two cycles exist, so the comparison slot from stage four finally has something to put in it. This is where the significance rule starts
            doing the work it was written for, and where most of what it says is that nothing can be said yet.
          </p>

          <dl className="wsfact">
            <dt className="wsfact__key">What is compared</dt>
            <dd className="wsfact__val">The newer cycle against the older one, each with its own interval and its own sample size</dd>

            <dt className="wsfact__key">The possible verdicts</dt>
            <dd className="wsfact__val">Higher, lower, no significant change, not enough data, or not comparable</dd>

            <dt className="wsfact__key">When no significant change appears</dt>
            <dd className="wsfact__val">
              Whenever the movement sits inside the intervals. The two estimates can differ and the verdict still be no significant change, and the
              row prints that sentence instead of an arrow
            </dd>

            <dt className="wsfact__key">When not enough data appears</dt>
            <dd className="wsfact__val">
              When either cycle&apos;s sample is under the comparison floor. Below it there is no interval worth testing, so no direction is claimed
            </dd>

            <dt className="wsfact__key">When not comparable appears</dt>
            <dd className="wsfact__val">
              When the scoring algorithm version, the collection path or the comparison basis differs between the two cycles. A changed instrument
              is not a changed reading
            </dd>

            <dt className="wsfact__key">What a significant move looks like</dt>
            <dd className="wsfact__val">Weight and a marker, never colour on its own, and never a green arrow for movement inside the interval</dd>

            <dt className="wsfact__key">What still does not exist here</dt>
            <dd className="wsfact__val">
              A trend line. Two points make a comparison, not a trend, and the chart waits until there are enough cycles for its shape to mean
              something
            </dd>
          </dl>

          <p className="prose">
            Most weeks the honest verdict is no significant change. A product that renders that as a flat sentence while a competitor renders the
            same week as a green arrow looks worse and is right, and that trade is the reason the rule exists at all.
          </p>

          <p className="prose prose--flag">
            This stage is the furthest from being real, because it needs stages two and three to have run twice. Everything downstream of it, the
            trend chart, week on week movement, and holdout experiments, is further still.
          </p>
        </section>

        <aside className="note note--flag">
          <span className="note__cap note__cap--flag">Planned</span>
          <span className="note__line">no cycle · no comparison</span>
          <span className="note__gloss">
            The comparison rule is written and tested against fixtures today. What is missing is not the rule, it is two collected cycles for it to
            read.
          </span>
        </aside>
      </div>
    </section>
  )
}
