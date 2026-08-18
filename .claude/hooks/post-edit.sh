#!/usr/bin/env bash
# After edits: typecheck always; stats + RLS suites when their areas are touched.
set -uo pipefail
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
cd "${CLAUDE_PROJECT_DIR:-.}"

[ -z "$FILE" ] && exit 0

case "$FILE" in
  *.ts|*.tsx)
    pnpm -s typecheck 2>&1 | tail -20
    ;;
esac

case "$FILE" in
  *packages/stats/*)
    echo "→ packages/stats touched: running statistical reference tests"
    pnpm -s test --filter stats 2>&1 | tail -30
    echo "⚠️  Invoke the stats-reviewer subagent before considering this done."
    ;;
  *packages/db/*)
    echo "→ packages/db touched: running RLS policy suite (CLAUDE.md rule R7)"
    pnpm -s test:rls 2>&1 | tail -30
    echo "⚠️  Invoke the tenancy-auditor subagent before considering this done."
    ;;
  *services/scorer/*)
    echo "→ scorer touched: run /score-version if scoring behaviour changed (rule R5)."
    ;;
esac
exit 0
