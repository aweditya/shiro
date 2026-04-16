# Agent Control Plane

Telegram bot that lets you approve/deny permission requests and monitor status of local **Claude Code** and **OpenAI Codex** sessions from your phone.

Why: when you run multiple agent sessions and step away from the laptop, they block on permission prompts. This bridges those prompts to Telegram so you can unblock them from anywhere.

## Architecture

```
┌────────────────┐       HTTP (held open)       ┌──────────────────┐
│  Claude Code   │ ───────────────────────────▶ │                  │
│   (hook)       │ ◀─ allow/deny JSON ────────  │   Control Plane  │
└────────────────┘                              │   (this repo)    │
                                                │                  │
┌────────────────┐   codex-hook.sh → curl ─────▶│  HTTP :7777      │
│     Codex      │ ◀─ permissionDecision ────── │  + grammY bot    │
│  (PreToolUse)  │                              └────────┬─────────┘
└────────────────┘                                       │
                                                         ▼
                                                    Telegram
                                                     (your phone)
```

Single TypeScript process. HTTP connection is held open until you tap Approve/Deny — no polling, no database.

## Setup

### 1. Create the Telegram bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, follow the prompts, and copy the **bot token**.
3. Send any message to your new bot (this creates a chat with it).
4. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in your browser.
5. Find `"chat":{"id": <number>, ...}` in the JSON — that number is your **chat ID**.

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in:

```
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_CHAT_ID=<your chat ID>
HTTP_PORT=7777
```

### 3. Install and start

```bash
npm install
npm run dev
```

You should see:

```
HTTP server listening on http://127.0.0.1:7777
Telegram bot started as @your_bot_name
Control plane ready.
```

### 4. Hook up Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7777/hooks/claude/permission",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

That's it. The next time Claude Code needs permission, you'll get a Telegram message.

### 5. Hook up Codex

Enable hooks in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Create `~/.codex/hooks.json`:

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "/Users/adityasriram/Labs/stanford/cs440lx/telegram-bot/hooks/codex-hook.sh",
          "timeout": 180,
          "statusMessage": "Waiting for Telegram approval..."
        }
      ]
    }
  ]
}
```

The shell bridge auto-approves read-only commands (`ls`, `cat`, `git status`, etc.) locally so Telegram only pings you for things that actually matter.

## Telegram Commands

| Command | What it does |
|---------|-------------|
| `/start` | Show help |
| `/status` | Active sessions + pending approval count |
| `/sessions` | List tracked sessions with their working dirs |
| `/pending` | Re-send buttons for unresolved approvals |
| `/approveall` | Approve every pending request |
| `/denyall` | Deny every pending request |

Approval messages have Approve / Deny inline buttons — just tap.

## Configuration knobs (optional)

In `.env`:

```
CLAUDE_TIMEOUT_SECONDS=55   # Auto-deny Claude requests after this many seconds (< hook's 60s)
CODEX_TIMEOUT_SECONDS=120   # Auto-deny Codex requests after this many seconds
SESSION_STALE_SECONDS=1800  # Drop sessions we haven't heard from after this long
```

## Security notes

- HTTP server binds to `127.0.0.1` only — not reachable from the network.
- Telegram bot only responds to messages from your configured `TELEGRAM_CHAT_ID`.
- On timeout, requests are **denied** (fail-closed).
- If the control plane is down when Codex calls it, the shell script denies the request.

## Project layout

```
src/
  index.ts        # entry: boots HTTP server + Telegram bot
  config.ts       # env loading
  types.ts        # shared interfaces
  state.ts        # in-memory session + pending-approval store
  http-server.ts  # /hooks/claude/permission + /hooks/codex/pretool
  telegram.ts     # grammY bot, commands, approve/deny callbacks
hooks/
  codex-hook.sh   # shell bridge Codex calls; forwards to HTTP server
```
