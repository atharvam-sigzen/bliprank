import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

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
 *
 * ⚠️ ONE ASYNCHRONOUS BASH, NOT ONE SYNCHRONOUS BASH PER CASE (MVP_PLAN B3d
 * item 6). The first version called spawnSync for every case. Each call
 * blocked the worker's event loop for a bash start-up — one to eight seconds
 * on Windows under load, 83 s over the file in a full run — and the runner
 * yields only microtasks between tests, so for the whole file the worker
 * never read the main process's acknowledgement of its task updates. vitest
 * gives that acknowledgement 60 s, so the full suite ended with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` while every test passed,
 * and CI's exit code depended on the machine's load (measured 2026-09-15:
 * the error reproduced without the 50 s pilot test, and never with this file
 * alone on a quiet machine). Now one bash runs every case through the real
 * hook and answers a line per case, spawned asynchronously in beforeAll, so
 * the loop is never blocked and the file takes seconds. The hook still reads
 * exactly the JSON Claude Code sends it, one command per invocation.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HOOK = join(ROOT, '.claude', 'hooks', 'pre-spend.sh').replace(/\\/g, '/')

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

const CASES: readonly string[] = [...BLOCKED, ...ALLOWED]

/**
 * One bash, every case: reads a JSON line per case on stdin, feeds each to
 * the real hook exactly as Claude Code would, and answers
 * `index<TAB>status<TAB>json(stderr)`. Exits 127 when jq is missing, which
 * is the hook's own requirement.
 */
const DRIVER = `
set -u
command -v jq >/dev/null 2>&1 || exit 127
i=0
while IFS= read -r line; do
  err=$(printf '%s' "$line" | bash "$HOOK" 2>&1 >/dev/null); st=$?
  printf '%s\\t%s\\t%s\\n' "$i" "$st" "$(printf '%s' "$err" | jq -Rs .)"
  i=$((i+1))
done
`

interface Verdict {
  readonly status: number
  readonly stderr: string
}

/** The hook's verdict per case, or null when bash or jq is absent on this machine. */
function runAll(commands: readonly string[]): Promise<ReadonlyMap<string, Verdict> | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', DRIVER], {
      // The exact condition the hook used to stand down under.
      env: { ...process.env, COLLECTION_ENABLED: 'true', CLAUDE_PROJECT_DIR: ROOT, HOOK },
    })
    const out: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', () => {})
    // No bash on PATH: skipped, said so below.
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code === 127) return resolve(null)
      const map = new Map<string, Verdict>()
      for (const line of Buffer.concat(out).toString('utf8').split('\n')) {
        if (!line) continue
        const [i, st, json] = line.split('\t')
        const cmd = commands[Number(i)]
        if (cmd === undefined || st === undefined || json === undefined) return reject(new Error(`the hook driver answered an unparsable line: ${line}`))
        map.set(cmd, { status: Number(st), stderr: (JSON.parse(json) as string).trim() })
      }
      if (map.size !== commands.length) return reject(new Error(`the hook driver answered ${map.size} of ${commands.length} cases (exit ${String(code)})`))
      resolve(map)
    })
    child.stdin.end(commands.map((command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } })).join('\n') + '\n')
  })
}

let verdicts: ReadonlyMap<string, Verdict> | null = null
beforeAll(async () => {
  verdicts = await runAll(CASES)
}, 120_000)

describe('the pre-spend hook, with COLLECTION_ENABLED=true in the environment', () => {
  // Plain `it` per case rather than `it.each`: the skip needs the test
  // context, which `it.each` does not type for string cases.
  for (const cmd of BLOCKED) {
    it(`blocks: ${cmd}`, (ctx) => {
      if (!verdicts) return ctx.skip()
      const r = verdicts.get(cmd)!
      expect([cmd, r.status]).toEqual([cmd, 2])
      expect(r.stderr).toContain('BLOCKED by pre-spend hook')
    })
  }

  for (const cmd of ALLOWED) {
    it(`allows: ${cmd}`, (ctx) => {
      if (!verdicts) return ctx.skip()
      const r = verdicts.get(cmd)!
      expect([cmd, r.status, r.stderr]).toEqual([cmd, 0, ''])
    })
  }
})

describe('the toolchain the hook needs', () => {
  it('is present on this machine, or this file said it was skipped', () => {
    // Not an assertion on availability: a CI box without jq must not fail the
    // build for it. The skips above are visible in the report, which is enough.
    expect(verdicts === null || verdicts.size === CASES.length).toBe(true)
  })
})
