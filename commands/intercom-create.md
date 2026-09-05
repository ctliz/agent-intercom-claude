---
description: Create a named intercom team and join it as manager
argument-hint: [team-name]
---

Create a named Intercom team that does not require tmux.

If `$ARGUMENTS` is a valid team name, call `intercom_join` with `create: true` and that name. If `$ARGUMENTS` is empty, ask the user for a name first. Do not invent a team name.

Example: `intercom_join({ name: "billing", create: true })`
