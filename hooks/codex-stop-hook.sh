#!/usr/bin/env bash
# Codex Stop bridge — fires-and-forgets the turn-completion event to Shiro so
# it can send a Telegram notification, then emits an empty-object response so
# Codex proceeds normally.
#
# Fail-open: if Shiro is unreachable or the secret is missing we silently
# skip the forward and still let Codex proceed. A dropped stop notification
# is never worth blocking the agent's next turn.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIRO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$SHIRO_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SHIRO_DIR/.env"
  set +a
fi

SERVER_URL="${SHIRO_SERVER_URL:-http://127.0.0.1:7777}"
ENDPOINT="${SERVER_URL}/hooks/codex/stop"

INPUT="$(cat)"

if [[ -n "${SHIRO_SHARED_SECRET:-}" ]]; then
  printf '%s' "$INPUT" | curl -sS -X POST \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${SHIRO_SHARED_SECRET}" \
    --data-binary @- \
    --max-time 3 \
    "$ENDPOINT" >/dev/null 2>&1 || true
fi

printf '{}\n'
exit 0
