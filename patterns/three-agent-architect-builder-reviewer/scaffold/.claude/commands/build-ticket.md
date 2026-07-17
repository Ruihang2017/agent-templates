---
description: Run the Builder stage on a planned ticket (three-agent pattern)
argument-hint: <ticket-id>
---

Launch the **builder** subagent for ticket $ARGUMENTS, pointing it at the ticket file and its plan at `docs/plans/$ARGUMENTS.md` (adjust the path if the plan lives elsewhere).

Refuse to start if the plan file does not exist — `/plan-ticket` runs first.

When the builder returns, show its diff summary, actual test output, and Deviations note, then STOP. Do not merge; clearance requires `/review-ticket` in a fresh context.

Hard rule: this stage runs in the **builder** subagent, never inline in this session — no matter how small the change looks. If the subagent cannot be launched or fails, report that and stop — do not absorb its role.
