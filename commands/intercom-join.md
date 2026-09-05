---
description: Join a named intercom team, or list joinable teams
argument-hint: [team-name]
---

Join a named Intercom team without tmux.

If `$ARGUMENTS` is empty, call `intercom_join` with no arguments to list joinable named teams. If `$ARGUMENTS` is a team name, call `intercom_join` with that name. Do not guess a team name.

Example: `intercom_join({ name: "billing" })`
