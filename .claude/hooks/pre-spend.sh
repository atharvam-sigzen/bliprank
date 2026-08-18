#!/usr/bin/env bash
# Blocks any command that could issue a paid collection call outside the scheduler.
# Rule R3 in CLAUDE.md. Exit 2 = block and tell Claude why.
set -euo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Patterns match spend *commands*, not filenames: "pnpm backfill ..." (the
# /backfill command's runner) rather than any path that merely contains the word.
BLOCK_PATTERNS=(
  "api.openwebninja.com"
  "services/collector/.*run"
  "collector:start"
  "(^|[[:space:];&|(])pnpm[^;&|]*[[:space:]]backfill(:[[:alnum:]_-]+)?([[:space:]]|$)"
)

for pat in "${BLOCK_PATTERNS[@]}"; do
  if echo "$CMD" | grep -Eq "$pat"; then
    if [ "${COLLECTION_ENABLED:-false}" != "true" ]; then
      echo "BLOCKED by pre-spend hook (CLAUDE.md rule R3): this command can issue paid collection calls, and COLLECTION_ENABLED is not 'true'. Use fixtures instead, or ask the human to enable collection deliberately." >&2
      exit 2
    fi
  fi
done
exit 0
