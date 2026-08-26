import type { Metadata } from 'next'
import { ProductBar } from '@/components/chrome'
import { CapSplit } from '@/components/cap-split'
import { CHECKS_PER_DAY, ENGINE_COUNT, TIERS, exampleSplit } from '@/lib/pricing'

export const metadata: Metadata = {
  title: 'Pricing — BlipRank',
  description: 'Three plans, priced on tracked prompts. A daily re-check of every prompt across five AI answer surfaces, once collection is scheduled.',
}

/**
 * PRICING — a static page, and static in the strong sense.
 *
 * There is no checkout here, no Stripe or Razorpay call, no plan stored against
 * an account and nothing that counts a workspace's prompts against its cap. The
 * buttons go to a mail link. That is the whole of it, on purpose: a page that
 * looks like it can take money and cannot is worse than one that plainly says
 * where to write.
 *
 * It follows the same rule as every other surface in this product: the thing
 * being sold is stated with its units attached. "40 prompts" alone is not a
 * quantity a buyer can reason about — 40 prompts times 5 engines times 30 days
 * is, and that is the number the invoice is really about.
 *
 * AND THE CADENCE IS AN OFFER, NOT A FACT. This is the most public, indexable
 * surface in the product and it stated recurring daily collection in the
 * present tense five times over. Nothing schedules a cycle: there is no
 * scheduler in this build. So every cadence line here is worded as what a plan
 * buys once collection is scheduled, and the disclosure at the foot says the
 * gap outright rather than caveating only the checkout.
 */
