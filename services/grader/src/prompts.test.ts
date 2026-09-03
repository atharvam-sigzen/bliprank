import { describe, expect, it } from 'vitest'
import { ENGINES } from '@bliprank/contracts'
import { parsePromptsArgs, promptCost } from './prompts.js'

describe('the arguments of pnpm grader:prompts', () => {
  it('apply and decline are two acts, a set needs a reason, a decline takes only a note, the set is pipe-separated and the whole set', () => {
    expect(parsePromptsArgs(['--apply', '--decline', '--domain', 'a.test'])).toMatchObject({ refuse: expect.stringContaining('two different acts') })
    expect(parsePromptsArgs(['--decline'])).toMatchObject({ refuse: expect.stringContaining('needs --domain') })
    expect(parsePromptsArgs(['--domain', 'a.test', '--set', 'q one|q two'])).toMatchObject({ refuse: expect.stringContaining('needs --reason') })
    expect(parsePromptsArgs(['--domain', 'a.test', '--decline', '--set', 'x', '--reason', 'y'])).toMatchObject({ refuse: expect.stringContaining('--decline takes --note only') })
    expect(parsePromptsArgs(['--domain', 'a.test', '--set', ' q one | q two ', '--reason', 'because', '--apply', '--data', 'd'])).toMatchObject({ set: ['q one', 'q two'], reason: 'because', apply: true, dataDir: 'd', by: 'operator' })
    expect(parsePromptsArgs(['--domain', 'a.test', '--set', '--reason', 'clear'])).toMatchObject({ set: [] })
    expect(parsePromptsArgs([], { GRADER_DATA_DIR: 'env-dir' })).toMatchObject({ dataDir: 'env-dir' })
  })

  it('the cost of a set is one cell per engine per prompt, at the plan in the environment, pay-as-you-go by default', () => {
    expect(promptCost(3, {})).toEqual({ cells: 3 * ENGINES.length, usd: (0.007 * 3 + 0.008 + 0.005) * 3, plan: 'payg' })
    expect(promptCost(0, { OPENWEBNINJA_PLAN: 'mega' })).toEqual({ cells: 0, usd: 0, plan: 'mega' })
  })
})
