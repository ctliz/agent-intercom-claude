# Waking a Claude Code session

Delivering a message to a *running* coding-agent session unprompted is the hard
part of any intercom. Codex exposes a long-lived app-server that can start a
turn in an existing thread over a socket. Claude Code does not expose an
equivalent stable programmatic turn-start API, so `claude-intercom` uses the
most robust primitive that exists today and documents the alternatives.

## What `claude-intercom` uses: headless `claude -p` workers

The wakeable worker (`cci` / `claude-intercom-worker`) shells out to the Claude
Code CLI:

```
claude -p --output-format json --resume <session-id> \
  --permission-mode manual ...   # message text on stdin
```

- **Genuine system access.** The woken turn is a full Claude Code turn: Bash,
  Read, Edit, Grep, everything, subject to the worker's permission mode.
- **Continuity.** `--output-format json` returns a stable `session_id`. The
  worker persists it and passes `--resume <session-id>` next time, so a worker
  is one long, resumable conversation. Attach with `claude --resume <id>`.
- **Intercom tools included.** Normal `cci` workers automatically pass the
  packaged MCP server to each headless turn, including proxy-backed profiles
  with an isolated `CLAUDE_CONFIG_DIR`. `ccim` deliberately omits MCP because
  Claude's `--safe-mode` disables it.
- **No experimental features.** Works on any Claude Code that supports `-p`.
- **Trade-off.** It wakes a *fresh background worker*, not a session you are
  personally sitting in. Headless turns can't answer interactive permission
  prompts, but the adapter still defaults to standard checks. Choose a
  validated explicit permission mode when needed; bypass is explicit-only and
  forbidden for hardened read-only reviewer roles.

## Alternatives for waking a *live* session

These deliver into a session you are actively watching. `claude-intercom` does
not depend on them, but they are worth knowing.

### Claude Code's `Monitor` tool (community: `claude-code-inter-session`)

A live session runs a small socket/WebSocket client as a background process via
the `Monitor` tool. Each inbound message is one stdout line, which Claude Code
turns into a native monitor notification injected into the live session — no
polling, low latency, zero idle cost. This is the most effective community
approach for waking an already-running session, but it requires the human to
have started the monitored client in that session.

### Native Channels (experimental)

`cci --tui --channel` uses Claude Code's research-preview
`notifications/claude/channel` mechanism. The original MCP owner declares
`experimental["claude/channel"]` and pushes a fixed inbox notification over
stdio after initialization. Claude reads and replies through the same existing
Intercom tools. It never needs a model-created Monitor or a first user prompt.
Custom channels require interactive development-channel confirmation,
supported Anthropic authentication, and applicable organization policy. The
notification has no host processing acknowledgement; require an actual reply
for task confirmation. See the [official reference](https://code.claude.com/docs/en/channels-reference).

### `PreToolUse` hook polling (community: Pigeon)

A `PreToolUse` hook checks a signal file for unread mail on each tool call.
Zero-cost when empty and simple, but it can only piggyback on the recipient's
*next* tool call — it cannot wake a truly idle session.

## Summary

| Mechanism                     | Wakes idle? | System access | Needs live session | Experimental | Shipped as |
|-------------------------------|-------------|---------------|--------------------|--------------|------------|
| Headless `claude -p` worker   | n/a (spawns fresh worker) | full | no | no | `cci` (default) |
| `Monitor` inbox (plugin)      | yes (if running) | full (live session) | yes | no | **`cci --tui`** |
| Native Channels               | yes (if enabled) | full (live session) | yes | yes | `cci --tui --channel` |
| `PreToolUse` hook polling      | no          | full (live session) | yes | no | — |

`claude-intercom` ships the first three rows: `cci` (headless worker), `cci
--tui` (live transport selection), and `cci --tui --channel` (live Channels).

### How `cci --tui` uses the Monitor mechanism

`cci --tui` launches `claude --plugin-dir <repo>` with an intercom identity and
`CLAUDE_INTERCOM_INBOX=<path>` in the environment. The bundled plugin's MCP
server owns the broker identity and appends each inbound message to that inbox
file; the plugin's auto-armed monitor (`monitors/monitors.json`, `when:
"always"`) runs `dist/inbox-monitor.mjs`, which tails the inbox and prints one
line per new message. Claude Code's Monitor machinery injects each line into the
live session, which then answers with `intercom_reply`. This is purely local —
no Anthropic channel relay — so it works behind a custom `ANTHROPIC_BASE_URL`.

Channels use the local MCP stdio transport; they do not require a separate
notification relay. Host authentication/provider and policy checks still
apply. This is now an opt-in alternative to Monitor. Local Claude 2.1.296 with
the CPA gateway and `gpt-6.1-sol` passed cold-start notification, pending read,
and model-generated `CHANNEL_CPA_OK` reply with the original ask correlation.
The test explicitly allowed only the pending and reply MCP tools; normal
permission prompts still apply to other tool calls.
