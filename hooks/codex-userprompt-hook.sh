#!/usr/bin/env bash
# Codex UserPromptSubmit bridge — fires-and-forgets the prompt to Shiro so
# it can capture it as the session's currentTask, then emits an empty-object
# response so Codex does nothing to the prompt (no block, no extra context).
#
# Fail-open: if Shiro is unreachable or the secret is missing we silently
# skip the forward and still let Codex proceed. A dropped prompt-capture
# is never worth blocking the user's turn.

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
ENDPOINT="${SERVER_URL}/hooks/codex/userprompt"

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
