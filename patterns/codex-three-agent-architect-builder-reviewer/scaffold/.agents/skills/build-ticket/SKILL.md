---
name: build-ticket
description: Run the Codex three-agent Builder stage for one already-planned ticket. Use when asked to implement a ticket through the Builder only.
---

Resolve the ticket and derive its id. Refuse to start unless `docs/plans/<ticket-id>.md` exists.

Determine the default branch without changing it. Spawn the project custom agent named `builder` with only the ticket path, plan path, default branch, and branch name `ticket/<ticket-id>`. Do not implement or edit in the primary thread.

Wait for the Builder. Return its branch/commit, diff summary, exact test output, and Deviations. Stop without review, merge, or tracker changes.

