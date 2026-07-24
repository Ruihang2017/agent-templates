---
description: Run the Architect stage on a ticket (three-agent pattern)
argument-hint: <ticket-id or path to ticket file>
---

Launch the **architect** subagent on ticket: $ARGUMENTS

Pass it only the ticket reference — no prior conversation content. When it returns, show the plan path and its summary, then STOP. Implementation is the Builder's stage (`/build-ticket`), not this session's next step.

The plan is HOW, not the spec: the **ticket** (its issue) is the source of truth. To change the spec, change the ticket (a docs PR), then re-publish the issue (`publish-tickets.mjs --sync`) — never patch spec into the plan.

Hard rule: this stage runs in the **architect** subagent, never inline in this session. If the subagent cannot be launched or fails, report that and stop — do not absorb its role.
