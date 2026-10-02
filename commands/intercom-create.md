---
description: Create a named intercom team and join it as manager
argument-hint: [team-name]
---

Create an additive task team without tmux. This explicit command is user approval; do not ask for approval again. Existing memberships and registration scope stay unchanged.

If `$ARGUMENTS` is a valid team name, call `intercom_join` with `create: true` and that name. If `$ARGUMENTS` is empty, ask the user for a name first. Do not invent a team name.

If the user also names peers or describes a task, discover those connected sessions and pass `members` and `work` in the same call. Do not require the user to join each terminal manually.

Example: `intercom_join({ name: "billing", create: true, members: ["front", "writer"], work: "Billing UI" })`