export default function Pricing() {
  return (
    <main className="shell shell--pricing">
      <ProductBar current="pricing" />

      {/* The letterhead: title and subject line in the record's serif, the
          terms in the margin — currency, tax, and the fact that nothing here
          takes money, stated before a price is shown rather than under it. */}
      <div className="annotated masthead">
        <header className="annotated__body">
          <h1>Pricing</h1>
          <p className="lede">
            Priced on tracked prompts. Every plan buys a daily re-check of every prompt across all {ENGINE_COUNT} answer surfaces, once collection
            is scheduled.
          </p>
        </header>
        <aside className="note" aria-label="Terms">
          <span className="note__cap">Terms</span>
          <span className="note__line">prices in US dollars</span>
          <span className="note__line">excluding tax</span>
          <span className="note__gloss">No checkout yet — every plan starts with an email, and this page creates nothing.</span>
        </aside>
      </div>

      {/*
        The pledge sits above the prices, not below them. Reproducibility is the
        reason this costs what it costs, and a buyer comparing tools needs it
        before the number rather than after. Set as a mark of provenance on the
        paper — eyebrow, rule, sentence — not as a boxed callout.
      */}
      <section className="stamp" aria-labelledby="pledge">
        <span className="stamp__eyebrow" id="pledge">
          What you are buying
        </span>
        <div className="stamp__body">
          <p style={{ margin: 0 }}>
            Every figure ships with its 95% confidence interval, the sample size behind it, and the version of the scoring algorithm that produced
            it. Movements inside the interval are reported as no significant change, not as growth. No plan changes that, and no plan buys a
            narrower interval than the sample supports.
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="plans">
        <h2 id="plans">Plans</h2>
        <div className="grid tiers">
          {TIERS.map((t) => {
            const split = exampleSplit(t.prompts)
            return (
              <article key={t.id} className={`card tier${t.id === 'pro' ? ' tier--featured' : ''}`}>
                {/*
                  NOT "Most chosen" — that was a fabricated customer-behaviour
                  claim on a page whose own closing section says no checkout
                  exists and nothing can be bought. Nobody has chosen anything,
                  so there is no population over which "most" could be measured.
                  "Worked below" is true of this page: Pro is the tier the
                  cap splitter opens on and works through.
                */}
                {t.id === 'pro' ? <span className="tier__flag">Worked below</span> : null}
                <h3 className="tier__name">{t.name}</h3>

                {/*
                  The price is typeset in three pieces for the eye and read as
                  one sentence by a screen reader. Marking only the "$" hidden
                  would have produced "149 slash month US dollars per month",
                  so the whole visual group is hidden and the sentence replaces
                  it rather than being appended to it.
                */}
                <p className="tier__price" aria-hidden="true">
                  <span className="tier__currency">$</span>
                  <span className="tier__amount">{t.usdPerMonth}</span>
                  <span className="tier__unit">/month</span>
                </p>
                <p className="visually-hidden">{t.usdPerMonth} US dollars per month</p>
                <p className="tier__for">{t.forWhom}</p>

                <p className="tier__cap">
                  <span className="tier__capnum">{t.prompts}</span> tracked prompts
                </p>

                {/*
                  The cap drawn as ONE track. This is the same idea as the range
                  rail elsewhere in the product: the shape carries the meaning and
                  the number sits inside it. Here the shape says the allowance is a
                  single pool, which is the part of the offer most easily misread.
                */}
                <div className="tier__pool" aria-hidden="true">
                  <div className="tier__pool-curated" style={{ width: `${(split.curated / t.prompts) * 100}%` }} />
                </div>
                <p className="tier__poolkey">
                  <span>
                    <span className="tier__key tier__key--curated" aria-hidden="true" /> curated
                  </span>
                  <span>
                    <span className="tier__key tier__key--custom" aria-hidden="true" /> your own
                  </span>
                </p>
                <p className="tier__note">
                  Shown as {split.curated} and {split.custom}. That split is an example, not a rule — any split of the {t.prompts} works.
                </p>

                <ul className="tier__list">
                  <li>
                    <strong className="num">{CHECKS_PER_DAY(t.prompts).toLocaleString('en-GB')}</strong> answer checks a day
                    <span className="tier__sub">
                      {t.prompts} prompts × {ENGINE_COUNT} engines, once daily cycles run
                    </span>
                  </li>
                  <li>ChatGPT, Gemini, Copilot, Google AI Mode and AI Overviews</li>
                  <li>Confidence interval, sample size and algorithm version on every metric</li>
                  <li>Competitor export reconciliation</li>
                </ul>

                <a className={`tier__cta${t.id === 'pro' ? ' tier__cta--primary' : ''}`} href={`mailto:hello@bliprank.com?subject=${t.name}%20plan`}>
                  Talk to us about {t.name}
                </a>
              </article>
            )
          })}
        </div>

        {/* The other pricing page. An agency landing here is being quoted per
            workspace for something it buys per portfolio, so the link belongs
            beside the panels rather than in a footer. */}
        <p className="prose" style={{ marginTop: 'var(--space-4)' }}>
          Running a book of clients rather than one brand? The <a href="/agency/pricing">agency plans</a> pool one prompt allowance across the
          whole portfolio.
        </p>
      </section>

      <section className="section" aria-labelledby="cap">
        <h2 id="cap">How the prompt cap works</h2>
        <div className="annotated">
          <div className="annotated__body">
            <p className="prose" style={{ marginBottom: 'var(--space-3)' }}>
              A tracked prompt is one question your plan puts to the answer engines on your behalf, once a day, once collection is scheduled. Your
              plan&apos;s cap is a single pool, shared
              between prompts BlipRank curates for your category and prompts you write yourself. Move the split to see it.
            </p>
            <CapSplit />
          </div>
          <aside className="note">
            <span className="note__cap">This control</span>
            <span className="note__gloss">Explains the offer; it configures nothing. No plan is selected and nothing is stored.</span>
          </aside>
        </div>
      </section>

      <section className="section" aria-labelledby="notsold">
        <h2 id="notsold">What is not on this page</h2>
        <p className="prose">
          There is no checkout here yet. These plans are not wired to a payment provider, nothing on this page creates an account, and no cap is
          enforced anywhere in the product today. Nor does any scheduler run a cycle today: recurring collection is not built yet, so the daily
          cadence described above is what a plan buys once it exists, not something running now. Prices are in US dollars and exclude tax.
        </p>
      </section>
    </main>
  )
}
