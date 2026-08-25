'use client'

import { useState } from 'react'
import { CHECKS_PER_DAY, ENGINE_COUNT, TIERS } from '@/lib/pricing'

/**
 * The shared cap, made draggable.
 *
 * WHY THIS IS INTERACTIVE AND THE REST OF THE PAGE IS NOT. "Shared between
 * curated and custom prompts" is the sentence buyers misread most often — it is
 * routinely heard as two separate allowances. A sentence cannot disprove that
 * reading; a control whose two halves visibly take from each other can, in about
 * a second, and the total never moves while you drag it.
 *
 * It is a native `<input type="range">`: keyboard-operable, screen-reader
 * labelled and touch-friendly without a line of code for any of it.
 *
 * ⚠️ IT CONFIGURES NOTHING. No plan is selected, nothing is stored, and there is
 * no cap enforcement anywhere in the product for this to reflect. It is an
 * explanation of an offer, not a control over an account.
 */
export function CapSplit() {
  const [tierId, setTierId] = useState<string>('pro')
  const tier = TIERS.find((t) => t.id === tierId) ?? TIERS[1]!
  const [curated, setCurated] = useState(26)

  // A cap change must not leave the split pointing past the new cap.
  const c = Math.min(curated, tier.prompts)
  const custom = tier.prompts - c

  return (
    <div className="capsplit">
      <div className="capsplit__tiers" role="group" aria-label="Plan">
        {TIERS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`capsplit__tier${t.id === tier.id ? ' capsplit__tier--on' : ''}`}
            aria-pressed={t.id === tier.id}
            onClick={() => {
              setTierId(t.id)
              // Hold the PROPORTION, not the count: jumping Starter to Growth
              // should widen both halves, not leave 15 curated and 85 custom.
              setCurated(Math.round((c / tier.prompts) * t.prompts))
            }}
          >
            {t.name}
            <span className="capsplit__tiercap">{t.prompts}</span>
          </button>
        ))}
      </div>

      <div className="capsplit__bar" aria-hidden="true">
        <div className="capsplit__curated" style={{ width: `${(c / tier.prompts) * 100}%` }}>
          {c > 0 ? <span className="capsplit__barnum">{c}</span> : null}
        </div>
        <div className="capsplit__custom">{custom > 0 ? <span className="capsplit__barnum">{custom}</span> : null}</div>
      </div>

      <label className="capsplit__label" htmlFor="capsplit-range">
        Curated prompts in the {tier.name} pool
      </label>
      <input
        id="capsplit-range"
        className="capsplit__range"
        type="range"
        min={0}
        max={tier.prompts}
        step={1}
        value={c}
        onChange={(e) => setCurated(Number(e.target.value))}
        aria-valuetext={`${c} curated and ${custom} custom, of ${tier.prompts}`}
      />

      <p className="capsplit__sum" aria-live="polite">
        <strong className="num">{c}</strong> curated <span className="capsplit__op">+</span> <strong className="num">{custom}</strong> your own{' '}
        <span className="capsplit__op">=</span> <strong className="num">{tier.prompts}</strong> tracked prompts
        <span className="capsplit__fixed"> — the total is fixed by the plan; only the split is yours</span>
      </p>

      <p className="capsplit__daily">
        Either way that is <strong className="num">{CHECKS_PER_DAY(tier.prompts).toLocaleString('en-GB')}</strong> answer checks a day
        <span className="capsplit__op"> · </span>
        {tier.prompts} × {ENGINE_COUNT} engines, re-run daily.
      </p>
    </div>
  )
}
