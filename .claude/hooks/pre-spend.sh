#!/usr/bin/env bash
# Blocks any command that could issue a paid collection or model call from an
# agent session. Rule R3 in CLAUDE.md. Exit 2 = block and tell Claude why.
#
# ⚠️ NO ENVIRONMENT FLAG CAN LIFT THIS. It used to stand down whenever
# COLLECTION_ENABLED was "true", and .claude/settings.json injects exactly
# that into every agent session — so the hook was a no-op where it ran
# (audit 2026-09-09, defect 3). A spending command is now blocked here
# unconditionally; a person runs it from a plain shell, which is the second
# deliberate act CLAUDE.md §7 describes.
set -euo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Patterns match spend *commands*, not filenames: "pnpm backfill ..." (the
# /backfill command's runner) rather than any path that merely contains the word.
BLOCK_ALWAYS=(
  "api.openwebninja.com"
  "services/collector/.*run"
  "collector:start"
  "collector:pilot"
  "(^|[[:space:];&|(])pnpm[^;&|]*[[:space:]]backfill(:[[:alnum:]_-]+)?([[:space:]]|$)"
  "grader:(diagnose|aeo)([[:space:]]|$)"
  "(tsx|node)[^;&|]*services/grader/src/(diagnose|aeo)\.ts"
)
# The scan runner spends unless the SAME command says --fixture or --stub.
SCAN="grader:scan([[:space:]]|$)|(tsx|node)[^;&|]*services/grader/src/run\.ts"
OFFLINE="--(fixture|stub)([[:space:]]|$)"
# The daily loop spends only with --live on the same command; the dry list and --fixture are free.
TICK="grader:tick([[:space:]]|$)|(tsx|node)[^;&|]*services/grader/src/tick\.ts"
LIVE="--live([[:space:]]|$)"

block() {
  echo "BLOCKED by pre-spend hook (CLAUDE.md rule R3): '$1' can issue paid provider or model calls, and an agent session may not spend. Use --fixture / fixtures, or ask the human to run it from their own shell." >&2
  exit 2
}

# One segment per shell command, so `a --fixture && b` cannot smuggle `b` past the flag check.
while IFS= read -r SEG; do
  [ -z "$SEG" ] && continue
  for pat in "${BLOCK_ALWAYS[@]}"; do
    if echo "$SEG" | grep -Eq -- "$pat"; then block "$SEG"; fi
  done
  if echo "$SEG" | grep -Eq -- "$SCAN" && ! echo "$SEG" | grep -Eq -- "$OFFLINE"; then block "$SEG"; fi
  if echo "$SEG" | grep -Eq -- "$TICK" && echo "$SEG" | grep -Eq -- "$LIVE"; then block "$SEG"; fi
done < <(printf '%s\n' "$CMD" | sed -E 's/(&&|\|\||;|\|)/\n/g')
exit 0
