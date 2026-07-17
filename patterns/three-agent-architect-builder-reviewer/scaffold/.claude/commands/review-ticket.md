---
description: Run the Reviewer stage on a built ticket (three-agent pattern) — requires a fresh context
argument-hint: <ticket-id> [branch-or-PR-ref]
---

Contamination check first: if this session contains the Builder's implementation conversation for ticket $0, STOP and tell the user to run `/review-ticket` from a fresh session. (A reviewer subagent launched from a session that only orchestrated — passing artifacts, never transcripts — is acceptable: Mode A in the scaffold's INSTALL.md.)

Launch the **reviewer** subagent for ticket $0. Give it ONLY: the ticket path, the plan path (`docs/plans/$0.md`), and the diff reference ($1 if provided, otherwise the ticket's branch). Never include the Builder's transcript or self-assessment.

Relay the verdict verbatim — CLEAR, or BOUNCE with its numbered findings. On BOUNCE, findings go back to the Builder; after 2 bounce cycles, escalate to a human instead of looping.

Hard rule: this stage runs in the **reviewer** subagent, never inline in this session. If the subagent cannot be launched or fails, report that and stop — do not absorb its role. After a merge, `/verify-delivery` still runs — a CLEAR verdict does not close the ticket by itself.
