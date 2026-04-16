#!/usr/bin/env bash
# Codex PreToolUse bridge — reads hook JSON from stdin, decides whether to
# route to Telegram for approval, and emits the permissionDecision Codex expects.
#
# Strategy: Codex PreToolUse fires on EVERY tool call, so to avoid notification
# spam this script auto-approves safe/read-only bash commands locally and only
# forwards "interesting" commands to the HTTP server for remote approval.

set -uo pipefail

SERVER_URL="${AGENT_CONTROL_PLANE_URL:-http://127.0.0.1:7777}"
ENDPOINT="${SERVER_URL}/hooks/codex/pretool"
TIMEOUT_SECONDS="${AGENT_CONTROL_PLANE_TIMEOUT:-150}"

INPUT="$(cat)"

allow() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n'
  exit 0
}

deny() {
  local reason="${1:-denied}"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

# Extract tool name and command (best effort; if jq isn't available, fall back to forwarding).
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
  COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
else
  TOOL_NAME=""
  COMMAND=""
fi

# Auto-approve known-safe, read-only bash command prefixes.
# The regex is conservative: first whitespace-separated token must be one of these.
if [[ "$TOOL_NAME" == "Bash" || "$TOOL_NAME" == "bash" || "$TOOL_NAME" == "shell" ]]; then
  FIRST_TOKEN="${COMMAND%% *}"
  # Strip leading subshells / env prefixes we don't handle — be conservative and just check the first token.
  case "$FIRST_TOKEN" in
    ls|cat|head|tail|wc|file|stat|pwd|which|type|echo|printf|date|whoami|uname|id|env|hostname)
      allow
      ;;
    find|grep|rg|ag|ack|tree|du|df)
      allow
      ;;
    git)
      # Only auto-approve read-only git subcommands
      SUBCMD="$(printf '%s' "$COMMAND" | awk '{print $2}')"
      case "$SUBCMD" in
        status|log|diff|show|branch|remote|config|rev-parse|ls-files|describe|blame|reflog)
          allow
          ;;
      esac
      ;;
    node|python|python3|ruby|go)
      # Only auto-approve `--version` style invocations
      if [[ "$COMMAND" == *" --version"* || "$COMMAND" == *" -V"* ]]; then
        allow
      fi
      ;;
  esac
fi

# Fall through: forward to the control plane for human approval.
RESPONSE="$(printf '%s' "$INPUT" | curl -sS -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  --max-time "$TIMEOUT_SECONDS" \
  "$ENDPOINT" 2>/dev/null)"

if [[ -z "$RESPONSE" ]]; then
  # Control plane unreachable — fail closed (deny) to be safe.
  deny "control_plane_unreachable"
fi

printf '%s\n' "$RESPONSE"
exit 0
