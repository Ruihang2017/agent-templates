---
name: start-milestone
description: Gate 1 for one Codex three-agent module. Publish its tickets, then run ready tickets sequentially through Architect, Builder, Reviewer, and delivery.
---

Treat invocation as Gate 1 sign-off and authorization to create issues. Resolve the module and optional mode override. Reject any requested concurrency greater than 1; this Codex-native pattern does not provide worktree isolation for parallel Builders.

Validate the module README and all tickets. Ask `delivery` to run `.codex/scripts/publish-tickets.mjs` first as a dry run, then with `--create --platform <Tracker>`. Stop on errors or drift.

Read `.agents/skills/run-ticket/SKILL.md` completely before starting a ticket. Read every ticket's `blocked_by`. Repeatedly select one open ticket whose dependencies are delivered/closed, then follow the loaded run-ticket procedure exactly. In supervised mode, stop after the first CLEAR opens a PR/MR and report `awaiting-human-merge`; a later invocation resumes because closed issues are filtered out. In autonomous mode, continue independent ready tickets after a failure, but skip their transitive dependents.

Re-read the module after each settled ticket. Finish with every ticket classified as delivered, awaiting-human-merge, escalated, failed, skipped-dependency, already-delivered, drift, or not-started. Never omit filtered tickets.
