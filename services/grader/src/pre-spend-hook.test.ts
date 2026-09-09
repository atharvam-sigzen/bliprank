import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE PRE-SPEND HOOK, RUN FOR REAL. `.claude/hooks/pre-spend.sh` is the R3
 * guard on every Bash command an agent session issues, and the 2026-09-09
 * audit found it (a) stood down whenever COLLECTION_ENABLED was "true", which
 * every agent session injects, and (b) never matched a grader command at all.
 * So this runs the actual script through bash with that flag deliberately ON
 * and asserts what it blocks.
 *
 * Needs bash and jq on PATH, as the hook itself does. Where either is absent
 * the suite is skipped and says so, rather than passing vacuously.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HOOK = join(ROOT, '.claude', 'hooks', 'pre-spend.sh')

const have = (tool: string): boolean => spawnSync('bash', ['-lc', `command -v ${tool}`], { encoding: 'utf8' }).status === 0
const available = have('bash') && have('jq')

function run(command: string): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    // The exact condition the hook used to stand down under.
    env: { ...process.env, COLLECTION_ENABLED: 'true', CLAUDE_PROJECT_DIR: ROOT },
  })
  return { status: r.status, stderr: r.stderr ?? '' }
}

const BLOCKED = [
  'pnpm grader:scan -- --domain acme.com',
  'pnpm grader:scan',
  'pnpm grader:tick -- --apply --live',
  'pnpm grader:diagnose',
  'pnpm grader:diagnose -- chatgpt',
  'pnpm grader:aeo -- --domain acme.com',
  'pnpm collector:pilot',
  'tsx services/grader/src/run.ts --domain acme.com',
  'tsx services/grader/src/tick.ts --apply --live',
  'curl https://api.openwebninja.com/usage',
  // A free segment does not launder a spending one on the same line.
  'pnpm grader:scan -- --fixture && pnpm grader:scan -- --domain acme.com',
  'pnpm test; pnpm grader:tick -- --apply --live',
  // The three bypasses the cost-sentinel review ran against the first version
  // (2026-09-09): a shell character right after the name, and a relative path.
  'X=$(pnpm grader:diagnose)',
  'pnpm grader:diagnose>out.txt',
  'bash -c "pnpm grader:diagnose"',
  'cd services/grader && tsx src/diagnose.ts',
  'pnpm --filter @bliprank/grader exec tsx src/run.ts --domain acme.com',
  'echo `pnpm grader:scan`',
]

const ALLOWED = [
  'pnpm grader:scan -- --fixture --domain acme.com',
  'pnpm grader:scan -- --stub',
  'pnpm grader:tick',
  'pnpm grader:tick -- --day 2026-09-04',
  'pnpm grader:tick -- --apply --fixture',
  'pnpm grader:track -- --domain acme.com --on --reason "paying customer"',
  'pnpm grader:rescore -- --all',
  'pnpm grader:answers -- --domain acme.com',
  'pnpm test',
  'git log --oneline -5',
  'cat services/grader/src/diagnose.ts',
  'grep -n budget services/grader/src/run.ts',
  'cat services/grader/src/run.ts',
  'pnpm grader:scan-report',
  'pnpm grader:diagnose-docs',
]

describe.skipIf(!available)('the pre-spend hook, with COLLECTION_ENABLED=true in the environment', () => {
  it.each(BLOCKED)('blocks: %s', (cmd) => {
    const r = run(cmd)
    expect([cmd, r.status]).toEqual([cmd, 2])
    expect(r.stderr).toContain('BLOCKED by pre-spend hook')
  })

  it.each(ALLOWED)('allows: %s', (cmd) => {
    const r = run(cmd)
    expect([cmd, r.status, r.stderr]).toEqual([cmd, 0, ''])
  })
})

describe('the toolchain the hook needs', () => {
  it('is present on this machine, or this file said it was skipped', () => {
    // Not an assertion on `available`: a CI box without jq must not fail the
    // build for it. The skip above is visible in the report, which is enough.
    expect(typeof available).toBe('boolean')
  })
})
