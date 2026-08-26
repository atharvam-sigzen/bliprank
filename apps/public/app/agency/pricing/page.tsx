import type { Metadata } from 'next'
import { BackLink } from '@/components/back-link'
import { ProductBar } from '@/components/chrome'
import { Planned } from '@/lib/planned'
import type { AgencyTier } from '@/lib/agency-pricing'
import { AGENCY_TIERS, FEATURED_ID, PROMPTS_PER_CYCLE, agencyMaths, brandComparison, tierById } from '@/lib/agency-pricing'

/**
 * The comparison rows. One row per figure, one cell per tier, every cell
 * derived — same rule as the plan panels, so a price edit moves the table with
 * the panels or fails `agency-pricing.test.ts`.
 *
 * "A full cycle" is stated per tier rather than as a note, because a reader
 * scanning three columns wants to see that it does NOT move between plans.
 */
const SIDE_BY_SIDE: readonly { label: string; cell: (t: AgencyTier) => string | number }[] = [
  { label: 'Price a month', cell: (t) => `$${t.usdPerMonth}` },
  { label: 'Domain ceiling', cell: (t) => t.domains },
  { label: 'Pooled prompts', cell: (t) => t.pooledPrompts },
  { label: 'A full cycle', cell: () => PROMPTS_PER_CYCLE },
  { label: 'Prompts per domain, even split', cell: (t) => agencyMaths(t).promptsPerDomainLabel },
  { label: 'Short of a full cycle by', cell: (t) => agencyMaths(t).shortfallPerDomain.toFixed(1) },
  { label: 'Prompts to fund every domain fully', cell: (t) => agencyMaths(t).promptsForFullOccupancy },
  { label: 'Domains the pool funds fully', cell: (t) => agencyMaths(t).domainsAtFullCycle },
  { label: 'Cost per domain at the ceiling', cell: (t) => `$${agencyMaths(t).usdPerDomain}` },
  { label: 'Cost per pooled prompt', cell: (t) => `$${agencyMaths(t).usdPerPrompt}` },
]

export const metadata: Metadata = {
  title: 'Agency pricing — BlipRank',
  description: 'Agency plans priced on a pooled prompt allowance. The domain count is a ceiling; the pool is what funds it.',
}

/**
 * AGENCY PRICING — and the division the page refuses to hide.
 *
 * A domain ceiling and a prompt pool are two different quantities, and every
 * tool in this category prints the first in large type and the second in small.
 * The buyer who matters here holds forty clients and will do 500 ÷ 40 in their
 * head before they finish the first plan panel. Finding 12.5 stated by us, next
 * to the 17 a full cycle needs, is worth more than finding it themselves.
 *
 * So no derived figure on this page is written as a literal. Everything comes
 * out of `lib/agency-pricing.ts`, which computes it from the tier data, and
 * `agency-pricing.test.ts` fails if any tier ever stops being short. The copy
 * and the arithmetic cannot drift apart without the suite going red.
 *
 * Like the brand page: no checkout, no payment provider, no account. The
 * buttons are a mail link.
 */
