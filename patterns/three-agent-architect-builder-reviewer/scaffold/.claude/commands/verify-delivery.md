---
description: Post-merge Definition-of-Done check for a ticket (three-agent pattern) — verifies delivery instead of assuming it
argument-hint: <ticket-id>
---

Verify — do not assume — that ticket $ARGUMENTS is actually delivered. Check every item yourself this session and print a pass/fail table:

1. **Plan** exists at `docs/plans/$ARGUMENTS.md`.
2. **Reviewer verdict** is CLEAR, attached to the MR/PR.
3. **MR/PR merged** into the **default branch** (not a side branch).
4. **Tracker issue closed** — check via `glab issue view` / `gh issue view`. Auto-close via `Closes #N` fires only under specific conditions (GitLab: default-branch merge with the closing pattern in the MR description) — never trust it blindly; this exact gap has shipped before (MRs merged, issues left open).
5. **Writeback** — any Deviations noted by the Builder are reflected back into the ticket/sub-PRD.

Report every failed item plainly. If the MR is merged but the issue is still open: show the exact close command (`glab issue close <N>` / `gh issue close <N>`) and run it only after explicit human OK — tracker writes are outward actions. Never mark an item passed that you did not check this session.
