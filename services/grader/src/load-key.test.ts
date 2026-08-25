import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readFlag, readVar } from './load-key.js'

describe('readVar — dotenv parsing, which the key path already depends on', () => {
  const CRLF = ['A="x"', 'B=y', ''].join('\r\n')

  it('strips quotes and the trailing carriage return a Windows file leaves', () => {
    // A value of 'true\r' is not 'true', and a key with one answers 401.
    expect(readVar(CRLF, 'A')).toBe('x')
    expect(readVar(CRLF, 'B')).toBe('y')
  })

  it('ignores comments and blanks, and does not match a name that merely prefixes another', () => {
    expect(readVar(['# A=no', '', 'AB=1', 'A=2'].join('\n'), 'A')).toBe('2')
  })
})

/**
 * THE SILENT FAILURE: a documented flag that could not be set by the documented
 * method.
 *
 * CLAUDE.md §7 puts COLLECTION_ENABLED in `.env.local`. The route read
 * `process.env` only, and Next loads env files from `apps/public` rather than
 * from the repo root where that file lives — so the edit landed in a file
 * nothing read, produced no error, and live scanning stayed off while the
 * operator believed it was on. It failed closed, which is why it survived; it
 * was still wrong.
 */
describe('readFlag — the route resolves its flags where the key already lives', () => {
  const root = mkdtempSync(join(tmpdir(), 'flags-'))
  writeFileSync(join(root, '.env.local'), 'GRADER_LIVE_SCAN=true\r\nCOLLECTION_ENABLED=true\r\n')
  writeFileSync(join(root, '.env'), 'GRADER_LIVE_SCAN=false\n')

  it('reads a flag out of the repo-root .env.local, and says so', () => {
    expect(readFlag(root, 'GRADER_LIVE_SCAN', {} as NodeJS.ProcessEnv)).toEqual({ value: 'true', from: '.env.local' })
  })

  it('the environment still wins, so an explicit one-off run overrides the file', () => {
    const env = { GRADER_LIVE_SCAN: 'false' } as unknown as NodeJS.ProcessEnv
    expect(readFlag(root, 'GRADER_LIVE_SCAN', env)).toEqual({ value: 'false', from: 'environment' })
  })

  it('.env.local beats .env, the same precedence the key uses', () => {
    expect(readFlag(root, 'GRADER_LIVE_SCAN', {} as NodeJS.ProcessEnv).value).toBe('true')
  })

  it('strips CRLF, because a flag of "true\r" is not "true"', () => {
    // Exactly the bug that once made a correct API key answer 401.
    expect(readFlag(root, 'COLLECTION_ENABLED', {} as NodeJS.ProcessEnv).value).toBe('true')
  })

  it('is an ALLOW-LIST, not a general env loader', () => {
    // A cap or a plan read from a file someone edited last month is not a
    // deliberate decision. Only the two flags may come from a file.
    writeFileSync(join(root, '.env.local'), 'GRADER_LIVE_SCAN=true\nGRADER_CAP_USD=999\n')
    expect(readFlag(root, 'GRADER_CAP_USD', {} as NodeJS.ProcessEnv)).toEqual({ value: undefined, from: 'environment' })
  })

  it('reports "unset" rather than guessing, so the off-state is explainable', () => {
    const bare = mkdtempSync(join(tmpdir(), 'flags-bare-'))
    expect(readFlag(bare, 'GRADER_LIVE_SCAN', {} as NodeJS.ProcessEnv)).toEqual({ value: undefined, from: 'unset' })
  })
})
