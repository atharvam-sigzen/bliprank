import { describe, expect, it } from 'vitest'
import { parseCompetitorsArgs } from './competitors.js'

describe('the arguments of pnpm grader:competitors', () => {
  it('apply and decline are two acts, each needs a domain, a change needs a reason, a decline takes only a note', () => {
    expect(parseCompetitorsArgs(['--apply', '--decline', '--domain', 'a.test'])).toMatchObject({ refuse: expect.stringContaining('two different acts') })
    expect(parseCompetitorsArgs(['--apply'])).toMatchObject({ refuse: expect.stringContaining('needs --domain') })
    expect(parseCompetitorsArgs(['--domain', 'a.test', '--exclude', 'zoho-crm'])).toMatchObject({ refuse: expect.stringContaining('need --reason') })
    expect(parseCompetitorsArgs(['--domain', 'a.test', '--decline', '--include', 'x', '--reason', 'y'])).toMatchObject({ refuse: expect.stringContaining('--decline takes --note only') })
  })

  it('lists are comma-separated and trimmed; an empty --exclude means "none", which is a whole override of nothing excluded', () => {
    const ok = parseCompetitorsArgs(['--domain', 'a.test', '--exclude', 'zoho-crm, hubspot', '--include', 'freshsales', '--reason', 'because', '--apply', '--data', 'd'])
    expect(ok).toMatchObject({ domain: 'a.test', exclude: ['zoho-crm', 'hubspot'], include: ['freshsales'], reason: 'because', apply: true, decline: false, by: 'operator', dataDir: 'd' })
    expect(parseCompetitorsArgs(['--domain', 'a.test', '--exclude', '--reason', 'clear it'])).toMatchObject({ exclude: [] })
    expect(parseCompetitorsArgs([], { GRADER_DATA_DIR: 'env-dir' })).toMatchObject({ dataDir: 'env-dir', apply: false, decline: false })
  })
})
