---
description: Post-merge Definition-of-Done check for a ticket (three-agent pattern) — verifies delivery instead of assuming it
argument-hint: <ticket-id>
---

Verify — do not assume — that ticket $ARGUMENTS is actually delivered. Check every item yourself this session and print a pass/fail table:

1. **Plan** exists at `docs/plans/$ARGUMENTS.md`.
2. **Reviewer verdict** is CLEAR, attached to the MR/PR.
3. **Tests green on the merged default branch** — run the suite yourself this session; never accept reported results.
4. **MR/PR merged** into the **default branch** (not a side branch).
5. **Tracker issue closed** — check via `glab issue view` / `gh issue view`. Auto-close via `Closes #N` fires only under specific conditions (GitLab: default-branch merge with the closing pattern in the MR description) — never trust it blindly; this exact gap has shipped before (MRs merged, issues left open).
6. **Writeback** — any Deviations noted by the Builder are reflected back into the ticket/sub-PRD.

Report every failed item plainly. If the MR is merged but the issue is still open, the repair is the exact close command (`glab issue close <N>` / `gh issue close <N>`) — behavior depends on the repo's declared operating mode (CLAUDE.md, "Operating mode"):

- `supervised`: show the command and run it only after explicit human OK.
- `autonomous`: run the repair, report what was repaired, and escalate to a human only if the repair fails or the gap is not mechanically repairable.

Never mark an item passed that you did not check this session.
