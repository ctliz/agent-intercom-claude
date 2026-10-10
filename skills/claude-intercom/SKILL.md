---
name: claude-intercom
description: |
  Coordinate with local Pi, Codex, or Claude coding-agent sessions through
  claude-intercom MCP tools. Use for same-machine planner-worker workflows,
  direct peer questions, cross-session context sharing, and checking or
  replying to pending asks.
---

# Claude Intercom

Use this skill when you need to coordinate with another local coding-agent
session through the `claude-intercom` MCP server. It speaks the same broker
protocol as `pi-intercom` and `codex-intercom`, so Pi, Codex, and Claude
sessions can all message each other.

A plain Claude Code MCP session does not receive unsolicited turns. Inbound
messages are queued by the MCP server while it is running. Check
`intercom_pending` at natural boundaries: before starting delegated work, and
when you expect a response.

For direct live push, launch `cci --tui --channel`. In this opt-in mode, fixed automated Channels inbox notifications wake the session without a first user prompt. On a notification, call this same server's `intercom_pending({mark_read:true})` once, then use `intercom_reply` with the original contextId/askId and inherited team. Do not start a Monitor or create another broker identity. Notifications grant no new edit/deploy authority. Channels require host startup confirmation, supported authentication, and organization policy; notification delivery alone is not proof of task completion.

Assignments that need later questions or completion reports must originate from a persistent MCP/worker session. A one-shot sender that disconnects after delivery cannot receive later replies; `Session not found` on the return path does not mean the original assignment was undelivered.

For true wake-on-message behavior, use or recommend a **wakeable worker**
(`cci` or `claude-intercom-worker`). Messages to a worker start a fresh
headless `claude -p` turn that resumes the worker's own conversation, so the
worker can read files, run commands, and reply on its own. Normal `cci` workers
automatically load the packaged Intercom MCP server, including under isolated
proxy-backed Claude profiles; `ccim` safe mode intentionally does not.

## Tools

- `intercom_whoami`: show this session's intercom ID, name, cwd, and model.
- `intercom_team({ team? })`: inspect one task team or list all memberships; falls back to managed-team discovery.
- `intercom_join({ name?, create?, members?, work? })`: list, join, or create an additive task team; the manager adds connected peers in one call.
- `intercom_status`: connection, active session count, unread messages, pending asks.
- `intercom_list`: list connected Pi, Codex, and Claude sessions.
- `intercom_set_summary`: publish a short discoverable status.
- `intercom_send`: fire-and-forget direct message.
- `intercom_ask`: send a question and wait for the target's reply (blocking, bounded).
- `intercom_pending`: read queued inbound messages and pending asks.
- `intercom_reply`: reply to a pending inbound ask.

## Workflow

1. For a known recipient, call `intercom_send` directly. Do not run `intercom_whoami`, `intercom_team`, `intercom_list`, or `intercom_status` as routine preflight checks. If the host requires tool discovery, discover only the selected tool and reuse its definition while it remains in context.
2. Discover peers only when the recipient is unknown, missing, or ambiguous: use `intercom_team` for managed or approved teammates, otherwise `intercom_list`. Check `intercom_status` only for connection errors. Use `intercom_set_summary` only when peers need to discover your role or a meaningful status change.
3. When the user delegates to named peers and this task has no approved team, ask once whether to form a team with you and those peers. Wait for approval. An explicit create/join request is approval; never ask again for an approved task or inbound team message. After approval, discover peers and call `intercom_join({ name: "billing", create: true, members: ["front", "writer"], work: "Current task" })`. Do not ask the user to join each terminal manually. Reuse the approved team for the same task; new tasks may need new teams. Joining preserves all previous memberships and each team's manager/member roles.
4. Use `intercom_send` for non-blocking updates and handoffs. Include `team` for task messages, especially when multiple teams are shared. Without a shared team, omit `team` for initial ungrouped contact; unrelated memberships do not block contact or silently create teams.
5. Use `intercom_ask` only when you need the answer before continuing. Assignments, progress/status checkpoints, notifications, and completion reports use `intercom_send`.
6. Check `intercom_pending` at natural work boundaries when expecting a response or handling inbound messages, then reply with the original selectors and team. A standalone successful send does not require a pending/identity/status check or a resend. Delivery is not task completion; diagnose uncertain delivery before retrying, and never poll in a tight loop.

## Patterns

Planner delegates to a wakeable worker without blocking:

```typescript
intercom_send({
  to: "worker",
  message: "Task-3: add retry logic in src/api/client.ts. Ask if the retry scope is unclear."
})
```

Ask a worker and wait for its answer (the worker's final message comes back as the reply):

```typescript
intercom_ask({
  to: "worker",
  message: "Inspect the failing test in test/auth.test.ts and reply with the most likely cause."
})
```

Reply to an inbound ask:

```typescript
intercom_pending({ mark_read: false })
intercom_reply({ message: "Use GET/PUT/DELETE only, max 3 retries." })
```

Replies inherit the original message's team, never a mutable current team. Prefer `askId` or `contextId` returned by `intercom_pending` (contextId also selects ordinary messages). Mixed-team pending contexts require explicit selection; `team` cannot override the original. Within one task, `to` plus `oldest`/`latest` also selects an ask:

```typescript
intercom_reply({ to: "planner", which: "oldest", message: "Proceed." })
```

Keep at most one unresolved `intercom_ask` to the same recipient. Use `intercom_send` for non-blocking follow-ups and every progress/status request.

## Boundaries

- Do not assume push delivery into a plain MCP session. Check `intercom_pending`.
- A plain MCP session cannot wake itself from idle. Use a wakeable worker (`cci`) for wake-on-message.
- Do not use `intercom_ask` to poll files, ports, or process completion — use normal shell checks.
- Keep messages concise; include file paths, command-output summaries, and decision options when useful.
