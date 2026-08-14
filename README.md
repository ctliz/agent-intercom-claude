# Claude Intercom

**Agent Intercom** is a cross-harness, same-machine messaging system for coding agents. Its Pi, Codex, Claude Code, and OpenCode adapters share one local broker and protocol, so sessions can discover and message each other regardless of which harness they run in.

| Harness | Repository |
|---|---|
| Core / Protocol | [`agent-intercom-core`](https://github.com/ctliz/agent-intercom-core) |
| Pi | [`agent-intercom-pi`](https://github.com/ctliz/agent-intercom-pi) |
| Codex | [`agent-intercom-codex`](https://github.com/ctliz/agent-intercom-codex) |
| Claude Code | [`agent-intercom-claude`](https://github.com/ctliz/agent-intercom-claude) |
| OpenCode | [`agent-intercom-opencode`](https://github.com/ctliz/agent-intercom-opencode) |
| Fleet lifecycle | [`agent-intercom-orchestrator`](https://github.com/ctliz/agent-intercom-orchestrator) |

## Maintenance & Upstream Provenance

- **Maintained by `ctliz`**: This distribution is maintained independently by [ctliz](https://github.com/ctliz).
- **Upstream Heritage**: Agent Intercom grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom) and the upstream [`dataforxyz/agent-intercom-*`](https://github.com/dataforxyz/agent-intercom-claude) repositories. This project is not officially endorsed by or affiliated with upstream organizations.
- **Package Namespace**: The canonical npm namespace is `@ctliz/*`. The historical `@dataforxyz/*` namespace was used up to and including `connect.1` and is retained only as provenance and as a migration-detection input; it is never treated as a current or healthy installation. The **Agent Intercom** branding and the `intercom_*` API surface are unchanged.

## Protocol v4 & Broker-Enforced Scope

Agent Intercom protocol v4 introduces **broker-enforced scope routing** via `AGENT_INTERCOM_SCOPE_ID`:

- **Registration**: The client submits its `scopeId` once in the top-level registration payload.
- **Broker Enforcement**: The shared local broker stores the scope in its private `ConnectedSession` record and enforces same-scope discovery (`intercom_list`), naming, and prefix matching.
- **Cross-Scope Routing**: Cross-scope messaging is fail-closed; communication across different scopes is permitted only when addressing an explicit full session ID.
- **UX Routing Isolation**: Scope is designed for same-OS-user workflow isolation (e.g. per-project or per-workspace agent teams), **not** as a cryptographic security principal, tenant boundary, or authentication credential.
- **Leak-Free**: The raw `scopeId` value never enters `SessionInfo`, list payloads, lifecycle events, frontend displays, or execution logs.
- **Standalone First**: `AGENT_INTERCOM_SCOPE_ID` is a general shell/IDE/service launcher contract. Agent Intercom works completely standalone in any terminal, tmux window, or script; TmuxDeck is optional visual tooling.

## Origin and thanks

Agent Intercom grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). A sincere thank you to Nico and the original contributors for creating the Pi extension and the foundation this cross-harness family builds on.

This repository contains the Claude Code adapter. It uses the shared strict `pi-intercom` protocol v4. Any adapter may start the broker first; incompatible legacy brokers fail closed without killing, downgrading, or creating second islands. Sends are retained in a durable per-session outbox and replayed after reconnect, while receiver acknowledgement distinguishes broker acceptance from durable receipt.

Attached Claude sessions support two local delivery transports. `native` bridges the broker to Claude Code's cross-session Unix socket protocol; `mcp` preserves the plugin/inbox/Monitor path. The default `auto` mode selects native only for Claude Code versions in the verified compatibility window (currently 2.1.220–2.1.226) and otherwise selects MCP. Explicit native selection fails closed outside that window.

When running `cci` or `ccim` in an attached terminal, press **Alt+M** to choose a connected session and send it a message, or **Alt+I** to copy that worker's intercom contact target. The MCP plugin cannot register native Claude Code keyboard shortcuts because Claude Code does not expose plugin keybinding registration; the plugin instead provides `/claude-intercom:intercom` and `/claude-intercom:intercom-id`. Detached worker-daemon mode has no terminal shortcuts.

Claude Intercom adds local messaging between Claude Code, Codex, Pi, OpenCode,
and other coding-agent sessions on the same machine. It speaks the same local broker
protocol as [`pi-intercom`](https://github.com/ctliz/agent-intercom-pi) and
[`codex-intercom`](https://github.com/ctliz/agent-intercom-codex), so sessions
can discover each other, send updates, ask blocking questions, read pending
messages, and reply to asks across all four supported harnesses.

The project has two related pieces:

- `claude-intercom-mcp`: an MCP server that exposes intercom tools inside a
  normal Claude Code session.
- `cci` / `claude-intercom-worker`: a **wakeable Claude worker**. It registers
  an intercom identity, and when another session sends it work, it starts a
  fresh headless `claude -p` turn that resumes the worker's own conversation —
  so the worker can read files, run commands, edit code, and reply on its own.

Use plain MCP when you only need tools inside an already-active Claude turn. Use
a wakeable worker when you want another session to wake Claude automatically and
have it act with real system access.

## Status

Preview. This is the Claude-side adapter, built alongside `pi-intercom` and
`codex-intercom`.

A plain Claude Code MCP session does not receive unsolicited visible turns.
Incoming messages are queued while the MCP server is running; call
`intercom_pending` to read them. Wake-on-message workflows use `cci` /
`claude-intercom-worker`.

## How Claude gets woken

Claude Code has no long-lived programmatic "app-server" the way Codex does, so
the worker uses the most robust primitive available: the headless CLI.

1. The worker registers an intercom identity on the local broker and idles.
2. When a message arrives, the worker runs
   `claude -p --output-format json --resume <session-id> ...`, feeding the
   message text on stdin. Normal `cci` workers automatically receive the
   packaged Intercom MCP server, even under an isolated `CLAUDE_CONFIG_DIR` or
   custom `ANTHROPIC_BASE_URL`.
3. Claude runs a full turn — it can use Bash, Read, Edit, and every other
   Claude Code tool, subject to the worker's permission mode — and prints a
   final result plus a stable `session_id`.
4. The worker persists that `session_id` so the next message resumes the same
   conversation, and (for blocking asks) sends the final assistant message back
   to the asker as the reply.

This gives a woken worker genuine access to the system while keeping each worker
a continuous, resumable conversation. You can attach to a worker's conversation
at any time with `claude --resume <session-id>`.

## Install

Install via npm using the `connect` dist-tag:

```bash
npm install -g @ctliz/agent-intercom-claude@connect
# or by exact prerelease version
npm install -g @ctliz/agent-intercom-claude@0.12.0-connect.3
```

Or install from GitHub source at the exact tag so the command-line entry points are on `PATH`:

```bash
git clone --depth 1 --branch v0.12.0-connect.3 https://github.com/ctliz/agent-intercom-claude.git
cd agent-intercom-claude && npm ci && npm link
```

This provides:

- `claude-intercom-mcp`
- `claude-intercom-worker`
- `cci` — start a normal wakeable worker
- `ccim` — start a minimal wakeable worker (`cci --minimal`)

To let a Pi manager create Claude workers with owned systemd cgroups, leases, model/effort selection, logs, and verified cleanup, install the companion Pi packages:

```bash
pi install git:github.com/ctliz/agent-intercom-pi@v0.11.0-connect.2
pi install git:github.com/ctliz/agent-intercom-orchestrator@v0.11.0-connect.2
```

Restart Pi or run `/reload`, then call `agent_fleet({ action: "doctor" })`. The orchestrator invokes the installed `cci`/`ccim` commands; it does not replace this Claude adapter.

`cci` and `ccim` are the recommended entry points when you want an attached,
wakeable Claude session. Unlike a plain MCP session or a detached headless
worker, the attached wrappers provide the **Alt+M** session picker/message
composer and the **Alt+I** contact-copy shortcut; they also keep an intercom
identity online so another agent can wake the worker.
If you use the same worker profiles repeatedly, add memorable shell aliases
with your own portable project paths and stable IDs:

```bash
alias claude-reviewer='cci --cwd "$HOME/src/my-project" --name reviewer --id reviewer'
alias claude-reviewer-min='ccim --cwd "$HOME/src/my-project" --name reviewer-min --id reviewer-min'
```

Put aliases in your shell startup file (for example `~/.bashrc` or `~/.zshrc`).
They are optional convenience shortcuts: the installed `cci` and `ccim`
commands work directly, but aliases make stable identities and project-specific
defaults easier to reuse without copying a long command.

For a plain, already-active Claude Code session, add the MCP server explicitly:

```bash
claude mcp add claude-intercom -- claude-intercom-mcp
```

With `--transport mcp`, `cci` does this automatically for each normal headless worker. Native headless workers are still woken and replied through the worker daemon's broker connection, but omit the packaged MCP server from the Claude turn. `ccim` intentionally uses Claude's `--safe-mode`, which disables MCP servers along with plugins, hooks, and skills.

Optional identity variables can be attached at registration time:

```bash
claude mcp add claude-planner \
  --env CLAUDE_INTERCOM_NAME=planner \
  --env CLAUDE_INTERCOM_SESSION_ID=claude-planner \
  --env CLAUDE_INTERCOM_MODEL=opus \
  -- claude-intercom-mcp
```

## Plugin Use

The repo also ships Claude Code plugin metadata:

- `.claude-plugin/plugin.json`
- `.mcp.json`
- `skills/claude-intercom/SKILL.md`
- `commands/intercom.md` and `commands/intercom-id.md`

The plugin packages the MCP server and the bundled `claude-intercom` skill (which
gives Claude copy-paste coordination patterns). It also installs these Claude
Code slash commands:

- `/claude-intercom:intercom [target and message]` — list sessions and send a
  message. Without arguments, Claude asks which peer to contact and what to send.
- `/claude-intercom:intercom-id` — print this session's stable, copyable
  intercom target.

Claude custom commands are model-driven prompt commands, not native modal UI.
Claude namespaces plugin commands by plugin name, so an installed plugin cannot
claim the unqualified `/intercom` command globally.
They call the same MCP tools and work in a normal Claude Code session, but only
the attached `cci`/`ccim` wrappers can own the terminal and provide an immediate
Alt+M picker. Load the plugin for a single session with `--plugin-dir`:

```bash
claude --plugin-dir /path/to/agent-intercom-claude      # this session only
```

For the minimal tool surface, prefer plain MCP registration
(`claude mcp add claude-intercom -- claude-intercom-mcp`) so you get the intercom
tools without the skill.

## Tools

- `intercom_whoami`: show this session's intercom ID, name, cwd, and model.
- `intercom_team`: show the current manager and live coworkers owned by that manager.
- `intercom_status`: show connection status and pending message counts.
- `intercom_list`: list local Pi, Codex, and Claude sessions in your scope (protocol v4 is same-scope; cross-scope contact requires an exact full session ID).
- `intercom_set_summary`: publish a short discoverable status.
- `intercom_send`: send a non-blocking message.
- `intercom_ask`: send a question and wait for the target's reply.
- `intercom_pending`: read queued inbound messages and unresolved asks.
- `intercom_reply`: reply to a pending inbound ask; use `to` plus `which: "oldest" | "latest"` if one sender has multiple unresolved asks.

Pending output never exposes protocol message IDs. Keep at most one unresolved `intercom_ask` to the same recipient; the broker rejects a second ask and recommends `intercom_send` for a non-blocking follow-up. Use `intercom_send`—not `intercom_ask`—for assignments and progress/status checkpoints.

Persistent Claude workers and plain MCP runtimes automatically reconnect their stable Intercom identity after a broker restart, so a live worker does not need to be respawned merely to become reachable again.

Example:

```typescript
intercom_team({})
// Manager: manager-id [connected]
// You: worker-a
// Coworkers: reviewer target=reviewer (codex, reviewer, running) [connected]

intercom_ask({
  to: "worker-a",
  message: "Please inspect the failing test and reply with the likely cause.",
  timeout_ms: 45000
})
```

Blocking asks default to a short bounded wait and reject waits over 120 seconds.
For longer work, use `intercom_send` and check later with `intercom_pending`.

## Wakeable Workers With `cci`

`cci` (Claude Code Intercom) starts a single wakeable worker in the foreground.
It registers the worker on the broker. For every inbound message, the attached
terminal visibly prints the sender and message, a working indicator, and the
final Claude result or error. Blocking asks still receive that final result as
their automatic intercom reply. Press **Alt+M** for a numbered list of connected
peers, then choose one and enter a message. Press **Alt+I** to copy the worker's
contact target.

This is an attached worker console, not Claude Code's interactive TUI: woken
turns run through `claude -p`, and their final output is mirrored into the
console. To continue or inspect the full Claude conversation, run `claude
--resume <session-id>` using the session ID printed with the completed turn.
`ccim` has the same visible wake behavior and shortcuts.

Start a named worker:

```bash
cci --name worker-a --id worker-a
```

Flags (all optional; `ccim` accepts the same set):

| Flag | Meaning |
|------|---------|
| `--name <name>` | Discoverable session name other sessions target |
| `--id <id>` | Stable intercom session id (defaults to a git-derived id) |
| `--cwd <dir>` | Working directory for the worker's turns (default: cwd) |
| `--model <model>` | Model for woken turns (`opus`, `sonnet`, `haiku`, or a full id) |
| `--effort <level>` | Claude effort for every woken turn (`low`, `medium`, `high`, `xhigh`, or `max`) |
| `--instructions <text>` | System-prompt guidance appended to every woken turn |
| `--tui` / `--live` | Run as a LIVE interactive Claude session woken in place (see below) instead of a headless `claude -p` worker |
| `--minimal` / `--bare` | Run woken turns with `--safe-mode` (see below); implied by `ccim` (ignored with `--tui`) |
| `--safe` | Compatibility alias for the safe `manual` permission mode |
| `--yolo` / `--dangerously-skip-permissions` | Explicitly bypass permission checks (never the default) |
| `--permission-mode <mode>` | Validated against Claude Code 2.1.220 (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, or `plan`) |
| `--add-dir <dir>` | Extra directory the worker may access (repeatable) |
| `--mcp-config <json\|file>` | Extra MCP servers for woken turns (e.g. to give the worker intercom tools) |
| `--state <path>` | Where to persist the worker's session id (default under `~/.pi/agent/intercom/`) |
| `--claude <cmd>` | Claude Code executable to invoke (default `claude`) |
| `--transport <auto\|native\|mcp>` | Delivery transport; `auto` uses native only for verified-compatible Claude versions |

```bash
cci --cwd /path/to/project --instructions "Reply tersely. Ask before destructive changes."
cci --model opus --effort max --name reviewer --id reviewer
cci --yolo --name trusted-worker --id trusted-worker # explicit opt-in only
cci --add-dir ../shared-lib --name worker-a --id worker-a
```

By default `cci` passes the standard `--permission-mode manual`; it never adds
`--dangerously-skip-permissions` on the user's behalf. Headless turns cannot
answer an interactive permission prompt, so choose a validated explicit mode
when a different non-interactive posture is required. `--yolo` remains an
explicit trusted-user opt-in outside hardened roles.

## Live TUI Mode (`cci --tui`)

Default `cci` is a headless worker: each message spawns a `claude -p` turn. With
`--tui`, `cci` instead opens a **live interactive Claude session that you sit in
and that is woken in place** — the Codex `coi` experience. Inbound intercom
messages are injected into the running session and it replies over the broker;
you see everything and can type alongside it.

```bash
cci --tui --name worker-a --id worker-a
```

Claude Code has no Codex-style app-server. `cci --tui` therefore resolves one of two local transports before launch:

- **Native** bridges the Intercom broker to Claude Code's local cross-session Unix socket. Inbound messages appear as attributed peer messages in the live session; Claude must answer them with its built-in `SendMessage` tool so the bridge can preserve blocking ask/reply correlation. Native launches enable Claude's cross-session feature flag automatically. `auto` uses this only for the verified Claude Code compatibility window (currently 2.1.220–2.1.226). If native attachment fails under `auto`, `cci` restarts once with MCP; explicit `--transport native` fails closed instead.
- **MCP** is the preserved compatibility path. It launches Claude with the packaged plugin, whose MCP server registers the identity, appends inbound messages to a durable inbox, and auto-arms `monitors/monitors.json` to inject them with Claude Code's local Monitor mechanism. Blocking asks are answered with `intercom_reply`.

Choose explicitly with `--transport native` or `--transport mcp`, or set `CLAUDE_INTERCOM_TRANSPORT`. Worker JSON entries also accept `"transport": "auto" | "native" | "mcp"`. The Claude executable is probed with `claude --version`; unreadable or out-of-window versions never silently enable native mode.

`--minimal` is ignored in live TUI mode. The native path requires an interactive Claude process that publishes its local messaging socket. The MCP path additionally needs a built checkout (`npm run build`) and an available Monitor feature; Monitor is unavailable when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or on Bedrock/Vertex/Foundry. Both paths remain local and work behind a custom `ANTHROPIC_BASE_URL`/proxy. See [docs/wake-mechanisms.md](docs/wake-mechanisms.md).

## Normal And Minimal Workers

Like Codex's `coi` (normal) and `coim` (minimal), `cci` has a minimal mode. Codex
needs a dedicated `CODEX_HOME` and a hand-written `config.toml` to strip
memories, plugins, skills, and browser surfaces (while keeping `multi_agent`).
Claude Code has this built in: `cci --minimal` runs every woken turn with Claude
Code's `--safe-mode`, which disables CLAUDE.md, skills, plugins, hooks, and MCP
servers while keeping auth, built-in tools (Bash/Read/Edit/…), and permissions
working normally. It is the focused-worker profile: less prompt and tool surface,
same coding ability.

**Subagents are retained in minimal mode.** `--safe-mode` only disables *custom*
agent-type definitions (`.claude/agents/`), not the built-in `Task` tool — so a
minimal worker can still delegate to general-purpose subagents, matching Codex
minimal's `multi_agent = true`. This is verified end-to-end
(`test/e2e/minimal-subagent.sh`): a minimal worker spawns a subagent that runs a
shell command and reports back.

`cci` and `ccim` are installed as a matched pair (like Codex's `coi` and `coim`):
`ccim` is exactly `cci --minimal` — same flags, same identity handling, minimal
by default. You do not need an alias to enable minimal mode; aliases are useful
only for reusable names, IDs, paths, or permission settings.

```bash
cci  --name reviewer --id reviewer                 # normal: full config, CLAUDE.md, skills, MCP
ccim --name lean-worker --id lean-worker           # minimal: --safe-mode woken turns
ccim --safe --name lean-safe --id lean-safe        # minimal + standard permission prompts
cci --minimal --name worker-a --id worker-a        # equivalent to `ccim ...`
```

Because minimal mode disables MCP in the woken turn, a minimal worker cannot use
the intercom tools to message other sessions itself — it still receives work and
replies normally (the worker daemon captures its final message and sends the
reply). Use a normal worker when you want the woken turn to reach out to peers on
its own.

## Manager And Worker Pattern

Use one Claude Code session as the manager and one or more `cci` workers.

Launch a worker in `tmux`:

```bash
tmux new-session -d -s worker-a 'cd /path/to/project && cci --name worker-a --id worker-a'
```

Then, from the manager session, delegate through the intercom tools:

```typescript
intercom_ask({
  to: "worker-a",
  message: "Create a plan for adding retries to src/api/client.ts, then report your first step.",
  timeout_ms: 60000
})
```

For non-blocking delegation, use `intercom_send` and check back with
`intercom_pending`. For a decision you need before continuing, use
`intercom_ask`.

## Worker Daemon (multiple workers)

Use `claude-intercom-worker` when you want one process to publish several
configured workers without a launcher per worker.

Create a config:

```json
{
  "statePath": "/path/to/intercom/claude-worker-state.json",
  "claudeCommand": "claude",
  "agents": [
    {
      "id": "claude-worker",
      "name": "claude-worker",
      "cwd": "/path/to/project",
      "model": "sonnet",
      "instructions": "Reply concisely. Ask before making destructive changes.",
      "permissionMode": "manual"
    }
  ]
}
```

Worker configuration validates permission modes and rejects permission flags
hidden in `claudeArgs`. A tightening-only `bossRole` hint of `adversary` or
`council` forces `--bare`, `permissionMode: "plan"`, and a `read-only` ceiling;
permission-granting settings, agents, plugins, and appended argv cannot widen
it. This local hint does not enroll a Boss participant or expose a reviewer
tool; those surfaces stay unavailable until a protected Controller supplies the
binding, transport, and durable dispatch path.

Start it:

```bash
claude-intercom-worker --config "$HOME/.pi/agent/intercom/claude-worker.json"
```

Each worker's `session_id` is persisted in `statePath`, so later messages resume
the same Claude conversation. The daemon reads a single worker's config from the
environment when no config file is given (`CLAUDE_INTERCOM_WORKER_ID`, `…_NAME`,
`…_CWD`, `…_MODEL`, `…_INSTRUCTIONS`, `…_STATE`).

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `CLAUDE_INTERCOM_NAME` | MCP server | Discoverable session name |
| `CLAUDE_INTERCOM_SESSION_ID` | MCP server | Stable intercom id |
| `CLAUDE_INTERCOM_MODEL` | MCP server | Model label shown to peers |
| `CLAUDE_INTERCOM_EFFORT` | `cci` / `ccim` | Effort level forwarded to every Claude turn |
| `CLAUDE_INTERCOM_CWD` / `_INSTRUCTIONS` | `cci` / `ccim` | Defaults for `--cwd` / `--instructions` |
| `CLAUDE_INTERCOM_CLAUDE_COMMAND` | workers | Claude Code executable (default `claude`) |
| `CLAUDE_INTERCOM_WORKER_ID` / `_NAME` / `_CWD` / `_MODEL` / `_INSTRUCTIONS` / `_STATE` | `claude-intercom-worker` | Single-worker config when no `--config` file is given |
| `CLAUDE_INTERCOM_WORKER_CONFIG` | `claude-intercom-worker` | Path to the worker config JSON |
| `PI_INTERCOM_ASK_TIMEOUT_MS` | all | Default blocking-ask timeout (≤ 120000) |
| `PI_CODING_AGENT_DIR` | all | Overrides the `~/.pi/agent` base dir (broker socket + config live under it) |

The `PI_*` names are shared with the Pi, Codex, and OpenCode adapters on purpose —
all four read the same broker location and ask-timeout so they interoperate.

## Development

```bash
git clone https://github.com/ctliz/agent-intercom-claude.git
cd agent-intercom-claude
npm install
npm run build
npm test
```

For MCP development, register the TypeScript source directly:

```bash
claude mcp add claude-intercom-dev -- npx --no-install tsx ./claude/server.ts
```

## Agent Intercom Compatibility

`agent-intercom-pi` is the Pi-native adapter with overlays and inline rendering.
`agent-intercom-codex` is the Codex MCP/plugin adapter plus wake-on-message Codex
app-server sidecars. This repository, `agent-intercom-claude`, is the Claude Code
MCP/plugin adapter plus wake-on-message headless `claude -p` workers.
`agent-intercom-opencode` provides the native OpenCode plugin.

All four vendor the compatible local broker/client protocol and share one broker
socket, so a single session list spans Pi, Codex, Claude Code, and OpenCode.

## Releasing

Releases are automated from version tags. Update `package.json`, the lockfile when
present, and `CHANGELOG.md` on `main`, then push an annotated tag that exactly
matches the package version:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The release workflow verifies that the tag points into `main`, runs typecheck,
tests, and the build, publishes the public npm package with trusted OIDC
provenance, and creates the GitHub Release. Existing npm versions and GitHub
Releases are skipped safely when a workflow is rerun.

## Compatibility, Migration & Rollback

- **Single Shared Broker**: The broker-capable adapters on the machine — `pi`, `claude`, `codex`, and `opencode` — connect to one local broker over a Unix domain socket (`~/.pi/agent/intercom/broker.sock` or `$PI_CODING_AGENT_DIR/intercom/broker.sock`).
- **Coordinated Upgrade Set**: Protocol v4 changes broker negotiation, so the broker-capable adapters that are *actually installed and enabled on this machine* must be upgraded together in one maintenance window. Adapters you do not use do not need to be installed to satisfy the upgrade. `@ctliz/agent-intercom-core` is an internal dependency that arrives with the adapters and is never installed or upgraded on its own.
- **Orchestrator is Optional**: `agent-intercom-orchestrator` is an optional Linux/systemd lifecycle component. It does not implement or start a Broker and is not part of the Broker compatibility set. Omitting it — for example on macOS, or when using TmuxDeck — is a fully supported configuration and is **not** a mixed or unsupported state. If it is installed on a supported Linux host, or on WSL with a systemd user manager enabled, update it together with the adapters it manages.
- **Fail-Closed Legacy Handling**: An incompatible legacy (v3) broker or client fails closed. It is rejected at negotiation and never killed, never downgraded, and never allowed to form a second broker island.
- **Rollback**: Rolling back covers only the components that were actually installed on this machine before the upgrade. Restore the exact specs and lockfiles you backed up, then reload the affected agent sessions. Roll Orchestrator back only if it was installed to begin with. There is no published pre-v4 tag under `ctliz`, so a pre-upgrade backup of the exact installed specs/locks is the supported rollback material. Leaving some installed broker-capable adapters on the old protocol while others are upgraded is an unsupported mixed state.

## License

The current project is licensed under the [GNU Affero General Public License
v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). If you modify this software and
make the modified version available to users over a network, the AGPL requires
you to offer those users the corresponding source code.

Portions derived from the original MIT-licensed `pi-intercom` project retain
their original notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[licenses/MIT-pi-intercom.txt](licenses/MIT-pi-intercom.txt). Versions already
published under MIT remain available under their original terms. See
[LICENSE_TRANSITION.md](LICENSE_TRANSITION.md) for the exact commit and tag boundary.

## Upgrading to the @ctliz namespace

The v4 release line renames the package namespace from `@dataforxyz/*` to `@ctliz/*`. The two namespaces are different packages to npm. For Claude Code, `0.12.0-connect.3` packages `monitors/monitors.json` alongside the plugin; other installed adapters update to their compatible v4 release (e.g. `connect.2`). Pi Git package installations deduplicate by repository URL without ref, but running agent sessions continue to execute legacy code in memory, and npm or global installs along with binary links can coexist and conflict. Operators must stop active sessions, clean active install surfaces, and follow remove-before-install — side-by-side installation is not supported.

1. Back up the exact specs, lock files, and settings of every installed component.
2. Stop or close the installed broker-capable adapters.
3. Remove the old `@dataforxyz/*` specs, packages, and binary links that are actually installed.
4. Assert the old identity is gone from the **active install surfaces of the current OS user**: Pi settings and extension specs, resolved managed install roots, actual `node_modules` installations, and conflicting binary links that the current `PATH` would resolve. Do not scan or delete unrelated source checkouts, historical documentation, or other users' files — a `@dataforxyz/*` string in an unrelated development clone is not an installation.
5. Install the `@ctliz/*` packages for the components you actually use (e.g. `npm install -g @ctliz/agent-intercom-claude@connect` / `v0.12.0-connect.3`, and companion `connect.2` releases for other harnesses).
6. Reload or restart, then verify exactly one broker is running.

**Classification rule.** Migration-aware setup and update tooling classifies an old-namespace-only install surface as `MIGRATION_REQUIRED`, and the simultaneous presence of both namespaces as a duplicate/dual-load hard error that refuses setup, update, and further installation. This tooling does not exist for every platform and adapter combination; where it is not available, apply the same two rules manually against the surfaces in step 4. Do not assume every adapter emits this code automatically.

**Rollback** reverses this and covers only the components that were installed on this machine before the upgrade: remove the `@ctliz/*` packages, then restore the backed-up exact `@dataforxyz/*` specs and locks. Roll Orchestrator back only if it was installed to begin with.

The `connect.1` tags, source commits, and published release assets are immutable and are not modified by this migration. Release notes may carry an explicit erratum, which corrects the description only and never moves a tag or replaces an asset.