export default function AgencyPricing() {
  const featured = tierById(FEATURED_ID)
  const worked = agencyMaths(featured)
  const compare = brandComparison()

  // The two allocations an agency actually chooses between, both drawn from the
  // featured tier. Neither is a recommendation; they are the endpoints.
  const evenTotal = worked.evenSplit * featured.domains
  const deepTotal = worked.domainsAtFullCycle * PROMPTS_PER_CYCLE

  return (
    <main className="shell shell--pricing">
      <ProductBar current="pricing" />

      <BackLink href="/" label="Back to the Grader" />

      {/* The letterhead. Same order as the brand page: title, subject line, and
          the terms in the margin before any price is shown. */}
      <div className="annotated masthead">
        <header className="annotated__body">
          {/* The fork, stated at the letterhead: same control as /pricing with
              the marked side swapped. Chrome stays neutral; the page marks
              itself. */}
          <nav className="pricefork" aria-label="Plan type">
            <a className="pricefork__opt" href="/pricing">
              Brand plans
            </a>
            <a className="pricefork__opt pricefork__opt--on" href="/agency/pricing" aria-current="page">
              Agency plans
            </a>
          </nav>
          <h1>Agency pricing</h1>
          <p className="lede">
            Priced on one pooled prompt allowance shared across the portfolio. The domain count is a ceiling; the pool is what actually funds
            the clients inside it.
          </p>
        </header>
        <aside className="note" aria-label="Terms">
          <span className="note__cap">Terms</span>
          <span className="note__line">prices in US dollars</span>
          <span className="note__line">excluding tax</span>
          <span className="note__gloss">No checkout yet. Every plan starts with an email, and this page creates nothing.</span>
        </aside>
      </div>

      {/*
        The pledge, written for the buyer who resells the number. An agency is
        not buying a dashboard; it is buying something it can put in front of a
        client and defend, including the case where the honest answer is that
        two clients cannot be separated.
      */}
      <section className="stamp" aria-labelledby="pledge">
        <span className="stamp__eyebrow" id="pledge">
          What you are buying
        </span>
        <div className="stamp__body">
          <p style={{ margin: 0 }}>
            The same measurement discipline on every client in the portfolio, not on the ones with the better story. Every figure ships with its
            95% confidence interval, its sample size and the version of the scoring algorithm that produced it. Where two clients&apos; ranges
            overlap we will not rank them, and where a week&apos;s movement sits inside the interval we report no significant change. That holds
            in a client report exactly as it holds on screen.
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="plans">
        <h2 id="plans">Plans</h2>
        <div className="grid tiers">
          {AGENCY_TIERS.map((t) => {
            const m = agencyMaths(t)
            return (
              <article key={t.id} className={`card tier${t.id === FEATURED_ID ? ' tier--featured' : ''}`}>
                {/*
                  NOT "Most chosen". Nothing on this page can be chosen: there
                  is no checkout, no agency account and no billing anywhere in
                  the product, so the population a "most" would be measured over
                  is empty for every tier. The flag says something this page can
                  actually support instead — that this is the tier the pool
                  section works through, which is a statement about the page.
                */}
                {t.id === FEATURED_ID ? <span className="tier__flag">Worked below</span> : null}
                <h3 className="tier__name">{t.name}</h3>

                {/*
                  Typeset in three pieces, read as one sentence. The whole
                  visual group is hidden rather than only the "$", which would
                  produce "199 slash month US dollars per month". Copied from
                  the brand page on purpose: two pricing pages that announce a
                  price two ways is a defect a screen reader user hears and a
                  sighted reviewer never will.
                */}
                <p className="tier__price" aria-hidden="true">
                  <span className="tier__currency">$</span>
                  <span className="tier__amount">{t.usdPerMonth}</span>
                  <span className="tier__unit">/month</span>
                </p>
                <p className="visually-hidden">{t.usdPerMonth} US dollars per month</p>
                <p className="tier__for">{t.forWhom}</p>

                <p className="tier__cap">
                  <span className="tier__capnum">{t.pooledPrompts}</span> pooled prompts
                </p>

                {/*
                  ONE TRACK, and what it measures is the honest thing: how much
                  of a full cycle the pool funds for one client once it is split
                  evenly across every domain the ceiling allows. The unfilled
                  remainder is the shortfall, and it is drawn rather than
                  described because a reader who skips the note still sees it.
                */}
                <div className="tier__pool" aria-hidden="true">
                  <div className="tier__pool-curated" style={{ width: `${(m.promptsPerDomain / PROMPTS_PER_CYCLE) * 100}%` }} />
                </div>
                <p className="tier__poolkey">
                  <span>
                    <span className="tier__key tier__key--curated" aria-hidden="true" /> funded
                  </span>
                  <span>
                    <span className="tier__key tier__key--custom" aria-hidden="true" /> short
                  </span>
                </p>
                <p className="tier__note">
                  Split evenly across all {t.domains} domains that is <span className="num">{m.promptsPerDomainLabel}</span> prompts each. A full
                  cycle is <span className="num">{PROMPTS_PER_CYCLE}</span>, so an even split runs every client{' '}
                  <span className="num">{m.shortfallPerDomain.toFixed(1)}</span> prompts short of one.
                </p>

                <ul className="tier__list">
                  <li>
                    <strong className="num">{t.domains}</strong> client domains
                    <span className="tier__sub">a ceiling on how many, not a promise about depth</span>
                  </li>
                  <li>
                    <strong className="num">{m.domainsAtFullCycle}</strong> of them at a full cycle
                    <span className="tier__sub">
                      {t.pooledPrompts} ÷ {PROMPTS_PER_CYCLE}, if depth is not shared out evenly
                    </span>
                  </li>
                  <li>
                    <strong className="num">${m.usdPerDomain}</strong> per domain at the ceiling
                    <span className="tier__sub">
                      ${t.usdPerMonth} ÷ {t.domains} domains
                    </span>
                  </li>
                  <li>
                    <strong className="num">${m.usdPerPrompt}</strong> per pooled prompt
                    <span className="tier__sub">
                      ${t.usdPerMonth} ÷ {t.pooledPrompts} prompts
                    </span>
                  </li>
                  <li>Confidence interval, sample size and algorithm version on every metric</li>
                  <li>Competitor export reconciliation, per client</li>
                </ul>

                <a
                  className={`tier__cta${t.id === FEATURED_ID ? ' tier__cta--primary' : ''}`}
                  href={`mailto:hello@bliprank.com?subject=${encodeURIComponent(`${t.name} plan`)}`}
                >
                  Talk to us about {t.name}
                </a>
              </article>
            )
          })}
        </div>

        <p className="prose" style={{ marginTop: 'var(--space-4)' }}>
          Running one brand rather than a portfolio? The <a href="/pricing">brand plans</a> are priced per workspace instead.
        </p>
      </section>

      <section className="section" aria-labelledby="pool-heading">
        <h2 id="pool-heading">How the pool works</h2>

        <div className="annotated">
          <div className="annotated__body">
            <p className="prose" style={{ marginBottom: 'var(--space-3)' }}>
              A full cycle asks a client&apos;s <span className="num">{PROMPTS_PER_CYCLE}</span> unprompted prompts across every answer surface.
              At maximum occupancy no plan funds that for every client: {featured.name} carries{' '}
              <span className="num">{featured.pooledPrompts}</span> prompts and {featured.domains} clients at full depth would need{' '}
              <span className="num">{worked.promptsForFullOccupancy}</span>. So an agency runs fewer clients deeply, or more clients shallowly,
              and it decides which. We do not decide it for them, and we do not pad the pool so the division comes out round.
            </p>

            <p className="readout__cap">Every client, even split</p>
            <div className="pool">
              <div className="pool__track" aria-hidden="true">
                <div className="pool__fill" style={{ width: `${(evenTotal / featured.pooledPrompts) * 100}%` }} />
              </div>
              <p className="pool__legend">
                <span className="num">{worked.evenSplit}</span> prompts to each of <span className="num">{featured.domains}</span> clients is{' '}
                <span className="num">{evenTotal}</span> of <span className="num">{featured.pooledPrompts}</span>. Every client is{' '}
                <span className="num">{PROMPTS_PER_CYCLE - worked.evenSplit}</span> prompts short of a full cycle, and{' '}
                <span className="num">{featured.pooledPrompts - evenTotal}</span> are left over.
              </p>
            </div>

            <p className="readout__cap" style={{ marginTop: 'var(--space-4)' }}>
              Fewer clients, full depth
            </p>
            <div className="pool">
              <div className="pool__track" aria-hidden="true">
                <div className="pool__fill" style={{ width: `${(deepTotal / featured.pooledPrompts) * 100}%` }} />
              </div>
              <p className="pool__legend">
                <span className="num">{worked.domainsAtFullCycle}</span> clients at the full{' '}
                <span className="num">{PROMPTS_PER_CYCLE}</span> is <span className="num">{deepTotal}</span> of{' '}
                <span className="num">{featured.pooledPrompts}</span>. The remaining{' '}
                <span className="num">{featured.domains - worked.domainsAtFullCycle}</span> of the{' '}
                <span className="num">{featured.domains}</span> the plan allows are funded out of what is left, or not at all.
              </p>
            </div>

            <p className="prose" style={{ marginTop: 'var(--space-4)' }}>
              Both readings are the same plan. Neither is a default, and nothing between them is forbidden: an agency can fund three clients
              fully and twelve lightly, or reverse it next month.
            </p>

            <h3 className="readout__cap" style={{ marginTop: 'var(--space-4)' }}>
              Setting the split <Planned />
            </h3>
            <p className="prose prose--flag">
              The arithmetic above is real and you can check it. The screen that lets an agency set a per client allocation is not built. There
              is no admin control for it today, nothing stores an allocation, and no cap is enforced anywhere in the product, so today the split
              is a decision an agency makes and we do not yet record.
            </p>
          </div>
          <aside className="note note--flag">
            <span className="note__cap note__cap--flag">This section</span>
            <span className="note__line">{featured.name}, worked</span>
            <span className="note__gloss">
              Arithmetic only. No plan is selected, no allocation is stored and nothing here is a record of collection.
            </span>
          </aside>
        </div>
      </section>

      <section className="section" aria-labelledby="side-by-side">
        <h2 id="side-by-side">The three, side by side</h2>
        {/*
          A REAL TABLE, because three tiers is three columns. This was ten
          middle-dot-joined strings in a two-column `wsfact` list, with the tier
          order stated once in a sentence above and never again: a screen reader
          announces U+00B7 as nothing, so "$199 · $499 · $999" was read as one
          run of three unattributed figures, and a sighted reader had to
          re-anchor every row against that sentence. Column and row headers do
          that association now, so the order sentence is gone with it.
        */}
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Every agency plan compared, figure by figure</caption>
            <thead>
              <tr>
                <th />
                {AGENCY_TIERS.map((t) => (
                  <th key={t.id} scope="col">
                    {t.name.replace('Agency ', '')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SIDE_BY_SIDE.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {AGENCY_TIERS.map((t) => (
                    <td key={t.id} className="num">
                      {row.cell(t)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="versus">
        <h2 id="versus">Against buying brand plans one at a time</h2>
        <p className="prose">
          {compare.clients} clients each on a brand {compare.brandName} plan is {compare.clients} × $
          {compare.brandUsdPerMonth} = <span className="num">${compare.brandTotalUsd}</span> a month, for{' '}
          <span className="num">{compare.pooledPrompts}</span> prompts held in {compare.clients} separate caps that cannot lend to each other.{' '}
          {compare.agencyName} is <span className="num">${compare.agencyUsdPerMonth}</span> for the same{' '}
          <span className="num">{compare.pooledPrompts}</span>, in one pool. That is{' '}
          <span className="num">${compare.savingUsd}</span> a month, and the pool is the larger part of the difference: a client in a slow
          quarter can hand its depth to one that needs it, which five separate accounts cannot do.
        </p>
      </section>

      <section className="section" aria-labelledby="notsold">
        <h2 id="notsold">What is not on this page</h2>
        <p className="prose">
          There is no checkout here. These plans are not wired to a payment provider, there are no agency accounts, nothing on this page creates
          one, and no cap of any kind is enforced anywhere in the product today: not the domain ceiling, not the prompt pool, not a per client
          allocation. Recurring collection is not built either: no scheduler exists today and a cycle runs only when a person starts one, so a
          monthly price is what a plan buys once collection is scheduled, not something running now. Prices are in US dollars and exclude tax.
        </p>
      </section>
    </main>
  )
}
