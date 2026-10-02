---
description: Join a named intercom team, or list joinable teams
argument-hint: [team-name]
---

Join an additional named task team without tmux. This explicit command is user approval; do not ask for approval again. Previous memberships and registration scope stay unchanged.

If `$ARGUMENTS` is empty, call `intercom_join` with no arguments to list joinable named teams. If `$ARGUMENTS` is a team name, call `intercom_join` with that name. Do not guess a team name.

Example: `intercom_join({ name: "billing" })`
