#!/usr/bin/env bash
# End-of-session reminder to keep CLAUDE.md's "Current state" honest.
set -uo pipefail
echo "─────────────────────────────────────────────"
echo "Session ending. Before you stop, confirm:"
echo "  • CLAUDE.md §9 'Current state' reflects reality"
echo "  • Any human-owned area you touched is flagged"
echo "  • New structural decisions have an ADR in docs/adr/"
echo "─────────────────────────────────────────────"
exit 0
