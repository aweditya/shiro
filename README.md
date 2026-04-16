# Shiro

Your personal bridge between phone and laptop.

Shiro is a Telegram bot that lets you monitor and control things running on your laptop from anywhere. Today it handles **Claude Code** and **OpenAI Codex** approval requests — step away from your laptop, and your phone will ping you when a session needs permission so you can approve or deny with a tap. More capabilities coming.

## Why

You start an agent running. You walk away to grab food / go to the gym / take the dog out. The agent hits a permission prompt and just sits there, blocked, until you're back in front of your laptop. Shiro fixes that.

## Quick start

```bash
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SHIRO_SHARED_SECRET
chmod 600 .env
npm install
npm run dev
```

Then hook up whichever agent(s) you use — see below.

Run the test suite with `npm test`.

## Setting up the Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow the prompts, and copy the **bot token**.
2. Send any message to your new bot (this creates your chat with it).
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in your browser.
4. Find `"chat":{"id": <number>` in the JSON response — that's your **chat ID**.
5. Put both values in `.env`.

## Generating the shared secret

Every hook request to Shiro's HTTP server must include an `Authorization: Bearer <secret>` header. Without this, any local process (including a malicious webpage making a `fetch()` to localhost) could spoof hook calls.

Generate a secret:

```bash
openssl rand -hex 32
```

Put it in `.env` as `SHIRO_SHARED_SECRET=<value>` and include the same value in your Claude Code / Codex hook configuration (see below). `chmod 600 .env` to keep it out of reach of other users.

## Claude Code

Add to `~/.claude/settings.json` (replace `<SHIRO_SHARED_SECRET>` with the value you put in `.env`):

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
            "timeout": 60,
            "headers": {
              "Authorization": "Bearer <SHIRO_SHARED_SECRET>"
            }
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7777/hooks/claude/posttool",
            "timeout": 5,
            "headers": {
              "Authorization": "Bearer <SHIRO_SHARED_SECRET>"
            }
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7777/hooks/claude/userprompt",
            "timeout": 5,
            "headers": {
              "Authorization": "Bearer <SHIRO_SHARED_SECRET>"
            }
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "matcher": "rate_limit",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7777/hooks/claude/stopfailure",
            "timeout": 5,
            "headers": {
              "Authorization": "Bearer <SHIRO_SHARED_SECRET>"
            }
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7777/hooks/claude/stop",
            "timeout": 5,
            "headers": {
              "Authorization": "Bearer <SHIRO_SHARED_SECRET>"
            }
          }
        ]
      }
    ]
  }
}
```

Run `chmod 600 ~/.claude/settings.json` so other users can't read the secret. Open a new Claude Code session and the hook will route permission requests to Telegram.

The `PostToolUse`, `UserPromptSubmit`, `StopFailure`, and `Stop` hooks are optional but recommended:
- `PostToolUse` lets Shiro update a stale message to "Approved in terminal" when you approve from your laptop (instead of leaving it at "No Telegram response").
- `UserPromptSubmit` captures your latest prompt as the session's current task, so approval notifications and `/status` / `/sessions` can show what each session is actually doing.
- `StopFailure` (with `matcher: "rate_limit"`) pings you on Telegram the moment Claude hits a rate limit, with the session label and the retry-after message. Swap `matcher` for `""` to also get pinged on auth, billing, and server errors.
- `Stop` pings you when Claude finishes a turn — useful when you've stepped away from a long-running task. Stop fires on **every** turn, so Shiro filters out short interactive turns: only turns lasting at least `STOP_NOTIFY_MIN_SECONDS` (default 30s) trigger a notification. Requires `UserPromptSubmit` to be configured (that's how Shiro knows when the turn started). Set `STOP_NOTIFY_MIN_SECONDS=0` to ping on every turn.

## Codex

Enable hooks in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Create `~/.codex/hooks.json` (update the path to match where you cloned Shiro):

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "/absolute/path/to/shiro/hooks/codex-hook.sh",
          "timeout": 180,
          "statusMessage": "Waiting for Telegram approval..."
        }
      ]
    }
  ],
  "UserPromptSubmit": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "/absolute/path/to/shiro/hooks/codex-userprompt-hook.sh",
          "timeout": 3
        }
      ]
    }
  ]
}
```

Both shell bridges source Shiro's `.env` to pick up `SHIRO_SHARED_SECRET` and send the `Authorization` header automatically. `codex-hook.sh` auto-approves common read-only commands (`ls`, `cat`, `git status`, etc.) locally, so Telegram only pings you for commands that actually matter. `codex-userprompt-hook.sh` is optional — it captures your latest prompt as the session's current task (mirrors the Claude side) and fails open if Shiro is unreachable.

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/start` | Show help |
| `/status` | Active sessions + pending approval count |
| `/sessions` | List tracked sessions |
| `/pending` | Re-show any unresolved approval requests |
| `/approveall` | Approve everything pending |
| `/denyall` | Deny everything pending |
| `/rename <short_id> <label>` | Rename a session (short_id is the 6-char prefix shown in `/sessions`) |
| `/bind <short_id> <tmux_target>` | Bind a session to a tmux pane (e.g. `/bind abc123 mywork:0.0`) |
| `/unbind <short_id>` | Clear a session's tmux binding |
| `/bindings` | List current tmux bindings |
| `/say <short_id> <message>` | Type a prompt into a bound Claude session — reply arrives via the Stop hook |

Approval messages include inline **Approve** / **Deny** buttons — just tap.

### Driving a session from your phone (`/say`)

`/say` types a prompt directly into a running Claude session via tmux, so you can keep an agent moving while you're away from your laptop. You need the agent running inside a tmux pane (just launch Claude inside `tmux` — no special wrapper required).

When Shiro sees a hook from a Claude session whose `cwd` matches exactly one tmux pane running an agent, it auto-binds. Use `/bindings` to inspect, `/bind` to override, `/unbind` to clear. Once bound, `/say <short_id> <message>` sends the message and Claude's reply comes back via the Stop hook prefixed with **Reply to /say** so it stands out from spontaneous turn completions. The Stop hook bypasses the usual duration filter for phone-driven turns.

Codex two-way support is deferred — Codex doesn't have a Stop-hook equivalent yet, so there's no path to route the reply back.

## How networking works

Your phone and laptop don't need to be on the same network. Shiro uses Telegram's bot API, which means your laptop connects *outbound* to Telegram, your phone talks to Telegram too, and Telegram routes between you. As long as your laptop has internet, you can control it from anywhere.

## Configuration (optional)

All tunable in `.env`:

```
CLAUDE_TIMEOUT_SECONDS=55
CODEX_TIMEOUT_SECONDS=120
SESSION_STALE_SECONDS=1800
STOP_NOTIFY_MIN_SECONDS=30
```

## Security notes

- HTTP server binds to `127.0.0.1` only — not reachable from the network.
- Every hook request requires an `Authorization: Bearer <shared secret>` header. Requests without a matching secret are rejected with 401. This defeats malicious webpages making `fetch()` to localhost.
- The Telegram bot only responds to the chat ID you configured; all other senders are ignored.
- Fails closed: if approval times out or the bot is unreachable, the agent request is denied.
- `chmod 600` on `.env` and `~/.claude/settings.json` keeps the shared secret from being read by other users on the machine.

## Roadmap

- Rate-limit-aware resume (ping you when token limits reset)
- Remind/scheduling commands
- Beyond coding: arbitrary tool triggering via chat
