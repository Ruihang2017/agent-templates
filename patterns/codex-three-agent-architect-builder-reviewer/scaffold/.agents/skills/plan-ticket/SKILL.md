---
name: plan-ticket
description: Run the Codex three-agent Architect stage for one ticket. Use when asked to plan a ticket without implementing it.
---

Resolve the requested ticket id or path. Require exactly one matching ticket file and stop if it is absent or ambiguous.

Spawn the project custom agent named `architect` with only the ticket path and this instruction: operate in ticket-planning mode and write `docs/plans/<ticket-id>.md`. Do not include prior conversation content.

Wait for the Architect. Confirm the plan exists and begins with the HOW-not-spec banner. Return the path and summary, then stop. Never implement inline or continue automatically to the Builder.

